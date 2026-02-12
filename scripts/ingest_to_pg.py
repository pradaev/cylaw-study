"""Ingest documents from data/cases_parsed/ into PostgreSQL for BM25 search.

Reads all .md files, extracts metadata (court, year, court_level, title),
and inserts FULL document text into the `documents` table.
PostgreSQL generates tsvector automatically from content.

Usage:
    python scripts/ingest_to_pg.py [--limit N] [--batch-size N]
"""

from __future__ import annotations

import argparse
import io
import os
import sys
import time
from pathlib import Path

import psycopg2

# Add project root to path for rag imports
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from rag.chunker import (
    _detect_court,
    _detect_court_level,
    _detect_subcourt,
    _detect_year,
    _extract_title,
)

# ── Config ──────────────────────────────────────────────

CASES_DIR = Path(__file__).resolve().parent.parent / "data" / "cases_parsed"
DATABASE_URL = os.environ.get(
    "DATABASE_URL", "postgresql://cylaw:cylaw_dev@localhost:5432/cylaw"
)
BATCH_SIZE = 1000  # docs per COPY batch


def get_doc_id(filepath: Path) -> str:
    """Convert filesystem path to doc_id (relative to cases_parsed/)."""
    return str(filepath.relative_to(CASES_DIR))


def read_document(filepath: Path) -> tuple[str, str, str, str, int] | None:
    """Read file and extract metadata. Returns (doc_id, title, court, court_level, year) or None."""
    try:
        text = filepath.read_text(encoding="utf-8")
    except Exception:
        return None

    if not text or len(text.strip()) < 50:
        return None

    doc_id = get_doc_id(filepath)
    title = _extract_title(text)[:200] if _extract_title(text) else ""
    court = _detect_court(doc_id)
    court_level = _detect_court_level(court)
    year_str = _detect_year(doc_id)

    try:
        year = int(year_str) if year_str else 0
    except (ValueError, TypeError):
        year = 0

    return doc_id, title, court, court_level, year, text


def ingest(limit: int | None = None, batch_size: int = BATCH_SIZE) -> None:
    """Main ingest: read files → bulk insert into PostgreSQL."""
    print(f"Connecting to {DATABASE_URL.split('@')[1] if '@' in DATABASE_URL else DATABASE_URL}...")
    conn = psycopg2.connect(DATABASE_URL)
    conn.autocommit = False
    cur = conn.cursor()

    # Check existing count
    cur.execute("SELECT COUNT(*) FROM documents")
    existing = cur.fetchone()[0]
    if existing > 0:
        print(f"Table already has {existing:,} documents. Truncating...")
        cur.execute("TRUNCATE documents RESTART IDENTITY")
        conn.commit()

    # Collect all .md files
    print(f"Scanning {CASES_DIR}...")
    files = sorted(CASES_DIR.rglob("*.md"))
    total = len(files)
    if limit:
        files = files[:limit]
    print(f"Found {total:,} files, processing {len(files):,}")

    # Bulk insert using COPY for speed
    inserted = 0
    skipped = 0
    start = time.time()

    batch_buffer: list[tuple] = []

    for i, filepath in enumerate(files):
        result = read_document(filepath)
        if result is None:
            skipped += 1
            continue

        doc_id, title, court, court_level, year, text = result
        # Escape for COPY: tab-separated, newlines escaped
        batch_buffer.append((doc_id, court, court_level, year, title, text))

        if len(batch_buffer) >= batch_size:
            _copy_batch(cur, batch_buffer)
            conn.commit()
            inserted += len(batch_buffer)
            batch_buffer = []
            elapsed = time.time() - start
            rate = inserted / elapsed if elapsed > 0 else 0
            print(
                f"  {inserted:,}/{len(files):,} inserted "
                f"({skipped:,} skipped) "
                f"[{rate:.0f} docs/s, {elapsed:.0f}s elapsed]"
            )

    # Final batch
    if batch_buffer:
        _copy_batch(cur, batch_buffer)
        conn.commit()
        inserted += len(batch_buffer)

    elapsed = time.time() - start

    # Update statistics for query planner
    print("Running ANALYZE...")
    cur.execute("ANALYZE documents")
    conn.commit()

    cur.close()
    conn.close()

    print(f"\nDone! {inserted:,} documents inserted, {skipped:,} skipped in {elapsed:.1f}s")
    print(f"Rate: {inserted / elapsed:.0f} docs/s")


def _copy_batch(cur, batch: list[tuple]) -> None:
    """Use COPY for fast bulk insert."""
    buf = io.StringIO()
    for doc_id, court, court_level, year, title, text in batch:
        # Escape special chars for COPY format
        safe_title = title.replace("\\", "\\\\").replace("\t", " ").replace("\n", " ").replace("\r", "")
        safe_text = text.replace("\\", "\\\\").replace("\t", " ").replace("\r", "")
        # COPY uses \n as row separator, so we need to escape newlines in content
        safe_text = safe_text.replace("\n", "\\n")
        row = f"{doc_id}\t{court}\t{court_level}\t{year}\t{safe_title}\t{safe_text}\n"
        buf.write(row)

    buf.seek(0)
    cur.copy_from(buf, "documents", columns=("doc_id", "court", "court_level", "year", "title", "content"))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Ingest documents into PostgreSQL")
    parser.add_argument("--limit", type=int, help="Max documents to ingest")
    parser.add_argument("--batch-size", type=int, default=BATCH_SIZE, help="Batch size for COPY")
    args = parser.parse_args()

    ingest(limit=args.limit, batch_size=args.batch_size)
