# Project Status

> This file is the single source of truth for agent continuity.
> **Read this first** at the start of every session.
> **Update this last** before committing at the end of every session.

## Architecture

```
User -> Next.js (Cloudflare Worker) -> API Routes
            |
            +-- /api/chat (POST, SSE streaming)
            |     Main LLM (GPT-4o / Claude) with two tools:
            |       1. search_cases -> Cloudflare Vectorize (PRODUCTION)
            |       2. summarize_documents -> R2 full text -> parallel GPT-4o agents
            |
            +-- /api/doc (GET)
                  Document viewer -> R2 bucket (149,886 .md files)
```

- **Document storage**: Cloudflare R2 bucket `cyprus-case-law-docs` (149,886 parsed .md files)
- **Document fetch in dev**: S3 HTTP API to real R2 (`r2FetchViaS3` in `frontend/app/api/chat/route.ts`)
- **Document fetch in prod**: R2 Worker binding (`r2FetchViaBinding`)
- **Vector search**: Cloudflare Vectorize index `cylaw-search` (PRODUCTION — see warning below)
- **Search in dev**: Same Vectorize index via Cloudflare REST API (`frontend/lib/vectorize-client.ts`)
- **Search in prod**: Vectorize Worker binding (zero-latency, no auth needed)
- **Search abstraction**: `VectorizeClient` interface in `frontend/lib/vectorize-client.ts` — single search codebase for dev and prod
- **Auth**: Cloudflare Zero Trust (email OTP)

### PRODUCTION WARNING — Vectorize Index

> **Index name:** `cylaw-search`
> **Status:** PRODUCTION — contains ~2.27M vectors from all 15 courts
> **DO NOT** delete, drop, or recreate this index.
> **DO NOT** run `wrangler vectorize delete cylaw-search`.
> Recreating it requires re-running the full batch embedding pipeline (~$15 OpenAI cost, ~2 hours).
> If you need to test, create a separate index (e.g., `cylaw-search-dev`).

### Vectorize Index Details

| Property | Value |
|----------|-------|
| Index name | `cylaw-search` |
| Dimensions | 1536 |
| Metric | cosine |
| Embedding model | OpenAI `text-embedding-3-small` |
| Total vectors | ~2,269,231 (all 15 courts, all chunks) |
| Vector ID format | `{doc_id}::{chunk_index}` (hashed via MD5 if >64 bytes) |
| Metadata fields | `doc_id`, `court`, `year`, `title`, `chunk_index` |
| Created | 2026-02-07 |

## What Works Now

- **Chat UI** — Perplexity-style, SSE streaming, multi-model (GPT-4o, o3-mini, Claude Sonnet 4) — `frontend/app/page.tsx`
- **Multi-agent summarizer** — parallel GPT-4o agents analyze up to 30 full court docs per query, auto-summarizes ALL search results — `frontend/lib/llm-client.ts`
- **Document viewer** — click any case to read full text with AI summary panel — `frontend/app/api/doc/route.ts`
- **R2 integration** — all 149,886 docs in R2, fetched in both dev (S3 API) and prod (binding) — `frontend/app/api/chat/route.ts`
- **Vectorize populated** — all 15 courts embedded via OpenAI Batch API, ~2.27M vectors in `cylaw-search` index — `scripts/batch_ingest.py`
- **Data pipeline** — scrape, download, parse, chunk, embed for all 15 courts — `scraper/`, `rag/`, `scripts/`
- **Vectorize search wired into frontend** — unified client for dev (REST API) and prod (binding), returns up to 30 unique docs — `frontend/lib/retriever.ts`, `frontend/lib/vectorize-client.ts`
- **Auto-summarization** — LLM's doc_id selection overridden; system always summarizes ALL documents from search results — `frontend/lib/llm-client.ts`
- **Local search (legacy)** — ChromaDB with ~2.3M chunks (original 9 courts) — `rag/search_server.py`
- **Production deployment** — https://cyprus-case-law.cylaw-study.workers.dev — `frontend/wrangler.jsonc`
- **Cost tracking** — per-request token/cost display in UI — `frontend/components/ChatArea.tsx`
- **Cloudflare secrets** — OPENAI_API_KEY, ANTHROPIC_API_KEY set via `wrangler secret put`

## What's Next

### High Priority

1. **Re-deploy to production** — Vectorize is wired in locally, needs `wrangler deploy`

### Medium Priority

