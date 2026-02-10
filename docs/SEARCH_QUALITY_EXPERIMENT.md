# Search Quality Experiment: Pipeline Stage Diagnosis

> **Purpose**: Repeatable test case with ground-truth data to diagnose WHERE relevant documents are lost in the RAG pipeline, and measure the impact of fixes.
>
> **Any agent can run this experiment**. All data, methodology, and expected outcomes are documented below.

## 1. Problem Statement

Our legal research tool uses a three-phase RAG pipeline:
1. **Phase 1 — Vector Search** (`retriever.ts`): LLM generates search queries → Vectorize returns top-K chunks → dedup by document → score filter → return `SearchResult[]`
2. **Phase 1.5 — Reranker** (`llm-client.ts :: rerankDocs`): GPT-4o-mini reads preview of each document, scores 0-10, drops docs scoring < 4
3. **Phase 2 — Summarizer** (`llm-client.ts :: summarizeAllDocs`): GPT-4o reads full document, produces structured summary with relevance rating (HIGH/MEDIUM/LOW/NONE)

**The problem**: For a specific test query, a manual audit of ALL 61 documents found by Phase 1 revealed:
- **3-4 highly relevant** documents exist in the corpus
- The system only surfaces **1-2** of them to the user
- **72% of documents** passed to Phase 1.5 are completely irrelevant (immigration, admin, labor cases)
- The most important document (M. v A. — EU Regulation 2016/1103 analysis) is consistently **filtered out by the reranker**

## 2. Test Query

```
Η εφαρμογή του αλλοδαπού δικαίου σε υποθέσεις περιουσιακών διαφορών στο πλαίσιο διαδικασιών διαζυγίου κατά την τελευταία πενταετία
```

Translation: "Application of foreign law in property disputes within divorce proceedings over the last five years"

Key legal concepts:
- Foreign/international law application (`αλλοδαπό δίκαιο`)
- Matrimonial property disputes (`περιουσιακές διαφορές`)
- Divorce context (`διαζύγιο`)
- EU Regulation 2016/1103 (matrimonial property regimes)
- Conflict of laws (`σύγκρουση νόμων`)
- Cyprus Law 232/1991 on spousal property relations

## 3. Ground Truth — Manually Audited Relevance

### Category A: HIGHLY RELEVANT (must be found)

| ID | Doc Path | Why Relevant |
|----|----------|-------------|
| A1 | `apofaseised/oik/2024/2320240403.md` | E.R v P.R — Russian citizens, Mareva injunction, property division in divorce, application of Russian law to Cyprus property dispute |
| A2 | `apofaseised/oik/2025/2320250270.md` | E.R v P.R (same case, later decision) — freezing €5M+ assets, continued property dispute with foreign element |
| A3 | `apofaseised/oik/2022/2320220243.md` | **M. v A. — THE KEY DOCUMENT**: Direct analysis of EU Regulation 2016/1103 on matrimonial property regimes, international jurisdiction, applicable law in cross-border property disputes. 22 foreign-law mentions, 36 property mentions, 4 divorce mentions. |
| A4 | `courtOfAppeal/2025/202512-E4-25.md` | E.R v P.R appeal — same case at appellate level, Russian-language interview with child, property context |

### Category B: PROBABLY RELEVANT (should be found if pipeline is good)

| ID | Doc Path | Why Relevant |
|----|----------|-------------|
| B1 | `apofaseised/oik/2025/2320250273.md` | A.K v K.K — Property dispute (ΠΕΡΙΟΥΣΙΑΚΩΝ ΔΙΑΦΟΡΩΝ), €5-10M assets, Moscow/Dubai business, English law references |
| B2 | `apofaseised/oik/2025/2320250275.md` | A.K v K.K (same case) — Asset freezing application, Russian extradition reference |
| B3 | `apofaseised/oik/2025/4320250176.md` | Α.Λ v Ι.Τ — Property division in divorce, 6 foreign-law keyword hits |
| B4 | `apofaseised/oik/2022/4320220257.md` | Π.Α v Φ.Γ — Long-running property dispute (since 2008), assets in Cyprus and abroad |
| B5 | `apofaseised/oik/2022/1320220770.md` | O.S v M.S — Property + divorce + foreign law elements |
| B6 | `apofaseised/oik/2024/2320240442.md` | Γ.Χ v Χ.Θ — Property dispute with foreign elements, 4 foreign-law hits |

