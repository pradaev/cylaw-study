#!/usr/bin/env python3
"""Export vectors from ChromaDB (OpenAI) and upload to Cloudflare Vectorize.

Reads vectors from the local ChromaDB OpenAI collection and uploads them
in batches to Cloudflare Vectorize via the REST API.

Usage:
    python scripts/export_to_vectorize.py
    python scripts/export_to_vectorize.py --dry-run          # count only
    python scripts/export_to_vectorize.py --limit 1000       # test batch
    python scripts/export_to_vectorize.py --batch-size 2000  # custom batch

Environment:
    CLOUDFLARE_ACCOUNT_ID   — Cloudflare account ID
    CLOUDFLARE_API_TOKEN    — API token with Vectorize permissions
"""

import argparse
import hashlib
import json
import logging
import os
import sys
import time
from pathlib import Path

import requests
from dotenv import load_dotenv
from tqdm import tqdm

MAX_VECTOR_ID_BYTES = 64


def make_vector_id(doc_id: str, chunk_index: int) -> str:
    """Create a Vectorize-safe vector ID (max 64 bytes)."""
    readable = f"{doc_id}::{chunk_index}"
    if len(readable.encode("utf-8")) <= MAX_VECTOR_ID_BYTES:
        return readable
    short = hashlib.md5(doc_id.encode("utf-8")).hexdigest()[:16]
    return f"{short}::{chunk_index}"

load_dotenv()

logger = logging.getLogger(__name__)

# Cloudflare Vectorize config
VECTORIZE_INDEX_NAME = "cyprus-law-cases-search"
CF_API_BASE = "https://api.cloudflare.com/client/v4"

# ChromaDB config — OpenAI embeddings (1536 dims)
CHROMADB_DIR = "data/chromadb_openai"
COLLECTION_NAME = "cylaw_openai"

# Upload limits (Vectorize HTTP API allows up to 5000 per request)
DEFAULT_BATCH_SIZE = 2500
MAX_RETRIES = 3

# Progress tracking
PROGRESS_FILE = "data/vectorize_upload_progress.json"


def get_cf_headers() -> dict:
    """Build Cloudflare API headers."""
    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    if not token:
        raise ValueError("CLOUDFLARE_API_TOKEN not set")
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/x-ndjson",
    }


def get_cf_url() -> str:
    """Build Vectorize insert URL."""
    account_id = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    if not account_id:
        raise ValueError("CLOUDFLARE_ACCOUNT_ID not set")
    return (
        f"{CF_API_BASE}/accounts/{account_id}"
        f"/vectorize/v2/indexes/{VECTORIZE_INDEX_NAME}/insert"
    )


def load_progress() -> set:
    """Load set of already-uploaded vector IDs."""
    path = Path(PROGRESS_FILE)
    if path.exists():
        data = json.loads(path.read_text())
        return set(data.get("uploaded_ids_count", 0).__class__.__name__)  # dummy
    return set()


def load_upload_count() -> int:
    """Load count of already-uploaded vectors."""
    path = Path(PROGRESS_FILE)
    if path.exists():
        data = json.loads(path.read_text())
        return data.get("uploaded_count", 0)
    return 0


def save_upload_count(count: int) -> None:
    """Save upload progress."""
    path = Path(PROGRESS_FILE)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"uploaded_count": count}))


def upload_batch_ndjson(
    vectors: list[dict],
    url: str,
    headers: dict,
) -> bool:
    """Upload a batch of vectors as NDJSON to Vectorize.

    Each vector: {"id": "...", "values": [...], "metadata": {...}}
    """
    ndjson_lines = []
    for v in vectors:
        line = json.dumps(v, ensure_ascii=False, separators=(",", ":"))
        ndjson_lines.append(line)
    body = "\n".join(ndjson_lines)

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = requests.post(
                url, data=body.encode("utf-8"), headers=headers, timeout=120
            )
            if resp.status_code == 200:
                result = resp.json()
                if result.get("success"):
                    return True
                else:
                    logger.warning(
                        "API returned success=false: %s",
                        json.dumps(result.get("errors", []))[:200],
                    )
            elif resp.status_code == 429:
                wait = min(2 ** attempt * 5, 60)
                logger.warning("Rate limited, waiting %ds...", wait)
                time.sleep(wait)
                continue
            else:
                logger.warning(
                    "HTTP %d (attempt %d/%d): %s",
                    resp.status_code, attempt, MAX_RETRIES,
                    resp.text[:200],
                )

            if attempt < MAX_RETRIES:
                time.sleep(2 ** attempt)

        except requests.RequestException as exc:
            logger.warning(
                "Request error (attempt %d/%d): %s",
                attempt, MAX_RETRIES, str(exc)[:100],
            )
            if attempt < MAX_RETRIES:
                time.sleep(2 ** attempt)

    return False


