# Changelog

## 2026-02-07 (late evening — Vectorize ingestion)

### Added
- **`scripts/batch_ingest.py`** — OpenAI Batch API pipeline for embedding all 149,886 documents into Cloudflare Vectorize. 3-step pipeline: prepare (chunk → JSONL), submit (Batch API), collect (download embeddings → upload to Vectorize). 50% cheaper than synchronous API, separate rate limits, no TPM throttling.
- **Parallel collect** — `step_collect` uses `concurrent.futures.ThreadPoolExecutor` with 2 download workers and 6 upload workers for ~6x speedup over sequential processing.
- **`make_vector_id()` helper** — generates Vectorize-safe vector IDs (max 64 bytes) using MD5 hashing for long doc_ids. Applied across all ingestion scripts.
- **Token bucket rate limiter** in `ingest_to_vectorize.py` — client-side rate limiting for OpenAI API with configurable TPM.

### Changed
- **Vectorize index `cylaw-search`** marked as PRODUCTION — ~2.27M vectors from all 15 courts, OpenAI `text-embedding-3-small` (1536 dims, cosine)
- `ingest_to_vectorize.py` — optimized batch sizes, added automatic batch splitting on token overflow, improved error handling
- All documentation updated to reflect Vectorize as production vector database (not "Phase 2")

### Fixed
- Vector ID length errors (>64 bytes) — `make_vector_id()` with MD5 fallback applied to `batch_ingest.py`, `ingest_to_vectorize.py`, `export_to_vectorize.py`, `migrate_to_cloudflare.py`
- Python 3.9 compatibility in `batch_ingest.py` — `str | None` → `Optional[str]`

## 2026-02-07 (evening)

### Added — Summarizer accuracy & relevance system
- **4-level engagement classification**: RULED / DISCUSSED / MENTIONED / NOT ADDRESSED — replaces binary "addressed/not addressed", prevents summarizer from conflating "party argued X" with "court ruled X"
- **4-level relevance rating**: HIGH / MEDIUM / LOW / NONE with explicit criteria tied to engagement levels (HIGH=RULED, MEDIUM=DISCUSSED, LOW=MENTIONED, NONE=NOT ADDRESSED)
- **"What the case is actually about" section** in summarizer output — anchors context so main LLM can't misrepresent an interim freezing order as a property division ruling
- **AI Analysis panel in DocViewer** — clicking a source now shows the summarizer's full analysis (engagement level, relevance, quotes) before the document text, in a collapsible indigo-highlighted section
- **Summaries SSE event** — backend sends `summaries` event with per-document AI analysis to client; cached in `summaryCache` state for instant display
- **Summarizer eval test suite** (`scripts/test_summarizer_eval.mjs`) — tests structural properties of summarizer output: correct engagement level, correct relevance rating, fabrication detection (forbidden phrases), interim status identification. 28/28 assertions passing.
- **Year-based sorting** of summaries at code level — `extractYearFromDocId()` sorts newest first before sending to main LLM, so results naturally appear in chronological order without relying on LLM sorting

### Changed
- **Main LLM system prompt** rewritten with "INTERPRETING CASE SUMMARIES" block:
  - Must present ALL summarized cases (not just HIGH), sorted by relevance then year
  - MEDIUM cases presented prominently — court's analysis without final ruling is valuable for research
  - LOW cases in "Related cases" section with honest explanation
  - CRITICAL rule: "A response with 10 summaries but only 3 cases in the answer is WRONG"
- **Sources section** now mandatory with per-case reasoning (not generic "High"/"Low" labels) — e.g., "(Court discussed Article 14 in obiter dicta but did not rule — case was about interim freezing orders)"
- **Workflow instruction** changed from "send relevant doc_ids" to "send ALL doc_ids — do NOT pre-filter" to prevent main LLM from dropping cases before summarization
- Summarizer prompt distinguishes party arguments from court decisions: "A party arguing something is NOT the court ruling on it"
- Interim orders clarified: "issuing an interim order IS a ruling" for engagement level purposes

