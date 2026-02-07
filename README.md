# CyLaw Chat

AI-powered legal research assistant for Cypriot court cases. Search through 150,000+ court decisions using natural language in Greek, English, or Russian.

## What it does

- **Chat interface** — ask legal questions, get answers with citations to specific cases
- **Agentic search** — LLM decides when and how to search the case database (function calling)
- **Document viewer** — read full case text directly in the browser
- **Multi-model** — GPT-4o, o3-mini, Claude Sonnet 4 (user selects in UI)
- **Translation** — toggle English translation for non-Greek speakers

## Architecture

```
User → Chat UI → FastAPI → LLM (function calling)
                              ↓
                         search_cases tool
                              ↓
                    OpenAI Embeddings → Vector DB → relevant chunks
                              ↓
                         LLM streams answer with citations
```

## Data Pipeline

The project includes a complete scraping and processing pipeline:

1. **Scrape** index pages from cylaw.org (9+ courts)
2. **Download** 150K+ case files (HTML/PDF)
3. **Parse** to Markdown with preserved cross-references
4. **Chunk** into overlapping segments (~2.2M chunks)
5. **Embed** via OpenAI text-embedding-3-small (1536 dims)
6. **Store** in vector database (ChromaDB local / cloud)

See [docs/PARSING_PIPELINE.md](docs/PARSING_PIPELINE.md) for full documentation.

## Quick Start

```bash
# Install dependencies
pip install -r requirements.txt

# Set API keys
cp .env.example .env
# Edit .env with your keys

# Run ingestion (if data is already downloaded and parsed)
python -m rag.ingest --provider openai

# Start the server
uvicorn web.app:app --host 0.0.0.0 --port 8000
```

## Courts Covered

| Court | Cases | Period |
|-------|-------|--------|
| Ανώτατο Δικαστήριο (old Supreme) | 35,485 | 1961–2024 |
| Άρειος Πάγος (Areios Pagos) | 46,159 | 1968–2026 |
| Πρωτόδικα Δικαστήρια (First Instance) | 37,840 | 2005–2026 |
| Διοικ. Πρωτοδικείο (Admin First Inst.) | 6,890 | 2018–2026 |
| Διοικητικό Δικαστήριο (Administrative) | 5,782 | 2016–2026 |
| Αναθεωρητική Αρχή Προσφορών (Tender Review) | 2,596 | 2004–2025 |
| Εφετείο (Court of Appeal) | 1,111 | 2004–2026 |
| Νέο Ανώτατο Δικαστήριο (new Supreme) | 1,028 | 2023–2026 |
| Επιτροπή Ανταγωνισμού (Competition) | 785 | 2002–2025 |
| Ανώτατο Συνταγματικό (Supreme Constitutional) | 420 | 2023–2026 |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes | OpenAI API key for embeddings and GPT models |
| `ANTHROPIC_API_KEY` | Optional | For Claude model support |
| `APP_PASSWORD` | Yes | Access password for the web interface |
| `EMBEDDING_PROVIDER` | No | `local` or `openai` (default: `local`) |

## Tech Stack

- **Backend**: Python, FastAPI, uvicorn
- **LLM**: OpenAI GPT-4o / o3-mini, Anthropic Claude Sonnet 4
- **Embeddings**: OpenAI text-embedding-3-small (1536 dims)
- **Vector DB**: ChromaDB (local), Cloudflare Vectorize (production)
- **Frontend**: Vanilla JS, SSE streaming, marked.js for Markdown
- **Scraping**: BeautifulSoup, requests, multiprocessing

## License

Private — not for redistribution. Data sourced from cylaw.org (Cyprus Legal Information Institute).
