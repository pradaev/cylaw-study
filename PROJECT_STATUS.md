# Project Status

> Single source of truth for agent continuity.
> **Read this first** at session start. **Update this last** before committing.
> Architecture details: see `docs/ARCHITECTURE.md`

## What Works Now

- **Two-phase pipeline** — Phase 1: fast search (LLM + Vectorize), Phase 2: batch summarize (Service Binding)
- **Service Binding summarizer** — `cylaw-summarizer` Worker, solves 6-connection limit
- **60-90 documents per query** — MAX_DOCUMENTS=30 per search, 3+ searches with dedup
- **Progressive UI** — progress bar during summarization, cards appear after completion
- **court_level filter** — LLM filters by `supreme` or `appeal`
- **legal_context parameter** — LLM provides legal framework note for summarizer
- **Light theme UI** — white background, Cypriot Greek interface (no English)
- **Source cards** — ΕΥΡΗΜΑΤΑ ΔΙΚΑΣΤΗΡΙΟΥ section, relevance badge, court, year
- **Document viewer** — click case to view full text, auto-appends .md
- **Zero Trust auth** — email OTP, tracked in all logs
- **Structured JSON logging** — sessionId + userEmail in all events
- **Deduplication** — doc_ids tracked across searches via `seenDocIds` Set
- **Court-level sorting** — Supreme > Appeal > First Instance
- **NONE filtering** — irrelevant cases filtered after summarization
- **Year filtering** — Vectorize metadata filter
- **Test suite** — search, summarizer, E2E tests (Cypriot Greek queries)
- **Pre-commit hook** — TypeScript + ESLint
- **Production** — https://cyprus-case-law.cylaw-study.workers.dev

## Current Problems

- **OpenAI 800K TPM** — parallel batches can hit rate limit, some docs fail. User can retry.
- **areiospagos dominance** — Greek Supreme Court (46K cases) classified as `court_level=supreme`, not Cypriot
- **Embedding quality** — `text-embedding-3-small` finds similar words, not relevant cases. Many NONE results.

## What's Next

### High Priority
1. **Reclassify areiospagos** → `court_level=foreign`
2. **Contextual header prepend** → `[Court | Case | Topic | Year]` before embedding
3. **Persistent summary cache** — KV or D1, avoid re-summarizing same doc

### Medium Priority
4. **Hybrid search** — vector + keyword matching (BM25 via D1 FTS5)
5. **Query analytics dashboard** — leverage structured logs
6. **Retry logic for rate-limited batches** — auto-retry after 429

### Low Priority
7. Legislation integration (64,477 acts from cylaw.org)
8. CI/CD pipeline (GitHub Actions → Cloudflare deploy)
9. Automated daily scrape for new cases

### Post-Launch (requires re-embedding, ~$15, ~40 min — do ALL in one batch)
1. Strip ΑΝΑΦΟΡΕΣ noise from first chunks
2. Contextual header prepend
3. Merge small tail chunks (<500 chars)

## Gotchas

### Architecture
- **Service Binding** — each batch of 5 docs = separate call = fresh connection pool
- **Two-phase pipeline** — LLM only searches, never sees summaries. Source cards ARE the answer.
- **No LLM answer text** — LLM only formulates search queries, source cards ARE the answer. `formatSummariesForLLM()` in llm-client.ts is dead code.
- **DO NOT add score boost in retriever** — areiospagos dominates
- **Summarizer prompt in English** — output in Greek, instructions in English (fewer hallucinations)

### Technical
- **Workers 6 connection limit** — solved by Service Binding
- **MAX_DOCUMENTS=30** — safe with Service Binding
- **Worker binding getByIds 20 ID limit** — both clients batch by 20
- **Vectorize index**: `cyprus-law-cases-search` (NOT `cylaw-search`)
- **Vectorize topK**: `returnMetadata: "all"` → max 20. Use `"none"` + `getByIds()`
- **Doc API auto-appends .md** — LLM often omits `.md`
- `initOpenNextCloudflareForDev()` creates EMPTY miniflare R2 — use `r2FetchViaS3` for dev
- R2 + Vectorize credentials in `frontend/.env.local` for dev
- `extractDecisionText()` truncates > 80K chars: 35% head + 65% tail

## Test Suite

| Command | What | When |
|---------|------|------|
| `npm test` | typecheck + lint + search + summarizer | Before deploy |
| `npm run test:fast` | typecheck + lint (free, 3s) | After every change |
| `npm run test:integration` | API tests (~$0.25) | Search/summarizer changes |
| `npm run test:e2e` | Full pipeline E2E (~$5-10) | Architecture changes |

## Last Session Log

### 2026-02-09 (session 5 — context optimization + documentation audit)
- Removed 3 duplicate skills (auto-orchestrator, subagent-driven-development-parallel, project-init-security)
- Moved stable architecture to `docs/ARCHITECTURE.md`
- Trimmed PROJECT_STATUS.md from ~230 to ~110 lines
- Made commit-format, testing, common-mistakes rules agent-requestable
- Full documentation audit: README.md rewritten (was 2 sessions outdated)
- Fixed Vectorize index name `cylaw-search` → `cyprus-law-cases-search` in 6 files
- Fixed stale JSDoc comments in route.ts, llm-client.ts, vectorize-client.ts
- Updated PARSING_PIPELINE.md index references

### 2026-02-09 (session 4 — major architecture overhaul)
- Separated search from summarization: Phase 1 (search) + Phase 2 (summarize)
- Created cylaw-summarizer Worker with Service Binding
- 60-90 documents per query without Connection errors
- Switched to Cypriot Greek only, light theme, progressive UI
- Source cards with court findings, no LLM answer text
- court_level + legal_context added to search_cases tool
- Zero Trust email logging, structured error logging

### 2026-02-08 (session 3 — summarize-first, production deployment)
- Summarize-first pipeline, E2E tests, production deployment
- Workers 6-connection limit discovered and partially fixed
