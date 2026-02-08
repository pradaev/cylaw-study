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
            |     Structured JSON logging -> Workers Logs (Cloudflare Dashboard)
            |
            +-- /api/doc (GET)
                  Document viewer -> R2 bucket (149,886 .md files)
```

- **Document storage**: Cloudflare R2 bucket `cyprus-case-law-docs` (149,886 parsed .md files)
- **Document fetch in dev**: S3 HTTP API to real R2 (`r2FetchViaS3` in `frontend/app/api/chat/route.ts`)
- **Document fetch in prod**: R2 Worker binding (`r2FetchViaBinding`)
- **Vector search**: Cloudflare Vectorize index `cyprus-law-cases-search` (PRODUCTION)
- **Search in dev**: Same Vectorize index via Cloudflare REST API (`frontend/lib/vectorize-client.ts`)
- **Search in prod**: Vectorize Worker binding (zero-latency, no auth needed)
- **Search abstraction**: `VectorizeClient` interface — single search codebase for dev and prod
- **Observability**: Workers Logs with structured JSON logging, session tracking (`sessionId`)
- **Auth**: Cloudflare Zero Trust (email OTP)

### PRODUCTION WARNING — Vectorize Index

> **Index name:** `cyprus-law-cases-search`
> **Status:** PRODUCTION — contains ~2.27M vectors from all 15 courts
> **DO NOT** delete, drop, or recreate this index.
> Recreating requires re-running the batch embedding pipeline (~$15 OpenAI cost, ~40 min).
> Old index `cylaw-search` is deprecated (stuck mutation queue, no metadata indexes).

### Vectorize Index Details

| Property | Value |
|----------|-------|
| Index name | `cyprus-law-cases-search` |
| Dimensions | 1536 |
| Metric | cosine |
| Embedding model | OpenAI `text-embedding-3-small` |
| Total vectors | ~2,269,231 (all 15 courts, all chunks) |
| Vector ID format | `{doc_id}::{chunk_index}` (hashed via MD5 if >64 bytes) |
| Metadata fields | `doc_id`, `court`, `year`, `title`, `chunk_index`, `court_level`, `subcourt` |
| Metadata indexes | `year` (string), `court` (string), `court_level` (string), `subcourt` (string) |
| Created | 2026-02-08 |

### Metadata Index Values

**`court_level`** — hierarchical court classification:
- `supreme` — aad, supreme, supremeAdministrative, areiospagos, jsc, rscc, clr
- `appeal` — courtOfAppeal, administrativeCourtOfAppeal
- `first_instance` — apofaseised, juvenileCourt
- `administrative` — administrative, administrativeIP
- `other` — epa, aap

**`subcourt`** — First Instance subcategories (only for `apofaseised`):
- `pol` (civil), `poin` (criminal), `oik` (family), `enoik` (rental), `erg` (labor)

## What Works Now

- **Chat UI** — Perplexity-style, SSE streaming, multi-model (GPT-4o, o3-mini, Claude Sonnet 4) — `frontend/app/page.tsx`
- **Multi-agent summarizer** — parallel GPT-4o agents analyze ALL found documents (no limit) — `frontend/lib/llm-client.ts`
- **Auto-summarization** — LLM's doc_id selection overridden; system always summarizes ALL documents from search results
- **Document viewer** — click any case to read full text with AI summary panel — `frontend/app/api/doc/route.ts`
- **R2 integration** — all 149,886 docs in R2, fetched in both dev (S3 API) and prod (binding)
- **Vectorize search** — unified client for dev (REST API) and prod (binding), up to 30 unique docs per search, year filtering — `frontend/lib/retriever.ts`
- **Metadata filtering** — Vectorize indexes for `year`, `court`, `court_level`, `subcourt` — enables court-level prioritization
- **Sources UI** — expandable source cards with inline AI summary, sorted by relevance then year — `frontend/components/SourceCard.tsx`
- **Structured logging** — JSON logs with sessionId, search queries, costs, errors → Cloudflare Workers Logs
- **Test suite** — `npm test` runs typecheck + lint + search regression (14 assertions) + summarizer eval (28 assertions)
- **Pre-commit hook** — TypeScript + ESLint check on every commit — `.githooks/pre-commit`
- **Data pipeline** — scrape, download, parse, chunk, embed for all 15 courts — `scraper/`, `rag/`, `scripts/`
- **Cost tracking** — per-request token/cost display in UI — `frontend/components/ChatArea.tsx`
- **Production deployment** — https://cyprus-case-law.cylaw-study.workers.dev

## What's Next

### High Priority

1. **Re-deploy to production** — new Vectorize index, logging, UI changes need `wrangler deploy`
2. **Implement contextual header prepend** (Improvement 2) — prepend court/case metadata to chunks before embedding, reduces retrieval failures by 49% (see Chunking Improvements section below)

### Medium Priority

3. Evaluate embedding upgrade — text-embedding-3-large (3072 dims), needs Pinecone/Qdrant; cost ~$2,400
4. Persistent summary cache — avoid re-summarizing the same doc for the same query
5. Server-side conversation history for session persistence
6. Hybrid search: vector similarity + keyword matching (BM25)
7. Evaluate Claude Sonnet 4 as summarizer (may handle Greek legal text better)

### Low Priority

8. Legislation integration — download/index 64,477 legislative acts from cylaw.org
9. CI/CD pipeline (GitHub Actions -> Cloudflare deploy)
10. Automated daily scrape of updates.html for new cases
11. Cross-reference graph analysis
12. Query analytics dashboard (leverage structured logs)

### Post-Launch: Chunking & Retrieval Quality Improvements

> All changes require re-embedding (~2.27M chunks, ~$15 via Batch API, ~40 min).
> Do ALL improvements in one batch, then re-ingest with `batch_ingest.py`.

See detailed analysis in the previous session's research. Key improvements:

1. **Strip references section** — remove ΑΝΑΦΟΡΕΣ noise from first chunks
2. **Contextual header prepend** — add `[Court | Case | Year]` to each chunk before embedding (49-67% retrieval improvement per Anthropic research)
3. **Merge small tail chunks** — merge fragments < 500 chars with previous chunk

## Test Suite

```
tests/
  run.mjs               # unified runner for all tests
  search.test.mjs       # search regression (14 assertions): document retrieval, year filtering, dedup, quality
  summarizer.test.mjs   # summarizer eval (28 assertions): engagement levels, relevance, fabrication detection