### Fixed
- **Main LLM fabricating court holdings** — e.g., stating "the court applied the presumption of one-third" when the court explicitly said it would not decide this issue. Root cause: old summarizer used vague "RELEVANCE: illustrates the application of Article 14" which main LLM inflated into fabricated holdings
- **MEDIUM cases disappearing** — gap between "court ruled" (HIGH) and "only mentioned" (LOW) was too wide; cases with substantive court analysis (hearing both sides, referencing legal frameworks) fell into LOW and were dropped
- **Random case ordering** — summaries were concatenated in Promise.all arrival order; now sorted by year descending at code level

## 2026-02-07

### Added
- Multi-agent summarization architecture: parallel GPT-4o agents analyze full court decisions
- Search returns metadata only; summarize_documents tool fetches and summarizes each document
- LLM cost tracking: per-request cost displayed under each response (model, tokens, USD)
- Activity log in UI: step-by-step progress (sending, thinking, searching, analyzing N cases, composing)
- Collapsible Sources section — click to expand/collapse case list
- Clickable case links in response text — click case name to open DocViewer
- Current date injected into system prompt for relative time queries ("last 10 years")
- Cypriot Greek legal terminology guidance in system prompt
- Search server health check with user-friendly error messages
- Python search server split: /search (metadata) + /document (full text)

### Changed
- Renamed project from "CyLaw Chat" to "Cyprus Case Law"
- Removed password authentication — now using Cloudflare Zero Trust (email OTP)
- Removed GPT-4o-mini from model list (context too small for legal analysis)
- Upgraded summarizer from GPT-4o-mini to GPT-4o (mini was hallucinating court conclusions)
- Removed court filter from search tool — LLM was making duplicate queries with different court= params
- Search no longer sends full document text to main LLM (prevents context overflow)
- Document text extraction: 35% head / 65% tail ratio (rulings are at end of documents)

### Fixed
- Context overflow error (809K tokens) — now impossible with multi-agent architecture
- Summarizer hallucinating "court ruled X" when court explicitly said "not decided"
- Empty links [title](#) in responses — now all links point to /doc?doc_id=
- Search indicator showing Greek query text with no context — replaced with activity log
- Year filter ChromaDB error on string field — fallback with manual filtering

### Added (earlier on 2026-02-07)
- Next.js frontend on Cloudflare Workers (Phase 1)
- React chat UI with SSE streaming, document viewer, source cards
- API routes: chat (function calling), doc viewer (R2/local)
- TypeScript LLM client supporting GPT-4o, o3-mini, Claude Sonnet 4
- R2 bucket created, upload script ready (rag/upload_to_r2.py)
- Cloudflare Workers deployment with wrangler
- Local dev: search server bridge (rag/search_server.py) for Next.js ↔ ChromaDB
- Scraped and parsed all 6 remaining courts (86,630 cases):
  - Areios Pagos — 46,159 cases (1968–2026)
  - First Instance Courts — 37,840 cases (5 categories)
  - JSC (English) — 2,429 cases (1964–1988)
  - RSCC (Constitutional 1960–63) — 122 cases
  - Admin Court of Appeal — 69 cases (2025–2026)
  - Juvenile Court — 11 cases (2023–2025)
- Full corpus: 149,886 parsed files (5.5 GB) across all 15 courts
- RAG pipeline: chunker, embedder, retriever, LLM client
- Dual embedding: local (paraphrase-multilingual-mpnet) and OpenAI (text-embedding-3-small)
- Full parsing pipeline documentation (docs/PARSING_PIPELINE.md)
- DATABASE_AUDIT.md with detailed findings

## 2026-02-06

### Added
- Markdown text extractor for HTML/PDF court case files
- Preserves cross-references as Markdown links (746K+ refs)
- Multiprocessing for ~1000 files/sec throughput
- Complete web scraper for cylaw.org (9 courts initially, later all 15)
- Bulk downloader with 30-thread parallelism and resume support
- 32 unit tests covering parser, fetcher, storage
- Initial project setup with security configuration
