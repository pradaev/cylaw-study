#!/usr/bin/env python3
"""Ingest court cases directly into Cloudflare Vectorize via OpenAI embeddings.

Pipeline (parallelized):
    Markdown files → chunk (multiprocess)
        → [queue] → OpenAI embed (N threads)
            → [queue] → Cloudflare Vectorize upload (M threads)

Usage:
    python scripts/ingest_to_vectorize.py                     # all docs
    python scripts/ingest_to_vectorize.py --limit 500         # test
    python scripts/ingest_to_vectorize.py --court areiospagos  # one court
    python scripts/ingest_to_vectorize.py --stats             # progress

Environment:
    OPENAI_API_KEY, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN
"""

import argparse
import json
import logging
import multiprocessing
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from queue import Queue, Empty

import requests
from dotenv import load_dotenv
from openai import OpenAI
from tqdm import tqdm

load_dotenv()

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from rag.chunker import chunk_document, _detect_court

logger = logging.getLogger(__name__)

# ── Config ──────────────────────────────────────────────────────────

VECTORIZE_INDEX = "cylaw-search"
CF_API_BASE = "https://api.cloudflare.com/client/v4"
OPENAI_MODEL = "text-embedding-3-small"
OPENAI_DIMS = 1536

INPUT_DIR = PROJECT_ROOT / "data" / "cases_parsed"
PROGRESS_FILE = PROJECT_ROOT / "data" / "vectorize_progress.json"

# Tuning knobs
EMBED_BATCH = 200       # texts per OpenAI call (~500 tok each = 100K tok/call)
EMBED_THREADS = 10      # parallel OpenAI calls
UPLOAD_BATCH = 4000     # vectors per Vectorize call (max 5000)
UPLOAD_THREADS = 5      # parallel Vectorize uploads
MAX_RETRIES = 5
QUEUE_MAXSIZE = 50      # backpressure: max pending upload batches


# ── Cloudflare Vectorize ────────────────────────────────────────────

_cf_url_cache = None
_cf_headers_cache = None


def _cf_insert_url() -> str:
    global _cf_url_cache
    if not _cf_url_cache:
        acct = os.environ["CLOUDFLARE_ACCOUNT_ID"]
        _cf_url_cache = (
            f"{CF_API_BASE}/accounts/{acct}"
            f"/vectorize/v2/indexes/{VECTORIZE_INDEX}/insert"
        )
    return _cf_url_cache


def _cf_headers() -> dict:
    global _cf_headers_cache
    if not _cf_headers_cache:
        token = os.environ["CLOUDFLARE_API_TOKEN"]
        _cf_headers_cache = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/x-ndjson",
        }
    return _cf_headers_cache


def upload_batch(vectors: list[dict], session: requests.Session) -> int:
    """Upload vectors to Vectorize. Returns count uploaded or 0 on failure."""
    url = _cf_insert_url()
    headers = _cf_headers()
    ndjson = "\n".join(
        json.dumps(v, ensure_ascii=False, separators=(",", ":"))
        for v in vectors
    )
    body = ndjson.encode("utf-8")

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = session.post(url, data=body, headers=headers, timeout=120)
            if resp.status_code == 200 and resp.json().get("success"):
                return len(vectors)
            if resp.status_code == 429:
                wait = min(2 ** attempt * 3, 60)
                time.sleep(wait)
                continue
            logger.warning("Upload %d (att %d): %s", resp.status_code, attempt, resp.text[:150])
        except requests.RequestException as exc:
            logger.warning("Upload err (att %d): %s", attempt, str(exc)[:100])
        if attempt < MAX_RETRIES:
            time.sleep(2 ** attempt)
    return 0


# ── OpenAI Embeddings ───────────────────────────────────────────────

def embed_batch(client: OpenAI, texts: list[str]) -> list[list[float]]:
    """Embed texts with retry + rate-limit pacing."""
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = client.embeddings.with_raw_response.create(
                model=OPENAI_MODEL, input=texts,
            )
            remaining = int(resp.headers.get("x-ratelimit-remaining-tokens", "999999"))
            reset_s = _parse_reset(resp.headers.get("x-ratelimit-reset-tokens", "0s"))

            parsed = resp.parse()
            embeddings = [item.embedding for item in parsed.data]

            # Pace if we're burning through the rate limit
            if remaining < 50_000 and reset_s > 0:
                time.sleep(min(reset_s, 5))

            return embeddings
        except Exception as exc:
            wait = min(2 ** attempt, 30)
            logger.warning("OpenAI err (att %d): %s", attempt, str(exc)[:100])
            time.sleep(wait)
    raise RuntimeError("OpenAI embed failed")