```

| Command | What | When |
|---------|------|------|
| `npm test` (from `frontend/`) | All: typecheck + lint + search + summarizer | Before deploy |
| `npm run test:fast` | Typecheck + lint only (free, 3s) | After every change |
| `npm run test:integration` | API tests with verbose (~$0.25, 30s) | Search/summarizer changes |

Pre-commit hook (`.githooks/pre-commit`) auto-runs TypeScript + ESLint.

## Gotchas for Future Agents

- **Vectorize index is `cyprus-law-cases-search`** — NOT the old `cylaw-search` (deprecated, stuck mutation queue)
- **Old index `cylaw-search`** — still exists but has no metadata indexes and stuck mutations. Do NOT use. Do NOT try to delete (may timeout).
- `initOpenNextCloudflareForDev()` creates a **local miniflare R2 emulator** which is EMPTY — use `r2FetchViaS3` for dev instead
- R2 credentials must be in `frontend/.env.local` for dev S3 API access
- `CLOUDFLARE_API_TOKEN` must be in `frontend/.env.local` for dev Vectorize REST API access
- `extractDecisionText()` truncates docs > 80K chars: 35% head + 65% tail
- **Vectorize topK limit**: `returnMetadata: "all"` limits `topK` to 20. Retriever uses `returnMetadata: "none"` + `getByIds()`.
- **Vectorize REST API `getByIds` limit**: max 20 IDs per request. `createHttpClient()` batches automatically.
- **Vectorize upsert vs insert**: Always use `/upsert` for re-uploads. `/insert` silently skips existing IDs.
- **batch_ingest.py `--index` flag**: Specify target index name (default: `cyprus-law-cases-search`). Use for new indexes.
- Port 3000 is often taken by Docker. Next.js dev server usually runs on 3001.
- HTML files from cylaw.org use ISO-8859-7 / Windows-1253 encoding (Greek).
- **ChromaDB is legacy** — use Vectorize for all search.

## Ingestion Scripts

| Script | Purpose | Status |
|--------|---------|--------|
| `scripts/batch_ingest.py` | **PRIMARY** — OpenAI Batch API -> Vectorize (parallel, 50% cheaper) | Production |
| Commands: `prepare`, `submit`, `status`, `collect`, `reupload`, `full-reset`, `run`, `reset` | |
| `scripts/ingest_to_vectorize.py` | Synchronous OpenAI API -> Vectorize (slower) | Legacy |
| `scripts/export_to_vectorize.py` | Export ChromaDB vectors -> Vectorize | Legacy |

### batch_ingest.py key features:
- `--index NAME` — target Vectorize index (default: `cyprus-law-cases-search`)
- `reupload` — re-download embeddings from OpenAI + re-upload to Vectorize (no new embedding cost)
- `full-reset` — delete index + recreate + create metadata indexes + reupload
- Auto-creates metadata indexes (`year`, `court`, `court_level`, `subcourt`) before uploading
- 10 parallel download threads, 6 parallel upload threads
- Uses `/upsert` endpoint (not `/insert`) to overwrite existing vectors
- Adds `court_level` and `subcourt` metadata computed from `court` and `doc_id`

## Last Session Log

### 2026-02-08 (session 2 — metadata indexes, tests, logging, UI)
- Removed 30-doc limit on summarization — now summarizes ALL found documents (no cap)
- Added year filtering to retriever (post-query filtering on metadata)
- Created Vectorize metadata indexes: `year`, `court`, `court_level`, `subcourt`
- Added `court_level` and `subcourt` fields to `Chunk` dataclass in `rag/chunker.py`
- Updated `batch_ingest.py`: upsert (not insert), `--index` flag, `reupload`, `full-reset`, 10 download threads, auto metadata index creation
- Migrated from old `cylaw-search` index to new `cyprus-law-cases-search` (old index had stuck mutation queue)
- Standardized tests into `tests/` directory with unified runner (`tests/run.mjs`)
- Added `npm test`, `npm run test:fast`, `npm run test:integration` scripts
- Added git pre-commit hook for TypeScript + ESLint
- Deleted 5 legacy one-off test scripts from `scripts/`
- Redesigned Sources UI: expandable cards with inline AI summary, relevance badges (High/Medium/Low), sorted by relevance then year
- Added structured JSON logging: `chat_request`, `search`, `vectorize_search`, `summarize_complete`, `chat_complete` events
- Added session tracking (`sessionId` from client → all logs)
- Enabled Cloudflare Workers Logs (`observability.enabled: true`, 100% sampling)

### 2026-02-08 (session 1 — Vectorize frontend integration)
- Wired Vectorize into frontend, created VectorizeClient abstraction
- Auto-summarization: overrides LLM's doc_id selection

### 2026-02-07 (evening — Vectorize ingestion)
- Created batch_ingest.py, ingested 2.27M vectors via OpenAI Batch API
