# Cyprus Case Law — Parsing Pipeline Documentation

## Overview

This document describes the complete data pipeline for extracting, downloading, and processing court case documents from cylaw.org — the Cyprus Legal Information Institute.

The pipeline produces a searchable corpus of **149,886 court decisions** from **15 courts** as clean Markdown files with preserved cross-references, organized by court and year.

---

## Pipeline Stages

```
Stage 1: INDEX          Stage 2: DOWNLOAD        Stage 3: PARSE           Stage 4: INDEX (RAG)
scrape.py               downloader.py            extract_text.py          rag/ingest.py

cylaw.org HTML    →     150K HTML/PDF files  →   150K Markdown files  →   ChromaDB vectors
index pages             data/cases/              data/cases_parsed/       data/chromadb_*/
      ↓
JSON indexes
data/indexes/
```

---

## Stage 1: Scraping Index Pages

### Purpose

Fetch the index pages from cylaw.org for each court and extract a list of every court case URL. Does NOT download the cases themselves — only builds the inventory.

### Scripts

| Script | Purpose |
|--------|---------|
| `scraper/config.py` | Court registry: 9 courts with URL patterns and year ranges |
| `scraper/fetcher.py` | HTTP client with rate limiting, disk cache, retry logic |
| `scraper/parser.py` | HTML parsing: extracts case links from 3 page formats |
| `scraper/storage.py` | Saves/loads JSON index files |
| `scraper/scrape.py` | CLI orchestrator for the indexing pipeline |
| `scraper/csv_converter.py` | Converts legacy CSV database to JSON index format |

### Court Registry (`scraper/config.py`)

15 courts total. Original 9 courts listed below, plus 6 additional courts added later (see `docs/DATABASE_AUDIT.md`):

| Court ID | Description | Base URL | Year Pattern | Years |
|----------|-------------|----------|--------------|-------|
| `aad` | Old Supreme Court | `/apofaseis/aad/` | `index_{year}.html` | 1961–2024 |
| `supreme` | New Supreme Court | `/supreme/` | `index_{year}.html` | 2023–2026 |
| `courtOfAppeal` | Court of Appeal | `/courtOfAppeal/` | `index_{year}.html` | 2004–2026 |
| `supremeAdministrative` | Supreme Constitutional | `/supremeAdministrative/` | `index_{year}.html` | 2023–2026 |
| `administrative` | Administrative Court | `/administrative/` | `index_{year}.html` | 2016–2026 |
| `administrativeIP` | Admin First Instance | `/administrativeIP/` | `index_{year}.html` | 2018–2026 |
| `epa` | District Courts | `/apofaseis/epa/` | `{year}/index.html` | 2002–2025 |
| `aap` | Competition Authority | `/apofaseis/aap/` | `{year}/index.html` | 2004–2025 |
| `dioikitiko` | Admin Appeal Court | `/apofaseis/dioikitiko/` | `index_{year}.html` | 2023 |

Plus `updates.html` — a cross-court page listing recently added cases since 2012.

### Data Model (`scraper/parser.py`)

Each case is represented as a `CaseEntry`:

```python
@dataclass
class CaseEntry:
    url: str           # https://www.cylaw.org/cgi-bin/open.pl?file=...
    file_path: str     # /courtOfAppeal/2026/202601-93-18PolEf.html
    title: str         # ΙΩΑΝΝΗΣ ΚΑΚΟΦΕΓΓΙΤΗ κ.α. v. ΓΕΝΙΚΟΥ ΕΙΣΑΓΓΕΛΕΑ...
    court: str         # courtOfAppeal
    year: str          # 2026
    date: str          # (optional)
```

### Parser Functions (`scraper/parser.py`)

Three parsing functions for three HTML page formats:

1. **`parse_court_main_index(html, court_id)`** — Parses the main index page of a court. Returns list of year-index URLs (e.g., `/supreme/index_2023.html`). Looks for `<a>` tags with href matching `index_YYYY.html` or `YYYY/index.html`.

2. **`parse_year_index(html, court_id, year)`** — Parses a year-specific index page. Returns list of `CaseEntry`. Extracts `file_path` from `open.pl?file=` parameter in href, title from link text.

3. **`parse_updates_page(html)`** — Parses updates.html. Returns list of `CaseEntry` with court auto-detected from file_path prefix.

### Fetcher (`scraper/fetcher.py`)

