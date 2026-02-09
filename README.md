# Cyprus Case Law

AI-powered legal research assistant for Cypriot court cases. Search through 150,000+ court decisions using natural language in Greek.

## What it does

- **AI-powered legal research** — ask legal questions in Greek, get relevant court decisions with summaries
- **Two-phase pipeline** — Phase 1: LLM formulates search queries via Vectorize. Phase 2: batch summarization via dedicated Worker
- **4-level relevance rating** — each case rated as RULED / DISCUSSED / MENTIONED / NOT ADDRESSED
- **Source cards with court findings** — ΕΥΡΗΜΑΤΑ ΔΙΚΑΣΤΗΡΙΟΥ shown directly, no LLM free-text answer
- **Document viewer** — read full case text by clicking on any source card
- **Multi-model** — GPT-4o, o3-mini, Claude Sonnet 4 (user selects in UI)
- **Cost tracking** — per-request cost and token usage displayed

## Current Status

| Component | Status | Notes |
|-----------|--------|-------|
| Data collection (15 courts) | **Done** | 149,886 decisions scraped, parsed to Markdown |
| R2 document storage | **Done** | All 149,886 .md files in `cyprus-case-law-docs` bucket |
| Vectorize embeddings | **Done** | ~2.27M vectors in `cyprus-law-cases-search` index |
| Next.js frontend + chat UI | **Done** | Deployed to Cloudflare Workers |
| Summarizer Worker | **Done** | `cylaw-summarizer` via Service Binding |
| Auth (Zero Trust) | **Done** | Cloudflare Zero Trust email OTP |

**Production URL:** https://cyprus-case-law.cylaw-study.workers.dev

## Architecture

```
User → Cloudflare Zero Trust (email OTP) → Next.js Worker (cyprus-case-law)
                                                │
                                    /api/chat (POST, SSE streaming)
                                                │
                              Phase 1: LLM formulates search queries
                                    search_cases tool → Vectorize
                                    (up to 10 rounds, dedup across searches)
                                                │
                              Phase 2: Batch summarization
                                    Service Binding → cylaw-summarizer Worker
                                      ├── R2 fetch (binding)
                                      ├── OpenAI GPT-4o summarize
                                      └── Returns SummaryResult[]
                                                │
                                    /api/doc (GET)
                                      Document viewer → R2 bucket
```

### Two-Worker design

| Worker | Role | Key bindings |
|--------|------|-------------|
| `cyprus-case-law` | Main app (Next.js) | R2, Vectorize, Summarizer Service Binding |
| `cylaw-summarizer` | Document summarization | R2 |

Each Service Binding call = new request = fresh 6-connection pool. Solves the Workers connection limit.

### Environment differences

| Environment | Documents | Search | Summarization |
|-------------|-----------|--------|---------------|
| Production | R2 via Worker binding | Vectorize binding (zero-latency) | Summarizer Worker (Service Binding) |
| Dev (`npm run dev`) | R2 via S3 HTTP API | Vectorize REST API | Direct OpenAI calls |

## Data Pipeline

1. **Scrape** index pages from cylaw.org (15 courts) → `data/indexes/*.json`
2. **Download** 150K+ case files (HTML/PDF) → `data/cases/`
3. **Parse** to Markdown with preserved cross-references → `data/cases_parsed/`
4. **Upload** to Cloudflare R2 → `cyprus-case-law-docs` bucket (149,886 files)
5. **Chunk** into overlapping segments (2000 chars, 400 overlap) → ~2.27M chunks
6. **Embed** via OpenAI Batch API (`text-embedding-3-small`, 1536 dims) → Cloudflare Vectorize (`cyprus-law-cases-search`)

See [docs/PARSING_PIPELINE.md](docs/PARSING_PIPELINE.md) for full documentation.

### Vectorize Ingestion

```bash
# Full pipeline (prepare → submit → poll → collect)
python scripts/batch_ingest.py run

# Or step by step:
python scripts/batch_ingest.py prepare
python scripts/batch_ingest.py submit
python scripts/batch_ingest.py status
python scripts/batch_ingest.py collect
```

> **WARNING**: The `cyprus-law-cases-search` Vectorize index is PRODUCTION.
> Do NOT delete or recreate it. ~2.27M vectors, ~$15 to regenerate.

## Quick Start (Local Development)

```bash
# 1. Install Python dependencies
pip install -r requirements.txt

# 2. Set API keys
cp .env.example .env
# Edit .env: OPENAI_API_KEY, CLOUDFLARE_* credentials

# 3. Set up frontend
cd frontend
npm install
# Create .env.local with:
#   OPENAI_API_KEY=...
#   ANTHROPIC_API_KEY=...
#   CLOUDFLARE_ACCOUNT_ID=...
#   CLOUDFLARE_R2_ACCESS_KEY_ID=...
#   CLOUDFLARE_R2_SECRET_ACCESS_KEY=...
#   CLOUDFLARE_API_TOKEN=...

# 4. Start frontend
npm run dev
# Open http://localhost:3001
```

Dev mode uses real R2 bucket and real Vectorize index via HTTP APIs. No Python server needed.

## Deployment

```bash
# Deploy summarizer worker first
cd summarizer-worker && source ../.env && npx wrangler deploy

# Deploy main worker
cd frontend && npm run deploy

# Set secrets (one-time)
cd frontend
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put ANTHROPIC_API_KEY
```

