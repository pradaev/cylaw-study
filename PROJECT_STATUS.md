# Project Status

> Single source of truth for agent continuity.
> **Read this first** at session start. **Update this last** before committing.
> Architecture details: see `docs/ARCHITECTURE.md`

## What Works Now

- **Hybrid search pipeline** — pgvector (2000d, text-embedding-3-large) + PostgreSQL BM25 (keyword) → RRF fusion → Cohere+GPT rerank → summarize
- **pgvector embeddings** — 2.07M chunks with text-embedding-3-large (3072d→2000d Matryoshka), IVFFlat index (1500 lists, probes=30), 100% corpus coverage (149,886/149,886 docs)
- **BM25 keyword search** — PostgreSQL `cylaw` text search config (Greek hunspell + custom legal dict + stop words), 149,886 full documents
- **BM25 phrase search** — `phraseto_tsquery` for exact statute/article/case number matches
- **Hybrid Cohere+GPT reranker** — Cohere rerank-v3.5 first pass, GPT-4o-mini rescue for low-Cohere docs
- **Adaptive multi-query** — 3-8 queries (LLM decides) + raw user query always searched first
- **Service Binding summarizer** — `cylaw-summarizer` Worker, temperature 0 for deterministic output
- **Summarizer research-value prompt** — decoupled engagement from relevance, MANDATORY OVERRIDES for foreign-law cases
- **Summarizer focus distillation** — `distillSummarizerFocus()` strips temporal/court/action noise from user query
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
- **2,945 docs without embeddings** — 2.0% of corpus (batch 019 stuck in OpenAI "finalizing" — will retry)

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
- **Chunks table** — 2,021,079 chunks, vector(2000) with IVFFlat index (lists=1500). Query with `SET ivfflat.probes = 30`.
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
- 42/42 batch files, 2,071,079 vectors, ~$97 OpenAI cost (text-embedding-3-large, 3072d→2000d truncated)
- Incremental upload: `python scripts/upload_missing_chunks.py --batches 17 40 19` (INSERT ON CONFLICT DO NOTHING)
- All batches complete — 100% corpus coverage

## Test Suite

| Command | What | When |
|---------|------|------|
| `npm test` | typecheck + lint + search + summarizer | Before deploy |
| `npm run test:fast` | typecheck + lint (free, 3s) | After every change |
| `node scripts/pipeline_stage_test.mjs` | Stage-by-stage ground-truth check | Search quality experiments |
| `node scripts/deep_dive_query.mjs` | Full pipeline diagnostic | Debug search quality |

## Last Session Log

### 2026-02-13 (session 24 — Summarizer focus distillation R24)
- **R24**: `distillSummarizerFocus()` — strips temporal ("κατά την τελευταία πενταετία"), court type, action prefix, quantity noise from user query before passing to summarizer. Deterministic regex, no LLM call. **9/13 GT**, hit rate 34% (was 41%), but NONE dropped 41→10. **KEPT**.
- **Test script fix**: `pipeline_stage_test.mjs` updated to parse `StructuredSummary` objects (was broken since structured summarizer change).
- **Key insight**: Lower hit rate is actually more accurate — summarizer is stricter about HIGH/MEDIUM, correctly downgrading tangential matches to LOW instead of blanket NONE.

### 2026-02-13 (session 23 — Query style experiments R22-R23, structured summarizer)
- **R22**: Few-shot judicial phrases in prompt — **5/13 GT** (was 9/13). Biased examples caused B-docs loss. **REVERTED**.
- **R23**: Dual query (keyword + bm25_phrase) — **8/13 GT**, hit rate 31% (was 41%). No improvement. **REVERTED**.
- **Structured summarizer**: JSON Schema output, relevance enforcement, UI refactor. See session 23 detail above.
- **Final config unchanged**: cap=75, BM25 boost=2, cutoff=2.0, probes=30.

### 2026-02-13 (session 22 — Cap + BM25 boost tuning, R18-R21)
- **R18**: `SUMMARIZE_DOCS_MAX` 50→75 — **MAJOR WIN**: 9/13 GT docs (was 5/13). A3 HIGH, B4/C1/C3 OTHER.
- **R19**: `BM25_BOOST_MAX` 5→2 — same 9/13, hit rate 37%→41%, 70 summaries. **KEPT**.
- R20: `SMART_CUTOFF_SCORE` 2.0→1.0 — no improvement. **REVERTED**.
- R21: `ivfflat.probes` 30→60 — no improvement, +35s latency. **REVERTED**.

### 2026-02-13 (session 21 — Full embedding recovery + A4 diagnosis)
- Batch 019 → 100% coverage (2,071,079 chunks, 149,886 docs). A4 has 41 chunks but still not found → semantic distance proven.