HTTP client wrapper with:
- **Rate limiting**: 0.75s delay between requests (configurable)
- **Disk cache**: saves raw HTML to `data/cache/{md5_hash}.html`
- **Retry**: exponential backoff on 5xx errors, max 3 retries
- **Timeout**: 30s per request
- **Encoding**: auto-detects ISO-8859-7 / Windows-1253 for Greek text
- **User-Agent**: `CyLawIndexScraper/1.0`

### Running

```bash
# Scrape one court
python -m scraper --court supreme

# Scrape all courts
python -m scraper --all

# Scrape updates page
python -m scraper --updates

# Print statistics
python -m scraper --stats

# Convert legacy CSV to JSON index
python -m scraper.csv_converter
```

### Output

JSON files in `data/indexes/`:

```json
{
  "court": "courtOfAppeal",
  "scraped_at": "2026-02-06T...",
  "total": 1111,
  "by_year": {
    "2026": [
      {
        "url": "https://www.cylaw.org/cgi-bin/open.pl?file=...",
        "file_path": "/courtOfAppeal/2026/202601-93-18PolEf.html",
        "title": "ΙΩΑΝΝΗΣ ΚΑΚΟΦΕΓΓΙΤΗ κ.α. v. ...",
        "court": "courtOfAppeal",
        "year": "2026",
        "date": ""
      }
    ]
  }
}
```

### CSV Databases (`scraper/csv_converter.py`)

The site has an open Apache directory at `/apofaseis/database/` containing CSV files for the old Supreme Court. The most complete is `cases_non_reported_table.csv` (23,654 entries, pipe-delimited, ISO-8859-7 encoding):

```
#File name|Title|Number|Date|Citation page|Citation year
/aad/meros_1/1996/1-199604-8877.htm|ΑΝΔΡΕΑΣ ΝΙΚΟΛΑΟΥ...|...|1/4/1996||
```

The converter normalizes paths (`/aad/` → `/apofaseis/aad/`) and produces `data/indexes/aad_csv.json`.

---

## Stage 2: Downloading Case Files

### Purpose

Download all 149,886 case files (HTML and PDF) from cylaw.org, preserving directory structure.

### Script: `scraper/downloader.py`

### How It Works

1. Reads all JSON indexes from `data/indexes/`
2. Collects unique `file_path` entries (deduplicates across indexes)
3. Downloads each file using direct URL: `https://www.cylaw.org{file_path}`
4. Falls back to CGI gateway (`/cgi-bin/open.pl?file=...`) on 404
5. Saves to `data/cases/{file_path}` (mirrors server directory structure)

### Features

- **Parallel**: 30 threads by default (configurable)
- **Rate limiting**: 0.5s delay per thread between downloads
- **Resume**: tracks downloaded files in `data/download_progress.txt`
- **Retry**: exponential backoff on 5xx, max 3 retries
- **Raw bytes**: saves original encoding, no transcoding

### Running

```bash
# Test on first 20 files
python -m scraper.downloader --limit 20

# Download everything (30 threads, 0.5s delay)
python -m scraper.downloader

# Custom settings
python -m scraper.downloader --threads 50 --delay 0.3
```

### Output

```
data/cases/
├── administrative/2016/201601-1113-13.html
├── administrativeIP/2019/201910-xxx.html
├── apofaseis/
│   ├── aad/meros_1/2023/1-202301-4-15PolEf.htm
│   ├── aad/meros_2/...
│   ├── aad/meros_3/...
│   ├── aad/meros_4/...
│   ├── aap/2004/...
│   ├── dioikitiko/2023/...
│   └── epa/2025/...
├── clr/1987/1987_1_467.pdf
├── courtOfAppeal/2026/202601-93-18PolEf.html
├── supreme/2026/...
└── supremeAdministrative/2026/...
```

### File Format Statistics

| Format | Count | Size | Notes |
|--------|-------|------|-------|
| `.htm` | 47,150 | 2.1 GB | Old Supreme Court (aad) cases |
| `.html` | 15,936 | 1.1 GB | Newer courts |
| `.pdf` | 94 | 23 MB | Mostly CLR and EPA courts |
| no extension | 78 | 3 MB | 75 are HTML, 3 are server errors |
| **Total** | **63,258** | **3.15 GB** | |

---

## Stage 3: Extracting Text to Markdown

### Purpose

Convert raw HTML/PDF case files to clean Markdown with preserved formatting, cross-references, and metadata. Strips CyLaw technical metadata (ECLI sections, footer).

### Script: `scraper/extract_text.py`

### How It Works

