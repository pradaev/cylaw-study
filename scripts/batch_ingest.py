#!/usr/bin/env python3
"""Ingest court cases into Cloudflare Vectorize via OpenAI Batch API.

Uses the Batch API for embeddings — 50% cheaper, separate rate limits,
no TPM throttling. Completes in minutes instead of hours.

Pipeline steps:
    1. prepare   — chunk docs, create batch JSONL files + metadata index
    2. submit    — upload batch files to OpenAI, create batch jobs
    3. collect   — download embeddings, create metadata indexes, upload to Vectorize
    4. reupload  — re-upload existing embeddings (after metadata index changes, no API cost)

Usage:
    python scripts/batch_ingest.py run                    # full pipeline (prepare → submit → collect)
    python scripts/batch_ingest.py reupload               # re-upload with metadata indexes (no OpenAI cost)

    python scripts/batch_ingest.py prepare                # chunk & create batches
    python scripts/batch_ingest.py submit                 # send to OpenAI
    python scripts/batch_ingest.py status                 # check progress
    python scripts/batch_ingest.py collect                # download & upload to Vectorize

    python scripts/batch_ingest.py prepare --limit 1000   # test with subset
    python scripts/batch_ingest.py prepare --court aad    # one court only

Environment:
    OPENAI_API_KEY, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN

Metadata indexes:
    The script automatically creates required metadata indexes (year, court)
    on Vectorize before uploading vectors. This ensures metadata filtering
    works for all uploaded vectors. See REQUIRED_METADATA_INDEXES constant.
"""

import argparse
import concurrent.futures
import hashlib
import json
import logging
import multiprocessing
import os
import sys
import threading
import time
from pathlib import Path
from typing import Optional

import requests as http_requests
from dotenv import load_dotenv
from openai import OpenAI
from tqdm import tqdm

load_dotenv()

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from rag.chunker import chunk_document, _detect_court, _detect_court_level, _detect_subcourt

logger = logging.getLogger(__name__)

# ── Config ──────────────────────────────────────────────────────────

OPENAI_MODEL = "text-embedding-3-small"
OPENAI_DIMS = 1536
VECTORIZE_INDEX_DEFAULT = "cyprus-law-cases-search"
VECTORIZE_INDEX = VECTORIZE_INDEX_DEFAULT  # overridden by --index CLI arg
CF_API_BASE = "https://api.cloudflare.com/client/v4"

INPUT_DIR = PROJECT_ROOT / "data" / "cases_parsed"
BATCH_DIR = PROJECT_ROOT / "data" / "batch_embed"
STATE_FILE = BATCH_DIR / "state.json"
META_FILE = BATCH_DIR / "chunks_meta.jsonl"

# Batch API limits
INPUTS_PER_REQUEST = 100   # embedding inputs per API request line
INPUTS_PER_BATCH = 50_000  # max embedding inputs per batch (OpenAI limit)
REQUESTS_PER_BATCH = INPUTS_PER_BATCH // INPUTS_PER_REQUEST  # 500

# Vectorize upload
UPLOAD_BATCH = 5000
UPLOAD_WORKERS = 6     # parallel uploads to Vectorize
MAX_VECTOR_ID_BYTES = 64


# ── Helpers ─────────────────────────────────────────────────────────

def make_vector_id(doc_id: str, chunk_index: int) -> str:
    """Create a Vectorize-safe vector ID (max 64 bytes)."""
    readable = f"{doc_id}::{chunk_index}"
    if len(readable.encode("utf-8")) <= MAX_VECTOR_ID_BYTES:
        return readable
    short = hashlib.md5(doc_id.encode("utf-8")).hexdigest()[:16]
    return f"{short}::{chunk_index}"


def load_state() -> dict:
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {"phase": "init", "batches": []}


def save_state(state: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2, ensure_ascii=False))


def _chunk_file(args: tuple) -> list[dict]:
    fp, base = args
    doc_id = str(Path(fp).relative_to(base))
    try:
        text = Path(fp).read_text(encoding="utf-8")
        return [c.to_dict() for c in chunk_document(text, doc_id)]
    except Exception:
        return []


def _cf_headers() -> dict:
    token = os.environ["CLOUDFLARE_API_TOKEN"]
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/x-ndjson",
    }


