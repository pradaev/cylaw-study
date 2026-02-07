# Changelog

## 2026-02-07

### Added
- Next.js frontend on Cloudflare Workers (Phase 1)
- React chat UI with SSE streaming, document viewer, source cards
- API routes: chat (function calling), doc viewer, authentication
- TypeScript LLM client supporting GPT-4o, o3-mini, Claude Sonnet 4
- R2 upload script with parallel uploads and resume support (not yet run — no files in R2)
- Cloudflare Workers deployment config with wrangler
- Local search server bridge (`rag/search_server.py`) for dev: Next.js ↔ ChromaDB
- Updated system prompt for 15 courts and 150K+ cases

### Changed
- Changelog rule now includes .py files and matches existing format
- Agentic chat interface (Perplexity-style) with function calling
- LLM uses `search_cases` tool to decide when to search the database
- Multi-model support: GPT-4o, o3-mini, GPT-4o-mini, Claude Sonnet 4
- Streaming responses via Server-Sent Events
- Document viewer modal — click source card to read full case text
- Password authentication (simple .env-based)
- EN translation toggle for non-Greek speakers
- Expert system prompt with Cypriot legal system knowledge
- Clarifying question behavior for vague queries
- Follow-up question suggestions after answers

### Added
- Scraped and parsed all 6 remaining courts (86,630 cases total):
  - Areios Pagos — 46,159 cases (1968–2026)
  - First Instance Courts — 37,840 cases (2005–2026, 5 categories)
  - JSC (English) — 2,429 cases (1964–1988)
  - RSCC (Constitutional 1960–63) — 122 cases
  - Admin Court of Appeal — 69 cases (2025–2026)
  - Juvenile Court — 11 cases (2023–2025)
- Full corpus now: 149,886 parsed files (5.5 GB) across all 15 courts
- DATABASE_AUDIT.md with detailed findings
- Site audit discovered 6 new courts from sidebar `/common/left.html`

### Added
- Full parsing pipeline documentation (docs/PARSING_PIPELINE.md)

### Added
- RAG pipeline: chunker, embedder, retriever, LLM client
- Dual embedding support: local (paraphrase-multilingual-mpnet) and OpenAI (text-embedding-3-small)
- Separate ChromaDB databases per provider
- Ingestion CLI with multiprocessing chunking and parallel API threads
- Rate limit header parsing for optimal OpenAI throughput
- FastAPI web interface with HTMX

## 2026-02-06

### Added
- Markdown text extractor for HTML/PDF court case files
- Preserves cross-references as Markdown links (746K+ refs)
- Strips ECLI metadata sections
- Multiprocessing for ~1000 files/sec throughput
- 63K files processed in under 2 minutes

### Added
- Complete web scraper for cylaw.org
- Index parser for 9 courts initially (3 HTML page formats); later extended to all 15
- Bulk downloader with 30-thread parallelism and resume support
- CSV converter for legacy Supreme Court databases
- 32 unit tests covering parser, fetcher, storage
- Rate limiting, disk caching, retry logic

### Added
- CyLaw site inventory (CYLAW_INVENTORY.md)
- Initial project setup with security configuration