## Courts Covered (15 courts, 149,886 decisions)

| Court | Cases | Period |
|-------|-------|--------|
| Ανώτατο Δικαστήριο (old Supreme) | 35,485 | 1961–2024 |
| Άρειος Πάγος (Areios Pagos) | 46,159 | 1968–2026 |
| Πρωτόδικα Δικαστήρια (First Instance) | 37,840 | 2005–2026 |
| Διοικ. Πρωτοδικείο (Admin First Inst.) | 6,890 | 2018–2026 |
| Διοικητικό Δικαστήριο (Administrative) | 5,782 | 2016–2026 |
| Αναθεωρητική Αρχή Προσφορών (Tender Review) | 2,596 | 2004–2025 |
| JSC (Supreme Court English) | 2,429 | 1964–1988 |
| Εφετείο (Court of Appeal) | 1,111 | 2004–2026 |
| Νέο Ανώτατο Δικαστήριο (new Supreme) | 1,028 | 2023–2026 |
| Επιτροπή Ανταγωνισμού (Competition) | 785 | 2002–2025 |
| Ανώτατο Συνταγματικό (Supreme Constitutional) | 420 | 2023–2026 |
| RSCC (Constitutional 1960–63) | 122 | 1960–1963 |
| Διοικ. Εφετείο (Admin Appeal) | 69 | 2025–2026 |
| Δικαστήριο Παίδων (Juvenile) | 11 | 2023–2025 |
| Ανώτατο Διοικητικό (Admin Supreme) | 1 | 2023 |

## Project Structure

```
cylaw-study/
  frontend/                    # Next.js app (Cloudflare Workers)
    app/
      page.tsx                 # Chat page (main UI)
      api/chat/route.ts        # POST: SSE streaming chat + search + summarize
      api/doc/route.ts         # GET: document viewer (R2)
    lib/
      llm-client.ts            # Two-phase pipeline: search → batch summarize
      retriever.ts             # Vectorize search (embed → query → group → return)
      vectorize-client.ts      # Vectorize client (binding for prod, HTTP for dev)
      local-retriever.ts       # Dev: legacy ChromaDB search via Python server
      types.ts                 # Shared TypeScript interfaces
    components/                # React components (ChatArea, DocViewer, etc.)
    wrangler.jsonc             # Cloudflare bindings (R2, Vectorize, Summarizer)
  summarizer-worker/           # Standalone Worker for document summarization
    src/index.ts               # R2 fetch → GPT-4o summarize → SummaryResult[]
    wrangler.jsonc             # R2 binding
  scripts/                     # Ingestion and utility scripts
    batch_ingest.py            # PRIMARY: OpenAI Batch API → Vectorize (production)
    ingest_to_vectorize.py     # Legacy: synchronous OpenAI API → Vectorize
    export_to_vectorize.py     # Legacy: export ChromaDB → Vectorize
  rag/                         # Python: embeddings, search, upload
    upload_to_r2.py            # Upload parsed docs to R2
    chunker.py                 # Text chunking logic
    search_server.py           # FastAPI search server (ChromaDB, legacy dev)
    ingest.py                  # Chunk + embed into ChromaDB (legacy)
  scraper/                     # Python: scraping + parsing pipeline
    scrape.py                  # CLI orchestrator for index scraping
    downloader.py              # Bulk file downloader (30 threads)
    extract_text.py            # HTML/PDF → Markdown converter
    parser.py                  # Index page parser
    config.py                  # Court registry (15 courts)
  data/                        # Local data (gitignored)
  docs/                        # Documentation
    ARCHITECTURE.md            # Stable architecture reference
    PARSING_PIPELINE.md        # Full pipeline documentation
    DATABASE_AUDIT.md          # Court coverage audit
```

## Environment Variables

| Variable | Where | Description |
|----------|-------|-------------|
| `OPENAI_API_KEY` | `.env.local` + CF secret | OpenAI API key for GPT-4o and embeddings |
| `ANTHROPIC_API_KEY` | `.env.local` + CF secret | For Claude model support |
| `CLOUDFLARE_ACCOUNT_ID` | `.env` + `.env.local` | Cloudflare account ID |
| `CLOUDFLARE_R2_ACCESS_KEY_ID` | `.env` + `.env.local` | R2 S3 API access key (dev only) |
| `CLOUDFLARE_R2_SECRET_ACCESS_KEY` | `.env` + `.env.local` | R2 S3 API secret key (dev only) |
| `CLOUDFLARE_API_TOKEN` | `.env` | For wrangler deploy and Vectorize REST API (dev) |

## Tech Stack

- **Frontend**: Next.js 16, React, TypeScript, Tailwind CSS
- **Deployment**: Cloudflare Workers via @opennextjs/cloudflare
- **LLM**: OpenAI GPT-4o (search + summarizer), Anthropic Claude Sonnet 4
- **Document Storage**: Cloudflare R2 (`cyprus-case-law-docs`, 149,886 files)
- **Vector DB**: Cloudflare Vectorize (`cyprus-law-cases-search`, ~2.27M vectors)
- **Embeddings**: OpenAI `text-embedding-3-small` (1536 dims) via Batch API
- **Auth**: Cloudflare Zero Trust (email OTP)
- **Scraping**: Python, BeautifulSoup, multiprocessing

## License

Private — not for redistribution.