2. Evaluate embedding upgrade — text-embedding-3-large (3072 dims) showed 2x better Greek-English matching (0.498 vs 0.216) but needs Pinecone/Qdrant (Vectorize max 1536 dims); cost ~$2,400
3. Add subcategory metadata for First Instance courts (pol/poin/oik/enoik/erg) to enable Family Court filtering
4. Persistent summary cache — avoid re-summarizing the same doc for the same query
5. Server-side conversation history for session persistence
6. Hybrid search: vector similarity + keyword matching (BM25)
7. Evaluate Claude Sonnet 4 as summarizer (may handle Greek legal text better)

### Low Priority

8. Legislation integration — download/index 64,477 legislative acts from cylaw.org
9. CI/CD pipeline (GitHub Actions -> Cloudflare deploy)
10. Automated daily scrape of updates.html for new cases
11. Cross-reference graph analysis
12. Query analytics dashboard

### Post-Launch: Chunking & Retrieval Quality Improvements

> Do these AFTER the project is fully launched and working in production.
> All changes require re-embedding (~2.27M chunks, ~$15 via Batch API, ~2 hours).
> Do ALL improvements in one batch, then re-ingest.

**Problem analysis** (2026-02-07 session research):

Current chunking (`rag/chunker.py`) uses `RecursiveCharacterTextSplitter` with 2000 char chunks, 400 overlap.
Recursive chunking is the correct baseline — 2025 research (ACL/NAACL) confirms semantic chunking
does NOT justify its computational cost over recursive in most cases. However, there are domain-specific
issues with how we apply it to Cypriot court cases.

**Improvement 1 — Strip references section before chunking** (High impact, Low effort)

Every document starts with ΑΝΑΦΟΡΕΣ (cross-references) — dozens of Markdown links to other cases.
These links get embedded into the first 1-3 chunks and create noise: a query for "lease termination"
may match a chunk that merely LINKS to 20 cases but contains no substantive text.

Fix: in `chunk_document()`, find the marker `ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ` and strip everything before it.
Store cross-references in metadata only (already extracted via `_extract_cross_refs()`).

**Improvement 2 — Contextual header prepend** (Very high impact, Medium effort)

Based on Anthropic's Contextual Retrieval research (Sept 2024): prepending document context
to each chunk before embedding reduces retrieval failures by 49% (67% with reranking).

Current problem: a chunk like "Ο εφεσίβλητος παρουσιάστηκε ενώπιον του Δικαστηρίου..."
(the respondent appeared before the court...) has no context about WHICH case, court, or issue.
The embedding captures the semantic meaning of the TEXT but not the DOCUMENT it belongs to.

Fix: before embedding, prepend a structured header to each chunk's text:

```
[Суд: Εφετείο Κύπρου | Дело: Ποιν. Έφεση 15/2026 | Стороны: ΓΕΝ. ΕΙΣΑΓΓΕΛΕΑΣ v. ΝΕΣΤΟΡΟΣ | 2026]
[текст чанка]
```

This header is included in the embedding but NOT stored in the chunk text for display.
The embedding model sees the context; the user sees clean text.

**Improvement 3 — Merge small tail chunks** (Low impact, Low effort)

1% of chunks are under 500 chars — tiny fragments at document ends. These are noise.

Fix: if last chunk is < 500 chars, merge it with the previous chunk.

**Improvement 4 — Structure-aware splitting** (Medium impact, High effort)

Court cases have clear structural sections: header, facts, legal analysis, ruling (ΑΠΟΦΑΣΗ).
Current chunker is unaware of this. It may split a legal argument mid-sentence.

Fix: detect section headers (bold markers, ΑΠΟΦΑΣΗ, etc.) and use them as primary split points.
This is complex and should be evaluated after improvements 1-3 are live.

**Research sources:**
- "Is Semantic Chunking Worth the Computational Cost?" (NAACL 2025) — semantic ≈ recursive in most cases
- Anthropic Contextual Retrieval (Sept 2024) — 49-67% retrieval error reduction with context prepend
- Summary-Augmented Chunking (SAC, NAACL 2025) — global context reduces Document-Level Retrieval Mismatch
- Late Chunking (ICLR 2025) — embed full doc first, chunk after — requires long-context embedding model

**Execution plan:**
1. Implement improvements 1-3 in `rag/chunker.py`
2. Run `batch_ingest.py reset` to clear old batch data
3. Run `batch_ingest.py run` to re-chunk, re-embed, re-upload (~$15, ~2 hours)
4. Verify retrieval quality on test queries
5. If satisfied, evaluate improvement 4

## Gotchas for Future Agents

