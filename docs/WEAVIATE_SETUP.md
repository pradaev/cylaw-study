# Weaviate Local Setup

## Quick Start

1. **Start Weaviate**
   ```bash
   docker compose up -d
   ```

2. **Create schema**
   ```bash
   python3 scripts/weaviate_schema.py
   ```

3. **Ingest documents** (runs ~10+ hours for full 150K corpus)
   ```bash
   python3 scripts/ingest_to_weaviate.py
   ```
   Progress: `tail -f data/weaviate_ingest.log`

4. **Configure frontend** (`frontend/.env.local`)
   ```
   WEAVIATE_URL=http://localhost:8080
   SEARCH_BACKEND=weaviate
   ```

5. **Run frontend**
   ```bash
   cd frontend && npm run dev
   ```

## Differences from Vectorize

| Aspect | Vectorize (default) | Weaviate |
|--------|---------------------|----------|
| Embedding | text-embedding-3-small (1536d) | text-embedding-3-large (3072d) |
| Granularity | Chunk-level | Document-level |
| Content | Chunks with headers | ΝΟΜΙΚΗ ΠΤΥΧΗ → conclusion |
| Search | Vector only | Hybrid (vector + BM25 keyword) |

## Hybrid search

Weaviate uses hybrid search: vector (semantic) + BM25 (keyword on content/title). Alpha=0.7 favors vector slightly.

## Quality comparison

```bash
# Start dev server first
cd frontend && npm run dev

# In another terminal
node scripts/compare_search_backends.mjs
```

Compares ground-truth hit rate for Vectorize vs Weaviate.
