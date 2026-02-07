# Project Status

> This file is the single source of truth for agent continuity.
> **Read this first** at the start of every session.
> **Update this last** before committing at the end of every session.

## Architecture

```
User -> Next.js (Cloudflare Worker) -> API Routes
            |
            +-- /api/chat (POST, SSE streaming)
            |     Main LLM (GPT-4o / Claude) with two tools:
            |       1. search_cases -> ChromaDB (dev) / Vectorize (prod, Phase 2)
            |       2. summarize_documents -> R2 full text -> parallel GPT-4o agents
            |
            +-- /api/doc (GET)
                  Document viewer -> R2 bucket (149,886 .md files)
```

- **Document storage**: Cloudflare R2 bucket `cyprus-case-law-docs` (149,886 parsed .md files)
- **Document fetch in dev**: S3 HTTP API to real R2 (`r2FetchViaS3` in `frontend/app/api/chat/route.ts`)
- **Document fetch in prod**: R2 Worker binding (`r2FetchViaBinding`)
- **Search in dev**: Python server (`rag/search_server.py`) -> local ChromaDB
- **Search in prod**: NOT YET WORKING — needs Cloudflare Vectorize (Phase 2)
- **Auth**: Cloudflare Zero Trust (email OTP)

## What Works Now

- **Chat UI** — Perplexity-style, SSE streaming, multi-model (GPT-4o, o3-mini, Claude Sonnet 4) — `frontend/app/page.tsx`
- **Multi-agent summarizer** — parallel GPT-4o agents analyze up to 10 full court docs per query — `frontend/lib/llm-client.ts`
- **Document viewer** — click any case to read full text with AI summary panel — `frontend/app/api/doc/route.ts`
- **R2 integration** — all 149,886 docs in R2, fetched in both dev (S3 API) and prod (binding) — `frontend/app/api/chat/route.ts`
- **Data pipeline** — scrape, download, parse, chunk, embed for all 15 courts — `scraper/`, `rag/`
- **Local search** — ChromaDB with ~2.3M chunks (original 9 courts indexed) — `rag/search_server.py`
- **Production deployment** — https://cyprus-case-law.cylaw-study.workers.dev — `frontend/wrangler.jsonc`
- **Cost tracking** — per-request token/cost display in UI — `frontend/components/ChatArea.tsx`
- **Cloudflare secrets** — OPENAI_API_KEY, ANTHROPIC_API_KEY set via `wrangler secret put`

## What's Next

### High Priority

1. **Vectorize integration (Phase 2)** — production search is currently a stub
   - Create Cloudflare Vectorize index (`npx wrangler vectorize create cylaw-cases --dimensions 1536 --metric cosine`)
   - Migrate vectors from ChromaDB -> Vectorize (`rag/migrate_to_cloudflare.py` exists but not run)
   - Write `frontend/lib/retriever.ts` (Vectorize query)
   - Wire retriever into `frontend/app/api/chat/route.ts` replacing `stubSearchFn`
   - Add Vectorize binding to `frontend/wrangler.jsonc` (currently commented out)
   - Re-deploy

2. **Re-index all 15 courts** — only original 9 courts are in ChromaDB; 6 new courts (Areios Pagos, First Instance, JSC, RSCC, Admin Appeal, Juvenile) need indexing

3. **Evaluate embedding upgrade** — text-embedding-3-large (3072 dims) showed 2x better Greek-English matching (0.498 vs 0.216) but needs Pinecone/Qdrant (Vectorize max 1536 dims); cost ~$2,400

### Medium Priority

4. Add subcategory metadata for First Instance courts (pol/poin/oik/enoik/erg) to enable Family Court filtering
5. Persistent summary cache — avoid re-summarizing the same doc for the same query
6. Server-side conversation history for session persistence
7. Hybrid search: vector similarity + keyword matching (BM25)
8. Evaluate Claude Sonnet 4 as summarizer (may handle Greek legal text better)

### Low Priority

9. Legislation integration — download/index 64,477 legislative acts from cylaw.org
10. CI/CD pipeline (GitHub Actions -> Cloudflare deploy)
11. Automated daily scrape of updates.html for new cases
12. Cross-reference graph analysis
13. Query analytics dashboard

## Gotchas for Future Agents

- `initOpenNextCloudflareForDev()` in `next.config.ts` creates a **local miniflare R2 emulator** which is EMPTY — that's why `r2FetchViaBinding` returns null in dev. Use `r2FetchViaS3` instead (calls real R2 over HTTPS).
- R2 credentials (`CLOUDFLARE_R2_ACCESS_KEY_ID`, `CLOUDFLARE_R2_SECRET_ACCESS_KEY`) must be in `frontend/.env.local` for dev S3 API access.
- `extractDecisionText()` in `llm-client.ts` truncates docs > 80K chars: 35% head + 65% tail. For large criminal cases (~300K chars), the middle (often witness testimony sections) is dropped.
- Python search server (`rag/search_server.py`) is only needed in dev for `search_cases`. Without it, chat still works for general questions and document viewing — just no case search.
- Port 3000 is often taken by Docker. Next.js dev server usually runs on 3001.
- HTML files from cylaw.org use ISO-8859-7 / Windows-1253 encoding (Greek).

## Last Session Log

### 2026-02-07 (afternoon session)
- Analyzed HTML structure of court cases for separating witness testimony from court reasoning — found ~57% of criminal cases have explicit section headers (ΜΑΡΤΥΡΙΑ, ΑΞΙΟΛΟΓΗΣΗ) that enable programmatic separation; no code written, analysis only
- Added R2 document fetching to chat route (`r2FetchViaBinding` for prod, `r2FetchViaS3` for dev) — discovered miniflare emulator is empty, fixed by using S3 HTTP API with AWS Signature V4 in dev
- Deployed Phase 1 to Cloudflare Workers, set secrets (OPENAI_API_KEY, ANTHROPIC_API_KEY)
- Updated README.md with current architecture, status table, deployment instructions, project structure
- Updated plan statuses: r2-setup and deploy-cf-phase1 marked done
