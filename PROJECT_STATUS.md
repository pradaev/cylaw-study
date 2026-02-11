# Project Status

> Single source of truth for agent continuity.
> **Read this first** at session start. **Update this last** before committing.
> Architecture details: see `docs/ARCHITECTURE.md`

## What Works Now

- **Three-phase pipeline** — Phase 1: search (LLM + Vectorize), Phase 1.5: rerank (GPT-4o-mini), Phase 2: summarize (Service Binding)
- **Service Binding summarizer** — `cylaw-summarizer` Worker, solves 6-connection limit
- **Reranker pre-filter** — GPT-4o-mini scores 48 docs by preview → keeps ~22 for full summarization (~$0.003)
- **Score threshold** — retriever drops docs below 0.42 cosine and below 75% of best match
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
- **Hit rate ~20%** — Improved from 2% → 4% → 14% → 20%. Reranker now in batches of 20, Subject-line extraction, legal_context enrichment. Still 80% NONE after summarization.
- **Embedding quality** — `text-embedding-3-small` finds similar words, not relevant cases. Hybrid search (BM25 + vector) is next step.
- **Summarizer false positives** — C-category docs sometimes rated HIGH (domestic property cases). Summarizer prompt needs tighter relevance criteria.

## What's Next

### High Priority
1. ~~**LLM search query diversification**~~ — DONE: facet-based query strategy. Hit rate: 2% → 4%.
2. ~~**Lightweight reranker**~~ — DONE: GPT-4o-mini pre-filter. Hit rate: 4% → 14%, cost: $2.33 → $1.16.
3. **Persistent summary cache** — KV or D1, avoid re-summarizing same doc

### Medium Priority
3. **Hybrid search** — vector + keyword matching (BM25 via D1 FTS5)
4. **Query analytics dashboard** — leverage structured logs
5. **Deploy new index to production** — switch `cyprus-law-cases-search-revised` on prod after testing

### Low Priority (ideal stack) — partial implementation
6. ~~**Weaviate + document-level**~~ — DONE: docker-compose, ingest_to_weaviate.py, weaviate-retriever
7. ~~**text-embedding-3-large**~~ — DONE in Weaviate path (3072d)
8. ~~**Node/Railway deploy**~~ — DONE: DEPLOY_TARGET=node, RAILWAY_ENVIRONMENT auto-detect
9. Hybrid BM25 — Weaviate vectorizer "none" = vector-only for now; add vectorizer for hybrid
10. Legislation integration (64,477 acts from cylaw.org)
11. CI/CD pipeline (GitHub Actions → Cloudflare deploy)
12. Automated daily scrape for new cases

## Gotchas

### Architecture
- **Service Binding** — each batch of 5 docs = separate call = fresh connection pool
- **Three-phase pipeline** — LLM searches → GPT-4o-mini reranks → GPT-4o summarizes. Source cards ARE the answer.
- **Reranker** — reads head+Subject+ΝΟΜΙΚΗ ΠΤΥΧΗ (or ΚΕΙΜΕΝΟ) preview+tail per doc, scores in batches of 20, keeps >= 4. Cost ~$0.005.
- **Summarizer prompt in English** — output in Greek, instructions in English (fewer hallucinations)

### Technical
- **ΝΟΜΙΚΗ ΠΤΥΧΗ extraction** — when present (~5400 docs), reranker preview and summarizer use the legal analysis section instead of ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ
- **Workers 6 connection limit** — solved by Service Binding
- **MAX_DOCUMENTS=30** — safe with Service Binding
- **Worker binding getByIds 20 ID limit** — both clients batch by 20
- **Vectorize index**: `cyprus-law-cases-search-revised` (new, with headers/jurisdiction/cleaned text)
- **Old production index**: `cyprus-law-cases-search` (still live on prod, do NOT delete yet)
- **Vectorize topK**: `returnMetadata: "all"` → max 20. Use `"none"` + `getByIds()`
- **Doc API auto-appends .md** — LLM often omits `.md`
- `initOpenNextCloudflareForDev()` creates EMPTY miniflare R2 — use `r2FetchViaS3` for dev
- R2 + Vectorize credentials in `frontend/.env.local` for dev
- `extractDecisionText()` prefers ΝΟΜΙΚΗ ΠΤΥΧΗ when present, else ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ; truncates > 80K chars: 35% head + 65% tail

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
| `node scripts/pipeline_stage_test.mjs` | Stage-by-stage ground-truth check | Search quality experiments |

## Last Session Log

### 2026-02-09 (session 11 — Weaviate infra + document-level search)
- Added Weaviate: docker-compose, weaviate_schema.py, ingest_to_weaviate.py
- Document-level extraction: rag/document_extractor.py (ΝΟΜΙΚΗ ΠΤΥΧΗ → conclusion)
- text-embedding-3-large (3072d) in Weaviate path
- weaviate-retriever.ts: nearVector search, court_level filter
- SEARCH_BACKEND=weaviate + WEAVIATE_URL to switch
- Node/Railway: DEPLOY_TARGET=node, RAILWAY_ENVIRONMENT → HTTP clients, no bindings
- docs/RAILWAY_DEPLOY.md

### 2026-02-09 (session 10 — ΝΟΜΙΚΗ ΠΤΥΧΗ extraction)
- **extractDecisionText**: prefer ΝΟΜΙΚΗ ΠΤΥΧΗ (legal analysis) when present (~5400 docs), else ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ
- **buildRerankPreview**: use first 600 chars after ΝΟΜΙΚΗ ΠΤΥΧΗ for relevance scoring when present
- Updated llm-client.ts, summarizer-worker, tests/summarizer.test.mjs, scripts/pipeline_stage_test.mjs, summarizer_focus_comparison.mjs
- Part of ideal-stack plan: hybrid search, document-level embedding, Weaviate remain for future

### 2026-02-10 (session 9 — search quality experiment framework + reranker fix)
- Created `docs/SEARCH_QUALITY_EXPERIMENT.md` — repeatable test case with 13 ground-truth docs, methodology, success criteria
- Created `scripts/pipeline_stage_test.mjs` — stage-by-stage diagnostic (vector search, reranker, summarizer)
- Diagnosed filtering at each stage: vector search misses A4/B5, reranker dropped A3, summarizer too strict on B-docs
- **Critical fix**: batch reranking (20 docs/batch) — sending 60+ docs in one call caused GPT-4o-mini attention degradation
- Added Subject-line extraction to reranker preview — improved A3 detection
- Sort `allFoundDocs` by score before reranking so best candidates always get evaluated
- Enriched summarizer `focus` with `legal_context` from LLM tool calls
- Added `reranked` SSE event with per-doc scores for observability
- Results: A3 (key EU Reg 2016/1103 case) now found as HIGH; hit rate 14% → 20%

### 2026-02-09 (session 8 — search quality: score threshold + reranker)
- Added score threshold in `retriever.ts`: MIN_SCORE=0.42, adaptive drop at 75% of best match
- Added GPT-4o-mini reranker in `llm-client.ts`: reads 600 chars, scores 0-10, keeps >= 4
- Test results: 48 docs → 22 reranked → 3 kept (14% hit rate), cost $1.16, time 144s

### 2026-02-09 (session 7 — LLM query diversification + doc audit)
- Fixed 24 stale references in 11 files (index names, pipeline commands, areiospagos classification)
- Implemented LLM search query diversification in `buildSystemPrompt()`: facet-based strategy
- Deep-dive diagnostic: hit rate improved 2% → 4% on niche foreign-law query