def _parse_reset(value: str) -> float:
    import re
    total = 0.0
    m = re.search(r"([\d.]+)m", value)
    if m:
        total += float(m.group(1)) * 60
    m = re.search(r"([\d.]+)s", value)
    if m:
        total += float(m.group(1))
    return total


# ── Progress ────────────────────────────────────────────────────────

_progress_lock = threading.Lock()


def load_progress() -> dict:
    if PROGRESS_FILE.exists():
        return json.loads(PROGRESS_FILE.read_text())
    return {"done_docs": [], "total_vectors": 0}


def save_progress(progress: dict) -> None:
    with _progress_lock:
        PROGRESS_FILE.parent.mkdir(parents=True, exist_ok=True)
        PROGRESS_FILE.write_text(json.dumps(progress, ensure_ascii=False))


# ── Chunking ────────────────────────────────────────────────────────

def _chunk_file(args: tuple) -> list[dict]:
    fp, base = args
    doc_id = str(Path(fp).relative_to(base))
    try:
        text = Path(fp).read_text(encoding="utf-8")
        return [c.to_dict() for c in chunk_document(text, doc_id)]
    except Exception:
        return []


# ── Pipeline ────────────────────────────────────────────────────────

def run_ingest(court: str = None, limit: int = None) -> None:
    openai_client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])

    # Collect files
    md_files = sorted(INPUT_DIR.rglob("*.md"))
    if court:
        md_files = [
            f for f in md_files
            if _detect_court(str(f.relative_to(INPUT_DIR))) == court
        ]
    if limit:
        md_files = md_files[:limit]

    # Filter done
    progress = load_progress()
    done = set(progress.get("done_docs", []))
    md_files = [f for f in md_files if str(f.relative_to(INPUT_DIR)) not in done]

    total_docs = len(md_files) + len(done)
    print(f"\n{'=' * 60}")
    print(f"Cloudflare Vectorize Direct Ingest (parallel)")
    print(f"  OpenAI:        {OPENAI_MODEL} ({OPENAI_DIMS}d)")
    print(f"  Vectorize:     {VECTORIZE_INDEX}")
    print(f"  Embed:         {EMBED_THREADS} threads × {EMBED_BATCH}/batch")
    print(f"  Upload:        {UPLOAD_THREADS} threads × {UPLOAD_BATCH}/batch")
    print(f"  Docs total:    {total_docs:,}")
    print(f"  Already done:  {len(done):,}")
    print(f"  To process:    {len(md_files):,}")
    print(f"{'=' * 60}\n")

    if not md_files:
        print("All documents already processed!")
        return

    # Step 1: Chunk (multiprocess, fast)
    ncpu = multiprocessing.cpu_count()
    print(f"[1/2] Chunking ({ncpu} cores)...")
    t0 = time.time()
    work = [(str(f), str(INPUT_DIR)) for f in md_files]

    all_chunks: list[dict] = []
    with multiprocessing.Pool() as pool:
        for result in tqdm(
            pool.imap_unordered(_chunk_file, work, chunksize=200),
            total=len(md_files), desc="Chunking", unit="docs",
        ):
            all_chunks.extend(result)
    chunk_time = time.time() - t0
    print(f"  {len(all_chunks):,} chunks in {chunk_time:.1f}s\n")

    # Step 2: Parallel embed + upload pipeline
    print(f"[2/2] Embed → Upload ({len(all_chunks):,} chunks)...")
    t1 = time.time()

    # Queue: embed threads produce vectors → upload threads consume
    upload_queue: Queue = Queue(maxsize=QUEUE_MAXSIZE)
    upload_done = threading.Event()

    # Counters
    counters = {"uploaded": 0, "failed": 0, "embedded": 0}
    counters_lock = threading.Lock()

    pbar = tqdm(total=len(all_chunks), desc="Processing", unit="ch",
                bar_format="{l_bar}{bar}| {n_fmt}/{total_fmt} [{elapsed}<{remaining}, {rate_fmt}]")

    # ── Upload workers ──
    def upload_worker():
        sess = requests.Session()
        adapter = requests.adapters.HTTPAdapter(
            pool_connections=10, pool_maxsize=10,
        )
        sess.mount("https://", adapter)

        while True:
            try:
                batch = upload_queue.get(timeout=5)
            except Empty:
                if upload_done.is_set():
                    break
                continue

            if batch is None:  # poison pill
                break

            n = upload_batch(batch, sess)
            with counters_lock:
                if n > 0:
                    counters["uploaded"] += n
                else:
                    counters["failed"] += len(batch)
            upload_queue.task_done()

    upload_pool = []
    for _ in range(UPLOAD_THREADS):
        t = threading.Thread(target=upload_worker, daemon=True)
        t.start()
        upload_pool.append(t)

    # ── Embed workers feed into upload queue ──
    # Split all_chunks into embed-sized batches
    embed_batches = []
    for i in range(0, len(all_chunks), EMBED_BATCH):
        embed_batches.append(all_chunks[i:i + EMBED_BATCH])

    doc_ids_done: set = set()
    doc_ids_lock = threading.Lock()

    def embed_and_enqueue(batch_chunks: list[dict]) -> int:
        texts = [c["text"] for c in batch_chunks]
        try:
            embeddings = embed_batch(openai_client, texts)
        except RuntimeError:
            return 0

        # Build vectors
        vectors = []
        local_docs = set()
        for j, cd in enumerate(batch_chunks):
            vectors.append({
                "id": f"{cd['doc_id']}::{cd['chunk_index']}",
                "values": embeddings[j],
                "metadata": {
                    "doc_id": cd["doc_id"],
                    "court": cd["court"],
                    "year": cd["year"],
                    "title": cd["title"][:200],
                    "chunk_index": cd["chunk_index"],
                },
            })
            local_docs.add(cd["doc_id"])

        with doc_ids_lock:
            doc_ids_done.update(local_docs)

        # Split into upload-sized chunks and enqueue
        for k in range(0, len(vectors), UPLOAD_BATCH):
            upload_queue.put(vectors[k:k + UPLOAD_BATCH])

        return len(vectors)

    with ThreadPoolExecutor(max_workers=EMBED_THREADS) as embed_executor:
        futures = {
            embed_executor.submit(embed_and_enqueue, batch): i
            for i, batch in enumerate(embed_batches)
        }
        for future in as_completed(futures):
            try:
                n = future.result()
                with counters_lock:
                    counters["embedded"] += n
                pbar.update(n)
                pbar.set_postfix(
                    emb=counters["embedded"],
                    up=counters["uploaded"],
                    fail=counters["failed"],
                    refresh=False,
                )
            except Exception as exc:
                logger.error("Embed batch error: %s", exc)

    # Signal upload workers to finish
    upload_done.set()
    upload_queue.join()
    for _ in upload_pool:
        upload_queue.put(None)
    for t in upload_pool:
        t.join(timeout=30)

    pbar.close()
    elapsed = time.time() - t1
    rate = counters["embedded"] / elapsed if elapsed > 0 else 0

    # Save progress
    progress["done_docs"].extend(doc_ids_done)
    progress["total_vectors"] = progress.get("total_vectors", 0) + counters["uploaded"]
    save_progress(progress)

    print(f"\n{'=' * 60}")
    print(f"Done! ({elapsed:.0f}s, {rate:.0f} ch/s)")
    print(f"  Embedded:  {counters['embedded']:>10,}")
    print(f"  Uploaded:  {counters['uploaded']:>10,}")
    print(f"  Failed:    {counters['failed']:>10,}")
    print(f"  Total:     {progress['total_vectors']:>10,}")
    print(f"{'=' * 60}")


def print_stats():
    progress = load_progress()
    done = len(set(progress.get("done_docs", [])))
    vecs = progress.get("total_vectors", 0)
    total_md = sum(1 for _ in INPUT_DIR.rglob("*.md"))
    print(f"\nVectorize ingest progress:")
    print(f"  Documents done:   {done:,} / {total_md:,}")
    print(f"  Vectors uploaded: {vecs:,}")
    remaining = total_md - done
    if remaining > 0:
        avg_chunks = vecs / done if done > 0 else 15
        print(f"  Est. remaining:   ~{int(remaining * avg_chunks):,} vectors")


def main():
    parser = argparse.ArgumentParser(
        description="Ingest cases → OpenAI → Cloudflare Vectorize (parallel)"
    )
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--court", type=str, default=None)
    parser.add_argument("--stats", action="store_true")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.WARNING,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )

    if args.stats:
        print_stats()
        return

    run_ingest(court=args.court, limit=args.limit)


if __name__ == "__main__":
    main()
