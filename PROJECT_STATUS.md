# Project Status

> Single source of truth for agent continuity.
> **Read this first** at session start. **Update this last** before committing.
> Architecture details: see `docs/ARCHITECTURE.md`

## What Works Now

- **Hybrid search pipeline** — pgvector (2000d, text-embedding-3-large) + PostgreSQL BM25 (keyword) → RRF fusion → Cohere+GPT rerank → summarize
- **pgvector embeddings** — 1.92M chunks with text-embedding-3-large (3072d→2000d Matryoshka), IVFFlat index (1500 lists, probes=30)
- **BM25 keyword search** — PostgreSQL `cylaw` text search config (Greek hunspell + custom legal dict + stop words), 149,886 full documents
- **BM25 phrase search** — `phraseto_tsquery` for exact statute/article/case number matches
- **Hybrid Cohere+GPT reranker** — Cohere rerank-v3.5 first pass, GPT-4o-mini rescue for low-Cohere docs
- **Adaptive multi-query** — 3-8 queries (LLM decides) + raw user query always searched first
- **Service Binding summarizer** — `cylaw-summarizer` Worker, temperature 0 for deterministic output
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

- **A4 not retrievable** — procedural appeal doc with 0 relevant keywords, BM25 rank 14531. Only connected via case-party association (E.R v P.R), not content. Needs "related cases" feature.
- **A3 still cut by cap** — rerank 3.5 consistently, but position 51+ in effective score ranking
- **B2 intermittent** — appears in some runs, absent in others (LLM query variance)
- **8,696 docs without embeddings** — 5.8% of corpus never embedded (need future batch job)

## What's Next

### High Priority
1. ~~**Phase 0: Weaviate cleanup**~~ — DONE
2. ~~**Phase 1: Fix summarizer prompt**~~ — DONE
3. ~~**Phase 2a: Cohere rerank**~~ — DONE
4. ~~**Phase 2b: PostgreSQL + BM25 hybrid search**~~ — DONE
5. ~~**Phase 2b+: Re-embed with text-embedding-3-large**~~ — DONE (2000d in pgvector)
6. ~~**Items 1,2,5,8: Hybrid reranker, temperature 0, Greek stemming, multi-query**~~ — DONE
7. **Deploy hybrid search to production** — needs hosted PostgreSQL (Neon/Supabase)
8. **Tune 30-doc cap** — increase to 40-50 or add smarter cutoff based on rerank score distribution

### Medium Priority
9. **Persistent summary cache** — KV or D1, avoid re-summarizing same doc
10. **Query analytics dashboard** — leverage structured logs

### Low Priority
11. Legislation integration (64,477 acts)
12. CI/CD pipeline
13. Automated daily scrape

## Gotchas

### Architecture
- **Hybrid search** — pgvector (chunk-level, 2000d) + PostgreSQL (doc-level BM25) → RRF fusion (k=60) → Cohere+GPT rerank → GPT-4o summarize
- **BM25 boost** — docs in top-50 BM25 get sorting boost in reranker (max 5.0 on 0-10 scale, inverse of rank)
- **Service Binding** — each batch of 5 docs = separate call = fresh connection pool
- **Summarizer prompt in English** — output in Greek, instructions in English

### Technical
- **PostgreSQL** — Docker custom image (Dockerfile.postgres), pgvector:pg17 + hunspell-el + cylaw_custom dict, port 5432, db `cylaw`
- **Chunks table** — 1,921,079 chunks, vector(2000) with IVFFlat index (lists=1500). Query with `SET ivfflat.probes = 30`.
- **Documents table** — 149,886 documents with `cylaw` text search config (Greek hunspell + custom legal dict)
- **tsvector** — `to_tsvector('cylaw', content)` GENERATED ALWAYS STORED. `cylaw` config: greek_hunspell → cylaw_custom → simple.
- **BM25 query** — OR logic (`word1 | word2 | word3`) + phrase search for exact matches
- **RRF constant** — k=60 (standard), score = 1/(k + rank_vector) + 1/(k + rank_bm25)
- **Cohere thresholds** — 0.1 (0-10 scale), GPT threshold 1.0 for hybrid pass
- **ΝΟΜΙΚΗ ΠΤΥΧΗ extraction** — when present (~5400 docs), reranker preview and summarizer use legal analysis section
- **MAX_SUMMARIZE_DOCS=30** — safe with Service Binding
- **Vectorize index**: `cyprus-law-cases-search-revised` (1536d, text-embedding-3-small) — fallback only
- `extractDecisionText()` prefers ΝΟΜΙΚΗ ΠΤΥΧΗ when present, else ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ; truncates > 80K chars

### Re-embedding Pipeline (scripts/batch_ingest.py)
- Pipeline: `create-index` → `prepare` → `submit` → `status` → `download` → `upload-pg`
- 39 batch files, 1,921,079 vectors, ~$97 OpenAI cost (text-embedding-3-large, 3072d→2000d truncated)

## Test Suite

| Command | What | When |
|---------|------|------|
| `npm test` | typecheck + lint + search + summarizer | Before deploy |
| `npm run test:fast` | typecheck + lint (free, 3s) | After every change |
| `node scripts/pipeline_stage_test.mjs` | Stage-by-stage ground-truth check | Search quality experiments |
| `node scripts/deep_dive_query.mjs` | Full pipeline diagnostic | Debug search quality |

## Last Session Log

### 2026-02-13 (session 19 — Search quality tuning: steps 1-4)
- **Step 1**: Smart cutoff (min 30, extend to 50 for score >= 2.0) replaces hard 30-doc cap. B5 found for first time ever.
- **Step 2**: Query generation temperature 0 → deterministic queries. B1 found and kept (MEDIUM). Hit rate 54%.
- **Step 3**: A4 investigation — procedural appeal doc, 0 relevant keywords, not retrievable by content search.
- **Step 4**: Simplified route.ts — always use hybrid search. A2 back as HIGH, B3 kept (OTHER). Best GT coverage: 5 docs in final output.
- Hit rate progression: 43% → 34% → 54% → 52% (50-doc runs). 5 HIGH + 21 MEDIUM + 9 NONE.
- All steps committed + pushed to origin/main.

### 2026-02-12 (session 18 — Search quality overhaul: items 1,2,4,5,8)
- Items 1,2,4,5,8 from search quality plan. Hit rate 17% → 67% → 43% across improvements.
- Key wins: hybrid Cohere+GPT reranker, multi-query 3-8, pgvector text-embedding-3-large, Greek stemming.

### 2026-02-12 (session 17 — Phases 0-2b complete)
- Weaviate removal, summarizer prompt fix, Cohere rerank, PostgreSQL BM25 hybrid search.
- All phases committed + pushed to origin/main.