1. Reads each HTML/PDF file from `data/cases/`
2. Strips ECLI metadata sections (`<!--sections_start-->...<!--sections_end-->`)
3. Converts HTML elements to Markdown recursively:
   - `<h1>`..`<h6>` → `#` headings
   - `<b>`, `<strong>` → `**bold**`
   - `<i>`, `<em>` → `*italic*`
   - `<a href="open.pl?file=...">` → `[case name](file_path.md)` (cross-reference)
   - `<a href="/nomoi/...">` → `[law name](url)` (legislation reference)
   - `<table>` → Markdown tables
   - `<ul>`, `<ol>` → Markdown lists
   - `<hr>` → `---`
4. Removes CyLaw footer (stops at "cylaw.org" / "Από το ΚΙΝΟΠ" markers)
5. PDFs: extracts text via `pdfplumber`, page breaks as `---`
6. Saves as `.md` file in `data/cases_parsed/` (same directory structure)

### Cross-References

Links between cases are preserved as Markdown links:

```markdown
[VEIS & OTHERS ν. REPUBLIC (1979) 3 CLR 390](/aad/meros_3/1979/rep/1979_3_0390.md)
```

The `file_path` in the link corresponds to the `.md` file in `data/cases_parsed/`.

### Legislation References

Links to laws are preserved with original URLs:

```markdown
[Ν. 1/1990 - Ο περί Δημόσιας Υπηρεσίας Νόμος του 1990](/nomoi/enop/non-ind/1990_1_1/full.html)
```

### HTML Structure of CyLaw Documents

Each case HTML typically has this structure:

```
<html>
  <head><title>CASE_TITLE</title></head>
  <body>
    <div>
      <!--noteup_start-->
        <b>ΑΝΑΦΟΡΕΣ:</b>           ← References section (case cross-refs)
        <ul><a href="open.pl?file=...">case name</a></ul>
        <b>ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ:</b>   ← "Text of decision" marker
      <!--noteup_end-->
      <!--sections_start-->
        <!--sino section eclidate-->   ← ECLI metadata (STRIPPED)
        2016-01-29
      <!--sections_end-->
      <p>ACTUAL CASE TEXT HERE</p>     ← The decision text
      <p>cylaw.org : Από το ΚΙΝOΠ...</p> ← Footer (STRIPPED)
    </div>
  </body>
</html>
```

### Encoding

The site uses **ISO-8859-7** (Greek) encoding. The parser tries encodings in order: UTF-8 → ISO-8859-7 → Windows-1253 → Latin-1.

### Features

- **Multiprocessing**: uses all CPU cores (`ProcessPoolExecutor`)
- **Speed**: ~1000 files/sec on 16-core machine
- **Resume**: skips already-processed files (checks if `.md` exists)
- **Stats**: word counts, cross-reference counts, per-court breakdown

### Running

```bash
# Process everything (~2 minutes for 63K files)
python -m scraper.extract_text

# Test on first 50 files
python -m scraper.extract_text --limit 50

# Only one court
python -m scraper.extract_text --court aad

# Count words in already-parsed files
python -m scraper.extract_text --stats
```

### Output Example

Input: `data/cases/administrative/2016/201601-1113-13.html`
Output: `data/cases_parsed/administrative/2016/201601-1113-13.md`

```markdown
# ΣΑΒΒΑΣ ΔΡΑΚΟΣ ν. ΚΥΠΡΙΑΚΗΣ ΔΗΜΟΚΡΑΤΙΑΣ, Υπόθεση Αρ. 1113/2013, 29/1/2016

**ΑΝΑΦΟΡΕΣ:**

**Κυπριακή νομολογία στην οποία κάνει αναφορά η απόφαση αυτή:**

[VEIS & OTHERS ν. REPUBLIC (1979) 3 CLR 390](/aad/meros_3/1979/rep/1979_3_0390.md)

[Νικολάου ν. Δημοκρατίας (1992) 4 ΑΑΔ 3959](/aad/meros_4/1992/rep/1992_4_3959.md)

**Κυπριακή νομοθεσία:**

[Ν. 1/1990 - Ο περί Δημόσιας Υπηρεσίας Νόμος](/nomoi/enop/non-ind/1990_1_1/full.html)

**ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ:**

ECLI:CY:DD:2016:6

ΔΙΟΙΚΗΤΙΚΟ ΔΙΚΑΣΤΗΡΙΟ
(Υπόθεση Αρ. 1113/2013)
29 Ιανουαρίου, 2016

[Γ. ΣΕΡΑΦΕΙΜ, Δ/στής]

ΑΝΑΦΟΡΙΚΑ ΜΕ ΤΟ ΑΡΘΡΟ 146 ΤΟΥ ΣΥΝΤΑΓΜΑΤΟΣ

ΣΑΒΒΑΣ ΔΡΑΚΟΣ,
*Αιτητής,*
-ΚΑΙ-
ΚΥΠΡΙΑΚΗΣ ΔΗΜΟΚΡΑΤΙΑΣ...

(full decision text follows)
```

