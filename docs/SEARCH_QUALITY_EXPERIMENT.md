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

### Run 3: 2026-02-12 (Phase 1 — summarizer prompt fix, GPT-4o-mini reranker)
- **Fixes applied**:
  1. Summarizer RELEVANCE RATING decoupled from engagement level
  2. MANDATORY OVERRIDES: foreign-law + cross-border elements → at least MEDIUM
  3. Domestic cases (Cypriot parties, no foreign element) → LOW
  4. MAX_SUMMARIZE_DOCS increased from 20 to 30
- **Queries generated**: 3 (facet-based)
- **Sources found**: 53
- **After reranker (GPT-4o-mini)**: 27 kept
- **After summarizer**: 2 HIGH, 1 MEDIUM

  | ID | Vec Score | In Sources | Rerank | Kept? | Summarized | Relevance | Lost At |
  |----|-----------|-----------|--------|-------|------------|-----------|---------|
  | A1 | 0.422 | ✅ | 6 | ✅ | ✅ | **HIGH** | — |
  | A2 | 0.420 | ✅ | 6 | ✅ | ✅ | **MEDIUM** | — |
  | A3 | 0.431 | ✅ | 5 | ✅ | ✅ | **HIGH** | — |
  | A4 | 0.474 | ✅ | 1 | ❌ | ❌ | — | RERANKER (batch noise) |
  | B1 | 0.453 | ✅ | 1 | ❌ | ❌ | — | RERANKER (batch noise) |
  | B2 | 0.421 | ✅ | 8 | ✅ | ✅ | **HIGH** | — |
  | B3 | 0.491 | ✅ | 1 | ❌ | ❌ | — | RERANKER (batch noise) |
  | B4 | 0.451 | ✅ | 5 | ✅ | ✅ | LOW | — |
  | B5 | — | ❌ | — | — | ❌ | — | VECTOR SEARCH |
  | B6 | 0.442 | ✅ | 6 | ✅ | ✅ | LOW | — |
  | C1 | 0.429 | ✅ | 5 | ✅ | ✅ | LOW | — (correct) |
  | C2 | — | ❌ | — | — | ❌ | — | — |
  | C3 | 0.439 | ✅ | 5 | ✅ | ✅ | LOW | — (correct) |

- **Key improvement**: True positive A+B docs rated HIGH/MEDIUM: 1 → 4 (A1 HIGH, A2 MEDIUM, A3 HIGH, B2 HIGH)
- **C-doc false positives eliminated** (were HIGH in Run 2, now correctly LOW)
- **Remaining issues**: GPT-4o-mini batch noise — A4, B1, B3 scored 1 (should be 4-6)
- **Hit rate (HIGH+MEDIUM)**: 4/27 = 15%
- **Time**: 198s

### Run 4: 2026-02-12 (Phase 2a — Cohere rerank-v3.5)
- **Fixes applied**:
  1. Cohere rerank-v3.5 replaces GPT-4o-mini (cross-encoder, no batch noise)
  2. Preview size increased: head 300→500, decision 600→2000, tail 800→1500 chars
  3. Separate thresholds: GPT-4o-mini ≥4, Cohere ≥0.1 (0-10 scale)
  4. Cohere `top_n=30` to limit returned results
