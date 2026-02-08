# Architecture Decisions

| Date | Topic | Decision | Rationale |
|------|-------|----------|-----------|
| 2026-02-07 | Embedding model | OpenAI `text-embedding-3-small` (1536 dims) | Best balance of cost ($0.01/1M tokens via Batch API), quality for Greek/English legal text, and Vectorize compatibility (max 1536 dims). `text-embedding-3-large` (3072 dims) showed 2x better cross-lingual matching but exceeds Vectorize dimension limit. |
| 2026-02-07 | Vector database | Cloudflare Vectorize (`cylaw-search` index) | Native Cloudflare integration (Worker bindings), no external infra, cosine similarity, metadata filtering. Replaced local ChromaDB which couldn't be used in production Workers environment. |
| 2026-02-07 | Ingestion method | OpenAI Batch API (`scripts/batch_ingest.py`) | 50% cheaper than synchronous API ($0.01 vs $0.02 per 1M tokens). Separate rate limits — no TPM throttling that plagued synchronous ingestion (~60 ch/s). Full 2.27M chunk ingestion completed in ~2 hours vs projected 5+ hours synchronous. |
| 2026-02-07 | Vectorize index name | `cylaw-search` (not `cylaw-cases`) | Created during iterative development. Index is PRODUCTION — do not rename or recreate. |
| 2026-02-07 | Vector ID hashing | MD5 truncation for IDs >64 bytes | Vectorize enforces 64-byte max on vector IDs. Long doc_ids (e.g., deeply nested court paths) are hashed: `md5(doc_id)[:16] + "::" + chunk_index`. Full `doc_id` preserved in metadata for retrieval. |
| 2026-02-07 | ChromaDB status | Legacy / dev-only | ChromaDB (`chromadb_local`, `chromadb_openai`) contains vectors from original 9 courts only. Not updated with 6 new courts. Kept for offline local development but not used in production. |
| 2026-02-07 | Document storage | Cloudflare R2 (`cyprus-case-law-docs`) | Zero egress costs, native Worker binding, 149,886 .md files. Dev uses S3 HTTP API (real bucket), prod uses Worker binding. |
| 2026-02-07 | Frontend framework | Next.js 16 on Cloudflare Workers via @opennextjs/cloudflare | Server-side rendering, API routes co-located with frontend, native Cloudflare bindings (R2, Vectorize). |
| 2026-02-07 | Auth | Cloudflare Zero Trust (email OTP) | No custom auth code needed. Replaced password-based auth. |
