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
- **Direct OpenAI summarizer** — no Service Binding, direct GPT-4o calls with structured JSON output
- **Summarizer research-value prompt** — decoupled engagement from relevance, MANDATORY OVERRIDES for foreign-law cases
- **Summarizer focus distillation** — `distillSummarizerFocus()` strips temporal/court/action noise from user query
- **Score threshold** — retriever drops docs below 0.42 cosine and below 75% of best match
- **Progressive UI** — progress bar during summarization, cards appear after completion
- **court_level filter** — LLM filters by `supreme`, `appeal`, or `foreign`
- **Light theme UI** — white background, Cypriot Greek interface (no English)
- **Source cards** — ΕΥΡΗΜΑΤΑ ΔΙΚΑΣΤΗΡΙΟΥ section, relevance badge, court, year
- **Document viewer** — click case to view full text, auto-appends .md
- **Pre-commit hook** — TypeScript + ESLint
- **Production VPS** — Hetzner CX53 (16 vCPU, 32 GB RAM, 320 GB SSD), Docker Compose, Nginx reverse proxy, IP-whitelisted

## Current Problems

- **A4 not retrievable** — procedural appeal doc with 0 relevant keywords, BM25 rank 14531. Only connected via case-party association (E.R v P.R), not content. Needs "related cases" feature.
- **A3 still cut by cap** — rerank 3.5 consistently, but position 51+ in effective score ranking
- **B2 intermittent** — appears in some runs, absent in others (LLM query variance)
- **2,945 docs without embeddings** — 2.0% of corpus (batch 019 stuck in OpenAI "finalizing" — will retry)

## What's Next

### High Priority
1. ~~**Deploy to VPS**~~ — DONE (Hetzner CX53, 46.225.59.0)
2. **Tune 30-doc cap** — increase to 40-50 or add smarter cutoff based on rerank score distribution

### Medium Priority
3. **Persistent summary cache** — PostgreSQL table, avoid re-summarizing same doc
4. **Query analytics dashboard** — leverage structured logs
5. **Auth** — decide on auth mechanism (self-hosted, no Cloudflare)

### Low Priority
6. Legislation integration (64,477 acts)
7. CI/CD pipeline
8. Automated daily scrape

## Gotchas

### Architecture
- **Hybrid search** — pgvector (chunk-level, 2000d) + PostgreSQL (doc-level BM25) → RRF fusion (k=60) → Cohere+GPT rerank → GPT-4o summarize
- **BM25 boost** — docs in top-50 BM25 get sorting boost in reranker (max 5.0 on 0-10 scale, inverse of rank)
- **Summarizer** — direct OpenAI calls, no Cloudflare Service Binding
- **Summarizer prompt in English** — output in Greek, instructions in English
- **No Cloudflare** — removed Workers, R2, Vectorize, Zero Trust, @opennextjs/cloudflare (2026-02-14)

### Technical
- **PostgreSQL** — Docker custom image (Dockerfile.postgres), pgvector:pg17 + hunspell-el + cylaw_custom dict, port 5432, db `cylaw`
- **Chunks table** — 2,021,079 chunks, vector(2000) with IVFFlat index (lists=1500). Query with `SET ivfflat.probes = 30`.
- **Documents table** — 149,886 documents with `cylaw` text search config (Greek hunspell + custom legal dict)
- **tsvector** — `to_tsvector('cylaw', content)` GENERATED ALWAYS STORED. `cylaw` config: greek_hunspell → cylaw_custom → simple.
- **BM25 query** — OR logic (`word1 | word2 | word3`) + phrase search for exact matches
- **RRF constant** — k=60 (standard), score = 1/(k + rank_vector) + 1/(k + rank_bm25)
- **Cohere thresholds** — 0.1 (0-10 scale), GPT threshold 1.0 for hybrid pass
- **ΝΟΜΙΚΗ ΠΤΥΧΗ extraction** — when present (~5400 docs), reranker preview and summarizer use legal analysis section
- **MAX_SUMMARIZE_DOCS=30** — direct OpenAI calls
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

### 2026-02-14 (session 25 — Remove Cloudflare + Deploy to Hetzner VPS)
- **Removed all Cloudflare dependencies**: Workers, R2, Vectorize, Service Bindings, Zero Trust, @opennextjs/cloudflare
- **Deleted files**: cloudflare-env.d.ts, wrangler.jsonc, open-next.config.ts, vectorize-client.ts, retriever.ts, export_to_vectorize.py, ingest_to_vectorize.py, compare_indexes.mjs, upload_to_r2.py, summarizer-worker/
- **Edited files**: chat/route.ts (rewritten), doc/route.ts (R2 removed), llm-client.ts (summarizerBinding removed), pg-retriever.ts (Vectorize fallback removed), next.config.ts (standalone output), package.json (CF scripts removed), tsconfig.json, local-retriever.ts (disk fallback)
- **Removed packages**: @opennextjs/cloudflare, wrangler, @cloudflare/workers-types (793 packages)
- **Production deployed**: Hetzner CX53 (16 vCPU, 32GB, 320GB SSD), Nuremberg. Docker Compose (PostgreSQL + Next.js), Nginx reverse proxy, UFW + Nginx IP whitelist (213.7.198.226)
- **Data migrated**: 2,071,079 chunks + 149,886 documents + 16GB IVFFlat index + 522MB BM25 GIN index. Full pipeline verified (search + rerank + summarize)
- **URL**: http://46.225.59.0

### 2026-02-13 (session 24 — Summarizer focus distillation R24)
- **R24**: `distillSummarizerFocus()` — strips temporal ("κατά την τελευταία πενταετία"), court type, action prefix, quantity noise from user query before passing to summarizer. Deterministic regex, no LLM call. **9/13 GT**, hit rate 34% (was 41%), but NONE dropped 41→10. **KEPT**.
- **Test script fix**: `pipeline_stage_test.mjs` updated to parse `StructuredSummary` objects (was broken since structured summarizer change).

### 2026-02-13 (session 23 — Query style experiments R22-R23, structured summarizer)
- **R22**: Few-shot judicial phrases in prompt — **5/13 GT** (was 9/13). Biased examples caused B-docs loss. **REVERTED**.
- **R23**: Dual query (keyword + bm25_phrase) — **8/13 GT**, hit rate 31% (was 41%). No improvement. **REVERTED**.
- **Structured summarizer**: JSON Schema output, relevance enforcement, UI refactor.
