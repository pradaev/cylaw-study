# Project Status

> Single source of truth for agent continuity.
> **Read this first** at session start. **Update this last** before committing.
> Architecture details: see `docs/ARCHITECTURE.md`

## What Works Now

- **Hybrid search pipeline** — Vectorize (vector, 1536d) + PostgreSQL BM25 (keyword) → RRF fusion → Cohere rerank → summarize
- **BM25 keyword search** — PostgreSQL + tsvector on 149,886 full documents. Finds docs that vector search misses (A1, B5).
- **BM25 boost in reranker** — docs with high BM25 rank get sorting boost so they survive Cohere score + cap filtering
- **Cohere rerank** — `rerank-v3.5` cross-encoder (if `COHERE_API_KEY` set), falls back to GPT-4o-mini batches
- **Service Binding summarizer** — `cylaw-summarizer` Worker, solves 6-connection limit
- **Summarizer research-value prompt** — decoupled engagement from relevance, MANDATORY OVERRIDES for foreign-law cases
- **Score threshold** — retriever drops docs below 0.42 cosine and below 75% of best match
- **Progressive UI** — progress bar during summarization, cards appear after completion
- **court_level filter** — LLM filters by `supreme`, `appeal`, or `foreign`
- **Light theme UI** — white background, Cypriot Greek interface (no English)
- **Source cards** — ΕΥΡΗΜΑΤΑ ΔΙΚΑΣΤΗΡΙΟΥ section, relevance badge, court, year
- **Document viewer** — click case to view full text, auto-appends .md
- **Zero Trust auth** — email OTP, tracked in all logs
- **Pre-commit hook** — TypeScript + ESLint
- **Production** — https://cyprus-case-law.cylaw-study.workers.dev

## Current Problems

- **Hit rate variable** — LLM query generation is non-deterministic. A1 HIGH, A3 HIGH stable. B-docs depend on which queries LLM picks.
- **A4 still not found** — BM25 rank 1665, too low for RRF to surface. Needs better query terms or dedicated search.
- **Cohere can't do legal reasoning** — scores A1/A2 as 0.0 (can't infer "Russian citizens = foreign law"). BM25 boost compensates.
- **OpenAI 800K TPM** — parallel batches can hit rate limit. User can retry.

## What's Next

### High Priority
1. ~~**Phase 0: Weaviate cleanup**~~ — DONE
2. ~~**Phase 1: Fix summarizer prompt**~~ — DONE
3. ~~**Phase 2a: Cohere rerank**~~ — DONE
4. ~~**Phase 2b: PostgreSQL + BM25 hybrid search**~~ — DONE (using existing 1536d embeddings via Vectorize + BM25 in PostgreSQL)
5. **Phase 2b+: Re-embed with text-embedding-3-large (3072d)** — better vector quality, store in pgvector. Cost: ~$97.
6. **Deploy hybrid search to production** — needs hosted PostgreSQL (Neon/Supabase)

### Medium Priority
7. **Persistent summary cache** — KV or D1, avoid re-summarizing same doc
8. **Query analytics dashboard** — leverage structured logs

### Low Priority
9. Legislation integration (64,477 acts)
10. CI/CD pipeline
11. Automated daily scrape

## Gotchas

### Architecture
- **Hybrid search** — Vectorize (chunk-level vector) + PostgreSQL (doc-level BM25) → RRF fusion (k=60) → Cohere rerank → GPT-4o summarize
- **BM25 boost** — docs in top-50 BM25 get sorting boost in reranker (max 5.0 on 0-10 scale, inverse of rank)
- **Service Binding** — each batch of 5 docs = separate call = fresh connection pool
- **Summarizer prompt in English** — output in Greek, instructions in English

### Technical
- **PostgreSQL** — Docker `pgvector/pgvector:pg17`, port 5432, db `cylaw`, 149,886 documents
- **tsvector** — `to_tsvector('simple', content)` GENERATED ALWAYS STORED. Uses `simple` config (no Greek stemming).
- **BM25 query** — OR logic (`word1 | word2 | word3`) for better recall
- **RRF constant** — k=60 (standard), score = 1/(k + rank_vector) + 1/(k + rank_bm25)
- **Cohere thresholds** — 0.1 (0-10 scale) vs GPT-4o-mini 4.0
- **ΝΟΜΙΚΗ ΠΤΥΧΗ extraction** — when present (~5400 docs), reranker preview and summarizer use legal analysis section
- **MAX_SUMMARIZE_DOCS=30** — safe with Service Binding
- **Vectorize index**: `cyprus-law-cases-search-revised` (1536d, text-embedding-3-small)
- `extractDecisionText()` prefers ΝΟΜΙΚΗ ΠΤΥΧΗ when present, else ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ; truncates > 80K chars

### Re-embedding Pipeline (scripts/batch_ingest.py)
- Pipeline: `create-index` → `prepare` → `submit` → `status` → `download` → `upload`
- 42 batch files, 2,071,079 vectors, ~$15 OpenAI cost (text-embedding-3-small)

## Test Suite

| Command | What | When |
|---------|------|------|
| `npm test` | typecheck + lint + search + summarizer | Before deploy |
| `npm run test:fast` | typecheck + lint (free, 3s) | After every change |
| `node scripts/pipeline_stage_test.mjs` | Stage-by-stage ground-truth check | Search quality experiments |
| `node scripts/deep_dive_query.mjs` | Full pipeline diagnostic | Debug search quality |

## Last Session Log

### 2026-02-12 (session 17 — Phases 0-2b complete)
- **Phase 0**: Weaviate removal. Committed + pushed.
- **Phase 1**: Summarizer prompt decoupled engagement from relevance. True A+B positives: 1→4. Committed + pushed.
- **Phase 2a**: Cohere rerank-v3.5 with GPT-4o-mini fallback. Tested live. Committed + pushed.
- **Phase 2b**: PostgreSQL + BM25 hybrid search via RRF fusion.
  - Docker pgvector/pgvector:pg17, 149,886 docs ingested (242 docs/s, 10 min).
  - BM25 finds A1 (rank 2), A3 (rank 12), B5 (rank 30), A4 (rank 1665).
  - BM25 boost in reranker: top-50 BM25 docs get sorting boost (max 5.0).
  - Result: A1 promoted from "dropped" to **HIGH**. 61-79 sources (up from 50).
- All phases committed + pushed to origin/main.