def _cf_upsert_url() -> str:
    """Upsert endpoint — creates new vectors or overwrites existing ones.

    MUST use upsert (not insert) for reupload/metadata refresh scenarios,
    because insert silently skips vectors with existing IDs.
    """
    acct = os.environ["CLOUDFLARE_ACCOUNT_ID"]
    return (
        f"{CF_API_BASE}/accounts/{acct}"
        f"/vectorize/v2/indexes/{VECTORIZE_INDEX}/upsert"
    )


def _cf_json_headers() -> dict:
    token = os.environ["CLOUDFLARE_API_TOKEN"]
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }


def _cf_index_url() -> str:
    acct = os.environ["CLOUDFLARE_ACCOUNT_ID"]
    return (
        f"{CF_API_BASE}/accounts/{acct}"
        f"/vectorize/v2/indexes/{VECTORIZE_INDEX}"
    )


# Required metadata indexes — extend this list to add new filterable fields
REQUIRED_METADATA_INDEXES = [
    {"propertyName": "year", "indexType": "string"},
    {"propertyName": "court", "indexType": "string"},
    {"propertyName": "court_level", "indexType": "string"},
    {"propertyName": "subcourt", "indexType": "string"},
]


def ensure_metadata_indexes() -> None:
    """Create metadata indexes on Vectorize if they don't exist.

    Must be called BEFORE uploading vectors — vectors upserted before
    an index is created won't be included in that index.
    """
    base = _cf_index_url()
    headers = _cf_json_headers()

    # List existing indexes
    resp = http_requests.get(f"{base}/metadata_index/list", headers=headers, timeout=30)
    if resp.status_code != 200:
        print(f"  Warning: could not list metadata indexes ({resp.status_code})")
        existing = []
    else:
        data = resp.json()
        existing = [
            idx["propertyName"]
            for idx in data.get("result", {}).get("metadataIndexes", [])
        ]

    print(f"\n[Metadata Indexes] Existing: {existing or 'none'}")

    for idx_def in REQUIRED_METADATA_INDEXES:
        name = idx_def["propertyName"]
        if name in existing:
            print(f"  ✓ {name} ({idx_def['indexType']}) — already exists")
            continue

        resp = http_requests.post(
            f"{base}/metadata_index/create",
            headers=headers,
            json=idx_def,
            timeout=30,
        )
        if resp.status_code == 200 and resp.json().get("success"):
            print(f"  ✓ {name} ({idx_def['indexType']}) — created")
        else:
            print(f"  ✗ {name} — failed: {resp.text[:150]}")

    print()


# ── Step 1: Prepare ────────────────────────────────────────────────

def step_prepare(court: Optional[str] = None, limit: Optional[int] = None) -> None:
    """Chunk documents and create batch JSONL files."""
    BATCH_DIR.mkdir(parents=True, exist_ok=True)

    # Collect files
    md_files = sorted(INPUT_DIR.rglob("*.md"))
    if court:
        md_files = [
            f for f in md_files
            if _detect_court(str(f.relative_to(INPUT_DIR))) == court
        ]
    if limit:
        md_files = md_files[:limit]

    print(f"\n[1/3] Chunking {len(md_files):,} documents...")
    t0 = time.time()
    ncpu = multiprocessing.cpu_count()
    work = [(str(f), str(INPUT_DIR)) for f in md_files]

    all_chunks: list[dict] = []
    with multiprocessing.Pool() as pool:
        for result in tqdm(
            pool.imap_unordered(_chunk_file, work, chunksize=200),
            total=len(md_files), desc="Chunking", unit="docs",
        ):
            all_chunks.extend(result)

    print(f"  {len(all_chunks):,} chunks in {time.time() - t0:.1f}s")

    # Save metadata index (without text — just for Vectorize upload later)
    print(f"\n[2/3] Saving metadata index...")
    with open(META_FILE, "w", encoding="utf-8") as mf:
        for i, chunk in enumerate(tqdm(all_chunks, desc="Metadata", unit="ch")):
            meta = {
                "idx": i,
                "doc_id": chunk["doc_id"],
                "court": chunk["court"],
                "year": chunk["year"],
                "title": chunk["title"][:200],
                "chunk_index": chunk["chunk_index"],
                "court_level": chunk.get("court_level", _detect_court_level(chunk["court"])),
                "subcourt": chunk.get("subcourt", _detect_subcourt(chunk["doc_id"], chunk["court"])),
            }
            mf.write(json.dumps(meta, ensure_ascii=False) + "\n")

    # Create batch JSONL files
    print(f"\n[3/3] Creating batch files...")
    total_inputs = len(all_chunks)
    num_batches = (total_inputs + INPUTS_PER_BATCH - 1) // INPUTS_PER_BATCH
    batch_files = []

    for batch_idx in range(num_batches):
        batch_start = batch_idx * INPUTS_PER_BATCH
        batch_end = min(batch_start + INPUTS_PER_BATCH, total_inputs)
        batch_chunks = all_chunks[batch_start:batch_end]

        fname = BATCH_DIR / f"batch_{batch_idx:03d}.jsonl"
        with open(fname, "w", encoding="utf-8") as bf:
            # Group into requests of INPUTS_PER_REQUEST
            for req_idx in range(0, len(batch_chunks), INPUTS_PER_REQUEST):
                req_chunks = batch_chunks[req_idx:req_idx + INPUTS_PER_REQUEST]
                texts = [c["text"] for c in req_chunks]
                global_start = batch_start + req_idx
                line = {
                    "custom_id": f"b{batch_idx}-r{req_idx}-s{global_start}",
                    "method": "POST",
                    "url": "/v1/embeddings",
                    "body": {
                        "model": OPENAI_MODEL,
                        "input": texts,
                    },
                }
                bf.write(json.dumps(line, ensure_ascii=False) + "\n")

        batch_files.append(str(fname))
        print(f"  batch_{batch_idx:03d}.jsonl: {batch_end - batch_start:,} inputs")

    # Save state
    state = {
        "phase": "prepared",
        "total_chunks": total_inputs,
        "num_batches": num_batches,
        "batch_files": batch_files,
        "batches": [],
    }
    save_state(state)
    print(f"\nPrepared {num_batches} batch files with {total_inputs:,} total inputs.")
    print(f"Files saved to {BATCH_DIR}/")


