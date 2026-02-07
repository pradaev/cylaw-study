# Cyprus Case Law

AI-powered legal research assistant for Cypriot court cases. Search through 150,000+ court decisions using natural language in Greek, English, or Russian.

## What it does

- **AI-powered legal research** — ask legal questions, get answers with citations to specific cases
- **Multi-agent analysis** — parallel AI agents summarize full court decisions with 4-level relevance rating (RULED/DISCUSSED/MENTIONED/NOT ADDRESSED)
- **Document viewer** — read full case text with AI analysis summary shown before the document
- **Multi-model** — GPT-4o, o3-mini, Claude Sonnet 4 (user selects in UI)
- **Cost tracking** — per-request cost and token usage displayed
- **Translation** — toggle English translation for non-Greek speakers

## Architecture

```
User → Next.js (React) → API Routes → Main LLM (GPT-4o)
                                           │
                                     search_cases tool
                                           │
                                    ChromaDB → relevant docs
                                           │
                                  summarize_documents tool
                                           │
                              ┌────────────┼────────────┐
                         GPT-4o agent  GPT-4o agent  GPT-4o agent
                         (full doc 1)  (full doc 2)  (full doc N)
                              └────────────┼────────────┘
                                     N summaries
                                           │
                                  Main LLM composes answer
                                   with all sources cited
```

**Key design decisions:**
- Search returns metadata only (no full text) — fast and cheap
- Each document is summarized in parallel by a dedicated GPT-4o agent
- Summaries include engagement level (RULED/DISCUSSED/MENTIONED) and relevance rating — prevents main LLM from fabricating court holdings
- Results sorted by relevance then by year (newest first) at code level
- Main LLM receives focused summaries (~10K tokens) instead of full docs (~150K tokens)
- AI Analysis shown in DocViewer before full text — user sees summary reasoning per case
- Authentication via Cloudflare Zero Trust (email-based OTP)

## Data Pipeline

1. **Scrape** index pages from cylaw.org (15 courts)
2. **Download** 150K+ case files (HTML/PDF)
3. **Parse** to Markdown with preserved cross-references
4. **Chunk** into overlapping segments (~2.3M chunks)
5. **Embed** via local model (paraphrase-multilingual-mpnet-base-v2, 768 dims)
6. **Store** in ChromaDB (local) / Cloudflare Vectorize (production — Phase 2)

See [docs/PARSING_PIPELINE.md](docs/PARSING_PIPELINE.md) for full documentation.

## Quick Start

```bash
# 1. Install Python dependencies
pip install -r requirements.txt

# 2. Set API keys
cp .env.example .env
# Edit .env with your OpenAI and Anthropic keys

# 3. Start the search server (local ChromaDB)
python -m rag.search_server --provider local

# 4. In another terminal, start the frontend
cd frontend
npm install
cp ../.env .env.local   # or create .env.local with OPENAI_API_KEY and ANTHROPIC_API_KEY
npm run dev

# Open http://localhost:3001
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

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes | OpenAI API key for GPT-4o and embeddings |
| `ANTHROPIC_API_KEY` | Optional | For Claude model support |
| `CLOUDFLARE_ACCOUNT_ID` | For deploy | Cloudflare account |
| `CLOUDFLARE_API_TOKEN` | For deploy | Cloudflare API token |

Authentication is handled by **Cloudflare Zero Trust** (email-based one-time PIN).

## Tech Stack

- **Frontend**: Next.js 16, React, TypeScript, Tailwind CSS
- **Deployment**: Cloudflare Workers via @opennextjs/cloudflare
- **LLM**: OpenAI GPT-4o (main + summarizer agents), Anthropic Claude Sonnet 4
- **Embeddings**: paraphrase-multilingual-mpnet-base-v2 (768 dims, local)
- **Vector DB**: ChromaDB (local dev), Cloudflare Vectorize (production — Phase 2)
- **Document Storage**: Local filesystem (dev), Cloudflare R2 (production — Phase 2)
- **Auth**: Cloudflare Zero Trust (email OTP)
- **Scraping**: Python, BeautifulSoup, multiprocessing

## License

Private — not for redistribution.
