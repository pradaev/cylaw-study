# Project Status

> Single source of truth for agent continuity.
> **Read this first** at session start. **Update this last** before committing.
> Architecture details: see `docs/ARCHITECTURE.md`

## What Works Now

- **Two-phase pipeline** — Phase 1: fast search (LLM + Vectorize), Phase 2: batch summarize (Service Binding)
- **Service Binding summarizer** — `cylaw-summarizer` Worker, solves 6-connection limit
- **60-90 documents per query** — MAX_DOCUMENTS=30 per search, 3+ searches with dedup
- **Progressive UI** — progress bar during summarization, cards appear after completion
- **court_level filter** — LLM filters by `supreme`, `appeal`, or `foreign`
- **legal_context parameter** — LLM provides legal framework note for summarizer
- **Light theme UI** — white background, Cypriot Greek interface (no English)
- **Source cards** — ΕΥΡΗΜΑΤΑ ΔΙΚΑΣΤΗΡΙΟΥ section, relevance badge, court, year
- **Document viewer** — click case to view full text, auto-appends .md
- **Zero Trust auth** — email OTP, tracked in all logs
- **Structured JSON logging** — sessionId + userEmail in all events
- **Deduplication** — doc_ids tracked across searches via `seenDocIds` Set
- **Court-level sorting** — Supreme > Appeal > First Instance > Administrative > Foreign
- **NONE filtering** — irrelevant cases filtered after summarization
- **Year filtering** — Vectorize metadata filter
- **Re-embedded index** — `cyprus-law-cases-search-revised` with contextual headers, jurisdiction, cleaned text
- **Test suite** — search, summarizer, E2E tests, index comparison, deep-dive diagnostic
- **Pre-commit hook** — TypeScript + ESLint
- **Production** — https://cyprus-case-law.cylaw-study.workers.dev

## Current Problems

- **OpenAI 800K TPM** — parallel batches can hit rate limit, some docs fail. User can retry.
- **Low hit rate (~2%)** — LLM generates near-identical search queries (word rearrangements), embedding finds keyword-similar but legally irrelevant docs. Needs prompt diversification strategy.
- **Embedding quality** — `text-embedding-3-small` finds similar words, not relevant cases. Many NONE results.

## What's Next

### High Priority
1. **LLM search query diversification** — rewrite system prompt to force diverse facets per query (see `docs/plan/llm_search_query_improvement_*.plan.md`)
2. **Persistent summary cache** — KV or D1, avoid re-summarizing same doc

### Medium Priority
3. **Hybrid search** — vector + keyword matching (BM25 via D1 FTS5)
4. **Query analytics dashboard** — leverage structured logs
5. **Deploy new index to production** — switch `cyprus-law-cases-search-revised` on prod after testing

### Low Priority
6. Legislation integration (64,477 acts from cylaw.org)
7. CI/CD pipeline (GitHub Actions → Cloudflare deploy)
8. Automated daily scrape for new cases

## Gotchas

### Architecture
- **Service Binding** — each batch of 5 docs = separate call = fresh connection pool
- **Two-phase pipeline** — LLM only searches, never sees summaries. Source cards ARE the answer.
- **No LLM answer text** — LLM only formulates search queries, source cards ARE the answer.
- **Summarizer prompt in English** — output in Greek, instructions in English (fewer hallucinations)

### Technical
- **Workers 6 connection limit** — solved by Service Binding
- **MAX_DOCUMENTS=30** — safe with Service Binding
- **Worker binding getByIds 20 ID limit** — both clients batch by 20
- **Vectorize index**: `cyprus-law-cases-search-revised` (new, with headers/jurisdiction/cleaned text)
- **Old production index**: `cyprus-law-cases-search` (still live on prod, do NOT delete yet)
- **Vectorize topK**: `returnMetadata: "all"` → max 20. Use `"none"` + `getByIds()`
- **Doc API auto-appends .md** — LLM often omits `.md`
- `initOpenNextCloudflareForDev()` creates EMPTY miniflare R2 — use `r2FetchViaS3` for dev
- R2 + Vectorize credentials in `frontend/.env.local` for dev
- `extractDecisionText()` truncates > 80K chars: 35% head + 65% tail

### Re-embedding Pipeline (scripts/batch_ingest.py)
- Pipeline: `create-index` → `prepare` → `submit` → `status` → `download` → `upload`
- 42 batch files, 2,071,079 vectors, ~$15 OpenAI cost
- Download workers reduced to 3 (from 10) to avoid 504 timeouts
- Retry logic with exponential backoff on download failures

## Test Suite

| Command | What | When |
|---------|------|------|
| `npm test` | typecheck + lint + search + summarizer | Before deploy |
| `npm run test:fast` | typecheck + lint (free, 3s) | After every change |
| `npm run test:integration` | API tests (~$0.25) | Search/summarizer changes |
| `npm run test:e2e` | Full pipeline E2E (~$5-10) | Architecture changes |
| `node scripts/compare_indexes.mjs` | Compare old vs new index | After re-embedding |
| `node scripts/deep_dive_query.mjs` | Full pipeline diagnostic for one query | Debug search quality |

## Last Session Log

### 2026-02-09 (session 6 — vectorize re-embedding overhaul)
- Implemented full re-embedding pipeline: chunker overhaul (contextual headers, jurisdiction extraction, ΑΝΑΦΟΡΕΣ stripping, markdown/C1 cleaning, tail merge)
- Reclassified areiospagos → `court_level=foreign` in chunker, llm-client, retriever
- Created new Vectorize index `cyprus-law-cases-search-revised` with jurisdiction metadata
- Refactored batch_ingest.py: separate `create-index`, `submit`, `download`, `upload` commands
- Uploaded 2,071,079 vectors (42 batches, 0 failures)
- Index comparison: areiospagos no longer pollutes results, jurisdiction metadata populated
- Deep-dive diagnostic: 2% hit rate on niche query — identified LLM query diversification as next improvement
- Added retry logic + reduced parallelism for OpenAI file downloads
- Created comparison (`scripts/compare_indexes.mjs`) and diagnostic (`scripts/deep_dive_query.mjs`) tools

### 2026-02-09 (session 5 — context optimization + documentation audit)
- Documentation audit, README rewrite, fixed stale references
- Trimmed PROJECT_STATUS.md, moved architecture to docs/ARCHITECTURE.md

### 2026-02-09 (session 4 — major architecture overhaul)
- Two-phase pipeline, Service Binding summarizer, progressive UI
- court_level + legal_context, Zero Trust email logging