# ── Step 2: Submit ──────────────────────────────────────────────────

def step_submit() -> None:
    """Upload batch files and create OpenAI batch jobs."""
    state = load_state()
    if state["phase"] not in ("prepared", "submitted"):
        print("Run 'prepare' first.")
        return

    client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
    batch_files = state["batch_files"]
    existing_batches = {b["file"]: b for b in state.get("batches", [])}

    print(f"\nSubmitting {len(batch_files)} batches to OpenAI Batch API...")

    for fpath in batch_files:
        if fpath in existing_batches:
            b = existing_batches[fpath]
            if b.get("batch_id") and b.get("status") not in ("failed", "expired", "cancelled"):
                print(f"  {Path(fpath).name}: already submitted (batch {b['batch_id']})")
                continue

        fname = Path(fpath).name
        print(f"  Uploading {fname}...", end=" ", flush=True)

        # Upload file
        with open(fpath, "rb") as f:
            file_obj = client.files.create(file=f, purpose="batch")

        print(f"file_id={file_obj.id}", end=" ", flush=True)

        # Create batch
        batch = client.batches.create(
            input_file_id=file_obj.id,
            endpoint="/v1/embeddings",
            completion_window="24h",
            metadata={"description": f"cylaw-search embeddings {fname}"},
        )

        print(f"batch_id={batch.id} ✓")

        existing_batches[fpath] = {
            "file": fpath,
            "file_id": file_obj.id,
            "batch_id": batch.id,
            "status": batch.status,
        }

    state["phase"] = "submitted"
    state["batches"] = list(existing_batches.values())
    save_state(state)
    print(f"\nAll batches submitted. Run 'status' to check progress.")


# ── Step 3: Status ──────────────────────────────────────────────────

def step_status() -> None:
    """Check status of all submitted batches."""
    state = load_state()
    if state["phase"] not in ("submitted", "collecting"):
        print(f"Current phase: {state['phase']}. Nothing to check.")
        return

    client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])

    print(f"\nBatch status ({len(state['batches'])} batches):")
    all_done = True
    for b in state["batches"]:
        batch = client.batches.retrieve(b["batch_id"])
        b["status"] = batch.status
        b["output_file_id"] = batch.output_file_id
        b["error_file_id"] = batch.error_file_id
        counts = batch.request_counts
        total = counts.total if counts else 0
        completed = counts.completed if counts else 0
        failed = counts.failed if counts else 0

        status_icon = {
            "completed": "✅",
            "failed": "❌",
            "expired": "⏰",
            "cancelled": "🚫",
            "in_progress": "🔄",
            "validating": "📋",
            "finalizing": "📦",
        }.get(batch.status, "❓")

        print(f"  {status_icon} {Path(b['file']).name}: {batch.status} "
              f"({completed}/{total} done, {failed} failed)")

        if batch.status not in ("completed", "failed", "expired", "cancelled"):
            all_done = False

    save_state(state)

    if all_done:
        completed_count = sum(1 for b in state["batches"] if b["status"] == "completed")
        print(f"\nAll batches finished! {completed_count}/{len(state['batches'])} completed.")
        print(f"Run 'collect' to download results and upload to Vectorize.")
    else:
        print(f"\nSome batches still in progress. Check again in a few minutes.")


