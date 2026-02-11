---
name: Vectorize re-embedding overhaul
overview: "Full re-embedding of 2.27M vectors: reclassify areiospagos, extract jurisdiction from docs (original terminology), prepend contextual headers, strip ΑΝΑΦΟΡΕΣ, clean text from markdown/encoding noise, merge tail chunks. One Batch API run (~$15, ~40 min)."
todos:
  - id: chunker-areiospagos
    content: Change areiospagos court_level from supreme to foreign in rag/chunker.py
    status: pending
  - id: chunker-display-names
    content: Add _COURT_DISPLAY_NAME and _JURISDICTION_FALLBACK mappings in rag/chunker.py
    status: pending
  - id: chunker-extract-jurisdiction
    content: Add _extract_jurisdiction() — extract ΔΙΚΑΙΟΔΟΣΙΑ from doc body, clean only Markdown artifacts, NO semantic normalization
    status: pending
  - id: chunker-strip-refs
    content: Add _strip_references() to remove ΑΝΑΦΟΡΕΣ section before chunking
    status: pending
  - id: chunker-clean-text
    content: "Add _clean_chunk_text() — strip markdown links [text](path)->text, remove *, #, C1 control chars, normalize NBSP/hyphens, remove HR rules, collapse whitespace (~6% savings)"
    status: pending
  - id: chunker-header
    content: Prepend contextual header (court, jurisdiction, year, title) to each chunk text
    status: pending
  - id: chunker-merge-tail
    content: Merge small tail chunks (<500 chars) with previous chunk
    status: pending
  - id: batch-ingest-metadata
    content: Add jurisdiction field to batch_ingest.py metadata and Vectorize metadata indexes
    status: pending
  - id: frontend-retriever
    content: Update retriever.ts to support foreign court_level filter
    status: pending
  - id: frontend-llm
    content: "Update llm-client.ts: tool definition, system prompt, COURT_LEVEL_ORDER"
    status: pending
  - id: test-prepare
    content: Run batch_ingest.py prepare --limit 100 and verify chunks manually
    status: pending
  - id: re-embed
    content: Run full-reset + batch_ingest.py run for complete re-embedding
    status: pending
isProject: false
---

# Vectorize Re-Embedding Overhaul

## Agent Onboarding — READ THIS FIRST

### Required reading (in this order)

1. `**PROJECT_STATUS.md**` (repo root) — current architecture, what works, gotchas
2. `**docs/DOCUMENT_METADATA_RESEARCH.md**` — full research on extractable metadata from court documents (jurisdiction types, coverage stats, document structure, extraction methods)
3. `**docs/ARCHITECTURE.md**` — two-worker architecture, Vectorize index details, deployment
4. **This plan** — implementation details below

### Key files to edit


| File                         | What to change                                                                                                             | Lines to focus on                                                                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rag/chunker.py`             | ALL chunking logic: court_level, display names, jurisdiction extraction, ΑΝΑΦΟΡΕΣ strip, text cleaning, header, tail merge | Full file (~220 lines). Core dataclass `Chunk` at line 60. `_COURT_LEVEL` mapping at line 37. `chunk_document()` at line 144.                                |
| `scripts/batch_ingest.py`    | Add jurisdiction to metadata, add metadata index                                                                           | `step_prepare()` at line 209 (metadata dict at ~242). `_parse_batch_vectors()` at line 425 (metadata dict at ~440). `REQUIRED_METADATA_INDEXES` at line 156. |
| `frontend/lib/retriever.ts`  | Support `foreign` court_level filter                                                                                       | Line 73: the `if` condition for filter.                                                                                                                      |
| `frontend/lib/llm-client.ts` | Tool definition, system prompt, court level ordering                                                                       | `COURT_LEVEL_ORDER` at line 24. System prompt at line 42. `search_cases` tool definition — search for `court_level` enum.                                    |


### Key files to read for context (DO NOT edit)


| File                       | Why                                                        |
| -------------------------- | ---------------------------------------------------------- |
| `scraper/config.py`        | Court registry — all 15 courts with IDs, URLs, year ranges |
| `frontend/lib/types.ts`    | Shared TypeScript interfaces (SearchResult, etc.)          |
| `docs/PARSING_PIPELINE.md` | Full data pipeline documentation                           |


### Where the documents live

- Parsed documents: `data/cases_parsed/` (gitignored, ~150K .md files)
- Directory structure: `data/cases_parsed/{court_path}/{year_or_meros}/{filename}.md`
- Examples:
  - `data/cases_parsed/apofaseised/oik/2013/1320130099.md` (family court)
  - `data/cases_parsed/courtOfAppeal/2024/202404-361-18PolEf.md` (appeal)
  - `data/cases_parsed/apofaseis/aad/meros_1/2020/...` (old supreme, criminal)
  - `data/cases_parsed/areiospagos/2024/...` (Greek supreme court)

### How to verify changes without re-embedding

```bash
# Quick: run prepare on a small subset, inspect output in data/batch_embed/
python scripts/batch_ingest.py prepare --limit 100

