"""Upload missing embedding batches to PostgreSQL (incremental, no TRUNCATE).

Reads specific embedding files + chunks_meta.jsonl, inserts only NEW chunks
using INSERT ... ON CONFLICT DO NOTHING.

Usage:
    # Upload specific batches (017, 040 already downloaded):
    python scripts/upload_missing_chunks.py --batches 17 40

    # Upload all 3 missing batches after batch 019 is ready:
    python scripts/upload_missing_chunks.py --batches 17 19 40

Environment:
    DATABASE_URL — PostgreSQL connection string
"""

import argparse
import io
import json
import os
import sys
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from rag.chunker import _detect_court_level, _detect_subcourt

META_FILE = PROJECT_ROOT / "data" / "batch_embed" / "chunks_meta.jsonl"
EMBEDDINGS_DIR = PROJECT_ROOT / "data" / "batch_embed" / "embeddings"
CHUNKS_PER_BATCH = 50_000


def main():
    parser = argparse.ArgumentParser(description="Upload missing embedding batches to pgvector")
    parser.add_argument("--batches", nargs="+", type=int, required=True,
                        help="Batch indices to upload (e.g., 17 19 40)")
    parser.add_argument("--batch-size", type=int, default=5000,
                        help="COPY batch size (default: 5000)")
    args = parser.parse_args()

    try:
        import psycopg2
    except ImportError:
        print("ERROR: psycopg2 not installed. Run: pip install psycopg2-binary")
        return 1

    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        print("ERROR: DATABASE_URL not set")
        return 1

    # Verify embedding files exist
    for idx in args.batches:
        emb_file = EMBEDDINGS_DIR / f"batch_{idx:03d}_embeddings.jsonl"
        if not emb_file.exists():
            print(f"ERROR: {emb_file} not found. Download it first.")
            return 1

    # Load metadata index for the needed ranges
    print(f"Loading metadata for batches {args.batches}...")
    needed_ranges = []
    for b in args.batches:
        start = b * CHUNKS_PER_BATCH
        end = start + CHUNKS_PER_BATCH
        needed_ranges.append((b, start, end))
    
    min_idx = min(s for _, s, _ in needed_ranges)
    max_idx = max(e for _, _, e in needed_ranges)
    
    meta_index = {}
    with open(META_FILE) as f:
        for i, line in enumerate(f):
            if i < min_idx:
                continue
            if i >= max_idx:
                break
            for _, start, end in needed_ranges:
                if start <= i < end:
                    meta_index[i] = json.loads(line)
                    break
    print(f"  Loaded {len(meta_index):,} metadata entries")

    # Connect to PostgreSQL
    conn = psycopg2.connect(database_url)
    conn.autocommit = False
    cur = conn.cursor()

    # Get current count
    cur.execute("SELECT COUNT(*) FROM chunks")
    before_count = cur.fetchone()[0]
    print(f"  Existing chunks: {before_count:,}")

    # Process each batch
    total_inserted = 0
    total_skipped = 0
    columns = ("doc_id", "chunk_index", "content", "embedding",
               "court", "court_level", "year", "title", "subcourt", "jurisdiction")
    
    t0 = time.time()

    for batch_idx in args.batches:
        emb_file = EMBEDDINGS_DIR / f"batch_{batch_idx:03d}_embeddings.jsonl"
        batch_start = batch_idx * CHUNKS_PER_BATCH
        
        print(f"\nProcessing batch_{batch_idx:03d}...")
        batch_buf = []
        batch_inserted = 0
        
        def flush_batch():
            nonlocal total_inserted, batch_inserted, total_skipped
            if not batch_buf:
                return
            # Use INSERT ... ON CONFLICT DO NOTHING to handle duplicates
            values_parts = []
            params = []
            for row in batch_buf:
                values_parts.append("(%s, %s, %s, %s::vector, %s, %s, %s, %s, %s, %s)")
                params.extend(row)
            
            sql = f"""
                INSERT INTO chunks ({', '.join(columns)})
                VALUES {', '.join(values_parts)}
                ON CONFLICT (doc_id, chunk_index) DO NOTHING
            """
            cur.execute(sql, params)
            inserted = cur.rowcount
            conn.commit()
            total_inserted += inserted
            batch_inserted += inserted
            total_skipped += len(batch_buf) - inserted
            elapsed = time.time() - t0
            rate = total_inserted / elapsed if elapsed > 0 else 0
            print(f"  {total_inserted:>10,} inserted ({rate:.0f}/s) [{total_skipped} skipped]", 
                  end="\r", flush=True)
            batch_buf.clear()

        for line in open(emb_file):
            if not line.strip():
                continue
            try:
                resp = json.loads(line)
            except json.JSONDecodeError:
                continue
            
            response = resp.get("response", {})
            if response.get("status_code") != 200:
                continue
            
            custom_id = resp["custom_id"]
            # Handle both original format (emb-bNNN-sNNNNN) and batch_ingest format (batch-NNN-sNNNNN)
            parts = custom_id.split("-")
            if custom_id.startswith("emb-"):
                # Resubmitted format: emb-b19-s950000
                global_start = int(parts[2][1:])
            else:
                # Original format: batch-019-s950000
                global_start = int(parts[2][1:])
            
            for emb in response["body"]["data"]:
                idx = global_start + emb["index"]
                meta = meta_index.get(idx)
                if meta is None:
                    continue
                
                # Truncate 3072d → 2000d (pgvector limit)
                truncated = emb["embedding"][:2000]
                vec_str = "[" + ",".join(f"{v:.8f}" for v in truncated) + "]"
                
                batch_buf.append((
                    meta["doc_id"],
                    meta["chunk_index"],
                    meta.get("text", ""),
                    vec_str,
                    meta["court"],
                    meta.get("court_level", _detect_court_level(meta["court"])),
                    meta["year"],
                    meta["title"],
                    meta.get("subcourt", _detect_subcourt(meta["doc_id"], meta["court"])),
                    meta.get("jurisdiction", ""),
                ))
                if len(batch_buf) >= args.batch_size:
                    flush_batch()
        
        flush_batch()
        print(f"\n  batch_{batch_idx:03d}: {batch_inserted:,} chunks inserted")

    elapsed = time.time() - t0
    
    # Verify final count
    cur.execute("SELECT COUNT(*) FROM chunks")
    after_count = cur.fetchone()[0]
    cur.execute("SELECT COUNT(DISTINCT doc_id) FROM chunks")
    unique_docs = cur.fetchone()[0]
    
    print(f"\n{'=' * 60}")
    print(f"Upload complete in {elapsed:.0f}s")
    print(f"  Before:    {before_count:>12,} chunks")
    print(f"  Inserted:  {total_inserted:>12,} chunks")
    print(f"  Skipped:   {total_skipped:>12,} (duplicates)")
    print(f"  After:     {after_count:>12,} chunks")
    print(f"  Unique docs: {unique_docs:>10,}")
    print(f"{'=' * 60}")

    # REINDEX since we added significant data to IVFFlat
    print("\nREINDEXing chunks.embedding (IVFFlat needs rebuild for new data)...")
    idx_t0 = time.time()
    cur.execute("REINDEX INDEX idx_chunks_embedding")
    conn.commit()
    idx_elapsed = time.time() - idx_t0
    print(f"  REINDEX done in {idx_elapsed:.0f}s")

    print("Running ANALYZE chunks...")
    cur.execute("ANALYZE chunks")
    conn.commit()

    cur.close()
    conn.close()
    print("Done!")
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
