# Project Status

> This file is the single source of truth for agent continuity.
> **Read this first** at the start of every session.
> **Update this last** before committing at the end of every session.

## Architecture

```
User -> Next.js (Cloudflare Worker) -> API Routes
            |
            +-- /api/chat (POST, SSE streaming)
            |     1. Legal analysis thinking step (LLM identifies laws, terms)
            |     2. search_cases tool (×3 calls with different terms)
            |        Each call: Vectorize → R2 fetch → GPT-4o summarize → filter NONE
            |     3. LLM composes answer from pre-summarized results
            |     Structured JSON logging -> Workers Logs
            |
            +-- /api/doc (GET)
                  Document viewer -> R2 bucket (149,886 .md files)
```

### Summarize-First Pipeline

Each `search_cases` call does everything in one step:
1. Vectorize semantic search → 15 unique docs (MAX_DOCUMENTS=15, Workers connection limit)
2. Fetch full text from R2 (batches of 5, concurrency=5)
3. Summarize each doc with GPT-4o (batches of 5)
4. Parse relevance rating (HIGH/MEDIUM/LOW/NONE)
5. Filter out NONE, keep max 15 relevant per search
6. Sort by: court level (Supreme > Appeal > others) → relevance → year
7. Return formatted summaries to main LLM

LLM makes 3 search calls → ~45 docs total → dedup across searches → LLM receives only relevant summaries.

### Legal Analysis Thinking Step

Before searching, LLM must analyze the query using its knowledge of Cypriot law:
1. Identify area of law (property, torts, procedure, etc.)
2. Recall specific Cypriot statutes (Cap. 15, Cap. 148, Ν. 232/91, etc.)
3. Determine precise Greek legal terms (not literal translation)
4. Generate alternative formulations

This produces significantly better search queries. Example: "delay as defence" → `παραγραφή αξιώσεων` (limitation) instead of literal `καθυστέρηση ως άμυνα`.

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

- **Summarize-first pipeline** — search + summarize + filter in one tool call
- **Legal analysis thinking step** — LLM identifies laws/terms before searching
- **Chat UI** — Perplexity-style, SSE streaming, multi-model (GPT-4o, o3-mini, Claude Sonnet 4)
- **Sources UI** — expandable cards with inline AI summary, relevance badges, court-level sorting
- **Document viewer** — click case links in answer or source cards to view full text
- **Doc link handling** — catches `/doc?doc_id=`, `/path.md`, and `path.md` link formats
- **Deduplication** — doc_ids tracked across searches via `summarizedDocIds` Set
- **Court-level sorting** — Supreme > Appeal > First Instance in results
- **NONE filtering** — irrelevant cases filtered before LLM sees them
- **Year filtering** — applied in retriever
- **Concurrency control** — batches of 5 for R2 fetch + GPT-4o (Workers 6-connection limit)
- **Structured logging** — JSON logs with sessionId → Cloudflare Workers Logs
- **Test suite** — fast, integration, E2E tests
- **Pre-commit hook** — TypeScript + ESLint
- **Vectorize metadata indexes** — year, court, court_level, subcourt (all populated)
- **Batch ingest pipeline** — download caching, upsert, full-reset, --index flag
- **Production deployment** — https://cyprus-case-law.cylaw-study.workers.dev

## Current Problems & Known Limitations

### Workers Connection Limit (6 simultaneous)
MAX_DOCUMENTS is set to 15 (not 30) because Cloudflare Workers allow only 6 simultaneous outgoing connections. Even with concurrency=5, 30 docs causes "Connection error" on production. This limits result diversity per search.

**Potential solutions discussed:**
- Cloudflare Workflows (durable execution, up to 15 min, each step gets own connection pool)
- Reduce summarizer token output to speed up each call
- Move summarization to a separate Worker via Service Binding

### areiospagos Dominance
areiospagos (Greek Supreme Court, 46K cases) is classified as `court_level=supreme`. It's NOT a Cypriot court but dominates Supreme Court results. Needs reclassification to `court_level=foreign` or similar.

### Embedding Quality
`text-embedding-3-small` finds "similar words" not "relevant cases". 44% of found docs are rated NONE by summarizer. Contextual header prepend (adding court/case metadata before embedding) could reduce this by 49-67%.

## What's Next

### High Priority

1. **Reclassify areiospagos** — move from `court_level=supreme` to `court_level=foreign`. Requires re-upload of areiospagos vectors (~46K) with updated metadata. This single change will dramatically improve Supreme Court search results.
2. **Contextual header prepend** — add `[Court | Case | Topic | Year]` to each chunk before embedding. Biggest retrieval quality improvement available. Requires full re-embedding (~$15, ~40 min).
3. **Deploy latest changes** — thinking step, concurrency fix, doc link handler need `wrangler deploy`.

### Medium Priority

4. **Query type classification** — formalize query types (SPECIFIC_PROVISION, LEGAL_DOCTRINE, PROCEDURAL, COMPARATIVE, GENERAL). Each type has optimal search strategy. Currently handled implicitly by thinking step; could become explicit with dedicated classifier.
5. **Persistent summary cache** — avoid re-summarizing same doc for same topic. Could use KV or D1.
6. **Increase MAX_DOCUMENTS** — solve Workers connection limit via Cloudflare Workflows or Service Bindings to allow 30+ docs per search.
7. **Hybrid search** — combine vector similarity with keyword matching (BM25 via D1 FTS5) for queries with specific legal references like "Άρθρο 47 ΚΕΦ. 148".

### Low Priority

8. Legislation integration — 64,477 legislative acts from cylaw.org
9. CI/CD pipeline (GitHub Actions -> Cloudflare deploy)
10. Automated daily scrape for new cases
11. Query analytics dashboard (leverage structured logs)
12. Knowledge base auto-expansion — save successful query→law mappings for future use

