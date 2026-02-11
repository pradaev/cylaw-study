#!/usr/bin/env python3
"""Ingest document-level court cases into Weaviate with text-embedding-3-large.

Pipeline:
    1. weaviate_schema.py — create CourtCase collection (one-time)
    2. This script: extract docs → embed → upsert

Usage:
    python scripts/ingest_to_weaviate.py                    # full ingest
    python scripts/ingest_to_weaviate.py --limit 100         # test subset
    python scripts/ingest_to_weaviate.py --court courtOfAppeal  # one court

Environment:
    OPENAI_API_KEY, WEAVIATE_URL (default http://localhost:8080)
"""

import argparse
import hashlib
import logging
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI
from tqdm import tqdm

load_dotenv()

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from rag.document_extractor import extract_document

logger = logging.getLogger(__name__)

OPENAI_MODEL = "text-embedding-3-large"
OPENAI_DIMS = 3072
WEAVIATE_URL = os.environ.get("WEAVIATE_URL", "http://localhost:8080")
INPUT_DIR = PROJECT_ROOT / "data" / "cases_parsed"
BATCH_SIZE = 50  # OpenAI allows up to 2048 inputs; 50 is safe for rate limits


def _doc_id_to_uuid(doc_id: str) -> str:
    """Deterministic UUID for Weaviate (doc_id is unique)."""
    h = hashlib.sha256(doc_id.encode("utf-8")).hexdigest()
    return f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}"


def _detect_court(rel_path: str) -> str:
    parts = Path(rel_path).parts
    return parts[0] if parts else "unknown"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=None, help="Max docs to process")
    parser.add_argument("--court", type=str, default=None, help="Only this court")
    args = parser.parse_args()

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        sys.exit("OPENAI_API_KEY required")

    # Collect doc files
    md_files = sorted(INPUT_DIR.rglob("*.md"))
    if args.court:
        md_files = [f for f in md_files if _detect_court(str(f.relative_to(INPUT_DIR))) == args.court]
    if args.limit:
        md_files = md_files[: args.limit]

    if not md_files:
        logger.warning("No .md files found")
        return

    client = OpenAI(api_key=api_key)
    base = WEAVIATE_URL.rstrip("/")

    # Extract documents
    logger.info("Extracting %d documents...", len(md_files))
    records = []
    for fp in tqdm(md_files, desc="Extract"):
        doc_id = str(fp.relative_to(INPUT_DIR))
        try:
            text = fp.read_text(encoding="utf-8")
            rec = extract_document(text, doc_id)
            if rec:
                records.append(rec)
        except Exception as e:
            logger.debug("Skip %s: %s", doc_id, e)

    logger.info("Extracted %d documents", len(records))

    # Batch embed + upsert
    for i in tqdm(range(0, len(records), BATCH_SIZE), desc="Embed+Upsert"):
        batch = records[i : i + BATCH_SIZE]
        OPENAI_MAX_CHARS = 5500  # ~8K tokens for Greek (0.7 chars/token)
        texts = [r.content[:OPENAI_MAX_CHARS] for r in batch]
        resp = client.embeddings.create(model=OPENAI_MODEL, input=texts)
        vectors = [d.embedding for d in resp.data]

        import requests

        objects = []
        for rec, vec in zip(batch, vectors):
            uuid = _doc_id_to_uuid(rec.doc_id)
            objects.append({
                "class": "CourtCase",
                "id": uuid,
                "properties": {
                    "doc_id": rec.doc_id,
                    "content": rec.content[:100_000],
                    "title": rec.title,
                    "court": rec.court,
                    "year": rec.year,
                    "court_level": rec.court_level,
                    "subcourt": rec.subcourt,
                    "jurisdiction": rec.jurisdiction,
                },
                "vector": vec,
            })
        try:
            r = requests.post(f"{base}/v1/batch/objects", json={"objects": objects})
            if r.status_code != 200:
                logger.warning("Batch upsert: %s %s", r.status_code, r.text[:300])
            else:
                j = r.json()
                result = j.get("result") if isinstance(j, dict) else {}
                errs = result.get("errors", []) if isinstance(result, dict) else []
                if errs:
                    logger.warning("Batch errors: %s", errs[:3])
        except Exception as e:
            logger.warning("Batch failed: %s", e)

    logger.info("Done. Ingested %d documents to Weaviate", len(records))


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    main()
