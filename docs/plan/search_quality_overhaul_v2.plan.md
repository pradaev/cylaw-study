# Plan: Search Quality Overhaul v2

> Phases 0-2b. Approved by user 2026-02-09.
> Goal: hit rate 20% -> 50%+ on ground-truth query.

## Phase 0: Cleanup (Weaviate removal)

### Files to DELETE
- `docker-compose.yml` (entire file is Weaviate service)
- `scripts/weaviate_schema.py`
- `scripts/ingest_to_weaviate.py`
- `scripts/test_weaviate_search.py`
- `scripts/compare_search_backends.mjs`
- `frontend/lib/weaviate-retriever.ts`
- `docs/WEAVIATE_SETUP.md`
- `docs/NIGHTLY_REPORT_2026-02-10.md`

### Files to MODIFY
- `frontend/app/api/chat/route.ts`: Remove Weaviate import, `searchBackendOverride`, `SEARCH_BACKEND` env logic; hardcode Vectorize path
- `.env.example`: Remove `WEAVIATE_URL`, `SEARCH_BACKEND`
- `docs/RAILWAY_DEPLOY.md`: Remove Weaviate section
- `PROJECT_STATUS.md`: Remove all Weaviate references, session logs 12-15
- `rag/document_extractor.py`: Remove "Weaviate upsert" comment
- `DECISIONS.md`: Add decision to remove Weaviate experiment

### Verification
- `npm run test:fast` passes
- No references to "weaviate" in codebase (grep)

---

## Phase 1: Fix Summarizer Prompt

### Problem
Summarizer (GPT-4o) is the #1 bottleneck:
- B-docs (property disputes with foreign elements) rated NONE — they DO address the topic but indirectly
- C-docs (domestic property, no foreign law) rated HIGH — false positives
- Hit rate: 20% (6 HIGH+MEDIUM out of 30 summarized)

### Root Cause
The engagement levels (RULED/DISCUSSED/MENTIONED/NOT ADDRESSED) map 1:1 to relevance (HIGH/MEDIUM/LOW/NONE). This is too rigid:
- A case about property division with Russian citizens applying foreign law gets NONE because the court didn't explicitly "discuss" foreign law application as a legal topic — it just APPLIED it
- A domestic property case gets HIGH because the court "ruled" on property division (the word matches)

### Fix: Decouple engagement from relevance + add research-value criteria

**File**: `summarizer-worker/src/index.ts` lines 117-154

**Changes to section 7 (RELEVANCE RATING)**:
```
7. RELEVANCE RATING: Rate as HIGH / MEDIUM / LOW / NONE:
   - HIGH: The decision is directly useful for the research question. The court analyzed
     the specific legal issue being researched (not just a related topic).
   - MEDIUM: The decision is partially useful. It involves the same legal area and shares
     key factual or legal elements with the research question, even if the court's main
     focus was different. Cross-border cases, foreign party involvement, or foreign law
     application count as MEDIUM even if the court didn't deeply analyze the foreign law aspect.
   - LOW: The decision is tangentially related. Same area of law but different factual
     context, or the research topic was only briefly referenced.
   - NONE: The decision has no connection to the research question.

   IMPORTANT: Rate based on RESEARCH VALUE to the lawyer, not just whether the court
   explicitly used the same legal terms as the query. A property dispute between foreign
   citizens in Cyprus IS relevant to "foreign law in property disputes" even if the court
   didn't use the phrase "αλλοδαπό δίκαιο".
```

**Also add to CRITICAL RULES**:
```
- When the research question involves FOREIGN LAW: any case with foreign parties,
  cross-border elements, or references to non-Cypriot legal systems is at least MEDIUM.
- When the research question involves PROPERTY DISPUTES: distinguish between the
  specific property dispute type asked about (e.g., matrimonial) and unrelated property
  disputes (e.g., commercial real estate).
```

### Also fix in `frontend/lib/llm-client.ts`
The inline summarizer (used when Service Binding is unavailable) has the same prompt — update it too. Search for the duplicated prompt text around line 740-790.

