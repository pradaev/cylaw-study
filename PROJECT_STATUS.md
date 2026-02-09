# Project Status

> This file is the single source of truth for agent continuity.
> **Read this first** at the start of every session.
> **Update this last** before committing at the end of every session.

## Architecture

```
User -> Cloudflare Zero Trust (email OTP) -> Next.js Worker (cyprus-case-law)
            |
            +-- /api/chat (POST, SSE streaming)
            |     Phase 1: LLM formulates search queries (fast, ~10s)
            |       - search_cases tool: Vectorize search only (no summarization)
            |       - Returns doc_ids + metadata to LLM
            |       - LLM decides if more searches needed (up to 10 rounds)
            |       - Sources emitted to UI progressively
            |     Phase 2: Batch summarization via Service Binding
            |       - All unique doc_ids sent to cylaw-summarizer Worker
            |       - Batches of 5, each Worker gets own 6-connection pool
            |       - Each summary emitted to UI as it completes
            |       - Progress bar: "15/40 (38%)"
            |     Structured JSON logging with userEmail + sessionId
            |
            +-- /api/doc (GET)
                  Document viewer -> R2 bucket (149,886 .md files)
                  Auto-appends .md if missing
```

### Two-Worker Architecture

```
cyprus-case-law (Main Worker)
    |
    +-- Phase 1: LLM tool-calling → Vectorize search (fast)
    |
    +-- Phase 2: Service Binding → cylaw-summarizer Worker
                                      |
                                      +-- R2 fetch (binding)
                                      +-- OpenAI GPT-4o summarize
                                      +-- Returns SummaryResult[]
```

Each Service Binding call = new request = fresh 6-connection pool. Solves the Workers connection limit permanently.

### Key Components

- **Main Worker**: `cyprus-case-law` — Next.js on Cloudflare Workers via @opennextjs/cloudflare
- **Summarizer Worker**: `cylaw-summarizer` — standalone Worker for document summarization
- **Document storage**: Cloudflare R2 bucket `cyprus-case-law-docs` (149,886 parsed .md files)
- **Vector search**: Cloudflare Vectorize index `cyprus-law-cases-search`
- **Search in dev**: Vectorize REST API (`frontend/lib/vectorize-client.ts`)
- **Search in prod**: Vectorize Worker binding (zero-latency)
- **Observability**: Workers Logs with structured JSON logging (sessionId + userEmail)
- **Auth**: Cloudflare Zero Trust (email OTP), `Cf-Access-Authenticated-User-Email` header

### search_cases Tool Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `query` | Yes | Search query — short phrases a judge would write in a decision |
| `legal_context` | Yes | Brief legal framework note (1-2 sentences) |
| `court_level` | No | `"supreme"` or `"appeal"` — filter by court level |
| `year_from` | No | Year range start |
| `year_to` | No | Year range end |

### PRODUCTION WARNING — Vectorize Index

> **Index name:** `cyprus-law-cases-search`
> **Status:** PRODUCTION — 2,269,131 vectors from all 15 courts
> **DO NOT** delete, drop, or recreate.

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

## What Works Now

- **Two-phase pipeline** — Phase 1: fast search (LLM + Vectorize), Phase 2: batch summarize (Service Binding)
- **Service Binding summarizer** — `cylaw-summarizer` Worker, solves 6-connection limit permanently
- **60-90 documents per query** — MAX_DOCUMENTS=30 per search, 3+ searches with dedup
- **Progressive UI** — progress bar during summarization, cards appear after all summaries complete
- **court_level filter** — LLM can filter by `supreme` or `appeal` when user requests specific court
- **legal_context parameter** — LLM provides brief legal framework note for summarizer
- **Light theme UI** — white background, Cypriot Greek interface
- **All UI in Cypriot Greek** — Κυπριακή Νομολογία, no English
- **Source cards with court findings** — show ΕΥΡΗΜΑΤΑ ΔΙΚΑΣΤΗΡΙΟΥ section, relevance badge, court, year
- **Document viewer** — click case in source card to view full text, auto-appends .md
- **Zero Trust email logging** — `Cf-Access-Authenticated-User-Email` tracked in all logs
- **Structured JSON logging** — chat_request, vectorize_search, summarize_batch, chat_complete, errors
- **Deduplication** — doc_ids tracked across searches via `seenDocIds` Set
- **Court-level sorting** — Supreme > Appeal > First Instance in results
- **NONE filtering** — irrelevant cases filtered from source cards after all summaries complete
- **Year filtering** — applied in retriever via Vectorize metadata filter
- **Test suite** — fast, integration, E2E tests (queries in Cypriot Greek)
- **Pre-commit hook** — TypeScript + ESLint
- **Production deployment** — https://cyprus-case-law.cylaw-study.workers.dev

## Current Problems & Known Limitations

### OpenAI Rate Limits (TPM)
When multiple queries run close together, OpenAI 800K TPM limit can cause some documents to fail summarization. Affected batches return fewer results. Not critical — user can retry.

### areiospagos Dominance
areiospagos (Greek Supreme Court, 46K cases) is classified as `court_level=supreme`. It's NOT a Cypriot court but dominates Supreme Court results. Needs reclassification to `court_level=foreign`.

### Embedding Quality
`text-embedding-3-small` finds "similar words" not "relevant cases". Many found docs rated NONE by summarizer. Contextual header prepend could reduce this by 49-67%.

## What's Next

### High Priority

1. **Reclassify areiospagos** — move from `court_level=supreme` to `court_level=foreign`
2. **Contextual header prepend** — add `[Court | Case | Topic | Year]` before embedding
3. **Persistent summary cache** — avoid re-summarizing same doc for same topic (KV or D1)

