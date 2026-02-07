# TODO

## High Priority

### Deploy to production
- [ ] Upload ~150K parsed docs to R2 (script ready: `python -m rag.upload_to_r2`)
- [ ] Set up Cloudflare Vectorize index (1536 dims, OpenAI text-embedding-3-small)
- [ ] Migrate vectors: ChromaDB → Cloudflare Vectorize (batch upsert 5000/req)
- [ ] Write `lib/retriever.ts` to use Cloudflare Vectorize binding
- [ ] Deploy Next.js app to Cloudflare Pages
- [ ] Configure environment variables on Cloudflare dashboard
- [ ] Test end-to-end in production

### Improve search quality
- [ ] **Migrate to text-embedding-3-large (3072 dims)** for better multilingual support
  - Current: text-embedding-3-small (1536 dims) — good for Greek-only
  - Target: text-embedding-3-large (3072 dims) — significantly better at matching Greek↔English queries
  - Test showed: English↔Greek similarity improves from 0.216 to 0.498 with large model
  - Cost: ~$2,400 one-time re-indexing (vs $370 for small)
  - Requires: Pinecone or Qdrant Cloud (Cloudflare Vectorize max is 1536 dims)
  - When: after validating product-market fit and when multilingual queries are a priority

### Current limitation
- [ ] App currently assumes Greek-only queries for best results
- [ ] System prompt instructs LLM to search in Greek first
- [ ] When migrating to large model, update prompt to leverage multilingual capability

## Medium Priority

### ~~Download remaining courts~~ ✅ Done (2026-02-07)
All 15 courts scraped and parsed: 149,886 files (5.5 GB) in `data/cases_parsed/`.
- [x] Areios Pagos — 46,159 cases
- [x] First Instance Courts — 37,840 cases (5 categories: civil, criminal, family, rental, labour)
- [x] JSC (Supreme Court in English) — 2,429 cases
- [x] Constitutional Court 1960-63 — 122 cases
- [x] Admin Appeal Court — 69 cases
- [x] Juvenile Court — 11 cases
- [ ] Re-run full pipeline for new courts: chunk → embed (not yet done for new courts)

### Chat improvements
- [ ] Server-side conversation history (SQLite) for persistence across devices
- [ ] User accounts with authentication
- [ ] Rate limiting per user to control API costs
- [ ] Conversation export (PDF/Markdown)
- [ ] Suggested questions based on popular searches

### Search improvements
- [ ] Hybrid search: combine vector similarity with keyword matching (BM25)
- [ ] Cross-reference graph analysis — find cases that cite each other
- [ ] Filter by case outcome (plaintiff won / defendant won)
- [ ] Date range search refinement
- [ ] Search within a specific case's citations

## Low Priority

### Legislation integration
- [ ] Download and index 64,477 legislative acts from cylaw.org
- [ ] Link cases to the laws they cite
- [ ] Allow searching legislation alongside case law

### Analytics
- [ ] Query analytics dashboard — what people search for
- [ ] Most-cited cases ranking
- [ ] Court activity trends over time

### Infrastructure
- [ ] CI/CD pipeline (GitHub Actions → Railway/Cloudflare)
- [ ] Monitoring and alerting (uptime, error rates, API costs)
- [ ] Automated daily scrape of updates.html for new cases
- [ ] Backup strategy for vector database
