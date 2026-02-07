"""Semantic search over the ChromaDB vector store.

Uses the same embedding backend as configured in rag.config.
"""

import logging
import os
from dataclasses import dataclass, field
from typing import Optional

import chromadb

from rag.config import EmbeddingBackend, get_backend

logger = logging.getLogger(__name__)


@dataclass
class SearchResult:
    doc_id: str
    title: str
    court: str
    year: str
    chunk_index: int
    text: str
    distance: float
    score: float


@dataclass
class GroupedResult:
    doc_id: str
    title: str
    court: str
    year: str
    best_score: float
    chunks: list[SearchResult] = field(default_factory=list)


class Retriever:
    """Semantic search using the configured embedding backend."""

    def __init__(self, provider: str = None):
        self._backend: EmbeddingBackend = get_backend(provider)

        if self._backend.name == "local":
            from sentence_transformers import SentenceTransformer

            self._model = SentenceTransformer(self._backend.model)
        else:
            from openai import OpenAI

            api_key = os.environ.get("OPENAI_API_KEY")
            if not api_key:
                raise ValueError("OPENAI_API_KEY required.")
            self._openai = OpenAI(api_key=api_key)

        self._chroma = chromadb.PersistentClient(path=self._backend.chromadb_dir)
        self._collection = self._chroma.get_collection(
            name=self._backend.collection_name
        )
        logger.info(
            "Retriever ready (%s, %s). %d chunks.",
            self._backend.name, self._backend.model,
            self._collection.count(),
        )

    def _embed_query(self, query: str) -> list[float]:
        if self._backend.name == "local":
            emb = self._model.encode(
                [query], normalize_embeddings=True
            )
            return emb[0].tolist()
        else:
            resp = self._openai.embeddings.create(
                model=self._backend.model, input=[query],
            )
            return resp.data[0].embedding

    def search(
        self,
        query: str,
        n_results: int = 10,
        court: Optional[str] = None,
        year_from: Optional[int] = None,
        year_to: Optional[int] = None,
    ) -> list[SearchResult]:
        query_emb = self._embed_query(query)
        where = self._build_filter(court, year_from, year_to)

        results = self._collection.query(
            query_embeddings=[query_emb],
            n_results=n_results,
            where=where,
            include=["documents", "metadatas", "distances"],
        )

        out: list[SearchResult] = []
        if not results["ids"] or not results["ids"][0]:
            return out

        for i, _ in enumerate(results["ids"][0]):
            meta = results["metadatas"][0][i]
            dist = results["distances"][0][i]
            score = max(0, (1 - dist) * 100)
            out.append(SearchResult(
                doc_id=meta.get("doc_id", ""),
                title=meta.get("title", ""),
                court=meta.get("court", ""),
                year=meta.get("year", ""),
                chunk_index=meta.get("chunk_index", 0),
                text=results["documents"][0][i],
                distance=dist,
                score=round(score, 1),
            ))
        return out

    def search_grouped(
        self,
        query: str,
        n_results: int = 20,
        max_docs: int = 5,
        court: Optional[str] = None,
        year_from: Optional[int] = None,
        year_to: Optional[int] = None,
    ) -> list[GroupedResult]:
        results = self.search(
            query, n_results=n_results, court=court,
            year_from=year_from, year_to=year_to,
        )
        groups: dict[str, GroupedResult] = {}
        for r in results:
            if r.doc_id not in groups:
                groups[r.doc_id] = GroupedResult(
                    doc_id=r.doc_id, title=r.title, court=r.court,
                    year=r.year, best_score=r.score, chunks=[r],
                )
            else:
                g = groups[r.doc_id]
                g.chunks.append(r)
                if r.score > g.best_score:
                    g.best_score = r.score

        return sorted(groups.values(), key=lambda g: g.best_score, reverse=True)[:max_docs]

    @staticmethod
    def _build_filter(court, year_from, year_to):
        conds = []
        if court:
            conds.append({"court": {"$eq": court}})
        if year_from:
            conds.append({"year": {"$gte": str(year_from)}})
        if year_to:
            conds.append({"year": {"$lte": str(year_to)}})
        if not conds:
            return None
        return conds[0] if len(conds) == 1 else {"$and": conds}
