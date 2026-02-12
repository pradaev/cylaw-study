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

## Backend Comparison (2026-02-10)

Ground-truth query: αλλοδαπό δίκαιο, περιουσιακές διαφορές, διαζύγιο (foreign law, property disputes, divorce).

| Backend | A (4 key) | B (6 related) | Total sources |
|---------|-----------|----------------|---------------|
| Vectorize | 3–4/4 | 5/6 | 50–64 |
| Weaviate (hybrid) | 0/4 | 0/6 | 9–12 |

**Vectorize wins** on this test query. Weaviate (document-level + hybrid) returns different docs — may need tuning (alpha, content weighting) or reflects chunk vs document granularity tradeoff.
