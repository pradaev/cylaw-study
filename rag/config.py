"""Embedding configuration for the RAG pipeline.

Two independent embedding backends with separate databases:

    local   — intfloat/multilingual-e5-large (1024 dims, 512 tokens, free)
    openai  — text-embedding-3-small (1536 dims, 8192 tokens, $0.02/1M tok)

Set EMBEDDING_PROVIDER env var or pass --provider to CLI to switch.
Each provider has its own ChromaDB directory and progress file, so
both can be indexed in parallel without conflicts.
"""

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class EmbeddingBackend:
    """Configuration for one embedding provider."""

    name: str
    model: str
    dimensions: int
    max_seq_length: int
    chromadb_dir: str
    progress_file: str
    collection_name: str


LOCAL = EmbeddingBackend(
    name="local",
    model="paraphrase-multilingual-mpnet-base-v2",
    dimensions=768,
    max_seq_length=128,
    chromadb_dir="data/chromadb_local",
    progress_file="data/embed_progress_local.json",
    collection_name="cylaw_local",
)

OPENAI = EmbeddingBackend(
    name="openai",
    model="text-embedding-3-small",
    dimensions=1536,
    max_seq_length=8192,
    chromadb_dir="data/chromadb_openai",
    progress_file="data/embed_progress_openai.json",
    collection_name="cylaw_openai",
)

# Which backend the web app uses for search (env var or default)
ACTIVE_PROVIDER = os.environ.get("EMBEDDING_PROVIDER", "local")


def get_backend(provider: str = None) -> EmbeddingBackend:
    """Get backend config by name. Defaults to ACTIVE_PROVIDER."""
    name = provider or ACTIVE_PROVIDER
    if name == "local":
        return LOCAL
    elif name == "openai":
        return OPENAI
    raise ValueError(f"Unknown provider '{name}'. Use 'local' or 'openai'.")
