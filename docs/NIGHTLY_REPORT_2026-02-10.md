# Nightly Report — 2026-02-10

## Weaviate Full Ingest

**Status: COMPLETE**

| Metric | Value |
|--------|-------|
| Documents ingested | 149,886 |
| Batches (50 docs each) | 2,998 |
| Embed+Upsert phase | ~2h 19m |
| Embedding model | text-embedding-3-large (3072d) |

The ingest process ran in background (`nohup`) and finished successfully. Final log line:

```
INFO:__main__:Done. Ingested 149886 documents to Weaviate
```

## Weaviate Status

- **Service**: Running (Docker)
- **Schema**: CourtCase class present
- **Vectorizer**: none (bring your own vectors)
- **Content**: document-level (ΝΟΜΙΚΗ ΠΤΥΧΗ → conclusion, max 3500 chars)

## Frontend Config

`.env.local` updated with:
- `WEAVIATE_URL=http://localhost:8080`
- `SEARCH_BACKEND=weaviate`

With this config, the chat API uses Weaviate (document-level, 3072d) instead of Vectorize (chunk-level, 1536d).

## Next Steps

1. **Smoke test** — Run `cd frontend && npm run dev`, send a query, verify search hits Weaviate
2. **Compare quality** — Same query on Vectorize vs Weaviate; compare hit rate
3. **Hybrid BM25** — Optional: add text2vec-openai to schema for keyword + vector search