### Category C: MARGINALLY RELEVANT (domestic property disputes, no foreign law)

| ID | Doc Path | Why |
|----|----------|-----|
| C1 | `apofaseised/oik/2021/2320210501.md` | Domestic property dispute under Law 232/91, no foreign law |
| C2 | `apofaseised/oik/2023/2320230482.md` | Domestic property dispute, no foreign law |
| C3 | `apofaseised/oik/2024/2320240463.md` | Property dispute but primarily custody (41 custody mentions) |
| C4 | `apofaseised/pol/2023/1120230294.md` | Property/divorce jurisdiction dispute, reference to Law 232/91 |
| C5 | `apofaseis/aad/meros_1/2021/1-202112-2-19etcFamApof.md` | Appeal on property dispute, Law 232/91 |
| C6 | `apofaseis/aad/meros_1/2021/1-202106-11-18famAnony.md` | Appeal on property dispute, English law comparison |
| C7 | `apofaseised/pol/2021/3120210196.md` | Civil case with property dispute between ex-spouses |

### Category D: IRRELEVANT (should be filtered out)

~44 documents including:
- 20+ administrative/immigration cases (HOSSAIN, NGUYEN, asylum seekers vs Cyprus)
- 5+ labor, banking, criminal cases
- 8+ pure custody/divorce cases with no property or foreign law
- 1 Greek Supreme Court case about divorce custody (no property/foreign law)
- 1 provident fund, 1 health insurance, 1 rent case

## 4. Pipeline Stages and What to Measure

### Stage 1: LLM Query Generation
- **What**: The LLM (GPT-4o) generates 3-5 search queries based on user input
- **Measure**: Which queries does it generate? Do they cover the key legal terms?
- **Expected queries should include**: `εφαρμογή αλλοδαπού δικαίου`, `Κανονισμός 2016/1103`, `σύγκρουση νόμων`, `περιουσιακές διαφορές διαζύγιο`
- **File**: `frontend/lib/llm-client.ts` → `buildSystemPrompt()` → `QUERY STRATEGY` section

### Stage 2: Vector Search (Retriever)
- **What**: Each query → embed → Vectorize topK=100 → dedup → year filter → score filter → MAX_DOCUMENTS=30
- **Measure**: For each ground-truth doc, what cosine score does it get? Is it above the threshold?
- **Key thresholds**: `MIN_SCORE_THRESHOLD = 0.42`, `SCORE_DROP_FACTOR = 0.75`
- **File**: `frontend/lib/retriever.ts`
- **Critical question**: Are ground-truth docs A1-A4, B1-B6 even IN the top-100 chunks returned by Vectorize?

### Stage 3: Deduplication
- **What**: `seenDocIds` Set in `llm-client.ts` prevents re-processing docs found in earlier searches
- **Measure**: Are any ground-truth docs found in search #1 but then not re-found with better context in #2/#3?
- **File**: `frontend/lib/llm-client.ts` → `seenDocIds`

### Stage 4: Reranker
- **What**: GPT-4o-mini reads `buildRerankPreview()` of each doc, scores 0-10, drops < 4
- **Measure**: What score does GPT-4o-mini assign to each ground-truth doc? Which are dropped?
- **Key threshold**: `RERANK_MIN_SCORE = 4`
- **File**: `frontend/lib/llm-client.ts` → `rerankDocs()`
- **Known issue**: Document A3 (M. v A.) was at position #26 with score 0.47 but was filtered by reranker

### Stage 5: Summarizer
- **What**: GPT-4o reads full document text, produces structured summary with relevance rating
- **Measure**: What relevance rating (HIGH/MEDIUM/LOW/NONE) does each ground-truth doc get?
- **File**: `summarizer-worker/src/index.ts`

## 5. How to Run the Experiment

### Prerequisites
1. Dev server running: `cd frontend && npm run dev` (port 3000)
2. `.env.local` configured with OpenAI + Cloudflare credentials
3. Node.js 18+

