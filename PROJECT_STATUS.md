# Project Status

> This file is the single source of truth for agent continuity.
> **Read this first** at the start of every session.
> **Update this last** before committing at the end of every session.

## Architecture

```
User -> Next.js (Cloudflare Worker) -> API Routes
            |
            +-- /api/chat (POST, SSE streaming)
            |     Main LLM (GPT-4o / Claude) with two tools:
            |       1. search_cases -> Cloudflare Vectorize (PRODUCTION)
            |       2. summarize_documents -> R2 full text -> parallel GPT-4o agents
            |
            +-- /api/doc (GET)
                  Document viewer -> R2 bucket (149,886 .md files)
```

- **Document storage**: Cloudflare R2 bucket `cyprus-case-law-docs` (149,886 parsed .md files)
- **Document fetch in dev**: S3 HTTP API to real R2 (`r2FetchViaS3` in `frontend/app/api/chat/route.ts`)
- **Document fetch in prod**: R2 Worker binding (`r2FetchViaBinding`)
- **Vector search**: Cloudflare Vectorize index `cylaw-search` (PRODUCTION — see warning below)
- **Search in dev**: Python server (`rag/search_server.py`) -> local ChromaDB (legacy, for offline dev)
- **Auth**: Cloudflare Zero Trust (email OTP)

### PRODUCTION WARNING — Vectorize Index

> **Index name:** `cylaw-search`
> **Status:** PRODUCTION — contains ~2.27M vectors from all 15 courts
> **DO NOT** delete, drop, or recreate this index.
> **DO NOT** run `wrangler vectorize delete cylaw-search`.
> Recreating it requires re-running the full batch embedding pipeline (~$15 OpenAI cost, ~2 hours).
> If you need to test, create a separate index (e.g., `cylaw-search-dev`).

### Vectorize Index Details

| Property | Value |
|----------|-------|
| Index name | `cylaw-search` |
| Dimensions | 1536 |
| Metric | cosine |
| Embedding model | OpenAI `text-embedding-3-small` |
| Total vectors | ~2,269,231 (all 15 courts, all chunks) |
| Vector ID format | `{doc_id}::{chunk_index}` (hashed via MD5 if >64 bytes) |
| Metadata fields | `doc_id`, `court`, `year`, `title`, `chunk_index` |
| Created | 2026-02-07 |

## What Works Now

- **Chat UI** — Perplexity-style, SSE streaming, multi-model (GPT-4o, o3-mini, Claude Sonnet 4) — `frontend/app/page.tsx`
- **Multi-agent summarizer** — parallel GPT-4o agents analyze up to 10 full court docs per query — `frontend/lib/llm-client.ts`
- **Document viewer** — click any case to read full text with AI summary panel — `frontend/app/api/doc/route.ts`
- **R2 integration** — all 149,886 docs in R2, fetched in both dev (S3 API) and prod (binding) — `frontend/app/api/chat/route.ts`
- **Vectorize populated** — all 15 courts embedded via OpenAI Batch API, ~2.27M vectors in `cylaw-search` index — `scripts/batch_ingest.py`
- **Data pipeline** — scrape, download, parse, chunk, embed for all 15 courts — `scraper/`, `rag/`, `scripts/`
- **Local search (legacy)** — ChromaDB with ~2.3M chunks (original 9 courts) — `rag/search_server.py`
- **Production deployment** — https://cyprus-case-law.cylaw-study.workers.dev — `frontend/wrangler.jsonc`
- **Cost tracking** — per-request token/cost display in UI — `frontend/components/ChatArea.tsx`
- **Cloudflare secrets** — OPENAI_API_KEY, ANTHROPIC_API_KEY set via `wrangler secret put`

## What's Next

### High Priority

1. **Wire Vectorize into frontend** — production search is currently a stub
   - Write `frontend/lib/retriever.ts` (query Vectorize, embed query via OpenAI)
   - Wire retriever into `frontend/app/api/chat/route.ts` replacing `stubSearchFn`
   - Add Vectorize binding to `frontend/wrangler.jsonc` (currently commented out)
   - Re-deploy

### Medium Priority

2. Evaluate embedding upgrade — text-embedding-3-large (3072 dims) showed 2x better Greek-English matching (0.498 vs 0.216) but needs Pinecone/Qdrant (Vectorize max 1536 dims); cost ~$2,400
3. Add subcategory metadata for First Instance courts (pol/poin/oik/enoik/erg) to enable Family Court filtering
4. Persistent summary cache — avoid re-summarizing the same doc for the same query
5. Server-side conversation history for session persistence
6. Hybrid search: vector similarity + keyword matching (BM25)
7. Evaluate Claude Sonnet 4 as summarizer (may handle Greek legal text better)

### Low Priority