### Post-Launch: Chunking Improvements

> All require re-embedding (~2.27M chunks, ~$15, ~40 min). Do ALL in one batch.

1. **Strip references section** — remove ΑΝΑΦΟΡΕΣ noise from first chunks
2. **Contextual header prepend** — `[Court | Case | Year]` before embedding
3. **Merge small tail chunks** — fragments < 500 chars

## Query Type Taxonomy (discussed, not yet implemented)

| Type | Example | Strategy |
|------|---------|----------|
| SPECIFIC_PROVISION | "Article 14 of Law 232/91" | Search by law number + Greek terms |
| LEGAL_DOCTRINE | "delay as defence to a claim" | Expand doctrine to specific laws (Cap. 15), synonyms |
| PROCEDURAL | "amending pleadings before hearing" | Search Rules of Civil Procedure terms |
| COMPARATIVE | "foreign law in property disputes" | International private law terms |
| GENERAL | "what happens when someone doesn't pay rent" | Standard search, LLM picks terms |

Currently the thinking step handles this implicitly. Could become explicit classifier for more control.

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

E2E test queries: one-third presumption, foreign law (5 years), amending pleadings, delay as defence.

## Gotchas for Future Agents

### Architecture Decisions (DO NOT REDO)

- **DO NOT add court_level filter to search_cases tool** — tried this, LLM ignores broad search and only filters Supreme Court. Court-level sorting in result formatter is the correct approach.
- **DO NOT add score boost in retriever** — tried ×1.15/×1.10. Combined with filters, areiospagos dominates. Use result sorting instead.
- **DO NOT increase MAX_DOCUMENTS above 15 on Workers** — 30 docs causes "Connection error" due to 6 simultaneous connection limit. Need Workflows or Service Bindings first.
- **DO NOT ask LLM to do 9+ searches** — LLM ignores complex instructions. "Do 3 searches" is the reliable maximum.
- **Summarize-first is the correct architecture** — previous batch-at-end approach led to 70-112 docs summarized at once, most NONE.
- **Thinking step works** — adding legal analysis before search improved topScore from 0.521 to 0.589 and halved cost.

### Technical Gotchas

- **Workers 6 connection limit** — the real production constraint. Concurrency must be ≤5 for fetch+summarize.
- **Worker binding getByIds also has 20 ID limit** — not just REST API. Both clients batch by 20.
- **Vectorize index is `cyprus-law-cases-search`** — NOT `cylaw-search` (deprecated, stuck mutations)
- **Vectorize upsert vs insert**: `/insert` silently skips existing IDs. Always use `/upsert`.
- **Vectorize metadata index timing**: Indexes must exist BEFORE upserting vectors.
- **Vectorize topK limit**: `returnMetadata: "all"` → topK max 20. Use `"none"` + `getByIds()`.
- `initOpenNextCloudflareForDev()` creates EMPTY miniflare R2 — use `r2FetchViaS3` for dev
- R2 + Vectorize credentials in `frontend/.env.local` for dev
- `extractDecisionText()` truncates > 80K chars: 35% head + 65% tail
- Port 3000 often taken; dev server on 3001
- **batch_ingest.py `download`**: saves embeddings to disk for fast re-uploads without OpenAI cost

## Ingestion Scripts

| Script | Purpose | Status |
|--------|---------|--------|
| `scripts/batch_ingest.py` | **PRIMARY** — OpenAI Batch API -> Vectorize | Production |

Commands: `prepare`, `submit`, `status`, `download`, `collect`, `reupload`, `full-reset`, `run`, `reset`

Key features: `--index`, download caching, upsert, auto metadata indexes, 10 download / 6 upload threads.

## Last Session Log

### 2026-02-08 (session 3 — summarize-first, production deployment, thinking step)
- **Summarize-first pipeline**: merged search + summarize into single tool call
- Removed `summarize_documents` tool, LLM now has only `search_cases`
- Each search: Vectorize → R2 fetch → GPT-4o summarize → filter NONE → sort → return to LLM
- Deduplication via `summarizedDocIds` Set across searches
- Court-level sorting in result formatter
- Removed LLM Sources section and concluding paragraphs
- Reverted court_level filter and score boost experiments (see Gotchas)
- Created E2E test suite (4 queries)
- Added `download` command to batch_ingest.py for embedding caching
- Fixed doc link handler: catches `/path.md` and `path.md` formats
- **Production deployment issues**: Workers 6-connection limit caused crashes with MAX_DOCUMENTS=30
  - Fixed: concurrency=5, MAX_DOCUMENTS=15
  - Fixed: binding client getByIds batching (20 ID limit)
- **Legal analysis thinking step**: LLM analyzes query → identifies Cypriot laws, Greek terms → better searches
  - Tested: "delay as defence" topScore 0.521 → 0.589, cost $3.95 → $2.04
- Discussed query type taxonomy (SPECIFIC_PROVISION, LEGAL_DOCTRINE, PROCEDURAL, COMPARATIVE, GENERAL)
- Discussed future improvements: Workflows, hybrid search, knowledge base expansion

### 2026-02-08 (session 2 — metadata indexes, tests, logging, UI)
- Created Vectorize index `cyprus-law-cases-search` with metadata indexes
- Full re-upload: 2,269,131 vectors with court_level + subcourt
- Standardized tests, pre-commit hook, structured logging, Sources UI

### 2026-02-08 (session 1 — Vectorize frontend integration)
- Wired Vectorize into frontend, created VectorizeClient abstraction

### 2026-02-07 (evening — Vectorize ingestion)
- Created batch_ingest.py, ingested 2.27M vectors via OpenAI Batch API