### Corpus Statistics

Original 9 courts (detailed stats available):

| Court | Files | Words | Avg words/doc | Cross-refs |
|-------|-------|-------|---------------|------------|
| aad | 45,015 | 105.7M | 2,348 | 543,337 |
| areiospagos | 46,159 | — | — | — |
| apofaseised | 37,840 | — | — | — |
| administrativeIP | 6,889 | 26.3M | 3,810 | 80,258 |
| administrative | 5,782 | 17.9M | 3,093 | 81,866 |
| aap | 2,184 | 4.4M | 2,021 | 556 |
| jsc | 2,429 | — | — | — |
| courtOfAppeal | 1,111 | 4.2M | 3,764 | 23,437 |
| supreme | 1,028 | 2.5M | 2,439 | 11,550 |
| epa | 784 | 5.5M | 6,975 | 79 |
| supremeAdministrative | 421 | 1.2M | 2,801 | 5,465 |
| rscc | 122 | — | — | — |
| administrativeCourtOfAppeal | 69 | — | — | — |
| clr | 41 | 112K | 2,722 | 0 |
| juvenileCourt | 11 | — | — | — |
| dioikitiko | 1 | 1K | 1,109 | 4 |
| **Total** | **149,886** | **~300M+** | **~2,600** | **746,552+** |

Note: Word counts for newly added courts (areiospagos, apofaseised, jsc, rscc, administrativeCourtOfAppeal, juvenileCourt) have not been recalculated yet.

---

## Stage 4: Embedding and Indexing (RAG)

### Purpose

Convert Markdown documents into vector embeddings for semantic search.

### Production: Cloudflare Vectorize (`cyprus-law-cases-search`)

> **WARNING**: The `cyprus-law-cases-search` index is PRODUCTION. Do NOT delete or recreate it.

| Property | Value |
|----------|-------|
| Index name | `cyprus-law-cases-search` |
| Embedding model | OpenAI `text-embedding-3-small` |
| Dimensions | 1536 |
| Metric | cosine |
| Total vectors | ~2,269,231 |
| Courts indexed | All 15 |
| Ingestion method | OpenAI Batch API (`scripts/batch_ingest.py`) |
| Cost | ~$15 (Batch API = 50% off standard pricing) |

### Ingestion via OpenAI Batch API (`scripts/batch_ingest.py`)

The production pipeline uses the OpenAI Batch API for embeddings — 50% cheaper than synchronous API, with separate (higher) rate limits and no TPM throttling.

**Pipeline steps:**
1. **Prepare** — chunk all documents, save metadata index (`chunks_meta.jsonl`), create batch JSONL files (50,000 inputs per batch, 100 inputs per request line)
2. **Submit** — upload batch files to OpenAI Files API, create batch jobs (`/v1/embeddings` endpoint)
3. **Status** — poll OpenAI for batch job completion
4. **Collect** — download embedding results, parse into vectors, upload to Cloudflare Vectorize (parallel: 2 download threads + 6 upload threads)

```bash
# Full pipeline
python scripts/batch_ingest.py run

# Step by step
python scripts/batch_ingest.py prepare          # chunk docs → JSONL batches
python scripts/batch_ingest.py submit           # upload to OpenAI Batch API
python scripts/batch_ingest.py status           # check progress
python scripts/batch_ingest.py collect           # download + upload to Vectorize

# Options
python scripts/batch_ingest.py prepare --limit 1000   # test subset
python scripts/batch_ingest.py prepare --court aad     # one court
python scripts/batch_ingest.py reset                   # clear batch data
```

State is saved to `data/batch_embed/state.json` — the pipeline is fully resumable.

### Legacy: ChromaDB (local dev only)

Two independent ChromaDB backends exist for local development:

| | Local | OpenAI |
|---|---|---|
| Model | `paraphrase-multilingual-mpnet-base-v2` | `text-embedding-3-small` |
| Dimensions | 768 | 1536 |
| DB path | `data/chromadb_local/` | `data/chromadb_openai/` |
| Courts indexed | Original 9 only | Original 9 only |
| Status | **Legacy** — use Vectorize for production | **Legacy** |

