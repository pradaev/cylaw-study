# Project Status

> This file is the single source of truth for agent continuity.
> **Read this first** at the start of every session.
> **Update this last** before committing at the end of every session.

## Architecture

```
User -> Next.js (Cloudflare Worker) -> API Routes
            |
            +-- /api/chat (POST, SSE streaming)
            |     Main LLM (GPT-4o / Claude) — single tool: search_cases
            |       search_cases = Vectorize search + R2 fetch + parallel GPT-4o summarization
            |       Returns pre-summarized results (NONE filtered out)
            |       Sorted by court level → relevance → year
            |     Structured JSON logging -> Workers Logs
            |
            +-- /api/doc (GET)
                  Document viewer -> R2 bucket (149,886 .md files)
```

### Summarize-First Pipeline (current)

Each `search_cases` call does everything in one step:
1. Vectorize semantic search → 30 unique docs
2. Fetch full text from R2 for each doc
3. Summarize each doc with GPT-4o (parallel)
4. Parse relevance rating (HIGH/MEDIUM/LOW/NONE)
5. Filter out NONE
6. Sort by: court level (Supreme > Appeal > others) → relevance → year
7. Return formatted summaries to main LLM

LLM makes 3 search calls → each triggers ~30 summarizations → LLM receives only relevant summaries → composes answer. No separate `summarize_documents` tool.

### Key Components

- **Document storage**: Cloudflare R2 bucket `cyprus-case-law-docs` (149,886 parsed .md files)
- **Document fetch in dev**: S3 HTTP API to real R2 (`r2FetchViaS3`)
- **Document fetch in prod**: R2 Worker binding (`r2FetchViaBinding`)
- **Vector search**: Cloudflare Vectorize index `cyprus-law-cases-search`
- **Search in dev**: Vectorize REST API (`frontend/lib/vectorize-client.ts`)
- **Search in prod**: Vectorize Worker binding (zero-latency)
- **Observability**: Workers Logs with structured JSON logging, session tracking (`sessionId`)
- **Auth**: Cloudflare Zero Trust (email OTP)

### PRODUCTION WARNING — Vectorize Index

> **Index name:** `cyprus-law-cases-search`
> **Status:** PRODUCTION — 2,269,131 vectors from all 15 courts
> **DO NOT** delete, drop, or recreate.
> Old index `cylaw-search` is deprecated (stuck mutation queue).

### Vectorize Index Details

| Property | Value |
|----------|-------|
| Index name | `cyprus-law-cases-search` |
| Dimensions | 1536 |
| Metric | cosine |
| Embedding model | OpenAI `text-embedding-3-small` |
| Total vectors | 2,269,131 |
| Metadata fields | `doc_id`, `court`, `year`, `title`, `chunk_index`, `court_level`, `subcourt` |
| Metadata indexes | `year`, `court`, `court_level`, `subcourt` (all string) |

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

- **Summarize-first pipeline** — each search_cases call searches + summarizes + filters in one step — `frontend/lib/llm-client.ts`
- **Chat UI** — Perplexity-style, SSE streaming, multi-model (GPT-4o, o3-mini, Claude Sonnet 4)
- **Sources UI** — expandable source cards with inline AI summary, relevance badges, sorted by court level + relevance + year
- **Document viewer** — click any case to read full text with AI summary panel
- **Deduplication** — doc_ids tracked across searches; second search skips already-summarized docs
- **Court-level sorting** — Supreme Court results sorted above Appeal above First Instance in LLM output
- **NONE filtering** — irrelevant cases filtered before reaching LLM
- **Year filtering** — applied in retriever when LLM passes year_from/year_to
- **Structured logging** — JSON logs with sessionId tracking → Cloudflare Workers Logs
- **Test suite** — fast (typecheck+lint), integration (search+summarizer), E2E (full pipeline)
- **Pre-commit hook** — TypeScript + ESLint
- **Vectorize metadata indexes** — year, court, court_level, subcourt (all populated)
- **Batch ingest pipeline** — with download caching, upsert, full-reset, --index flag
- **Production deployment** — https://cyprus-case-law.cylaw-study.workers.dev

## What's Next

### High Priority

1. **Re-deploy to production** — summarize-first pipeline, UI changes need `wrangler deploy`
2. **Implement contextual header prepend** — prepend `[Court | Case | Year]` to chunks before embedding (49-67% retrieval improvement per Anthropic research)
3. **Reclassify areiospagos** — currently `court_level=supreme` but it's the GREEK Supreme Court, not Cypriot. Its 46K cases dominate Supreme Court results. Move to `court_level=foreign` or separate category.

### Medium Priority

4. Persistent summary cache — avoid re-summarizing the same doc for the same query
5. Server-side conversation history for session persistence
6. Hybrid search: vector similarity + keyword matching (BM25)

### Low Priority

7. Legislation integration — 64,477 legislative acts from cylaw.org
8. CI/CD pipeline (GitHub Actions -> Cloudflare deploy)
9. Automated daily scrape for new cases
10. Query analytics dashboard (leverage structured logs)

### Post-Launch: Chunking Improvements

> All require re-embedding (~2.27M chunks, ~$15, ~40 min). Do ALL in one batch.

1. **Strip references section** — remove ΑΝΑΦΟΡΕΣ noise from first chunks
2. **Contextual header prepend** — `[Court | Case | Year]` before embedding
3. **Merge small tail chunks** — fragments < 500 chars

## Test Suite