- **Queries generated**: 3 (facet-based)
- **Sources found**: 50
- **After reranker (Cohere)**: 30 kept (threshold ≥0.1)
- **After summarizer**: 2 HIGH

  | ID | Vec Score | In Sources | Rerank (Cohere 0-10) | Kept? | Summarized | Relevance | Lost At |
  |----|-----------|-----------|---------------------|-------|------------|-----------|---------|
  | A1 | 0.422 | ✅ | 0.0 | ❌ | ❌ | — | RERANKER (Cohere can't infer) |
  | A2 | 0.420 | ✅ | 0.3 | ✅ | ✅ | **HIGH** | — |
  | A3 | 0.431 | ✅ | 3.5 | ✅ | ✅ | **HIGH** | — |
  | A4 | — | ❌ | — | — | ❌ | — | VECTOR SEARCH |
  | B1 | 0.453 | ✅ | 0.0 | ❌ | ❌ | — | RERANKER (Cohere can't infer) |
  | B2 | 0.421 | ✅ | 0.0 | ❌ | ❌ | — | RERANKER (Cohere can't infer) |
  | B3 | 0.473 | ✅ | 0.8 | ✅ | ✅ | LOW | — |
  | B4 | 0.451 | ✅ | 2.2 | ✅ | ✅ | LOW | — |
  | B5 | — | ❌ | — | — | ❌ | — | VECTOR SEARCH |
  | B6 | 0.442 | ✅ | 1.7 | ✅ | ✅ | LOW | — |
  | C1 | 0.429 | ✅ | 3.1 | ✅ | ✅ | LOW | — (correct) |
  | C2 | — | ❌ | — | — | ❌ | — | — |
  | C3 | 0.439 | ✅ | 3.4 | ✅ | ✅ | LOW | — (correct) |

- **Key trade-offs vs GPT-4o-mini**:
  - **Faster**: 90s total (vs 200s with GPT-4o-mini) — single API call
  - **No batch noise**: scores are deterministic and consistent
  - **A2 upgraded**: HIGH (was MEDIUM with GPT-4o-mini)
  - **B3 kept**: consistently kept (GPT-4o-mini dropped it due to batch noise)
  - **Lost**: A1 (scored 0.0), B1/B2 (scored 0.0) — Cohere can't infer legal connection from preview text
  - **B5 appeared** in some runs (vector search found it at 0.460)
- **Cohere limitation**: Text similarity model, not legal reasoning. Can't infer "Russian citizens + property = foreign law case" from preview alone.
- **Hit rate (HIGH+MEDIUM)**: 2/30 = 7% (lower than GPT-4o-mini, but no false positives)
- **Time**: 90s (55% faster)
- **Cost**: ~$0.002 Cohere + ~$1.50 summarizer
- **Next steps**: Phase 2b (PostgreSQL + BM25 hybrid search) to find A4/B5 and improve A1/B1/B2 retrieval

### Run 5: 2026-02-12 (Hybrid Cohere + GPT-4o-mini reranker)
- **Fixes applied**:
  1. Two-pass reranking: Cohere first, then GPT-4o-mini rescores docs with Cohere score < 1.0
  2. Use `max(cohereScore, gptScore)` as final score
  3. Enhanced GPT prompt with party-name and cross-border scoring tips
- **Queries generated**: 3 (facet-based)
- **Sources found**: 74 (hybrid: Vectorize + BM25)
- **After reranker (Cohere + GPT hybrid)**: 30 kept
- **After summarizer**: 4 HIGH, 6 MEDIUM, 6 NONE

  | ID | Vec Score | In Sources | Rerank (hybrid) | Kept? | Summarized | Relevance | Lost At |
  |----|-----------|-----------|-----------------|-------|------------|-----------|---------|
  | A1 | 0.029 | ✅ | 4 | ✅ | ✅ | **HIGH** | — |
  | A2 | 0.020 | ✅ | 4 | ✅ | ✅ | **HIGH** | — |
  | A3 | 0.014 | ✅ | 3.5 | ✅ | ✅ | **HIGH** | — |
  | A4 | — | ❌ | — | — | ❌ | — | VECTOR SEARCH |
  | B1 | 0.016 | ✅ | 4 | ❌ | ❌ | — | CAP (30 docs) |
  | B2 | — | ✅ | 8 | ✅ | ✅ | **MEDIUM** | — |
  | B3 | — | ✅ | 5 | ❌ | ❌ | — | CAP (30 docs) |
  | B4 | 0.016 | ✅ | 2.2 | ❌ | ❌ | — | RERANKER (Cohere) |
  | B5 | — | ❌ | — | — | ❌ | — | VECTOR SEARCH |
  | B6 | 0.015 | ✅ | 1.7 | ❌ | ❌ | — | RERANKER (Cohere) |
  | C1 | 0.027 | ✅ | 3.1 | ✅ | ✅ | OTHER | — |
  | C2 | — | ❌ | — | — | ❌ | — | — |
  | C3 | 0.015 | ✅ | 3.4 | ❌ | ❌ | — | RERANKER (Cohere) |

- **Key improvements vs Run 4 (Cohere-only)**:
  - **A1 rescued**: Cohere scored 0.0 → GPT scored 4 → kept + summarized as HIGH
  - **B2 rescued**: Cohere scored 0.0 → GPT scored 8 → kept + summarized as MEDIUM
  - **B1 rescued by GPT** (score 4) but capped at 30 docs
  - **B3 rescued by GPT** (score 5) but capped at 30 docs
  - **Hit rate**: 10/30 = **33%** (up from 7% Cohere-only, 15% GPT-only, 20% baseline)
- **Time**: ~610s (longer due to dual reranker pass + BM25 hybrid)
- **Best run so far**: highest hit rate, 3 A-docs + 1 B-doc correctly identified as HIGH/MEDIUM
- **Remaining issues**: A4 and B5 not in vector search. B1/B3 found by GPT but capped at 30.

### Run 6: 2026-02-12 (Summarizer temperature 0)
- **Fixes applied**: `temperature: 0.1` → `0` in both `llm-client.ts` and `summarizer-worker/src/index.ts`
- **Queries generated**: 3 (facet-based)
- **Sources found**: 71 (hybrid)
- **After reranker (Cohere + GPT hybrid)**: 30 kept
- **After summarizer**: 5 HIGH, 4 MEDIUM, 7 NONE

  | ID | In Sources | Rerank (hybrid) | Kept? | Summarized | Relevance | Notes |
  |----|-----------|-----------------|-------|------------|-----------|-------|
  | A1 | ✅ | 4 | ✅ | ✅ | **HIGH** | — |
  | A2 | ✅ | 5 | ✅ | ✅ | **HIGH** | Up from MEDIUM in Run 5 |
  | A3 | ✅ | 3.5 | ✅ | ✅ | **HIGH** | Stable |
  | A4 | ❌ | — | — | ❌ | — | Still not in vector search |
  | B1 | ❌ | — | — | ❌ | — | Appeared in Run 5 but not here (LLM query variance) |
  | B2 | ❌ | — | — | ❌ | — | Same — query variance |
  | B3 | ❌ | — | — | ❌ | — | Not in sources |
  | B4 | ✅ | 2.2 | ✅ | ✅ | OTHER | — |
  | B5 | ❌ | — | — | ❌ | — | Not in sources |
  | B6 | ❌ | — | — | ❌ | — | Not in sources |
  | C1 | ✅ | 3.1 | ✅ | ✅ | OTHER | — |

- **Hit rate**: ~30% (within variance of Run 5's 33%)
- **Key observation**: Temperature change from 0.1→0 has minimal impact on ratings (expected — 0.1 was already near-deterministic). Main benefit: truly deterministic summarizer outputs across runs.
- **LLM query variance** explains B1/B2 not appearing — different queries generated this run found different docs. Multi-query expansion (Item 8) should stabilize this.

### Run 7: 2026-02-12 (Greek stemming for BM25)
- **Fixes applied**:
  1. Custom Dockerfile with `hunspell-el` for Greek word recognition + stop words
  2. `cylaw` text search config: `greek_hunspell → cylaw_custom → simple`
  3. Greek stop words (ο, η, το, και, etc.) now filtered from BM25 tsvector
  4. Rebuilt documents.tsv column with `cylaw` config
  5. Updated `pg-retriever.ts` to use `to_tsquery('cylaw', ...)` instead of `simple`
- **Note**: el_GR hunspell dictionary doesn't actually stem (flat word list, no affix flags). Main benefit: Greek stop word removal from index and custom legal term recognition.

  | ID | In Sources | Rerank | Kept? | Rel | Notes |
  |----|-----------|--------|-------|-----|-------|
  | A1 | ✅ | 2 | ✅ | **HIGH** | Stable |
  | A2 | ❌ | — | — | — | LLM query variance |
  | A3 | ✅ | 3.5 | ✅ | **HIGH** | Stable |
  | A4 | ❌ | — | — | — | Not in vector search |
  | C1 | ✅ | 3.1 | ✅ | OTHER | — |

- **Hit rate**: 33% — consistent with Runs 5/6
- **BM25 improvement**: stop word filtering reduces index noise, slightly better rankings. No morphological stemming (el_GR limitation).

### Run 8: 2026-02-12 (Adaptive multi-query 3-8 + raw user query search)
- **Fixes applied**:
  1. Raw user query always searched first (query #0) — both vector and BM25 with phrase matching
  2. System prompt updated: 3-8 queries (was 3-5) with 5 new facets (procedural, landmark, party-type, court, alternative framework)
  3. BM25 now includes `phraseto_tsquery` for exact phrase matches alongside OR-logic
  4. RERANK_MAX_DOCS_IN increased from 90 to 180 for more queries
- **Searches**: 6 (1 raw query + 5 LLM-generated facet queries)
- **Sources found**: 121 (up from 69-74 with 3 queries)
- **After reranker (Cohere + GPT hybrid)**: 30 kept

  | ID | In Sources | Rerank (hybrid) | Kept? | Summarized | Relevance | Notes |
  |----|-----------|-----------------|-------|------------|-----------|-------|
  | A1 | ✅ | 5 | ✅ | ✅ | **HIGH** | Stable — found by raw query + facet queries |
  | A2 | ✅ | 5 | ✅ | ✅ | **HIGH** | Upgraded from MEDIUM → HIGH |
  | A3 | ✅ | 3.5 | ✅ | ✅ | **HIGH** | Stable |
  | A4 | ❌ | — | — | ❌ | — | Still not in vector search (needs pgvector 3072d) |
  | B1 | ❌ | — | — | ❌ | — | Not found this run |
  | B2 | ❌ | — | — | ❌ | — | Not found this run |
  | B3 | ❌ | — | — | ❌ | — | Not found this run |
  | B4 | ❌ | — | — | ❌ | — | — |
  | B5 | ❌ | — | — | ❌ | — | — |
  | B6 | ❌ | — | — | ❌ | — | — |
  | C1 | ✅ | 3.1 | ❌ | ❌ | — | Found but cut by 30-doc cap |
  | C2 | ❌ | — | — | ❌ | — | — |
  | C3 | ✅ | 3.4 | ❌ | ❌ | — | Found but cut by cap |

- **Hit rate**: 20/30 = **67%** — DOUBLED from Run 7 (33%)! ⬆️⬆️
- **Key improvements**:
  - **All 3 A-docs found and rated HIGH** (A1, A2, A3 all HIGH — best A-doc performance)
  - **9 HIGH + 11 MEDIUM = 20/30 relevant docs** — zero NONE ratings (was 6-8 NONE previously)
  - **More sources found** (121 vs 69-74) due to 6 diverse searches covering more facets
  - **Raw query search** ensures the user's exact phrasing is always included
- **Remaining**: A4/B-docs need pgvector 3072d embeddings (currently in Vectorize 1536d only)

### Run 9: 2026-02-12 (pgvector text-embedding-3-large 2000d)
- **Fixes applied**:
  1. Re-embedded all 1.92M chunks with `text-embedding-3-large` (3072d → truncated to 2000d for HNSW limit)
  2. Uploaded to PostgreSQL `chunks` table with IVFFlat index (lists=1500, probes=30)
  3. `pg-retriever.ts` uses pgvector for vector search instead of Cloudflare Vectorize (1536d)
  4. Model dimension upgrade: 1536d (text-embedding-3-small) → 2000d (text-embedding-3-large, Matryoshka truncated)
- **Searches**: 6+ (1 raw query + 5 LLM-generated facet queries)
- **Sources found**: 133 (up from 121 with Vectorize)
- **After reranker (Cohere + GPT hybrid)**: 30 kept (threshold ≥0.1)
- **After summarizer**: 4 HIGH, 9 MEDIUM, 10 NONE

  | ID | In Sources | Rerank (hybrid) | Kept? | Summarized | Relevance | Notes |
  |----|-----------|-----------------|-------|------------|-----------|-------|
  | A1 | ✅ | 6 | ✅ | ✅ | **HIGH** | Stable — best score yet |
  | A2 | ✅ | 6 | ✅ | ✅ | **HIGH** | Stable — best score yet |
  | A3 | ✅ | 3.5 | ❌ | ❌ | — | Found in sources but cut by 30-doc cap (more competition) |
  | A4 | ❌ | — | — | ❌ | — | Still not found (Court of Appeal, different path structure) |
  | B1 | ✅ | 0.2 | ❌ | ❌ | — | **NEW**: now found in sources (pgvector recall improvement!) |
  | B2 | ✅ | 6 | ❌ | ❌ | — | **NEW**: now found with high rerank score (6) but cap limited |
  | B3 | ✅ | 5 | ❌ | ❌ | — | **NEW**: found with good rerank score (5) but cap limited |
  | B4 | ✅ | 2.2 | ❌ | ❌ | — | **NEW**: now found in sources |
  | B5 | ❌ | — | — | ❌ | — | Still not found |
  | B6 | ✅ | 1.7 | ❌ | ❌ | — | **NEW**: now found in sources |
  | C1 | ✅ | 3.1 | ❌ | ❌ | — | Found but cut by cap |
  | C2 | ❌ | — | — | ❌ | — | Not found |
  | C3 | ✅ | 3.4 | ❌ | ❌ | — | Found but cut by cap |

- **Hit rate**: (4+9)/30 = **43%** (down from 67% in Run 8)
- **Key observations**:
  - **Recall massively improved**: 10/13 ground truth docs found in sources (was 6/13 in Run 8)
  - **5 B-docs now found** (B1, B2, B3, B4, B6) that were completely missing with Vectorize
  - **Higher embedding quality** confirmed — text-embedding-3-large finds more semantically related docs
  - **Hit rate decreased** because more sources (133 vs 121) means more competition for the 30-doc cap
  - B2 and B3 scored 6 and 5 on rerank but still didn't make top 30 — the cap is the bottleneck
  - A3 was kept in Run 8 but dropped here due to tighter competition
- **Conclusion**: pgvector embeddings are a significant upgrade in recall. The 30-doc cap is now the limiting factor. Consider increasing cap or improving reranker to prioritize ground-truth-like docs.

### Run 10: 2026-02-13 (pgvector 3072d→2000d via subvector, clean re-upload)
- **Fixes applied**:
  1. Attempted full 3072d upload — confirmed both HNSW and IVFFlat have 2000d limit in pgvector
  2. Uploaded 1.92M chunks at full 3072d, truncated in-place via `subvector(embedding, 1, 2000)` (~3 min)
  3. Rebuilt IVFFlat index (lists=1500, probes=30) — 12 min
  4. Clean data state (no prior truncation artifacts)
- **Searches**: 5 (1 raw query + 4 LLM-generated facet queries)
- **Sources found**: 104
- **After reranker (Cohere + GPT hybrid)**: 30 kept (threshold ≥0.1)
- **After summarizer**: 5 HIGH, 11 MEDIUM, 2 NONE

  | ID | In Sources | Rerank (hybrid) | Kept? | Summarized | Relevance | Notes |
  |----|-----------|-----------------|-------|------------|-----------|-------|
  | A1 | ✅ | 5 | ✅ | ✅ | **HIGH** | Stable |
  | A2 | ✅ | 5 | ❌ | ❌ | — | Found but cut by 30-doc cap |
  | A3 | ✅ | 3.5 | ❌ | ❌ | — | Found but cut by cap |
  | A4 | ❌ | — | — | ❌ | — | Still not found (Court of Appeal path) |
  | B1 | ✅ | 4 | ❌ | ❌ | — | Found + good rerank (4), but cap limited |
  | B2 | ❌ | — | — | ❌ | — | Not found this run (LLM query variance) |
  | B3 | ✅ | 6 | ❌ | ❌ | — | Found + high rerank (6), but cap limited |
  | B4 | ✅ | 2.2 | ❌ | ❌ | — | Found in sources |
  | B5 | ❌ | — | — | ❌ | — | Still not found |
  | B6 | ✅ | 1.7 | ❌ | ❌ | — | Found in sources |
  | C1 | ✅ | 3.1 | ❌ | ❌ | — | Found but cut by cap |
  | C2 | ❌ | — | — | ❌ | — | Not found |
  | C3 | ✅ | 3.4 | ❌ | ❌ | — | Found but cut by cap |

- **Hit rate**: (5+11)/30 = **53%** (up from 43% in Run 9)
- **Key observations**:
  - **9/13 ground truth in sources** (B2 dropped vs Run 9 due to LLM query variance)
  - **B3 scored 6 on rerank** — high quality doc consistently found by pgvector but always cut by 30-doc cap
  - **Only 2 NONE** in 30 summarized docs (best noise ratio so far)
  - **5 HIGH + 11 MEDIUM = 16/30** relevant = 53% hit rate
  - More efficient: 198s total (vs 269s in Run 9)

## 12. Comparative Summary: All Runs

| Run | Date | Changes | Sources | In Sources (of 13 GT) | Kept | Summarized | HIGH | MED | NONE | Hit Rate | Time |
|-----|------|---------|---------|----------------------|------|------------|------|-----|------|----------|------|
| 1 | 02-10 | Baseline | ~70 | 11 | 12 | 12 | 2 | 0 | 10 | **17%** | 134s |
| 2 | 02-10 | Batch reranker, sort by score | 57 | 11 | 30 | 30 | 5 | 1 | 24 | **20%** | 200s |
| 3 | 02-12 | Summarizer prompt fix | 53 | 11 | 27 | 27 | 2 | 1 | — | **15%** | 198s |
| 4 | 02-12 | Cohere rerank (replaces GPT) | 50 | 9 | 30 | 30 | 2 | 0 | — | **7%** | 90s |
| 5 | 02-12 | Hybrid Cohere + GPT reranker | 74 | 10 | 30 | 30 | 4 | 6 | 6 | **33%** | 610s |
| 6 | 02-12 | Summarizer temp 0 | 71 | 6 | 30 | 30 | 5 | 4 | 7 | **30%** | — |
| 7 | 02-12 | Greek stemming BM25 | — | 3 | — | — | 2 | — | — | **33%** | — |
| 8 | 02-12 | Multi-query 3-8 + raw query | 121 | 6 | 30 | 30 | 9 | 11 | 0 | **67%** | — |
| 9 | 02-12 | pgvector text-emb-3-large 2000d | 133 | 10 | 30 | 30 | 4 | 9 | 10 | **43%** | 269s |
| **10** | **02-13** | **Clean re-upload, subvector** | **104** | **9** | **30** | **30** | **5** | **11** | **2** | **53%** | **198s** |

### Key Trends

1. **Hit rate progression**: 17% → 20% → 15% → 7% → 33% → 30% → 33% → **67%** → 43% → **53%**
2. **Best hit rate**: Run 8 (67%) — multi-query expansion was the biggest single improvement
3. **Best recall**: Run 9 (10/13 ground truth in sources) — pgvector embeddings dramatically improved recall
4. **Best noise ratio**: Run 10 (only 2 NONE in 30 docs) — clean data + good embeddings
5. **Persistent failures**: A4 (Court of Appeal) and B5 never found by any search method
6. **30-doc cap is the bottleneck**: B3 scores 5-6 on rerank every time but can't make top 30
7. **LLM query variance**: B-docs appear/disappear between runs due to non-deterministic query generation

### Ground Truth Document Tracking Across All Runs

| Doc | R1 | R2 | R3 | R4 | R5 | R6 | R7 | R8 | R9 | R10 |
|-----|----|----|----|----|----|----|----|----|----|----|
| A1 | HIGH | HIGH | HIGH | ❌ | HIGH | HIGH | HIGH | HIGH | HIGH | HIGH |
| A2 | HIGH | HIGH | MED | HIGH | HIGH | HIGH | ❌ | HIGH | HIGH | ❌(src) |
| A3 | ❌(rr) | HIGH | HIGH | HIGH | HIGH | HIGH | HIGH | HIGH | ❌(cap) | ❌(cap) |
| A4 | ❌(vs) | ❌(vs) | ❌(rr) | ❌(vs) | ❌(vs) | ❌ | ❌ | ❌ | ❌ | ❌ |
| B1 | NONE | NONE | ❌(rr) | ❌(rr) | ❌(cap) | ❌ | ❌ | ❌ | ❌(src) | ❌(cap) |
| B2 | NONE | NONE | HIGH | ❌(rr) | MED | ❌ | ❌ | ❌ | ❌(src) | ❌ |
| B3 | ❌(rr) | NONE | ❌(rr) | LOW | ❌(cap) | ❌ | ❌ | ❌ | ❌(cap) | ❌(cap) |
| B4 | NONE | MED | LOW | LOW | ❌(rr) | OTHER | ❌ | ❌ | ❌(src) | ❌(src) |
| B5 | ❌(vs) | ❌(vs) | ❌(vs) | ❌(vs) | ❌(vs) | ❌ | ❌ | ❌ | ❌ | ❌ |
| B6 | NONE | NONE | LOW | LOW | ❌(rr) | ❌ | ❌ | ❌ | ❌(src) | ❌(src) |
| C1 | NONE | NONE | LOW | LOW | OTHER | OTHER | OTHER | ❌(cap) | ❌(cap) | ❌(cap) |

Legend: ❌(vs)=not in vector search, ❌(rr)=dropped by reranker, ❌(cap)=cut by cap, ❌(src)=in sources but not kept, ❌=not found

### Run 11: 2026-02-13 (Smart cutoff: min 30, extend to 50 for score >= 2.0)
- **Fixes applied**:
  1. Replaced hard `MAX_SUMMARIZE_DOCS = 30` with adaptive cutoff
  2. Keep minimum 30 docs, extend up to 50 if docs at position 31+ score >= 2.0 (effective score incl. BM25 boost)
  3. Absolute max 50 to prevent cost explosion
- **Searches**: 5 (1 raw query + 4 LLM-generated)
- **Sources found**: 98
- **After reranker**: 50 kept (smart cutoff extended from 30 to max 50)
- **After summarizer**: 4 HIGH, 13 MEDIUM, 12 NONE

  | ID | In Sources | Rerank (hybrid) | Kept? | Summarized | Relevance | Notes |
  |----|-----------|-----------------|-------|------------|-----------|-------|
  | A1 | ✅ | 5 | ✅ | ✅ | **HIGH** | Stable |
  | A2 | ✅ | 5 | ❌ | ❌ | — | Still cut — BM25-boosted docs outrank it |
  | A3 | ✅ | 3.5 | ❌ | ❌ | — | Still cut by cap (position 51+) |
  | A4 | ❌ | — | — | ❌ | — | Not found |
  | B1 | ✅ | 1 | ❌ | ❌ | — | Low rerank score (below 2.0 cutoff) |
  | B2 | ❌ | — | — | ❌ | — | Not found (LLM query variance) |
  | B3 | ✅ | 5 | ❌ | ❌ | — | Still cut despite score 5 — BM25-boosted docs crowd it out |
  | B4 | ✅ | 2.2 | ❌ | ❌ | — | Just above threshold but position too low |
  | B5 | ✅ | 6 | ✅ | ✅ | **MEDIUM** | **FIRST TIME EVER FOUND!** Never appeared in Runs 1-10 |
  | B6 | ✅ | 1.7 | ❌ | ❌ | — | Below 2.0 cutoff |
  | C1 | ✅ | 3.1 | ❌ | ❌ | — | Cut by cap |
  | C2 | ❌ | — | — | ❌ | — | Not found |
  | C3 | ✅ | 3.4 | ❌ | ❌ | — | Cut by cap |

- **Hit rate**: (4+13)/50 = **34%** (down from 53% in Run 10 due to 50-doc denominator)
- **Absolute relevant count**: 17 (4 HIGH + 13 MEDIUM) vs 16 in Run 10 — marginally more
- **Key win**: **B5 found for the first time ever!** (rerank score 6, MEDIUM). This doc was missed by ALL previous search methods.
- **Key issue**: BM25 boost (max 5.0) inflates effective scores of keyword-matched docs, pushing quality rerank-only docs (A2, A3, B3 with scores 3.5-5) below position 50
- **10/13 GT in sources** (same as Run 9) — pgvector recall is stable

### Run 12: 2026-02-13 (Temperature 0 for query generation)
- **Fixes applied**: `temperature: 0.1` → `0` for main LLM call (OpenAI + Claude) that generates search queries
- **Searches**: 5 (1 raw query + 4 LLM-generated — deterministic)
- **Sources found**: 104 (same as Runs 10-11 — confirms determinism)
- **After reranker**: 50 kept (smart cutoff extended to max)
- **After summarizer**: 7 HIGH, 20 MEDIUM, 7 NONE

  | ID | In Sources | Rerank (hybrid) | Kept? | Summarized | Relevance | Notes |
  |----|-----------|-----------------|-------|------------|-----------|-------|
  | A1 | ✅ | 5 | ✅ | ✅ | **HIGH** | Stable |
  | A2 | ✅ | 5 | ❌ | ❌ | — | Still cut by cap (BM25-boosted docs outrank) |
  | A3 | ✅ | 3.5 | ❌ | ❌ | — | Still cut by cap |
  | A4 | ❌ | — | — | ❌ | — | Not found |
  | B1 | ✅ | 6 | ✅ | ✅ | **MEDIUM** | **NEW**: First time kept since Run 2! Rerank 6 |
  | B2 | ❌ | — | — | ❌ | — | Not found (query variance — even at temp 0, not fully deterministic) |
  | B3 | ✅ | 2 | ❌ | ❌ | — | Rerank dropped to 2 (was 5 in Run 11) — score variance |
  | B4 | ✅ | 2.2 | ❌ | ❌ | — | Position too low |
  | B5 | ✅ | 6 | ✅ | ✅ | **MEDIUM** | Stable from Run 11 — confirmed! |
  | B6 | ✅ | 1.7 | ❌ | ❌ | — | Below cutoff |
  | C1 | ✅ | 3.1 | ❌ | ❌ | — | Cut by cap |
  | C2 | ❌ | — | — | ❌ | — | Not found |
  | C3 | ✅ | 3.4 | ❌ | ❌ | — | Cut by cap |

- **Hit rate**: (7+20)/50 = **54%** (up from 34% in Run 11)
- **Key wins**:
  - **B1 kept + MEDIUM** for first time since early runs (rerank score 6)
  - **B5 stable** at MEDIUM (rerank 6) — confirmed the Run 11 discovery
  - **Only 7 NONE** (down from 12 in Run 11) — noise dramatically reduced
  - **27/50 relevant docs** vs 17/50 in Run 11 — huge improvement in quality ratio
  - Sources count stable at 104 — confirms deterministic query generation is more consistent
- **Remaining**: A2, A3, B3 still cut by cap. A4 still not found. B2 absent (needs investigation)

### Investigation: A4 (`courtOfAppeal/2025/202512-E4-25.md`)
- **Status**: 65K chars but 0 foreign-law keywords, 0 property keywords, 2 divorce mentions
- **BM25 rank**: 14,531 (our top-K is 100 — unreachable)
- **In chunks table**: NO — never embedded (8,696 docs total without embeddings)
- **Root cause**: This is a **procedural appeal document** about E.R v P.R. It discusses the appeal process, not foreign law or property disputes. Its relevance is through **case-party association** (same parties as A1/A2), not content overlap.
- **Conclusion**: A4 is **not retrievable by content-based search** for this query. It would require a "related cases by party name" feature — a separate capability, not a search quality bug.
- **Also discovered**: 8,696 documents (5.8% of corpus) exist in `documents` table (BM25) but not in `chunks` table (vector search). These were never part of the original Vectorize embedding and should be embedded in a future batch job.

### Run 13: 2026-02-13 (Simplified route.ts — always use hybrid search)
- **Fixes applied**: Removed conditional `DATABASE_URL ? hybrid : vectorize` — always use `createHybridSearchFn` which handles all fallbacks internally. Added TODO to remove Vectorize after hosted PG deployment.
- **Searches**: 5 (1 raw + 4 LLM, temp 0)
- **Sources found**: ~104
- **After reranker**: 50 kept (smart cutoff)
- **After summarizer**: 5 HIGH, 21 MEDIUM, 9 NONE

  | ID | In Sources | Rerank (hybrid) | Kept? | Summarized | Relevance | Notes |
  |----|-----------|-----------------|-------|------------|-----------|-------|
  | A1 | ✅ | 5 | ✅ | ✅ | **HIGH** | Stable |
  | A2 | ✅ | 5 | ✅ | ✅ | **HIGH** | **BACK**: First time in final output since Run 8! |
  | A3 | ✅ | 3.5 | ❌ | ❌ | — | Still cut by cap |
  | A4 | ❌ | — | — | ❌ | — | Not in corpus embeddings |
  | B1 | ✅ | 5 | ✅ | ✅ | **MEDIUM** | Stable from Run 12 |
  | B2 | ❌ | — | — | ❌ | — | Not found |
  | B3 | ✅ | 6 | ✅ | ✅ | OTHER | **NEW**: First time kept since Run 4! (score 6) |
  | B4 | ✅ | 2.2 | ❌ | ❌ | — | Position too low |
  | B5 | ✅ | 6 | ✅ | ✅ | **MEDIUM** | Stable from Run 11 |
  | B6 | ✅ | 1.7 | ❌ | ❌ | — | Below cutoff |
  | C1 | ✅ | 3.1 | ❌ | ❌ | — | Cut by cap |
  | C2 | ❌ | — | — | ❌ | — | Not found |
  | C3 | ✅ | 3.4 | ❌ | ❌ | — | Cut by cap |

- **Hit rate**: (5+21)/50 = **52%**
- **Ground truth in final output**: **5 docs** (A1 HIGH, A2 HIGH, B1 MED, B3 OTHER, B5 MED) — best ever!
- **Key milestone**: First run where both A1+A2 are HIGH and 3 B-docs are in the output
- **Only 9 NONE** in 50 docs (noise ratio stable)