### Method A: Full Pipeline Test (E2E via SSE)
```bash
node scripts/deep_dive_query.mjs
```
This runs the full pipeline through the API. Output shows:
- All search queries generated
- All documents found with scores
- All summaries with relevance ratings

**Limitation**: Cannot see reranker decisions (reranking happens server-side, not emitted via SSE).

### Method B: Stage-by-Stage Diagnostic (TO BE BUILT)
```bash
node scripts/pipeline_stage_test.mjs
```
This script should:
1. **Stage 1**: Call `/api/chat` and capture all `searching` events → see which queries were generated
2. **Stage 2**: For each ground-truth doc, directly query Vectorize with each search query and report the score
3. **Stage 3**: Check if ground-truth docs appear in the `sources` SSE event
4. **Stage 4**: Manually call the reranker on all ground-truth docs and report scores
5. **Stage 5**: Check if ground-truth docs appear in `summaries` SSE events with their relevance ratings

### Method C: Isolated Reranker Test (TO BE BUILT)
```bash
node scripts/test_reranker.mjs
```
This script should:
1. Fetch full text of all ground-truth docs (A1-A4, B1-B6)
2. Build `buildRerankPreview()` for each
3. Send them to GPT-4o-mini with the same reranker prompt
4. Report the score each doc gets
5. Show the preview text that was sent (for debugging prompt quality)

## 6. Success Criteria

| Metric | Current | Target |
|--------|---------|--------|
| A-category docs found | 2 of 4 | **4 of 4** |
| B-category docs found | 0 of 6 | **≥ 3 of 6** |
| C-category docs found | 0 of 7 | 0-2 (acceptable to miss) |
| D-category docs reaching summarizer | ~13 | **≤ 5** |
| Hit rate (HIGH+MEDIUM / summarized) | 13% | **≥ 30%** |
| Total docs summarized | 15 | **≤ 20** |
| Cost per query | ~$1.50 | **≤ $1.00** |

## 7. Hypothesis: Where Documents Are Lost

Based on manual analysis:

### Hypothesis 1: Reranker filters too aggressively
- **Evidence**: A3 (M. v A., score 0.47) was in search results but not in final output
- **Test**: Run isolated reranker on A3 and check its score
- **Fix options**: Lower threshold, improve preview extraction, improve prompt

### Hypothesis 2: Vector search doesn't find relevant docs at all
- **Evidence**: Some B-category docs may not appear in top-100 chunks
- **Test**: Directly embed the query and check each ground-truth doc's cosine similarity
- **Fix options**: Better chunking, hybrid search (BM25), query reformulation

### Hypothesis 3: LLM generates redundant queries that don't cover all facets
- **Evidence**: All 3 queries tend to be variations of "foreign law + divorce + property"
- **Test**: Check if adding queries like `Κανονισμός 2016/1103 περιουσιακές σχέσεις` would surface A3
- **Fix options**: More specific query templates, force EU regulation search

### Hypothesis 4: Reranker preview doesn't capture enough legal substance
- **Evidence**: Preview shows title + procedural header (court, parties) + tail (costs/signatures)
- **Test**: Compare reranker scores for A3 with different preview strategies
- **Fix options**: Extract first substantive paragraph, skip procedural metadata

## 8. Document Structure Reference

Cypriot court documents have this structure:
```
# Title (case name, number, date)

**ΑΝΑΦΟΡΕΣ:**                          ← Cross-references (NOISE for reranking)
[list of referenced cases and laws]

**ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ:**                  ← Decision text marker

**COURT NAME**                          ← Court, jurisdiction type
**ΔΙΚΑΙΟΔΟΣΙΑ ΠΕΡΙΟΥΣΙΑΚΩΝ ΔΙΑΦΟΡΩΝ**  ← Jurisdiction type (KEY SIGNAL!)
ΕΝΩΠΙΟΝ: Judge name
Case number, parties, date

[Opening paragraphs - facts]            ← USEFUL for reranking
[Legal analysis]                        ← MOST USEFUL
[Conclusion / ruling]                   ← USEFUL for reranking

(Signature)                             ← NOISE
ΠΙΣΤΟΝ ΑΝΤΙΓΡΑΦΟΝ                      ← NOISE
ΠΡΩΤΟΚΟΛΛΗΤΗΣ                           ← NOISE
```