# ── Step 4: Collect ─────────────────────────────────────────────────

def _upload_chunk(args: tuple) -> int:
    """Upload one NDJSON chunk to Vectorize. Returns count uploaded."""
    ndjson_bytes, cf_url, cf_headers = args
    session = http_requests.Session()
    for attempt in range(5):
        try:
            resp = session.post(cf_url, data=ndjson_bytes, headers=cf_headers, timeout=120)
            if resp.status_code == 200 and resp.json().get("success"):
                count = ndjson_bytes.count(b"\n") + 1
                return count
            if resp.status_code == 429:
                time.sleep(min(2 ** attempt * 3, 60))
                continue
            logger.warning("Upload %d: %s", resp.status_code, resp.text[:150])
        except http_requests.RequestException as exc:
            logger.warning("Upload error: %s", str(exc)[:100])
        if attempt < 4:
            time.sleep(2 ** attempt)
    return 0


def _parse_batch_vectors(content_text: str, meta_index: list) -> list:
    """Parse OpenAI batch result into vector dicts."""
    vectors = []
    for line in content_text.strip().split("\n"):
        resp = json.loads(line)
        response = resp.get("response", {})
        if response.get("status_code") != 200:
            continue
        parts = resp["custom_id"].split("-")
        global_start = int(parts[2][1:])
        for emb in response["body"]["data"]:
            idx = global_start + emb["index"]
            if idx >= len(meta_index):
                continue
            meta = meta_index[idx]
            vectors.append({
                "id": make_vector_id(meta["doc_id"], meta["chunk_index"]),
                "values": emb["embedding"],
                "metadata": {
                    "doc_id": meta["doc_id"],
                    "court": meta["court"],
                    "year": meta["year"],
                    "title": meta["title"],
                    "chunk_index": meta["chunk_index"],
                    "court_level": meta.get("court_level", _detect_court_level(meta["court"])),
                    "subcourt": meta.get("subcourt", _detect_subcourt(meta["doc_id"], meta["court"])),
                },
            })
    return vectors