```bash
# Legacy: index into ChromaDB (not recommended for new work)
python -m rag.ingest --provider local
python -m rag.ingest --provider openai
```

### Chunking (`rag/chunker.py`)

Each Markdown file is split into overlapping chunks:
- **Chunk size**: 2000 characters (~500 words for Greek)
- **Overlap**: 400 characters
- **Separators**: `\n\n`, `\n`, `. `, ` ` (paragraph boundaries first)

Each chunk carries metadata: `doc_id`, `title`, `court`, `year`, `chunk_index`, `cross_refs`.

Total: **~2,269,231 chunks** from 149,886 documents across all 15 courts.

### Vector ID Format

Vectorize has a 64-byte limit on vector IDs. The `make_vector_id()` helper (used in all ingestion scripts) generates IDs as:
- `{doc_id}::{chunk_index}` if ≤64 bytes
- `{md5(doc_id)[:16]}::{chunk_index}` if >64 bytes (MD5 hash fallback)

---

## Environment Setup

### Dependencies

```bash
pip install -r requirements.txt
```

Key packages: `requests`, `beautifulsoup4`, `pdfplumber`, `chromadb`, `openai`, `anthropic`, `fastapi`, `sentence-transformers`, `langchain-text-splitters`, `tqdm`, `python-dotenv`

### Environment Variables (`.env`)

```
OPENAI_API_KEY=sk-proj-...
ANTHROPIC_API_KEY=sk-ant-...
EMBEDDING_PROVIDER=local    # or "openai"
```

### Full Pipeline Execution Order

```bash
# 1. Scrape indexes from all courts (~3 min)
python -m scraper --all
python -m scraper --updates
python -m scraper.csv_converter

# 2. Download all case files (~20 min with 30 threads)
python -m scraper.downloader

# 3. Convert to Markdown (~2 min)
python -m scraper.extract_text

# 4. Upload to R2 (~30 min)
python -m rag.upload_to_r2

# 5. Build Vectorize index via Batch API (~2 hours, ~$15)
python scripts/batch_ingest.py run

# 6. Start frontend
cd frontend && npm run dev
```

---

## Important Notes

### Terms of Service

cylaw.org terms explicitly prohibit mass downloading and external indexing by web robots. This pipeline was built for research purposes. Rate limiting is enforced at every stage to minimize server impact.

### Character Encoding

The site uses ISO-8859-7 (Greek) encoding. All parsers handle encoding detection automatically. Output Markdown files are always UTF-8.

### Cross-Reference Graph

The corpus contains **746,552 cross-references** between cases. These are preserved as Markdown links in the parsed files, enabling future graph analysis of case law citations.

### Data Volumes (current — as of 2026-02-07)

| What | Count | Size |
|------|-------|------|
| Courts covered | 15 | All courts on cylaw.org |
| Downloaded case files | 149,886 | ~8 GB |
| Parsed Markdown files | 149,886 | ~5.5 GB |
| R2 documents | 149,886 | ~5.5 GB |
| Total words | ~300M+ | |
| Vector chunks (Vectorize) | ~2,269,231 | PRODUCTION |
| Vector chunks (ChromaDB, legacy) | ~2,269,231 | ~38 GB (local) |
| Cross-references | 746,552+ | |
| Embedding model | text-embedding-3-small | 1536 dims |

---

## Court Scraping Status (as of 2026-02-07)

**All 15 courts have been scraped, downloaded, and parsed.** Total: 149,886 files.

See `docs/DATABASE_AUDIT.md` for detailed breakdown per court.

### Not Yet Scraped: Legislation

| Database | URL | Approx. count |
|----------|-----|---------------|
| Consolidated Legislation | `/nomoi/` | ~3,995 laws |
| Numbered Legislation | `/nomoi/arith_index.html` | ~14,406 laws |
| Consolidated Procedural Rules | `/nomoi/kanon` | unknown |
| Numbered Procedural Rules | `/nomoi/kanon/arith_index.html` | unknown |
| Regulatory Admin Acts (KDP) | `/KDP` | 45,915 acts |
| Rules of Civil Procedure | `/cpr.html` | unknown |
| New Civil Procedure Rules | `/ncpr.html` | ~161 rules |

Legislation databases have a completely different structure (hierarchical catalogs, not `open.pl` links) — requires separate parser.
