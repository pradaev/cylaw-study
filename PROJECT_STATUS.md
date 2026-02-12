# Project Status

> Single source of truth for agent continuity.
> **Read this first** at session start. **Update this last** before committing.
> Architecture details: see `docs/ARCHITECTURE.md`

## What Works Now

- **Three-phase pipeline** — Phase 1: search (LLM + Vectorize), Phase 1.5: rerank (GPT-4o-mini), Phase 2: summarize (Service Binding)
- **Service Binding summarizer** — `cylaw-summarizer` Worker, solves 6-connection limit
- **Reranker pre-filter** — GPT-4o-mini scores docs by preview in batches of 20, keeps ≥4 for full summarization (~$0.005)
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
- **Test suite** — search, summarizer, E2E tests, deep-dive diagnostic, pipeline stage test
- **Pre-commit hook** — TypeScript + ESLint
- **Production** — https://cyprus-case-law.cylaw-study.workers.dev

## Current Problems

- **OpenAI 800K TPM** — parallel batches can hit rate limit, some docs fail. User can retry.
- **Hit rate ~10%** — Improved from 2% → 4% → 14% → 20% → 10% (after fixing false positives). A1/A2/A3 found, B-docs rated NONE by summarizer.
- **Embedding quality** — `text-embedding-3-small` finds similar words, not relevant cases. Hybrid search (BM25 + vector) is next step.
- **Summarizer too strict on B-docs** — Cases with foreign elements but no explicit "foreign law" discussion rated NONE. Needs decoupled relevance criteria.

## What's Next

See `docs/plan/search_quality_overhaul_v2.plan.md` for detailed plan.

### High Priority
1. ~~**Phase 0: Weaviate cleanup**~~ — DONE: removed all Weaviate code, hardcoded Vectorize.
2. **Phase 1: Fix summarizer prompt** — decouple engagement from relevance, add research-value criteria. Target: B-docs MEDIUM, hit rate ≥35%.
3. **Phase 2a: Cohere rerank** — replace GPT-4o-mini reranker with `rerank-multilingual-v3.0` (cross-encoder, supports Greek). Target: better calibration, no batch noise.
4. **Phase 2b: PostgreSQL + pgvector + hybrid search** — text-embedding-3-large (3072d), BM25 + vector via RRF. Target: find A4/B5, hit rate ≥50%.

### Medium Priority
5. **Persistent summary cache** — KV or D1, avoid re-summarizing same doc
6. **Query analytics dashboard** — leverage structured logs
7. **Deploy new index to production** — switch `cyprus-law-cases-search-revised` on prod after testing

### Low Priority
8. Legislation integration (64,477 acts from cylaw.org)
9. CI/CD pipeline (GitHub Actions → Cloudflare deploy)
10. Automated daily scrape for new cases

## Gotchas

### Architecture
- **Service Binding** — each batch of 5 docs = separate call = fresh connection pool
- **Three-phase pipeline** — LLM searches → GPT-4o-mini reranks → GPT-4o summarizes. Source cards ARE the answer.
- **Reranker** — reads head+Subject+ΝΟΜΙΚΗ ΠΤΥΧΗ (or ΚΕΙΜΕΝΟ) preview+tail per doc, scores in batches of 20, keeps >= 4. Cost ~$0.005.
- **Summarizer prompt in English** — output in Greek, instructions in English (fewer hallucinations)

### Technical
- **ΝΟΜΙΚΗ ΠΤΥΧΗ extraction** — when present (~5400 docs), reranker preview and summarizer use the legal analysis section instead of ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ
- **Workers 6 connection limit** — solved by Service Binding
- **MAX_SUMMARIZE_DOCS=30** — safe with Service Binding
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

### 2026-02-12 (session 16 — Weaviate cleanup + MAX_SUMMARIZE_DOCS fix)
- **Weaviate removed** — deleted 8 files, cleaned route.ts/env/docs. Hardcoded Vectorize.
- **MAX_SUMMARIZE_DOCS** 20 → 30 — cap of 20 was dropping A1/A2 after reranker. Fixed.
- **SSE `kept` flag** — now reflects actual summarization list, not just score threshold.
- Pipeline test: 57 sources → 30 summarized, A1 HIGH, A2 MEDIUM, A3 HIGH. Hit rate 10%.
- C2/C3 false positives fixed (were HIGH in Run 2, now correctly NONE).