For non-Cypriot docs (areiospagos, etc.): no `ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ` marker, entire text is the decision.

## 9. Key Files

| File | Role |
|------|------|
| `frontend/lib/llm-client.ts` | LLM orchestration, system prompt, reranker, query generation |
| `frontend/lib/retriever.ts` | Vector search, score filtering, year filtering |
| `frontend/lib/vectorize-client.ts` | Cloudflare Vectorize API client |
| `summarizer-worker/src/index.ts` | Document summarization with relevance rating |
| `scripts/deep_dive_query.mjs` | E2E diagnostic tool |
| `rag/chunker.py` | How documents were chunked for embedding |
| `scripts/batch_ingest.py` | Embedding pipeline |

## 10. Keyword Fingerprints for Ground-Truth Documents

These keyword counts help verify document identity and relevance:

| Doc | foreign_law* | property** | divorce*** | custody |
|-----|-------------|-----------|---------|---------|
| A1 (`2320240403`) | 84 | 145 | 5 | 23 |
| A2 (`2320250270`) | 24 | 109 | 2 | 6 |
| A3 (`2320220243`) | 22 | 36 | 4 | 0 |
| A4 (`202512-E4-25`) | 3 | 0 | 2 | — |
| B1 (`2320250273`) | 9 | 28 | 0 | 1 |
| B2 (`2320250275`) | 7 | 49 | 0 | 12 |
| B3 (`4320250176`) | 6 | 29 | 6 | 14 |
| B4 (`4320220257`) | 5 | 34 | 2 | 14 |
| B5 (`1320220770`) | 3 | 11 | 2 | 1 |
| B6 (`2320240442`) | 4 | 18 | 1 | 0 |

\* `αλλοδαπ|Κανονισμ.*1103|σύγκρουση νόμων|ρωσικ|αγγλικ|γερμανικ|ιδιωτικό διεθνές|lex causae`
\*\* `περιουσιακ|ακίνητη|κινητή περιουσί|property|Mareva|δέσμευση|freezing`
\*\*\* `διαζύγι|διαζυγ|λύση.*γάμου|divorce`

## 11. Run Log

Record each experiment run here:

### Run 1: 2026-02-10 (baseline, before fixes)
- **Setup**: head+decision+tail reranker preview
- **Queries generated**: 3 (facet-based)
- **Sources found**: ~70 unique docs (deduplicated across 3 searches)
- **After reranker**: 12 (RERANK_MAX_DOCS_IN=60, threshold ≥4)
- **After summarizer**: 2 HIGH, 0 MEDIUM, 10 NONE
- **Ground truth tracking**:

  | ID | Vec Score | In Sources | Summarized | Relevance | Lost At |
  |----|-----------|-----------|------------|-----------|---------|
  | A1 | 0.4225 | ✅ | ✅ | HIGH | — |
  | A2 | 0.4203 | ✅ | ✅ | HIGH | — |
  | A3 | 0.4609 | ✅ | ❌ | — | **RERANKER** |
  | A4 | — | ❌ | ❌ | — | **VECTOR SEARCH** |
  | B1 | 0.4534 | ✅ | ✅ | NONE | **SUMMARIZER** |
  | B2 | 0.4204 | ✅ | ✅ | NONE | **SUMMARIZER** |
  | B3 | 0.4727 | ✅ | ❌ | — | **RERANKER** |
  | B4 | 0.4508 | ✅ | ✅ | NONE | **SUMMARIZER** |
  | B5 | — | ❌ | ❌ | — | **VECTOR SEARCH** |
  | B6 | 0.4419 | ✅ | ✅ | NONE | **SUMMARIZER** |
  | C1 | 0.4296 | ✅ | ✅ | NONE | — (correct) |
  | C2 | 0.4203 | ✅ | ✅ | NONE | — (correct) |
  | C3 | 0.4393 | ✅ | ✅ | NONE | — (correct) |

