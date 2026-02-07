"""Minimal search API server for local development.

Wraps the existing Retriever and exposes a single /search endpoint
that the Next.js frontend can call during local dev.

Usage:
    python -m rag.search_server
    python -m rag.search_server --port 8100 --provider local
"""

import argparse
import json
import logging
import os

from dotenv import load_dotenv
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import uvicorn

load_dotenv()

logger = logging.getLogger(__name__)

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


@app.get("/search")
async def search(
    query: str = Query(..., description="Search query"),
    court: str = Query(None, description="Filter by court ID"),
    year_from: int = Query(None, description="Filter: cases from this year"),
    year_to: int = Query(None, description="Filter: cases up to this year"),
    n_results: int = Query(10, description="Number of results"),
):
    """Search court cases by semantic similarity."""
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
        # ChromaDB $gte/$lte fail on string 'year' field — retry without year filters
        logger.warning("Year filter failed (string field), retrying without year filter")
        results = retriever.search(
            query=query,
            n_results=n_results,
            court=court,
        )
        # Manual year filtering on results
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

    return [
        {
            "doc_id": r.doc_id,
            "title": r.title,
            "court": r.court,
            "year": r.year,
            "text": r.text,
            "score": r.score,
        }
        for r in results
    ]


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

    # Pre-set provider if specified
    if args.provider:
        os.environ["EMBEDDING_PROVIDER"] = args.provider

    # Pre-load retriever
    logger.info("Loading retriever (this may take a moment)...")
    get_retriever(args.provider)
    logger.info("Retriever loaded. Starting server on port %d", args.port)

    uvicorn.run(app, host="0.0.0.0", port=args.port, log_level="info")


if __name__ == "__main__":
    main()
