"""Embed text chunks and store in ChromaDB.

Supports both local (sentence-transformers) and OpenAI backends.
Each backend writes to its own ChromaDB directory.
"""

import json
import logging
import os
import time
from pathlib import Path

import chromadb

from rag.chunker import Chunk
from rag.config import EmbeddingBackend, get_backend

logger = logging.getLogger(__name__)


class Embedder:
    """Embeds chunks and stores them in ChromaDB."""

    def __init__(self, provider: str = None):
        self._backend: EmbeddingBackend = get_backend(provider)
        self._progress_file = Path(self._backend.progress_file)

        # Initialize embedding engine
        if self._backend.name == "local":
            from sentence_transformers import SentenceTransformer

            logger.info("Loading local model: %s", self._backend.model)
            self._model = SentenceTransformer(self._backend.model)
        else:
            from openai import OpenAI

            api_key = os.environ.get("OPENAI_API_KEY")
            if not api_key:
                raise ValueError("OPENAI_API_KEY required.")
            self._openai_client = OpenAI(api_key=api_key)

        # Initialize ChromaDB
        os.makedirs(self._backend.chromadb_dir, exist_ok=True)
        self._chroma = chromadb.PersistentClient(path=self._backend.chromadb_dir)
        self._collection = self._chroma.get_or_create_collection(
            name=self._backend.collection_name,
            metadata={"hnsw:space": "cosine"},
        )

        self._progress = self._load_progress()

    @property
    def backend(self) -> EmbeddingBackend:
        return self._backend

    # ── Progress tracking ──────────────────────────────────────────

    def _load_progress(self) -> dict:
        if self._progress_file.exists():
            return json.loads(self._progress_file.read_text())
        return {"embedded_docs": [], "total_chunks": 0}

    def _save_progress(self) -> None:
        self._progress_file.parent.mkdir(parents=True, exist_ok=True)
        self._progress_file.write_text(
            json.dumps(self._progress, ensure_ascii=False)
        )

    def get_done_docs(self) -> set[str]:
        return set(self._progress.get("embedded_docs", []))

    def mark_docs_done(self, doc_ids: list[str], chunk_count: int) -> None:
        self._progress.setdefault("embedded_docs", []).extend(doc_ids)
        self._progress["total_chunks"] = (
            self._progress.get("total_chunks", 0) + chunk_count
        )
        self._save_progress()

    # ── Embedding ──────────────────────────────────────────────────

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        """Embed a batch of texts using the configured backend."""
        if self._backend.name == "local":
            return self._embed_local(texts)
        else:
            return self._embed_openai(texts)

    def _embed_local(self, texts: list[str]) -> list[list[float]]:
        embeddings = self._model.encode(
            texts, batch_size=1024,
            show_progress_bar=False, normalize_embeddings=True,
        )
        return embeddings.tolist()

    def _embed_openai(self, texts: list[str]) -> list[list[float]]:
        for attempt in range(5):
            try:
                resp = self._openai_client.embeddings.with_raw_response.create(
                    model=self._backend.model,
                    input=texts,
                )
                # Parse rate limit headers for pacing
                remaining_tokens = int(
                    resp.headers.get("x-ratelimit-remaining-tokens", "999999")
                )
                reset_secs = _parse_reset(
                    resp.headers.get("x-ratelimit-reset-tokens", "0s")
                )

                parsed = resp.parse()
                embeddings = [item.embedding for item in parsed.data]

                # If we've used most of the token budget, wait for reset
                if remaining_tokens < 100_000 and reset_secs > 0:
                    logger.info(
                        "Pacing: %d tokens remaining, waiting %.1fs",
                        remaining_tokens, reset_secs,
                    )
                    time.sleep(reset_secs)

                return embeddings

            except Exception as exc:
                wait = min(2 ** attempt, 30)
                logger.warning(
                    "API error (attempt %d/5), retry in %ds: %s",
                    attempt + 1, wait, str(exc)[:100],
                )
                time.sleep(wait)
        raise RuntimeError("Failed to embed after 5 retries")

    # ── Store ──────────────────────────────────────────────────────

    def store_batch(self, texts: list[str], chunks: list[Chunk]) -> None:
        """Embed and store a batch in ChromaDB."""
        embeddings = self.embed_batch(texts)

        self._collection.add(
            ids=[f"{c.doc_id}::{c.chunk_index}" for c in chunks],
            embeddings=embeddings,
            metadatas=[
                {
                    "doc_id": c.doc_id,
                    "title": c.title[:500],
                    "court": c.court,
                    "year": c.year,
                    "chunk_index": c.chunk_index,
                }
                for c in chunks
            ],
            documents=texts,
        )

    def get_stats(self) -> dict:
        count = self._collection.count()
        progress = self._load_progress()
        return {
            "provider": self._backend.name,
            "model": self._backend.model,
            "dimensions": self._backend.dimensions,
            "total_chunks": count,
            "documents": len(progress.get("embedded_docs", [])),
            "chromadb_dir": self._backend.chromadb_dir,
        }


def _parse_reset(value: str) -> float:
    """Parse x-ratelimit-reset-tokens like '44.169s' or '1m30s'."""
    import re

    total = 0.0
    m = re.search(r"([\d.]+)m", value)
    if m:
        total += float(m.group(1)) * 60
    m = re.search(r"([\d.]+)s", value)
    if m:
        total += float(m.group(1))
    return total