# Then inspect:
# - data/batch_embed/chunks_meta.jsonl (metadata per chunk, check jurisdiction field)
# - data/batch_embed/batch_000.jsonl (batch requests, check chunk text has header)
```

### Vectorize index info (PRODUCTION — do not delete casually)

- Index name: `cyprus-law-cases-search`
- ~2.27M vectors, 1536 dimensions, cosine metric
- Metadata indexes: year, court, court_level, subcourt (adding: jurisdiction)
- Upsert overwrites existing vectors by ID
- `full-reset` command in batch_ingest.py deletes + recreates the index

---

## Context

Two high-priority tasks + post-launch cleanup + new metadata extraction. Since all require re-embedding, we batch into one `batch_ingest.py run` (~$15, ~40 min via OpenAI Batch API).

**Current state:** 2.27M vectors in `cyprus-law-cases-search`, embedded as raw chunk text with no context, areiospagos classified as `supreme`.

### Design principle

**Preserve original terminology.** We use exactly the terms judges write in their decisions. Cleaning removes only formatting/encoding noise — Markdown syntax (`*`, `#`, `[text](/path)` → `text`), broken encoding (C1 control chars), invisible unicode (NBSP, soft hyphens), and horizontal rules. No semantic renaming, no invented categories. See change #5 for the full cleaning spec.

---

## Changes

### 1. Reclassify areiospagos as `foreign`

**File:** `rag/chunker.py` line 41

```python
# Before
"areiospagos": "supreme",
# After
"areiospagos": "foreign",
```

Also update `Chunk.court_level` docstring (line 70) to include `foreign`.

**Why:** Areiospagos is the Greek Supreme Court (46K cases, ~700K vectors). Currently classified as `supreme`, it dominates Cypriot supreme court searches. With `foreign`, it's excluded from `court_level=supreme` filter automatically.

---

### 2. Extract ΔΙΚΑΙΟΔΟΣΙΑ (jurisdiction / dispute type)

**File:** `rag/chunker.py` — new function `_extract_jurisdiction()`

#### How ΔΙΚΑΙΟΔΟΣΙΑ appears in documents

After the `**ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ:**` marker, within the first ~30 lines of the decision text, there's often a line containing the word `ΔΙΚΑΙΟΔΟΣΙΑ`. Examples from real documents:

```
ΔΙΚΑΙΟΔΟΣΙΑ ΓΟΝΙΚΗΣ ΜΕΡΙΜΝΑΣ              (family court — custody)
ΔΙΚΑΙΟΔΟΣΙΑ ΔΙΑΤΡΟΦΗΣ                      (family court — alimony)
ΔΙΚΑΙΟΔΟΣΙΑ ΠΕΡΙΟΥΣΙΑΚΩΝ ΔΙΑΦΟΡΩΝ         (family court — property)
ΕΦΕΤΕΙΟ ΚΥΠΡΟΥ - ΠΟΛΙΤΙΚΗ ΔΙΚΑΙΟΔΟΣΙΑ    (appeal — civil)
ΕΦΕΤΕΙΟ ΚΥΠΡΟΥ - ΠΟΙΝΙΚΗ ΔΙΚΑΙΟΔΟΣΙΑ     (appeal — criminal)
ΑΝΑΘΕΩΡΗΤΙΚΗ ΔΙΚΑΙΟΔΟΣΙΑ                  (review jurisdiction)
ΔΕΥΤΕΡΟΒΑΘΜΙΑ ΔΙΚΑΙΟΔΟΣΙΑ                 (supreme — appellate)
ΔΙΚΑΙΟΔΟΣΙΑ ΠΤΩΧΕΥΣΕΩΝ                    (civil — bankruptcy)
ΔΙΚΑΙΟΔΟΣΙΑ ΝΑΥΤΟΔΙΚΕΙΟΥ                  (admiralty)
```