def main():
    parser = argparse.ArgumentParser(
        description="Export ChromaDB vectors to Cloudflare Vectorize"
    )
    parser.add_argument(
        "--batch-size", type=int, default=DEFAULT_BATCH_SIZE,
        help=f"Vectors per API request (default: {DEFAULT_BATCH_SIZE})",
    )
    parser.add_argument(
        "--limit", type=int, default=None,
        help="Upload only first N vectors (for testing)",
    )
    parser.add_argument(
        "--offset", type=int, default=0,
        help="Skip first N vectors (for resume)",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Count vectors without uploading",
    )
    parser.add_argument(
        "-v", "--verbose", action="store_true",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )

    # Connect to ChromaDB
    import chromadb

    logger.info("Connecting to ChromaDB at %s ...", CHROMADB_DIR)
    client = chromadb.PersistentClient(path=CHROMADB_DIR)
    collection = client.get_collection(COLLECTION_NAME)
    total_count = collection.count()
    logger.info("Collection '%s' has %d vectors.", COLLECTION_NAME, total_count)

    if args.dry_run:
        print(f"\nDry run: {total_count:,} vectors in ChromaDB")
        print(f"Would upload to Cloudflare Vectorize index '{VECTORIZE_INDEX_NAME}'")
        print(f"Batch size: {args.batch_size}")
        print(f"Estimated batches: {(total_count + args.batch_size - 1) // args.batch_size}")
        return

    # Setup Cloudflare
    url = get_cf_url()
    headers = get_cf_headers()

    # Determine range
    start = args.offset
    end = min(start + args.limit, total_count) if args.limit else total_count
    to_upload = end - start

    print(f"\n{'=' * 60}")
    print(f"Cloudflare Vectorize Upload")
    print(f"  Source:     ChromaDB ({CHROMADB_DIR})")
    print(f"  Index:      {VECTORIZE_INDEX_NAME}")
    print(f"  Total in DB: {total_count:,}")
    print(f"  Uploading:  {to_upload:,} (offset {start})")
    print(f"  Batch size: {args.batch_size}")
    print(f"{'=' * 60}\n")

    uploaded = 0
    failed = 0

    pbar = tqdm(
        total=to_upload,
        desc="Uploading",
        unit="vecs",
        bar_format="{l_bar}{bar}| {n_fmt}/{total_fmt} [{elapsed}<{remaining}, {rate_fmt}]",
    )

    # Paginate through ChromaDB
    pos = start
    while pos < end:
        chunk_size = min(args.batch_size, end - pos)

        # Fetch from ChromaDB with embeddings and metadata
        result = collection.get(
            include=["embeddings", "metadatas"],
            limit=chunk_size,
            offset=pos,
        )

        ids = result["ids"]
        embeddings = result["embeddings"]
        metadatas = result["metadatas"]

        if not ids:
            break

        # Build vectors for Vectorize
        vectors = []
        for i, vec_id in enumerate(ids):
            meta = metadatas[i] if metadatas else {}
            # Convert numpy array to list if needed
            vals = embeddings[i]
            if hasattr(vals, "tolist"):
                vals = vals.tolist()
            doc_id = meta.get("doc_id", "")
            chunk_idx = meta.get("chunk_index", 0)
            vectors.append({
                "id": make_vector_id(doc_id, chunk_idx),
                "values": vals,
                "metadata": {
                    "doc_id": doc_id,
                    "court": meta.get("court", ""),
                    "year": meta.get("year", ""),
                    "title": meta.get("title", "")[:200],
                    "chunk_index": chunk_idx,
                },
            })

        ok = upload_batch_ndjson(vectors, url, headers)
        if ok:
            uploaded += len(vectors)
        else:
            failed += len(vectors)
            logger.error("Failed batch at offset %d", pos)

        pbar.update(len(ids))
        pos += len(ids)

        # Save progress periodically
        if uploaded % 50000 < args.batch_size:
            save_upload_count(start + uploaded)

    pbar.close()
    save_upload_count(start + uploaded)

    print(f"\n{'=' * 60}")
    print(f"Upload complete!")
    print(f"  Uploaded:  {uploaded:>10,}")
    print(f"  Failed:    {failed:>10,}")
    print(f"{'=' * 60}")


if __name__ == "__main__":
    main()