8. Legislation integration — download/index 64,477 legislative acts from cylaw.org
9. CI/CD pipeline (GitHub Actions -> Cloudflare deploy)
10. Automated daily scrape of updates.html for new cases
11. Cross-reference graph analysis
12. Query analytics dashboard

## Gotchas for Future Agents

- **Vectorize index is PRODUCTION** — `cylaw-search` contains ~2.27M vectors. Do NOT delete. See warning above.
- `initOpenNextCloudflareForDev()` in `next.config.ts` creates a **local miniflare R2 emulator** which is EMPTY — that's why `r2FetchViaBinding` returns null in dev. Use `r2FetchViaS3` instead (calls real R2 over HTTPS).
- R2 credentials (`CLOUDFLARE_R2_ACCESS_KEY_ID`, `CLOUDFLARE_R2_SECRET_ACCESS_KEY`) must be in `frontend/.env.local` for dev S3 API access.
- `extractDecisionText()` in `llm-client.ts` truncates docs > 80K chars: 35% head + 65% tail. For large criminal cases (~300K chars), the middle (often witness testimony sections) is dropped.
- Python search server (`rag/search_server.py`) is only needed in dev for `search_cases`. Without it, chat still works for general questions and document viewing — just no case search.
- Port 3000 is often taken by Docker. Next.js dev server usually runs on 3001.
- HTML files from cylaw.org use ISO-8859-7 / Windows-1253 encoding (Greek).
- **Vector ID length limit**: Vectorize max is 64 bytes. Long doc_ids are hashed via MD5 (first 16 hex chars). The `make_vector_id()` helper handles this — used in `batch_ingest.py`, `ingest_to_vectorize.py`, `export_to_vectorize.py`, and `migrate_to_cloudflare.py`.
- **ChromaDB is legacy** — `chromadb_local` and `chromadb_openai` contain vectors from original 9 courts only. Not all 15 courts. Use Vectorize for production search.
- **Batch data** — `data/batch_embed/` contains OpenAI Batch API state, metadata index, and batch JSONL files. Safe to delete after successful ingestion (can be recreated with `batch_ingest.py prepare`).

## Ingestion Scripts

| Script | Purpose | Status |
|--------|---------|--------|
| `scripts/batch_ingest.py` | **PRIMARY** — OpenAI Batch API -> Vectorize (parallel, 50% cheaper) | Production |
| `scripts/ingest_to_vectorize.py` | Synchronous OpenAI API -> Vectorize (slower, rate-limited) | Legacy |
| `scripts/export_to_vectorize.py` | Export ChromaDB vectors -> Vectorize (no re-embedding) | Legacy |
| `rag/migrate_to_cloudflare.py` | Migrate ChromaDB -> Vectorize | Legacy |
| `rag/ingest.py` | Chunk + embed -> ChromaDB (local/OpenAI) | Legacy/Dev |

## Last Session Log

### 2026-02-07 (evening session — Vectorize ingestion)
- Analyzed existing ingestion scripts (`ingest_to_vectorize.py`, `migrate_to_cloudflare.py`)
- Ran test ingestion of 1000 docs into Vectorize — confirmed pipeline works
- Started full ingestion with `ingest_to_vectorize.py` — hit rate limiting issues (~60 ch/s)
- Optimized: implemented TokenBucket rate limiter, adjusted batch sizes, measured actual tokens/chunk (~1300)
- Fixed vector ID length errors (>64 bytes) — implemented `make_vector_id()` with MD5 hashing across all scripts
- Speed still too slow (~5 hours projected) — switched to **OpenAI Batch API**
- Created `scripts/batch_ingest.py` — 3-step pipeline: prepare (chunk+JSONL), submit (Batch API), collect (download+upload)
- Prepared 46 batches (2,269,231 chunks), submitted all to OpenAI Batch API
- All 46 batches completed successfully (1 request failed out of ~23,000)
- Rewrote `step_collect` with parallel downloads (2 threads) and parallel Vectorize uploads (6 threads) for ~6x speedup
- Marked Vectorize index `cylaw-search` as PRODUCTION in documentation

### 2026-02-07 (afternoon session)
- Analyzed HTML structure of court cases for separating witness testimony from court reasoning
- Added R2 document fetching to chat route (`r2FetchViaBinding` for prod, `r2FetchViaS3` for dev)
- Deployed Phase 1 to Cloudflare Workers, set secrets (OPENAI_API_KEY, ANTHROPIC_API_KEY)
- Updated README.md with current architecture, status table, deployment instructions

### 2026-02-07 (morning session)
- Next.js frontend rewrite, React chat UI, multi-agent summarization, cost tracking
- Scraped and parsed all 6 remaining courts (86,630 cases), total 149,886 files
- R2 bucket upload, Cloudflare Workers deployment