def step_collect() -> None:
    """Download embedding results and upload to Vectorize — parallel."""
    state = load_state()
    if state["phase"] not in ("submitted", "collecting", "done"):
        print(f"Current phase: {state['phase']}. Run submit first.")
        return

    # Ensure metadata indexes exist BEFORE uploading vectors
    ensure_metadata_indexes()

    openai_key = os.environ["OPENAI_API_KEY"]

    # Load metadata index
    print(f"\nLoading metadata index...")
    meta_index: list[dict] = []
    with open(META_FILE, "r", encoding="utf-8") as mf:
        for line in mf:
            meta_index.append(json.loads(line))
    print(f"  {len(meta_index):,} chunk metadata entries loaded.")

    cf_url = _cf_upsert_url()
    cf_headers = _cf_headers()

    # Count already collected
    already_uploaded = sum(
        b.get("uploaded", 0) for b in state["batches"] if b.get("collected")
    )
    to_collect = [
        b for b in state["batches"]
        if b["status"] == "completed" and not b.get("collected") and b.get("output_file_id")
    ]
    skipped = [
        b for b in state["batches"]
        if b["status"] != "completed" and not b.get("collected")
    ]

    print(f"  Already collected: {already_uploaded:,} vectors")
    print(f"  To collect: {len(to_collect)} batches")
    if skipped:
        print(f"  Skipped (not completed): {len(skipped)}")

    total_uploaded = already_uploaded
    total_failed = 0
    t0 = time.time()

    # Parallel pipeline:
    #   - Download pool: 6 threads fetching batch files from OpenAI in parallel
    #   - Upload pool: 6 threads uploading NDJSON chunks to Vectorize in parallel
    #   - As each download completes, its vectors are parsed and queued for upload
    DOWNLOAD_WORKERS = 10
    download_pool = concurrent.futures.ThreadPoolExecutor(max_workers=DOWNLOAD_WORKERS)
    upload_pool = concurrent.futures.ThreadPoolExecutor(max_workers=UPLOAD_WORKERS)

    def download_batch(b: dict) -> tuple:
        """Download one batch result from OpenAI."""
        client = OpenAI(api_key=openai_key)
        content = client.files.content(b["output_file_id"])
        return b, content.text

    # Submit ALL downloads at once — pool limits concurrency to DOWNLOAD_WORKERS
    download_futures = {
        download_pool.submit(download_batch, b): b for b in to_collect
    }

    batch_num = 0
    for future in concurrent.futures.as_completed(download_futures):
        batch_num += 1
        b, content_text = future.result()
        fname = Path(b["file"]).name

        # Parse vectors
        vectors = _parse_batch_vectors(content_text, meta_index)
        del content_text  # free memory

        # Prepare NDJSON chunks for parallel upload
        ndjson_chunks = []
        for i in range(0, len(vectors), UPLOAD_BATCH):
            chunk = vectors[i:i + UPLOAD_BATCH]
            ndjson = "\n".join(
                json.dumps(v, ensure_ascii=False, separators=(",", ":"))
                for v in chunk
            ).encode("utf-8")
            ndjson_chunks.append((ndjson, cf_url, cf_headers))

        del vectors  # free memory before upload

        # Upload all chunks in parallel
        upload_futures_list = [upload_pool.submit(_upload_chunk, c) for c in ndjson_chunks]
        batch_uploaded = sum(f.result() for f in upload_futures_list)
        batch_total = sum(c[0].count(b"\n") + 1 for c in ndjson_chunks)
        batch_failed = batch_total - batch_uploaded

        total_uploaded += batch_uploaded
        total_failed += batch_failed

        elapsed = time.time() - t0
        rate = total_uploaded / elapsed if elapsed > 0 else 0

        print(f"  [{batch_num}/{len(to_collect)}] {fname}: "
              f"{batch_uploaded:,} uploaded "
              f"({total_uploaded:,} total, {rate:,.0f} vec/s)", flush=True)

        b["collected"] = True
        b["uploaded"] = batch_uploaded
        state["phase"] = "collecting"
        state["total_uploaded"] = total_uploaded
        save_state(state)

    download_pool.shutdown(wait=False)
    upload_pool.shutdown(wait=False)

    state["phase"] = "done"
    state["total_uploaded"] = total_uploaded
    save_state(state)

    elapsed = time.time() - t0
    print(f"\n{'=' * 60}")
    print(f"Collection complete in {elapsed:.0f}s!")
    print(f"  Uploaded:  {total_uploaded:>10,}")
    print(f"  Failed:    {total_failed:>10,}")
    print(f"{'=' * 60}")


# ── Run all steps ───────────────────────────────────────────────────

def step_reupload() -> None:
    """Re-upload existing embeddings to Vectorize (no OpenAI calls).

    Use when:
      - Metadata indexes were created after initial upload
      - Vectors need re-indexing for metadata filtering
      - Upload was interrupted and needs to resume

    Resets the 'collected' flag on all completed batches and re-runs collect.
    """
    state = load_state()
    if state["phase"] not in ("done", "collecting", "submitted"):
        print(f"Current phase: {state['phase']}. Need completed batches to reupload.")
        return

    # Reset collected flags
    reset_count = 0
    for b in state["batches"]:
        if b["status"] == "completed" and b.get("output_file_id"):
            b["collected"] = False
            b["uploaded"] = 0
            reset_count += 1

    state["phase"] = "submitted"  # allow collect to run
    state["total_uploaded"] = 0
    save_state(state)

    print(f"\nReset {reset_count} batches for re-upload.")
    print(f"Embeddings will be re-downloaded from OpenAI file storage (no new API cost).")
    print(f"Vectors will be re-upserted to Vectorize with metadata indexes.\n")

    step_collect()