### Verification
1. Run `node scripts/deep_dive_query.mjs` (E2E test, ~$2)
2. Check ground-truth tracking table:
   - B1, B2, B3, B4, B6 should be MEDIUM (not NONE)
   - C2, C3 should be LOW or NONE (not HIGH)
   - A1, A2, A3 should remain HIGH
3. Target hit rate: >= 35% (up from 20%)

---

## Phase 2a: Cohere Rerank

### Why
GPT-4o-mini reranker works but has fundamental limitations:
- It reads a 1700-char preview, not the full document — misses context
- It's a generative model doing a classification task — cross-encoders are purpose-built for this
- Batch noise: scoring 20 docs at once degrades calibration
- Cost: ~$0.005 per query but adds 3-5s latency per batch

### Implementation

1. **Add dependency**: `npm install cohere-ai` in `frontend/`
2. **Add env var**: `COHERE_API_KEY` in `.env.local` and `.env.example`
3. **Create `frontend/lib/cohere-reranker.ts`**:
   - Use `rerank-multilingual-v3.0` (supports Greek)
   - Input: user query + array of document previews (same `buildRerankPreview()` output)
   - Output: scored + sorted documents with `relevance_score` (0-1)
   - Threshold: calibrate based on ground-truth (likely ~0.3)
4. **Modify `frontend/lib/llm-client.ts`**:
   - Replace `rerankDocs()` body: if `COHERE_API_KEY` exists, use Cohere; else fall back to GPT-4o-mini
   - Keep same interface: input `RerankInput[]`, output sorted+filtered array
   - Remove batch-of-20 logic (Cohere handles 1000 docs in one call)
5. **Update `DECISIONS.md`**: Record switch to Cohere

### Cohere Rerank API (rerank-multilingual-v3.0)
```typescript
const cohere = new CohereClientV2({ token: process.env.COHERE_API_KEY });
const response = await cohere.rerank({
  model: "rerank-multilingual-v3.0",
  query: userQuery,
  documents: docPreviews.map(d => d.text),
  topN: 20,
});
// response.results: [{ index, relevanceScore }]
```

### Cost
- Cohere Rerank: $2.00 per 1000 searches (first 1000 free/month)
- Per query with ~60 docs: effectively free during development
- GPT-4o-mini reranker: ~$0.005/query — comparable

### Verification
1. Run `node scripts/deep_dive_query.mjs`
2. Check: A3 (M. v A.) should score high (it was borderline with GPT-4o-mini)
3. Check: D-category docs should score very low
4. Compare reranker output: Cohere vs GPT-4o-mini side by side

---

## Phase 2b: PostgreSQL + pgvector + Hybrid Search

### Why
- Vectorize caps at 1536 dimensions — can't use text-embedding-3-large (3072d)
- No BM25/keyword search in Vectorize — vector-only misses keyword-dependent legal queries
- A4 and B5 not found by vector search at all — hybrid search should find them via keyword matching
- PostgreSQL FTS supports Greek stemming out of the box

### Architecture

```
┌─────────────────────────────────────────────┐
│  PostgreSQL (Docker, port 5432)              │
│                                              │
│  Table: chunks                               │
│  ├─ id: SERIAL PRIMARY KEY                   │
│  ├─ doc_id: TEXT (indexed)                   │
│  ├─ chunk_index: INT                         │
│  ├─ content: TEXT                             │
│  ├─ embedding: vector(3072)                  │
│  ├─ tsv: tsvector (GENERATED from content)   │
│  ├─ court: TEXT                               │
│  ├─ court_level: TEXT                         │
│  ├─ year: INT                                 │
│  ├─ title: TEXT                               │
│  └─ jurisdiction: TEXT                        │
│                                              │
│  Indexes:                                    │
│  ├─ HNSW on embedding (cosine)               │
│  ├─ GIN on tsv                               │
│  └─ BTREE on (doc_id, year, court_level)     │
└─────────────────────────────────────────────┘
```

### Implementation Steps