#### Coverage (from research)


| Court                     | Total docs | With ΔΙΚΑΙΟΔΟΣΙΑ | Coverage |
| ------------------------- | ---------- | ---------------- | -------- |
| Εφετείο (Appeal)          | 1,111      | 1,106            | 99.5%    |
| Οικογενειακό (Family)     | 1,389      | 832              | 60%      |
| Ανώτατο/aad (Old Supreme) | 45,015     | 22,830           | 50.7%    |
| Πολιτικό/pol (Civil)      | 23,839     | 283              | 1.2%     |


#### Extraction logic

```python
def _extract_jurisdiction(text: str) -> str:
    """Extract jurisdiction line from document body.
    
    Looks for line containing ΔΙΚΑΙΟΔΟΣΙΑ in the first 30 lines
    after ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ. Returns the original text cleaned
    only of Markdown artifacts. No semantic transformation.
    """
    parts = re.split(r'\*{0,4}ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ\*{0,4}', text, maxsplit=1)
    if len(parts) < 2:
        return ""
    
    for line in parts[1].split("\n")[:30]:
        cleaned = _clean_markdown(line)  # strip *, #, normalize whitespace only
        if "ΔΙΚΑΙΟΔΟΣΙΑ" in cleaned:
            return cleaned
    
    return ""
```

#### Cleaning rules (NOT normalization)

Only remove Markdown/parsing artifacts. Original legal terminology stays intact:


| Raw (from .md file)                     | After cleaning                          |
| --------------------------------------- | --------------------------------------- |
| `**ΔΙΚΑΙΟΔΟΣΙΑ****ΓΟΝΙΚΗΣ ΜΕΡΙΜΝΑΣ**`   | `ΔΙΚΑΙΟΔΟΣΙΑ ΓΟΝΙΚΗΣ ΜΕΡΙΜΝΑΣ`          |
| `ΔΙΚΑΙΟΔΟΣΙΑ ΔΙΑΤΡΟΦΗΣ`                 | `ΔΙΚΑΙΟΔΟΣΙΑ ΔΙΑΤΡΟΦΗΣ`                 |
| `### ΑΝΑΘΕΩΡΗΤΙΚΗ ΔΙΚΑΙΟΔΟΣΙΑ`          | `ΑΝΑΘΕΩΡΗΤΙΚΗ ΔΙΚΑΙΟΔΟΣΙΑ`              |
| `ΕΦΕΤΕΙΟ ΚΥΠΡΟΥ ‑ ΠΟΛΙΤΙΚΗ ΔΙΚΑΙΟΔΟΣΙΑ` | `ΕΦΕΤΕΙΟ ΚΥΠΡΟΥ - ΠΟΛΙΤΙΚΗ ΔΙΚΑΙΟΔΟΣΙΑ` |


What we strip: `*`, `#`, normalize `‑` (U+2011) to `-`, collapse multiple spaces to single.
What we keep: everything else — court prefixes, word order, case, the word ΔΙΚΑΙΟΔΟΣΙΑ itself.

#### `_clean_markdown()` helper

```python
def _clean_markdown(line: str) -> str:
    """Remove Markdown formatting artifacts from a line."""
    cleaned = line.replace("*", "").replace("#", "")
    cleaned = cleaned.replace("\u2011", "-")  # non-breaking hyphen
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned
```

#### Fallback: proceeding type from path

