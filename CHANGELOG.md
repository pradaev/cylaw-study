# Changelog

## 2026-02-07

### Added
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
- 6 newly discovered courts from site audit (Areios Pagos 46K, First Instance 37K, JSC 2.4K, Constitutional 1960-63, Admin Appeal, Juvenile)
- Updated inventory to 150K+ total cases
- DATABASE_AUDIT.md with detailed findings

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
- Index parser for 9 courts (3 HTML page formats)
- Bulk downloader with 30-thread parallelism and resume support
- CSV converter for legacy Supreme Court databases
- 32 unit tests covering parser, fetcher, storage
- Rate limiting, disk caching, retry logic

### Added
- CyLaw site inventory (CYLAW_INVENTORY.md)
- Initial project setup with security configuration
