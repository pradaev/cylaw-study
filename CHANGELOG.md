# Changelog

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