When ΔΙΚΑΙΟΔΟΣΙΑ is not found in the document (~50% of docs), derive from file path. Uses standard Greek legal terms in the same `ΔΙΚΑΙΟΔΟΣΙΑ` pattern found in real documents:

```python
_JURISDICTION_FALLBACK: dict[str, str] = {
    # Subcourts (apofaseised) — detected from doc_id containing these path segments
    "pol": "ΠΟΛΙΤΙΚΗ ΔΙΚΑΙΟΔΟΣΙΑ",
    "poin": "ΠΟΙΝΙΚΗ ΔΙΚΑΙΟΔΟΣΙΑ",
    "oik": "ΟΙΚΟΓΕΝΕΙΑΚΗ ΔΙΚΑΙΟΔΟΣΙΑ",
    "enoik": "ΔΙΚΑΙΟΔΟΣΙΑ ΕΝΟΙΚΙΟΣΤΑΣΙΟΥ",
    "erg": "ΕΡΓΑΤΙΚΗ ΔΙΚΑΙΟΔΟΣΙΑ",
    # AAD meros — detected from doc_id containing meros_N/
    "meros_1": "ΠΟΙΝΙΚΗ ΔΙΚΑΙΟΔΟΣΙΑ",
    "meros_2": "ΠΟΛΙΤΙΚΗ ΔΙΚΑΙΟΔΟΣΙΑ",
    "meros_3": "ΕΡΓΑΤΙΚΗ ΔΙΚΑΙΟΔΟΣΙΑ",
    "meros_4": "ΔΙΟΙΚΗΤΙΚΗ ΔΙΚΑΙΟΔΟΣΙΑ",
}
```

Detection: check `doc_id` string for subcourt codes (`/pol/`, `/poin/`, etc.) or meros segments (`meros_1/`, etc.).

#### New Chunk field

Add `jurisdiction: str = ""` to `Chunk` dataclass (after `court_level`).

---

### 3. Contextual header on every chunk

**File:** `rag/chunker.py` — modify `chunk_document()`

#### Header format examples (from real data patterns)

```
Δικαστήριο: Εφετείο | ΕΦΕΤΕΙΟ ΚΥΠΡΟΥ - ΠΟΙΝΙΚΗ ΔΙΚΑΙΟΔΟΣΙΑ | Έτος: 2024 | ΓΕΝΙΚΟΣ ΕΙΣΑΓΓΕΛΕΑΣ ν. ΝΕΣΤΟΡΟΣ

[chunk text]
```

```
Δικαστήριο: Οικογενειακό Δικαστήριο | ΔΙΚΑΙΟΔΟΣΙΑ ΓΟΝΙΚΗΣ ΜΕΡΙΜΝΑΣ | Έτος: 2023 | Χριστοδούλου ν. Χριστοδούλου

[chunk text]
```

```
Δικαστήριο: Επαρχιακό Δικαστήριο | ΠΟΛΙΤΙΚΗ ΔΙΚΑΙΟΔΟΣΙΑ | Έτος: 2013 | Τράπεζα Κύπρου ν. Κυριακίδη

[chunk text]
```

No jurisdiction (rare — when neither doc nor path provides it):

```
Δικαστήριο: Άρειος Πάγος (Ελλάδα) | Έτος: 2024 | Title

[chunk text]
```

#### Implementation

```python
def _build_chunk_header(court_name: str, jurisdiction: str, year: str, title: str) -> str:
    parts = [f"Δικαστήριο: {court_name}"]
    if jurisdiction:
        parts.append(jurisdiction)
    if year:
        parts.append(f"Έτος: {year}")
    if title:
        parts.append(title[:120])
    return " | ".join(parts)
```

In `chunk_document()`, after splitting, prepend header to each chunk's text:

```python
header = _build_chunk_header(court_display, jurisdiction, year, title)
for i, chunk_text in enumerate(raw_chunks):
    full_text = header + "\n\n" + chunk_text
    # ... create Chunk with text=full_text
```

#### Court display names mapping

