# TODO

## High Priority

### Deploy to production (Cloudflare)
- [x] Next.js app deployed to Cloudflare Workers (`cyprus-case-law`)
- [x] R2 bucket `cylaw-docs` created
- [x] Cloudflare Zero Trust configured (email OTP auth)
- [x] Secrets set: OPENAI_API_KEY, ANTHROPIC_API_KEY
- [ ] Upload ~150K parsed docs to R2 (`python -m rag.upload_to_r2`)
- [ ] Set up Cloudflare Vectorize index (1536 dims or 768 dims)
- [ ] Migrate vectors: ChromaDB → Cloudflare Vectorize
- [ ] Write `lib/retriever.ts` for Vectorize binding (Phase 2)
- [ ] Write production `fetchDocument` for R2 (Phase 2)
- [ ] Re-deploy with Vectorize + R2 integration

### Improve search quality
- [ ] **Migrate to text-embedding-3-large (3072 dims)** for better multilingual support
  - Current: paraphrase-multilingual-mpnet (768 dims, local) — good for Greek
  - Alternative: text-embedding-3-large (3072 dims) — better Greek↔English matching
  - Test showed: English↔Greek similarity improves from 0.216 to 0.498
  - Cost: ~$2,400 one-time re-indexing
  - Requires: Pinecone or Qdrant Cloud (Cloudflare Vectorize max is 1536 dims)
- [ ] Add subcategory metadata for First Instance courts (pol/poin/oik/enoik/erg)
  - Would enable filtering by Family Court (oik) specifically
  - Currently embedded in file path but not in ChromaDB metadata
- [ ] Re-index new courts (Areios Pagos, First Instance, JSC, etc.) — only original 9 courts are in ChromaDB

## Medium Priority

### Chat improvements
- [ ] Server-side conversation history for persistence across sessions
- [ ] Rate limiting per user to control API costs
- [ ] Conversation export (PDF/Markdown)
- [ ] Suggested questions based on popular searches

### Search improvements
- [ ] Hybrid search: combine vector similarity with keyword matching (BM25)
- [ ] Cross-reference graph analysis — find cases that cite each other
- [ ] Filter by case outcome (plaintiff won / defendant won)
- [ ] Search within a specific case's citations

### Summarizer improvements
- [ ] Evaluate Claude Sonnet 4 as summarizer (potentially better at Greek legal text)
- [ ] Cache summaries to avoid re-summarizing same documents
- [ ] Allow user to request "deep dive" on a specific case (full analysis)

## Low Priority

### Legislation integration
- [ ] Download and index 64,477 legislative acts
- [ ] Link cases to the laws they cite
- [ ] Allow searching legislation alongside case law

### Analytics
- [ ] Query analytics dashboard — what people search for
- [ ] Most-cited cases ranking
- [ ] Court activity trends over time
- [ ] Per-user cost tracking

### Infrastructure
- [ ] CI/CD pipeline (GitHub Actions → Cloudflare)
- [ ] Monitoring and alerting (uptime, error rates, API costs)
- [ ] Automated daily scrape of updates.html for new cases
- [ ] Backup strategy for vector database

## Completed

### ✅ Scraping (2026-02-06/07)
- [x] All 15 courts scraped and parsed: 149,886 files (5.5 GB)
- [x] Full parsing pipeline with cross-reference preservation

### ✅ Frontend (2026-02-07)
- [x] Next.js + React + TypeScript + Tailwind
- [x] Multi-agent summarization (parallel GPT-4o agents)
- [x] SSE streaming with activity log
- [x] Document viewer, collapsible sources, clickable case links
- [x] Cost tracking per request
- [x] Cloudflare Zero Trust authentication
- [x] Deployed to Cloudflare Workers