```
tests/
  run.mjs               # unified runner
  search.test.mjs       # search regression (14 assertions)
  summarizer.test.mjs   # summarizer eval (28 assertions)
  e2e.test.mjs          # E2E pipeline (4 queries, behavioral assertions)
```

| Command | What | When |
|---------|------|------|
| `npm test` | typecheck + lint + search + summarizer | Before deploy |
| `npm run test:fast` | typecheck + lint (free, 3s) | After every change |
| `npm run test:integration` | API tests (~$0.25) | Search/summarizer changes |
| `npm run test:e2e` | Full pipeline E2E (~$5-10) | Architecture changes |

Pre-commit hook auto-runs TypeScript + ESLint.

## Gotchas for Future Agents

### Architecture Decisions (DO NOT REDO)

- **DO NOT add court_level filter to search_cases tool** — tried this, LLM ignores broad search instructions and only searches Supreme Court. The correct approach is court-level sorting in the result formatter, not filtering at search time.
- **DO NOT add score boost in retriever** — tried ×1.15 for Supreme, ×1.10 for Appeal. Combined with court_level filter, areiospagos (46K Greek cases) dominates all results. If you want court prioritization, do it in result sorting, not score manipulation.
- **areiospagos is NOT a Cypriot court** — it's the Greek Supreme Court. Its 46K cases are in the database but should NOT be treated as binding Cypriot precedent. Currently `court_level=supreme` — this needs reclassification.
- **Summarize-first is the correct architecture** — previous approach (search → collect all → summarize batch at end) led to 70-112 docs being summarized at once, most being NONE. Current approach summarizes per-search-call and filters NONE before LLM sees them.
- **LLM cannot be trusted to follow complex search instructions** — "do 9 searches with 3 court levels each" results in LLM doing 3 searches all with supreme filter. Keep instructions simple: "do 3 searches with different terms."

### Technical Gotchas

- **Vectorize index is `cyprus-law-cases-search`** — NOT `cylaw-search` (deprecated)
- **Vectorize upsert vs insert**: Always use `/upsert`. `/insert` silently skips existing IDs.
- **Vectorize metadata index timing**: Indexes must be created BEFORE upserting vectors. Vectors uploaded before index creation won't be filtered.
- **Vectorize topK limit**: `returnMetadata: "all"` limits `topK` to 20. Use `returnMetadata: "none"` + `getByIds()`.
- **Vectorize REST API `getByIds` limit**: max 20 IDs per request. `createHttpClient()` batches automatically.
- `initOpenNextCloudflareForDev()` creates an EMPTY miniflare R2 emulator — use `r2FetchViaS3` for dev
- R2 + Vectorize credentials must be in `frontend/.env.local` for dev
- `extractDecisionText()` truncates docs > 80K chars: 35% head + 65% tail
- Port 3000 often taken by Docker; dev server usually on 3001
- **batch_ingest.py embeddings cache**: `download` command saves OpenAI batch results to `data/batch_embed/embeddings/`. Subsequent `collect`/`reupload` use cached files (no re-download).

## Ingestion Scripts

| Script | Purpose | Status |
|--------|---------|--------|
| `scripts/batch_ingest.py` | **PRIMARY** — OpenAI Batch API -> Vectorize | Production |
| Commands: `prepare`, `submit`, `status`, `download`, `collect`, `reupload`, `full-reset`, `run`, `reset` | |

Key features:
- `--index NAME` — target Vectorize index (default: `cyprus-law-cases-search`)
- `download` — save OpenAI embeddings to disk for fast re-uploads
- `reupload` — re-upload from cached embeddings (no OpenAI cost)
- `full-reset` — delete index + recreate + metadata indexes + reupload
- Auto-creates metadata indexes before uploading
- 10 parallel download threads, 6 parallel upload threads
- Uses `/upsert` endpoint

## Last Session Log

### 2026-02-08 (session 3 — summarize-first pipeline, E2E tests)
- **Major architecture change**: merged search + summarize into single tool call (summarize-first)
- Removed `summarize_documents` tool — LLM now has only `search_cases`
- Each search_cases: Vectorize search → R2 fetch → parallel GPT-4o summarize → filter NONE → sort by court level + relevance + year → return to LLM
- Deduplication: `summarizedDocIds` Set tracks across searches, prevents re-summarization
- Court-level sorting in result formatter (Supreme > Appeal > First Instance)
- NONE relevance filtered before LLM sees results
- Removed Sources section and concluding paragraphs from LLM output
- Reverted court_level filter and score boost (caused search degradation — see Gotchas)
- Created E2E pipeline test suite with 4 behavioral test queries
- batch_ingest.py: added `download` command for embedding caching
- System prompt: simplified to "do 3 searches", single tool workflow
- MAX_TOOL_ROUNDS reduced from 7 to 5
- Unified court names in UI (aad/supreme → "Supreme Court")

### 2026-02-08 (session 2 — metadata indexes, tests, logging, UI)
- Created Vectorize index `cyprus-law-cases-search` with metadata indexes
- Full re-upload: 2,269,131 vectors with court_level + subcourt
- Standardized tests, pre-commit hook, structured logging, Sources UI

### 2026-02-08 (session 1 — Vectorize frontend integration)
- Wired Vectorize into frontend, created VectorizeClient abstraction

### 2026-02-07 (evening — Vectorize ingestion)
- Created batch_ingest.py, ingested 2.27M vectors via OpenAI Batch API