```python
_COURT_DISPLAY_NAME: dict[str, str] = {
    "aad": "Ανώτατο Δικαστήριο",
    "supreme": "Ανώτατο Δικαστήριο (νέο)",
    "supremeAdministrative": "Ανώτατο Συνταγματικό Δικαστήριο",
    "areiospagos": "Άρειος Πάγος (Ελλάδα)",
    "courtOfAppeal": "Εφετείο",
    "administrativeCourtOfAppeal": "Διοικητικό Εφετείο",
    "apofaseised": "Επαρχιακό Δικαστήριο",
    "administrative": "Διοικητικό Δικαστήριο",
    "administrativeIP": "Διοικητικό Δικαστήριο Διεθνούς Προστασίας",
    "juvenileCourt": "Δικαστήριο Παίδων",
    "epa": "Επιτροπή Προστασίας Ανταγωνισμού",
    "aap": "Αναθεωρητική Αρχή Προσφορών",
    "jsc": "Supreme Court of Cyprus",
    "rscc": "Supreme Constitutional Court",
    "clr": "Cyprus Law Reports",
    "dioikitiko": "Διοικητικό Δικαστήριο",
}
```

- Header goes into `chunk.text` (what gets embedded by OpenAI)
- Metadata fields stay clean (no header text in metadata)
- Header is ~80-180 chars, well within the 2000-char chunk budget

---

### 4. Strip ΑΝΑΦΟΡΕΣ noise

**File:** `rag/chunker.py` — new helper `_strip_references()`

#### Document structure (see docs/DOCUMENT_METADATA_RESEARCH.md for full canonical structure)

```
# Title                              <- KEEP
**ΑΝΑΦΟΡΕΣ:**                        <- STRIP from here
Κυπριακή νομολογία...               <- STRIP (cross-references)
[Case A](/path/a.md)                 <- STRIP (but extract cross_refs first!)
[Case B](/path/b.md)                 <- STRIP
Κυπριακή νομοθεσία...               <- STRIP (legislation refs)
[Law X](/path/x.html)               <- STRIP
**ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ:**                <- STRIP this marker, keep everything after
ECLI:CY:...
Actual decision text...              <- KEEP
```

#### Implementation logic

1. Call `_extract_cross_refs(text)` BEFORE stripping — we still want cross-ref metadata
2. Call `_extract_jurisdiction(text)` BEFORE stripping — jurisdiction is AFTER ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ, but it's safer to extract from full text
3. Find `ΑΝΑΦΟΡΕΣ` marker (regex for `\*{0,4}ΑΝΑΦΟΡΕΣ\*{0,4}`)
4. Find `ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ` marker (regex for `\*{0,4}ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ\*{0,4}`)
5. Keep: everything before ΑΝΑΦΟΡΕΣ (title line) + everything after ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ
6. If markers not found, return text unchanged

**Important:** Some documents don't have these markers. The function must be defensive — no crash on missing markers.

---

### 5. Clean chunk text from formatting/encoding noise

**File:** `rag/chunker.py` — new function `_clean_chunk_text()`

Applied to the decision text AFTER `_strip_references()` and BEFORE the text splitter runs. This ensures the splitter and embeddings see only clean legal text.

#### What we clean (research-verified on 102 real documents across all courts)


| Category             | What                     | Example                                                                                                             | Savings   |
| -------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------- | --------- |
| Markdown links       | `[text](/path)` → `text` | `[Βίκης ν. Νεοφύτου (1990) 1 ΑΑΔ 345](/aad/meros_1/1990/rep/1990_1_0345.md)` → `Βίκης ν. Νεοφύτου (1990) 1 ΑΑΔ 345` | 1.5%      |
| Markdown bold/italic | Remove `*`               | `**ΑΠΟΦΑΣΗ**` → `ΑΠΟΦΑΣΗ`                                                                                           | 1.3%      |
| Markdown headers     | Remove `#`               | `## ΕΠΑΡΧΙΑΚΟ ΔΙΚΑΣΤΗΡΙΟ` → `ΕΠΑΡΧΙΑΚΟ ΔΙΚΑΣΤΗΡΙΟ`                                                                  | <0.1%     |
| C1 control chars     | Remove U+0080–U+009F     | Broken encoding of `€`, quotes, dashes                                                                              | 0.1%      |
| NBSP                 | U+00A0 → regular space   | Invisible spaces that break tokenization                                                                            | normalize |
| Non-breaking hyphen  | U+2011 → `-`             | `ΕΦΕΤΕΙΟ‑ΚΥΠΡΟΥ` → `ΕΦΕΤΕΙΟ-ΚΥΠΡΟΥ`                                                                                 | normalize |
| Soft hyphen          | Remove U+00AD            | Invisible line-break hints                                                                                          | remove    |
| Combining dot        | Remove U+0358            | OCR/parsing artifact                                                                                                | remove    |
| Horizontal rules     | Remove `---`, `___` etc. | Section dividers                                                                                                    | 0.06%     |
| Extra blank lines    | 3+ newlines → 2          | Wasted vertical space                                                                                               | 0.02%     |
| Multiple spaces      | 2+ spaces → 1            | Collapsed from removed `*` chars                                                                                    | normalize |