- **Vectorize index is PRODUCTION** — `cylaw-search` contains ~2.27M vectors. Do NOT delete. See warning above.
- `initOpenNextCloudflareForDev()` in `next.config.ts` creates a **local miniflare R2 emulator** which is EMPTY — that's why `r2FetchViaBinding` returns null in dev. Use `r2FetchViaS3` instead (calls real R2 over HTTPS).
- R2 credentials (`CLOUDFLARE_R2_ACCESS_KEY_ID`, `CLOUDFLARE_R2_SECRET_ACCESS_KEY`) must be in `frontend/.env.local` for dev S3 API access.
- `extractDecisionText()` in `llm-client.ts` truncates docs > 80K chars: 35% head + 65% tail. For large criminal cases (~300K chars), the middle (often witness testimony sections) is dropped.
- Python search server (`rag/search_server.py`) is only needed in dev for `search_cases`. Without it, chat still works for general questions and document viewing — just no case search.
- Port 3000 is often taken by Docker. Next.js dev server usually runs on 3001.
- HTML files from cylaw.org use ISO-8859-7 / Windows-1253 encoding (Greek).
- **Vector ID length limit**: Vectorize max is 64 bytes. Long doc_ids are hashed via MD5 (first 16 hex chars). The `make_vector_id()` helper handles this — used in `batch_ingest.py`, `ingest_to_vectorize.py`, `export_to_vectorize.py`, and `migrate_to_cloudflare.py`.
- **Vectorize topK limit**: `returnMetadata: "all"` limits `topK` to 20. Use `returnMetadata: "none"` with `topK: 100`, then `getByIds()` for metadata. See `frontend/lib/retriever.ts`.
- **Vectorize REST API `getByIds` limit**: max 20 IDs per request. `createHttpClient()` in `vectorize-client.ts` batches automatically.
- **Dev Vectorize access** requires `CLOUDFLARE_API_TOKEN` in `frontend/.env.local` (copies from root `.env`).
- **ChromaDB is legacy** — `chromadb_local` and `chromadb_openai` contain vectors from original 9 courts only. Not all 15 courts. Use Vectorize for production search.
- **Batch data** — `data/batch_embed/` contains OpenAI Batch API state, metadata index, and batch JSONL files. Safe to delete after successful ingestion (can be recreated with `batch_ingest.py prepare`).

## Ingestion Scripts

| Script | Purpose | Status |
|--------|---------|--------|
| `scripts/batch_ingest.py` | **PRIMARY** — OpenAI Batch API -> Vectorize (parallel, 50% cheaper) | Production |
| `scripts/ingest_to_vectorize.py` | Synchronous OpenAI API -> Vectorize (slower, rate-limited) | Legacy |
| `scripts/export_to_vectorize.py` | Export ChromaDB vectors -> Vectorize (no re-embedding) | Legacy |
| `rag/migrate_to_cloudflare.py` | Migrate ChromaDB -> Vectorize | Legacy |
| `rag/ingest.py` | Chunk + embed -> ChromaDB (local/OpenAI) | Legacy/Dev |

## Last Session Log

### 2026-02-08 (Vectorize frontend integration + auto-summarization)
- Wired Vectorize `cylaw-search` into frontend as primary search for both dev and prod
- Created `frontend/lib/vectorize-client.ts` — `VectorizeClient` abstraction with two implementations:
  - `createBindingClient()` for production (Worker binding, zero-latency)
  - `createHttpClient()` for development (Cloudflare REST API over HTTPS)
- Created `frontend/lib/retriever.ts` — two-step query strategy to bypass Vectorize topK=20 limit with metadata:
  1. Query with `returnMetadata: "none"` and `topK: 100` for broad ID retrieval
  2. Group by doc_id prefix, take top 30 unique docs, fetch metadata via `getByIds()`
- Fixed `getByIds` batching — Vectorize REST API limits to 20 IDs per request
- Updated `frontend/app/api/chat/route.ts` — replaced `stubSearchFn`/`localSearchFn` with unified Vectorize search
- Increased max unique documents from 10 to 30 across all search paths
- **Auto-summarization**: LLM's `summarize_documents` doc_id selection now overridden — system always passes ALL doc_ids from `allSources` (both OpenAI and Claude providers)
- Updated tool description and system prompt to reflect automatic summarization
- All summarizer eval tests pass: 28/28 assertions, 0 failed
- TypeScript compiles cleanly

### 2026-02-07 (evening session — Vectorize ingestion)
- Created `scripts/batch_ingest.py` — OpenAI Batch API pipeline for Vectorize ingestion
- All 46 batches completed (2,269,231 chunks), ~$15 cost
- Marked Vectorize index `cylaw-search` as PRODUCTION

### 2026-02-07 (afternoon session)
- Added R2 document fetching, deployed Phase 1 to Cloudflare Workers
- Set secrets, updated README with architecture