- **Isolated reranker test** (13 ground-truth docs only):
  - A: 4/4 kept (scores 4-6), B: 4/6 kept, C: 2/3 kept
  - A3 scored 4 (borderline), B3 scored 3 (dropped)
  - In real E2E with 60+ mixed docs, A3 gets dropped — batch noise effect

- **Hit rate**: 2/12 = 17%
- **Time**: 134s
- **Cost**: ~$1.50

#### Diagnosis Summary
Three distinct failure modes:
1. **Vector search** misses A4, B5 (not in top-100 chunks at all)
2. **Reranker** drops A3 and B3 (borderline scores, batch noise effect with 60 docs)
3. **Summarizer** marks B1,B2,B4,B6 as NONE (too strict — these have foreign law elements but summarizer doesn't recognize partial relevance)

#### Root Cause Analysis
1. `RERANK_MAX_DOCS_IN=60` truncates — docs from search #3 may be dropped without evaluation
2. `allFoundDocs` is NOT sorted by score before reranking — docs are in search-order, not quality-order
3. Reranker preview doesn't capture enough legal substance for borderline cases
4. Summarizer relevance criteria is vague — no explicit guidance on what constitutes "relevant"
5. **Batch attention degradation** — sending 60+ docs in ONE GPT-4o-mini call causes the model to lose calibration and score everything low

### Run 2: 2026-02-10 (after fixes)
- **Fixes applied**:
  1. Sort `allFoundDocs` by vector score (desc) before reranking
  2. Increase `RERANK_MAX_DOCS_IN` from 60 to 90
  3. Process reranker in batches of 20 (prevents attention degradation)
  4. Extract `Subject:` line from documents and include in preview
  5. Enrich summarizer `focus` with `legal_context` from LLM tool calls
  6. Emit `reranked` SSE event with scores for each document
- **Queries generated**: 3 (facet-based)
- **Sources found**: 57
- **After reranker**: 30 (57 → 30, batches of 20)
- **After summarizer**: 5 HIGH, 1 MEDIUM, 24 NONE

  | ID | Vec Score | In Sources | Rerank | Kept? | Summarized | Relevance | Lost At |
  |----|-----------|-----------|--------|-------|------------|-----------|---------|
  | A1 | 0.423 | ✅ | 6 | ✅ | ✅ | HIGH | — |
  | A2 | 0.420 | ✅ | 6 | ✅ | ✅ | HIGH | — |
  | A3 | 0.471 | ✅ | **5** | ✅ | ✅ | **HIGH** | — (**FIXED!**) |
  | A4 | — | ❌ | — | — | ❌ | — | VECTOR SEARCH |
  | B1 | 0.454 | ✅ | 6 | ✅ | ✅ | NONE | SUMMARIZER |
  | B2 | 0.421 | ✅ | 6 | ✅ | ✅ | NONE | SUMMARIZER |
  | B3 | 0.473 | ✅ | 5 | ✅ | ✅ | NONE | SUMMARIZER |
  | B4 | 0.451 | ✅ | 5 | ✅ | ✅ | MEDIUM | — |
  | B5 | — | ❌ | — | — | ❌ | — | VECTOR SEARCH |
  | B6 | 0.442 | ✅ | 5 | ✅ | ✅ | NONE | SUMMARIZER |
  | C1 | 0.430 | ✅ | 5 | ✅ | ✅ | NONE | — (correct) |
  | C2 | 0.420 | ✅ | 6 | ✅ | ✅ | HIGH | — (false positive) |
  | C3 | 0.439 | ✅ | 5 | ✅ | ✅ | HIGH | — (false positive) |

- **Key improvement**: A3 (M. v A. — EU Reg 2016/1103) now correctly found with reranker score 5 and summarizer rating HIGH
- **Remaining issues**:
  - A4, B5 not in vector search (need hybrid search or better embeddings)
  - B-docs mostly NONE from summarizer (they have international elements but don't deeply discuss foreign law application)
  - C2, C3 false positives from summarizer (domestic cases rated HIGH)
- **Hit rate**: 6/30 = 20% (up from 13%)
- **Time**: 200s (up from 134s due to more docs summarized)
- **Next steps**: Tune summarizer prompt, consider hybrid search for A4/B5