**Total savings: ~6% of document text** → each 2000-char chunk carries ~120 more chars of real legal content.

#### Implementation

```python
def _clean_chunk_text(text: str) -> str:
    """Clean formatting/encoding noise from document text.
    
    Only removes noise. Never touches legal content or terminology.
    Called AFTER _strip_references(), BEFORE text splitting.
    """
    # 1. Strip markdown link syntax: [text](/path) -> text
    text = re.sub(r'\[([^\]]*)\]\([^)]*\)', r'\1', text)
    
    # 2. Remove markdown formatting
    text = text.replace("*", "").replace("#", "")
    
    # 3. Remove C1 control chars (broken encoding artifacts: €, quotes, dashes)
    text = re.sub(r'[\x80-\x9f]', '', text)
    
    # 4. Normalize invisible unicode
    text = text.replace('\u00a0', ' ')   # NBSP → regular space
    text = text.replace('\u2011', '-')   # non-breaking hyphen → regular hyphen
    text = text.replace('\u00ad', '')    # soft hyphen → remove
    text = text.replace('\u0358', '')    # combining dot → remove
    
    # 5. Remove horizontal rules (3+ dashes or underscores on a line)
    text = re.sub(r'^[-_]{3,}$', '', text, flags=re.MULTILINE)
    
    # 6. Collapse whitespace
    text = re.sub(r'\n{3,}', '\n\n', text)
    text = re.sub(r' {2,}', ' ', text)
    
    return text.strip()
```

#### Relationship with `_clean_markdown()`

`_clean_markdown()` is a **line-level** helper used only by `_extract_jurisdiction()` to clean a single line for the jurisdiction field. `_clean_chunk_text()` is a **document-level** cleaner applied to the full text before chunking. They share some logic (removing `*`, `#`, normalizing hyphens) but serve different purposes.

---

### 6. Merge small tail chunks (<500 chars)

After `_splitter.split_text(text)`, if the last chunk is smaller than 500 chars AND there are at least 2 chunks, append the last chunk's text to the previous chunk. This prevents tiny context-poor tail fragments from polluting search results.

---

### 7. New `jurisdiction` metadata in Vectorize

**File:** `scripts/batch_ingest.py`

#### In `step_prepare()` (~line 242)

Add jurisdiction to the metadata dict written to `chunks_meta.jsonl`:

```python
meta = {
    "idx": i,
    "doc_id": chunk["doc_id"],
    "court": chunk["court"],
    "year": chunk["year"],
    "title": chunk["title"][:200],
    "chunk_index": chunk["chunk_index"],
    "court_level": chunk.get("court_level", ...),
    "subcourt": chunk.get("subcourt", ...),
    "jurisdiction": chunk.get("jurisdiction", ""),  # NEW
}
```

#### In `_parse_batch_vectors()` (~line 440)

Same — add jurisdiction to the vector metadata dict:

```python
"metadata": {
    "doc_id": meta["doc_id"],
    ...existing...,
    "jurisdiction": meta.get("jurisdiction", ""),  # NEW
}
```

#### New metadata index (~line 156)

Add to `REQUIRED_METADATA_INDEXES`:

