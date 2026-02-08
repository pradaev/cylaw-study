"""Search API server for local development.

Wraps the existing Retriever and exposes search + document endpoints
that the Next.js frontend calls during local dev.

Endpoints:
    GET /search     — semantic search, returns metadata only (no full text)
    GET /document   — fetch full text of a single document by doc_id
    GET /health     — server health check

Usage:
    python -m rag.search_server
    python -m rag.search_server --port 8100 --provider local
"""

import argparse
import logging
import os
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

load_dotenv()

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
CASES_PARSED_DIR = PROJECT_ROOT / "data" / "cases_parsed"

app = FastAPI(title="Cyprus Case Law Search API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:3001", "http://localhost:3002", "http://localhost:3003"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

_retriever = None


def get_retriever(provider: str = None):
    global _retriever
    if _retriever is None:
        from rag.retriever import Retriever
        _retriever = Retriever(provider=provider)
    return _retriever


def load_full_text(doc_id: str) -> Optional[str]:
    """Load full document text from disk."""
    # Prevent directory traversal
    if ".." in doc_id or doc_id.startswith("/"):
        return None
    doc_path = CASES_PARSED_DIR / doc_id
    try:
        return doc_path.read_text(encoding="utf-8")
    except (FileNotFoundError, OSError):
        return None


@app.get("/search")
async def search(
    query: str = Query(..., description="Search query"),
    court: str = Query(None, description="Filter by court ID"),
    year_from: int = Query(None, description="Filter: cases from this year"),
    year_to: int = Query(None, description="Filter: cases up to this year"),
    n_results: int = Query(20, description="Number of chunk results to fetch"),
    max_documents: int = Query(30, description="Max unique documents to return"),
):
    """Search court cases — returns metadata only, no full text.

    1. Searches ChromaDB for relevant chunks (n_results)
    2. Groups chunks by document, ranks by best chunk score
    3. Returns top unique documents with metadata
    """
    retriever = get_retriever()

    try:
        results = retriever.search(
            query=query,
            n_results=n_results,
            court=court,
            year_from=year_from,
            year_to=year_to,
        )
    except ValueError:
        logger.warning("Year filter failed (string field), retrying without year filter")
        results = retriever.search(
            query=query,
            n_results=n_results,
            court=court,
        )
        if year_from or year_to:
            filtered = []
            for r in results:
                try:
                    y = int(r.year)
                except (ValueError, TypeError):
                    filtered.append(r)
                    continue
                if year_from and y < year_from:
                    continue
                if year_to and y > year_to:
                    continue
                filtered.append(r)
            results = filtered

    # Group by document, keep best score per document
    doc_map: dict[str, dict] = {}
    for r in results:
        if r.doc_id not in doc_map:
            doc_map[r.doc_id] = {
                "doc_id": r.doc_id,
                "title": r.title,
                "court": r.court,
                "year": r.year,
                "score": r.score,
                "chunk_count": 1,
            }
        else:
            doc_map[r.doc_id]["chunk_count"] += 1
            if r.score > doc_map[r.doc_id]["score"]:
                doc_map[r.doc_id]["score"] = r.score

    # Sort by score, take top max_documents
    docs = sorted(doc_map.values(), key=lambda d: d["score"], reverse=True)[:max_documents]

    logger.info(
        "Search: query=%r → %d chunks → %d unique docs",
        query[:60], len(results), len(docs),
    )

    return docs


@app.get("/document")
async def get_document(
    doc_id: str = Query(..., description="Document ID (relative path)"),
):
    """Fetch full text of a single document by doc_id."""
    text = load_full_text(doc_id)
    if text is None:
        raise HTTPException(status_code=404, detail=f"Document not found: {doc_id}")

    return {
        "doc_id": doc_id,
        "text": text,
        "text_length": len(text),
    }


@app.get("/health")
async def health():
    retriever = get_retriever()
    return {"status": "ok", "provider": retriever._backend.name}


def main():
    parser = argparse.ArgumentParser(description="Search API server for local dev")
    parser.add_argument("--port", type=int, default=8100)
    parser.add_argument("--provider", type=str, default=None, help="local or openai")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    if args.provider:
        os.environ["EMBEDDING_PROVIDER"] = args.provider

    logger.info("Loading retriever (this may take a moment)...")
    get_retriever(args.provider)
    logger.info("Retriever loaded. Starting server on port %d", args.port)

    uvicorn.run(app, host="0.0.0.0", port=args.port, log_level="info")


if __name__ == "__main__":
    main()