### Medium Priority

4. **Hybrid search** — combine vector similarity with keyword matching (BM25 via D1 FTS5)
5. **Query analytics dashboard** — leverage structured logs with userEmail
6. **Retry logic for rate-limited batches** — auto-retry after 429 with backoff

### Low Priority

7. Legislation integration — 64,477 legislative acts from cylaw.org
8. CI/CD pipeline (GitHub Actions -> Cloudflare deploy)
9. Automated daily scrape for new cases

### Post-Launch: Chunking Improvements

> All require re-embedding (~2.27M chunks, ~$15, ~40 min). Do ALL in one batch.

1. **Strip references section** — remove ΑΝΑΦΟΡΕΣ noise from first chunks
2. **Contextual header prepend** — `[Court | Case | Year]` before embedding
3. **Merge small tail chunks** — fragments < 500 chars

## Test Suite

```
tests/
  run.mjs               # unified runner
  search.test.mjs       # search regression (12 assertions)
  summarizer.test.mjs   # summarizer eval (28 assertions)
  e2e.test.mjs          # E2E pipeline (4 queries in Cypriot Greek)
```

| Command | What | When |
|---------|------|------|
| `npm test` | typecheck + lint + search + summarizer | Before deploy |
| `npm run test:fast` | typecheck + lint (free, 3s) | After every change |
| `npm run test:integration` | API tests (~$0.25) | Search/summarizer changes |
| `npm run test:e2e` | Full pipeline E2E (~$5-10) | Architecture changes |

## Gotchas for Future Agents

### Architecture Decisions

- **Service Binding for summarization** — `cylaw-summarizer` Worker handles all document summarization. Each batch of 5 docs = separate Service Binding call = fresh connection pool. This is THE solution to the 6-connection limit.
- **Two-phase pipeline** — Phase 1 (search) and Phase 2 (summarize) are separate. LLM only does search, never sees summaries. App handles display.
- **No LLM answer text** — LLM only formulates search queries. No text answer generated. Source cards with court findings ARE the answer.
- **court_level filter** — LLM can use it but instructed to keep 1-2 broad searches. Works well now.
- **DO NOT add score boost in retriever** — tried ×1.15/×1.10, areiospagos dominates.
- **Summarizer prompt in English** — instructions in English, output in Greek. LLM follows English instructions better.

### Technical Gotchas

- **Workers 6 connection limit** — solved by Service Binding to cylaw-summarizer
- **MAX_DOCUMENTS=30** — safe with Service Binding (each batch gets own connections)
- **Worker binding getByIds also has 20 ID limit** — both clients batch by 20
- **Vectorize index is `cyprus-law-cases-search`** — NOT `cylaw-search` (deprecated)
- **Vectorize topK limit**: `returnMetadata: "all"` → topK max 20. Use `"none"` + `getByIds()`
- **Doc API auto-appends .md** — LLM often omits `.md` from doc_ids in links
- `initOpenNextCloudflareForDev()` creates EMPTY miniflare R2 — use `r2FetchViaS3` for dev
- R2 + Vectorize credentials in `frontend/.env.local` for dev
- `extractDecisionText()` truncates > 80K chars: 35% head + 65% tail
- **OpenAI 800K TPM rate limit** — parallel batches can hit this, some docs fail

### Deployment

```bash
# Deploy summarizer worker first
cd summarizer-worker && source ../.env && npx wrangler deploy

# Deploy main worker
cd frontend && npm run deploy
```

## Ingestion Scripts

| Script | Purpose | Status |
|--------|---------|--------|
| `scripts/batch_ingest.py` | **PRIMARY** — OpenAI Batch API -> Vectorize | Production |

Commands: `prepare`, `submit`, `status`, `download`, `collect`, `reupload`, `full-reset`, `run`, `reset`

## Last Session Log

### 2026-02-09 (session 4 — major architecture overhaul)
- **Separated search from summarization**: Phase 1 (LLM search only, fast) + Phase 2 (batch summarize)
- **Created cylaw-summarizer Worker** with Service Binding — solves 6-connection limit permanently
- **60-90 documents processed per query** without Connection errors
- **Switched to Cypriot Greek only** — removed English translate option, all UI in Greek
- **Light theme** — white background, indigo accents
- **Progressive UI** — progress bar during summarization, cards appear after completion
- **Source cards redesigned** — show court findings (ΕΥΡΗΜΑΤΑ), relevance badge, semi-expanded
- **No LLM answer text** — LLM only searches, source cards ARE the answer
- **court_level + legal_context** added to search_cases tool
- **MAX_TOOL_ROUNDS increased to 10** — LLM can do more searches
- **Doc API auto-appends .md** — fixes broken links from LLM
- **Zero Trust email logging** — userEmail from Cf-Access-Authenticated-User-Email in all logs
- **Structured error logging** — all errors as JSON with sessionId, userEmail, stack trace
- **Summarizer prompt reverted** to stable English version (Greek instructions caused hallucinations)
- **Relevance rules** clarified: HIGH=RULED, MEDIUM=DISCUSSED, LOW=MENTIONED, NONE=NOT ADDRESSED
- Tests updated: Cypriot Greek queries, fixed accumulative counters in E2E

### 2026-02-08 (session 3 — summarize-first, production deployment, thinking step)
- Summarize-first pipeline, E2E tests, production deployment
- Workers 6-connection limit discovered and partially fixed (concurrency=5, MAX_DOCUMENTS=15)

### 2026-02-08 (session 2 — metadata indexes, tests, logging, UI)
- Vectorize index with metadata indexes, test suite, structured logging