```python
{"propertyName": "jurisdiction", "indexType": "string"},
```

Total indexes after: 5 (year, court, court_level, subcourt, jurisdiction). Vectorize limit is 10.

Note: Vectorize string index uses first 64 bytes. Most jurisdiction values fit (e.g., `ΔΙΚΑΙΟΔΟΣΙΑ ΓΟΝΙΚΗΣ ΜΕΡΙΜΝΑΣ` is ~56 bytes in UTF-8). Longer values like `ΕΦΕΤΕΙΟ ΚΥΠΡΟΥ - ΠΟΛΙΤΙΚΗ ΔΙΚΑΙΟΔΟΣΙΑ` are ~74 bytes and will be truncated for filtering but stored in full in metadata.

---

### 8. Frontend changes

#### retriever.ts (line 73)

```typescript
// Before
if (courtLevel && (courtLevel === "supreme" || courtLevel === "appeal")) {
// After
if (courtLevel && ["supreme", "appeal", "foreign"].includes(courtLevel)) {
```

#### llm-client.ts

- Add `foreign: 5` to `COURT_LEVEL_ORDER` (line ~24)
- Update `search_cases` tool enum: add `"foreign"` to allowed `court_level` values
- Update system prompt (line ~42): change Άρειος Πάγος description to clarify it's Greek (foreign), add guidance that `court_level=foreign` is for Greek court cases
- Update Άρειος Πάγος entry in court list to add "(Ελληνικό - ξένο δικαστήριο)"

---

## Execution Order

### Phase 1: Code changes (no API calls)

1. Edit `rag/chunker.py` — all 7 changes (areiospagos, display names, jurisdiction extraction, strip refs, text cleaning, header, merge tail)
2. Edit `scripts/batch_ingest.py` — add jurisdiction to metadata + index
3. Edit `frontend/lib/retriever.ts` — foreign filter
4. Edit `frontend/lib/llm-client.ts` — tool + prompt + ordering

### Phase 2: Verify locally

```bash
python scripts/batch_ingest.py reset
python scripts/batch_ingest.py prepare --limit 100
```

Then inspect output files:

- `data/batch_embed/chunks_meta.jsonl` — check jurisdiction field values
- `data/batch_embed/batch_000.jsonl` — check chunk text starts with header
- Verify: no ΑΝΑΦΟΡΕΣ in chunk text, no tiny tail chunks
- Verify: no `*` or `#` in chunk text, no markdown links `](/`, no C1 control chars

### Phase 3: Full re-embedding (costs ~$15, takes ~40 min)

```bash
python scripts/batch_ingest.py full-reset
```

This deletes the Vectorize index, recreates it with metadata indexes (including new `jurisdiction`), then runs the full pipeline: chunk all 150K docs → OpenAI Batch API embed → upload to Vectorize.

**WARNING:** `full-reset` causes downtime (~40 min). The production search will not work until re-upload completes.

### Phase 4: Deploy frontend

```bash
cd frontend && npm run deploy
```

### Phase 5: Verify in production

- Search with `court_level=supreme` — should NOT return areiospagos results
- Search family law queries — should see custody/alimony cases ranked higher thanks to jurisdiction in headers
- Check source cards display correctly

---

## Files Changed Summary


| File                                 | Changes                                                                                                                                                                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rag/chunker.py`                     | court_level mapping, `_COURT_DISPLAY_NAME`, `_JURISDICTION_FALLBACK`, `_extract_jurisdiction()`, `_clean_markdown()`, `_clean_chunk_text()`, `_strip_references()`, `_build_chunk_header()`, tail merge, new `jurisdiction` field in Chunk |
| `scripts/batch_ingest.py`            | jurisdiction in metadata dict (2 places), new metadata index                                                                                                                                                                               |
| `frontend/lib/retriever.ts`          | foreign in filter condition                                                                                                                                                                                                                |
| `frontend/lib/llm-client.ts`         | COURT_LEVEL_ORDER, search_cases tool enum, system prompt                                                                                                                                                                                   |
| `docs/DOCUMENT_METADATA_RESEARCH.md` | Already created — research reference                                                                                                                                                                                                       |


