# Cyprus Case Law

AI-powered legal research assistant for Cypriot court cases. Search through 150,000+ court decisions using natural language in Greek, English, or Russian.

## What it does

- **AI-powered legal research** — ask legal questions, get answers with citations to specific cases
- **Multi-agent analysis** — parallel AI agents summarize full court decisions with 4-level relevance rating (RULED/DISCUSSED/MENTIONED/NOT ADDRESSED)
- **Document viewer** — read full case text with AI analysis summary shown before the document
- **Multi-model** — GPT-4o, o3-mini, Claude Sonnet 4 (user selects in UI)
- **Cost tracking** — per-request cost and token usage displayed
- **Translation** — toggle English translation for non-Greek speakers

## Current Status

| Component | Status | Notes |
|-----------|--------|-------|
| Data collection (15 courts) | **Done** | 149,886 decisions scraped, parsed to Markdown |
| R2 document storage | **Done** | All 149,886 .md files uploaded to `cyprus-case-law-docs` bucket |
| Next.js frontend + chat UI | **Done** | Deployed to Cloudflare Workers |
| Summarizer (R2 → GPT-4o) | **Done** | Reads full docs from R2 in both dev and production |
| Search (Vectorize) | **Phase 2** | Local dev uses ChromaDB; production needs Vectorize migration |
| Auth (Zero Trust) | **Done** | Cloudflare Zero Trust email OTP |

**Production URL:** https://cyprus-case-law.cylaw-study.workers.dev

## Architecture

```
User → Next.js (Cloudflare Worker) → API Routes → Main LLM (GPT-4o / Claude)
                                          │
                                    search_cases tool
                                          │
                              ┌── Dev: ChromaDB (Python server)
                              └── Prod: Cloudflare Vectorize (Phase 2)
                                          │
                                 summarize_documents tool
                                          │
                              For each doc_id (parallel, up to 10):
                              ┌── Dev: R2 via S3 HTTP API
                              └── Prod: R2 via Worker binding
                                          │
                                   GPT-4o summarizes full text
                                    (extractDecisionText, max 80K chars)
                                          │
                                 Main LLM composes final answer
                                  with all sources cited
```

### Document fetching strategy

| Environment | Documents (for summarizer) | Search (for finding cases) |
|-------------|---------------------------|---------------------------|
| `npm run dev` | R2 via S3 API (real bucket) | Python search server → ChromaDB |
| `npm run dev` (no Python) | R2 via S3 API | Not available |
| Production (CF Worker) | R2 via Worker binding | Vectorize (Phase 2) / stub |

**Key design decisions:**
- Search returns metadata only (no full text) — fast and cheap
- Each document is summarized in parallel by a dedicated GPT-4o agent
- Summaries include engagement level (RULED/DISCUSSED/MENTIONED) and relevance rating — prevents main LLM from fabricating court holdings
- Results sorted by relevance then by year (newest first) at code level
- Main LLM receives focused summaries (~10K tokens) instead of full docs (~150K tokens)
- AI Analysis shown in DocViewer before full text — user sees summary reasoning per case
- Dev uses S3 HTTP API to reach the REAL R2 bucket (not miniflare emulator)

## Data Pipeline

1. **Scrape** index pages from cylaw.org (15 courts) → `data/indexes/*.json`
2. **Download** 150K+ case files (HTML/PDF) → `data/cases/`
3. **Parse** to Markdown with preserved cross-references → `data/cases_parsed/`
4. **Upload** to Cloudflare R2 → `cyprus-case-law-docs` bucket (149,886 files)
5. **Chunk** into overlapping segments (~2.3M chunks)
6. **Embed** via local model or OpenAI → ChromaDB (local) / Vectorize (Phase 2)

See [docs/PARSING_PIPELINE.md](docs/PARSING_PIPELINE.md) for full documentation.

## Quick Start (Local Development)