1. **Docker setup**: New `docker-compose.yml` with PostgreSQL + pgvector
   ```yaml
   services:
     postgres:
       image: pgvector/pgvector:pg17
       ports: ["5432:5432"]
       environment:
         POSTGRES_DB: cylaw
         POSTGRES_USER: cylaw
         POSTGRES_PASSWORD: cylaw_dev
       volumes:
         - pgdata:/var/lib/postgresql/data
   ```

2. **Schema migration**: `scripts/pg_schema.sql`
   - CREATE EXTENSION vector;
   - CREATE TABLE chunks (...);
   - CREATE INDEX on embedding USING hnsw;
   - CREATE INDEX on tsv USING gin;

3. **Re-embed with text-embedding-3-large (3072d)**:
   - Modify `scripts/batch_ingest.py`:
     - Change `OPENAI_MODEL` to `text-embedding-3-large`
     - Change `OPENAI_DIMS` to `3072`
     - Add `dimensions: 3072` to API call
     - Add pgvector upload target (alongside or instead of Vectorize)
   - Cost: ~$97 via Batch API (~$50 if cached)
   - Time: ~2-3 hours (same as previous re-embedding)

4. **Ingest to PostgreSQL**: `scripts/ingest_to_pg.py`
   - Read batch embeddings output
   - Bulk INSERT into chunks table with COPY
   - Generate tsvector from content (greek configuration or simple)

5. **Hybrid search retriever**: `frontend/lib/pg-retriever.ts`
   ```typescript
   // Vector search (pgvector)
   SELECT doc_id, 1 - (embedding <=> $query_vec) AS vec_score
   FROM chunks ORDER BY embedding <=> $query_vec LIMIT 100;

   // BM25 search (tsvector)
   SELECT doc_id, ts_rank(tsv, plainto_tsquery('simple', $query)) AS bm25_score
   FROM chunks WHERE tsv @@ plainto_tsquery('simple', $query) LIMIT 100;

   // RRF fusion
   // rrf_score = 1/(k+rank_vector) + 1/(k+rank_bm25), k=60
   ```

6. **Update chat route**: Add pgvector as a search backend option
   - env var: `DATABASE_URL=postgresql://cylaw:cylaw_dev@localhost:5432/cylaw`
   - If `DATABASE_URL` is set, use pg-retriever; else fall back to Vectorize

7. **Query embedding**: Update `frontend/lib/retriever.ts`
   - Change model to `text-embedding-3-large`
   - Add `dimensions: 3072` parameter
   - Share embedding function between pg-retriever and vectorize-retriever

### Env vars
```
DATABASE_URL=postgresql://cylaw:cylaw_dev@localhost:5432/cylaw
```

### Verification
1. `docker compose up -d` — PostgreSQL starts
2. Run schema migration
3. Re-embed + ingest (~3 hours)
4. Run `node scripts/deep_dive_query.mjs` with pgvector backend
5. Check: A4 and B5 should now appear (BM25 finds them by keywords)
6. Check: Hit rate should be >= 50%

### Cost summary
| Item | Cost |
|------|------|
| Re-embedding (Batch API) | ~$97 |
| Cohere Rerank (dev) | Free (1000 searches/mo) |
| PostgreSQL | Free (Docker local) |
| Summarizer (per query) | ~$1.00 |

---

## Expected Outcome (all phases combined)

| Metric | Before | After Phase 1 | After Phase 2a | After Phase 2b |
|--------|--------|---------------|----------------|----------------|
| A-docs found | 3/4 | 3/4 | 3/4 | **4/4** |
| B-docs found (MEDIUM+) | 1/6 | **4-5/6** | **4-5/6** | **5-6/6** |
| C-docs false positives | 2 | **0** | **0** | **0** |
| Hit rate | 20% | **35-40%** | **40-45%** | **50-60%** |
| Cost per query | ~$1.50 | ~$1.20 | ~$1.00 | ~$1.00 |

## Execution Order

1. Phase 0 (cleanup) — 30 min
2. Phase 1 (summarizer) — 1 hour + E2E test
3. Phase 2a (Cohere) — 2 hours + E2E test
4. Phase 2b (pgvector) — 1 day (re-embedding takes hours)

Each phase is independently testable and committable.
