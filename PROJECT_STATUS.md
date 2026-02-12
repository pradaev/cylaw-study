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
- **Weaviate search path** — `SEARCH_BACKEND=weaviate` + `WEAVIATE_URL`: document-level, text-embedding-3-large (3072d), 149,886 docs
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
- **Weaviate**: docker-compose, ingest_to_weaviate.py, CourtCase schema; 149,886 docs ingested (test: scripts/test_weaviate_search.py)
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

### 2026-02-10 (session 14 — nightly report + Weaviate complete)
- **Weaviate full ingest DONE** — 149,886 docs, ~2h19m embed+upsert, 2998 batches
- Smoke test: scripts/test_weaviate_search.py — OK
- docs/NIGHTLY_REPORT_2026-02-10.md — overnight status
- .env.local updated: SEARCH_BACKEND=weaviate, WEAVIATE_URL

### 2026-02-09 (session 13 — Weaviate full ingest + docs)
- Started full ingest in background: `nohup python3 scripts/ingest_to_weaviate.py`
- Added docs/WEAVIATE_SETUP.md, .env.example SEARCH_BACKEND options
- PROJECT_STATUS: Weaviate path, gotchas

### 2026-02-09 (session 12 — Weaviate ingest + truncation)
- Ingested 10K docs to Weaviate; MAX_CONTENT_CHARS 3500, OpenAI truncation 5500
- Docker image: semitechnologies/weaviate:1.35.7