```bash
# 1. Install Python dependencies
pip install -r requirements.txt

# 2. Set API keys
cp .env.example .env
# Edit .env: OPENAI_API_KEY, ANTHROPIC_API_KEY, CLOUDFLARE_* credentials

# 3. Set up frontend
cd frontend
npm install
# Create .env.local with API keys and R2 credentials:
#   OPENAI_API_KEY=...
#   ANTHROPIC_API_KEY=...
#   CLOUDFLARE_ACCOUNT_ID=...
#   CLOUDFLARE_R2_ACCESS_KEY_ID=...
#   CLOUDFLARE_R2_SECRET_ACCESS_KEY=...

# 4. Start frontend (documents load from R2, no Python needed)
npm run dev
# Open http://localhost:3001

# 5. (Optional) Start search server for case search
# In another terminal:
cd .. && python -m rag.search_server --provider local
```

### Development modes

| Mode | What works | Python needed? |
|------|-----------|---------------|
| `npm run dev` only | Chat (general questions), DocViewer, summarizer | No |
| `npm run dev` + Python search server | Everything including case search | Yes |

## Deployment

```bash
cd frontend

# Build and deploy
npm run deploy

# Set secrets (one-time)
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put ANTHROPIC_API_KEY
```

R2 bucket binding (`DOCS_BUCKET`) is configured in `wrangler.jsonc`.

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
      api/chat/route.ts        # POST: SSE streaming chat + summarization
      api/doc/route.ts         # GET: document viewer (R2)
    lib/
      llm-client.ts            # Multi-agent LLM: search → summarize → answer
      local-retriever.ts       # Dev: search via Python server + doc fetch via R2 S3 API
      types.ts                 # Shared TypeScript interfaces
    components/                # React components (ChatArea, DocViewer, etc.)
    wrangler.jsonc             # Cloudflare bindings (R2, Vectorize Phase 2)
  rag/                         # Python: embeddings, search, upload
    search_server.py           # FastAPI search server (ChromaDB)
    upload_to_r2.py            # Upload parsed docs to R2
    ingest.py                  # Chunk + embed into ChromaDB
    chunker.py                 # Text chunking logic
  scraper/                     # Python: scraping + parsing pipeline
    extract_text.py            # HTML/PDF → Markdown converter
    downloader.py              # Bulk file downloader
    parser.py                  # Index page parser
  data/                        # Local data (gitignored)
    cases/                     # Raw HTML/PDF files
    cases_parsed/              # Parsed Markdown files
    indexes/                   # JSON index files
  docs/                        # Documentation
    PARSING_PIPELINE.md        # Full pipeline documentation
    DATABASE_AUDIT.md          # Court coverage audit
    plans/                     # Implementation plans
```

## Environment Variables

| Variable | Where | Description |
|----------|-------|-------------|
| `OPENAI_API_KEY` | `.env.local` + CF secret | OpenAI API key for GPT-4o and embeddings |
| `ANTHROPIC_API_KEY` | `.env.local` + CF secret | For Claude model support |
| `CLOUDFLARE_ACCOUNT_ID` | `.env` + `.env.local` | Cloudflare account ID |
| `CLOUDFLARE_R2_ACCESS_KEY_ID` | `.env` + `.env.local` | R2 S3 API access key (dev only) |
| `CLOUDFLARE_R2_SECRET_ACCESS_KEY` | `.env` + `.env.local` | R2 S3 API secret key (dev only) |
| `CLOUDFLARE_API_TOKEN` | `.env` | For wrangler deploy/secret commands |

## Tech Stack

- **Frontend**: Next.js 16, React, TypeScript, Tailwind CSS
- **Deployment**: Cloudflare Workers via @opennextjs/cloudflare
- **LLM**: OpenAI GPT-4o (main + summarizer agents), Anthropic Claude Sonnet 4
- **Document Storage**: Cloudflare R2 (`cyprus-case-law-docs` bucket, 149,886 files)
- **Vector DB**: ChromaDB (local dev), Cloudflare Vectorize (production — Phase 2)
- **Embeddings**: paraphrase-multilingual-mpnet-base-v2 (768 dims, local)
- **Auth**: Cloudflare Zero Trust (email OTP)
- **Scraping**: Python, BeautifulSoup, multiprocessing

## License

Private — not for redistribution.
