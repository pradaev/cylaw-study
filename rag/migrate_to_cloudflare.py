#!/usr/bin/env python3
"""Migrate vectors from local ChromaDB to Cloudflare Vectorize.

Reads all vectors from the OpenAI ChromaDB database and uploads them
to Cloudflare Vectorize via the HTTP API in NDJSON batches.

Usage:
    python -m rag.migrate_to_cloudflare
    python -m rag.migrate_to_cloudflare --limit 1000  # test with small batch
"""

import argparse
import hashlib
import json
import logging
import os
import sys
import time
from pathlib import Path

import requests as http_requests
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

import chromadb

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# Cloudflare config
CF_ACCOUNT_ID = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
CF_API_TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN")
CF_INDEX_NAME = "cylaw-cases"

# Source: OpenAI ChromaDB (1536 dims)
CHROMADB_DIR = str(PROJECT_ROOT / "data" / "chromadb_openai")
COLLECTION_NAME = "cylaw_openai"

# Batch size: max 5000 per NDJSON file per Cloudflare docs
BATCH_SIZE = 2000


def get_cf_url(endpoint: str = "") -> str:
    return f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/vectorize/v2/indexes/{CF_INDEX_NAME}{endpoint}"


def cf_headers() -> dict:
    return {"Authorization": f"Bearer {CF_API_TOKEN}"}


def upload_ndjson_batch(vectors: list[dict]) -> dict:
    """Upload a batch of vectors as NDJSON to Cloudflare Vectorize.

    Each vector: {"id": "...", "values": [...], "metadata": {...}}
    """
    # Build NDJSON content
    ndjson_lines = []
    for v in vectors:
        ndjson_lines.append(json.dumps(v, ensure_ascii=False))
    ndjson_content = "\n".join(ndjson_lines)

    resp = http_requests.post(
        get_cf_url("/upsert"),
        headers=cf_headers(),
        files={"vectors": ("vectors.ndjson", ndjson_content.encode("utf-8"))},
    )

    if resp.status_code != 200:
        logger.error("Upload failed: %d %s", resp.status_code, resp.text[:300])

    return resp.json()


def migrate(limit: int = None) -> None:
    """Read from ChromaDB and upload to Cloudflare Vectorize."""
    if not CF_ACCOUNT_ID or not CF_API_TOKEN:
        print("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in .env")
        sys.exit(1)

    # Open ChromaDB
    print(f"Opening ChromaDB at {CHROMADB_DIR}...")
    client = chromadb.PersistentClient(path=CHROMADB_DIR)
    collection = client.get_collection(name=COLLECTION_NAME)
    total = collection.count()
    print(f"Total vectors in ChromaDB: {total:,}")

    if limit:
        total = min(total, limit)
        print(f"Limiting to {total:,} vectors")

    # Check current Cloudflare index
    resp = http_requests.get(get_cf_url(), headers=cf_headers())
    cf_info = resp.json()
    print(f"Cloudflare index: {CF_INDEX_NAME}")
    print(f"  Dimensions: {cf_info['result']['config']['dimensions']}")
    print(f"  Metric: {cf_info['result']['config']['metric']}")

    # Read and upload in batches
    print(f"\nMigrating {total:,} vectors (batch size: {BATCH_SIZE})...")
    t0 = time.time()
    uploaded = 0
    errors = 0

    pbar = tqdm(total=total, desc="Uploading", unit="vecs",
                bar_format="{l_bar}{bar}| {n_fmt}/{total_fmt} [{elapsed}<{remaining}, {rate_fmt}]")

    offset = 0
    while offset < total:
        batch_size = min(BATCH_SIZE, total - offset)

        # Read batch from ChromaDB
        results = collection.get(
            limit=batch_size,
            offset=offset,
            include=["embeddings", "metadatas", "documents"],
        )

        if not results["ids"]:
            break

        # Convert to Cloudflare format
        cf_vectors = []
        for i, vec_id in enumerate(results["ids"]):
            metadata = results["metadatas"][i] if results["metadatas"] else {}

            # Include chunk text in metadata (Cloudflare allows 10 KiB)
            if results["documents"] and results["documents"][i]:
                metadata["text"] = results["documents"][i][:4000]  # stay under 10 KiB

            doc_id = metadata.get("doc_id", vec_id.split("::")[0])
            chunk_idx = metadata.get("chunk_index", 0)
            cf_vectors.append({
                "id": make_vector_id(doc_id, chunk_idx),
                "values": results["embeddings"][i],
                "metadata": metadata,
            })

        # Upload to Cloudflare
        try:
            result = upload_ndjson_batch(cf_vectors)
            if result.get("success"):
                uploaded += len(cf_vectors)
            else:
                errors += 1
                logger.error("Batch error: %s", result.get("errors", []))
        except Exception as exc:
            errors += 1
            logger.error("Upload exception: %s", exc)

        pbar.update(len(cf_vectors))
        offset += batch_size

        # Rate limit: Cloudflare API has 1200 req/5min = 4/sec
        time.sleep(0.5)

    pbar.close()
    elapsed = time.time() - t0

    print(f"\n{'=' * 50}")
    print(f"Migration complete!")
    print(f"  Uploaded: {uploaded:,}")
    print(f"  Errors:   {errors}")
    print(f"  Time:     {elapsed:.0f}s ({uploaded/elapsed:.0f} vecs/sec)")
    print(f"{'=' * 50}")

    # Verify
    resp = http_requests.get(
        get_cf_url("/info"),
        headers=cf_headers(),
    )
    if resp.status_code == 200:
        info = resp.json()
        print(f"\nCloudflare index info: {json.dumps(info.get('result', {}), indent=2)}")


def main():
    parser = argparse.ArgumentParser(description="Migrate ChromaDB → Cloudflare Vectorize")
    parser.add_argument("--limit", type=int, default=None, help="Limit vectors to migrate")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.WARNING,
        format="%(asctime)s [%(levelname)s] %(message)s",
    )

    migrate(limit=args.limit)


if __name__ == "__main__":
    main()