def step_full_reset() -> None:
    """Delete Vectorize index, recreate with metadata indexes, then reupload.

    WARNING: This causes downtime — the index is empty until reupload completes.
    Use 'reupload' instead if you just need to refresh metadata.
    """
    import subprocess

    acct = os.environ["CLOUDFLARE_ACCOUNT_ID"]
    token = os.environ["CLOUDFLARE_API_TOKEN"]
    headers = _cf_json_headers()
    base = f"{CF_API_BASE}/accounts/{acct}/vectorize/v2/indexes"

    # 1. Delete existing index
    print(f"\n[1/4] Deleting index '{VECTORIZE_INDEX}'...")
    resp = http_requests.delete(f"{base}/{VECTORIZE_INDEX}", headers=headers, timeout=30)
    if resp.status_code == 200:
        print(f"  ✓ Index deleted")
    else:
        print(f"  Response: {resp.status_code} {resp.text[:150]}")

    # Wait for deletion to propagate
    print("  Waiting 10s for deletion to propagate...")
    time.sleep(10)

    # 2. Recreate index
    print(f"\n[2/4] Creating index '{VECTORIZE_INDEX}' (dims={OPENAI_DIMS}, metric=cosine)...")
    resp = http_requests.post(
        base,
        headers=headers,
        json={
            "name": VECTORIZE_INDEX,
            "config": {
                "dimensions": OPENAI_DIMS,
                "metric": "cosine",
            },
        },
        timeout=30,
    )
    resp_data = resp.json()
    if resp.status_code == 200 and resp_data.get("success"):
        print(f"  ✓ Index created")
    elif resp_data.get("result", {}).get("name") == VECTORIZE_INDEX:
        # Index was created even if success flag is missing
        print(f"  ✓ Index created (confirmed by name)")
    else:
        print(f"  ✗ Failed: {resp.status_code} {json.dumps(resp_data, indent=2)[:300]}")
        return

    # Wait for creation to propagate
    print("  Waiting 5s for creation to propagate...")
    time.sleep(5)

    # 3. Create metadata indexes
    print(f"\n[3/4] Creating metadata indexes...")
    ensure_metadata_indexes()

    # Wait for indexes to propagate
    print("  Waiting 5s for metadata indexes to propagate...")
    time.sleep(5)

    # 4. Reupload
    print(f"\n[4/4] Starting reupload...")
    step_reupload()


def step_run(court: Optional[str] = None, limit: Optional[int] = None) -> None:
    """Run all steps: prepare, submit, then collect with parallel uploads."""
    state = load_state()

    if state["phase"] == "init":
        step_prepare(court=court, limit=limit)
        state = load_state()

    if state["phase"] == "prepared":
        step_submit()
        state = load_state()

    if state["phase"] in ("submitted", "collecting"):
        # Poll until all batches are done, then collect
        client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
        print(f"\nPolling for batch completion...")
        while True:
            all_done = True
            for b in state["batches"]:
                if b.get("collected") or b["status"] in ("completed", "failed", "expired", "cancelled"):
                    continue
                batch_obj = client.batches.retrieve(b["batch_id"])
                b["status"] = batch_obj.status
                b["output_file_id"] = batch_obj.output_file_id
                b["error_file_id"] = batch_obj.error_file_id
                if batch_obj.status not in ("completed", "failed", "expired", "cancelled"):
                    all_done = False
            save_state(state)

            completed = sum(1 for b in state["batches"] if b["status"] == "completed")
            total = len(state["batches"])
            if all_done:
                print(f"  All batches done! ({completed}/{total} completed)")
                break
            print(f"  {completed}/{total} completed, waiting 30s...", flush=True)
            time.sleep(30)

        # Now collect with parallel uploads
        step_collect()


# ── CLI ─────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Ingest cases → OpenAI Batch API → Cloudflare Vectorize"
    )
    parser.add_argument(
        "command",
        choices=["prepare", "submit", "status", "collect", "reupload", "full-reset", "run", "reset"],
        help="Pipeline step to run",
    )
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--court", type=str, default=None)
    parser.add_argument("--index", type=str, default=VECTORIZE_INDEX_DEFAULT,
                        help=f"Vectorize index name (default: {VECTORIZE_INDEX_DEFAULT})")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    global VECTORIZE_INDEX
    VECTORIZE_INDEX = args.index

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.WARNING,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )

    print(f"Using Vectorize index: {VECTORIZE_INDEX}")

    if args.command == "reset":
        if BATCH_DIR.exists():
            import shutil
            shutil.rmtree(BATCH_DIR)
            print("Batch data cleared.")
        return

    if args.command == "full-reset":
        step_full_reset()
        return

    if args.command == "prepare":
        step_prepare(court=args.court, limit=args.limit)
    elif args.command == "submit":
        step_submit()
    elif args.command == "status":
        step_status()
    elif args.command == "collect":
        step_collect()
    elif args.command == "reupload":
        step_reupload()
    elif args.command == "run":
        step_run(court=args.court, limit=args.limit)


if __name__ == "__main__":
    main()
