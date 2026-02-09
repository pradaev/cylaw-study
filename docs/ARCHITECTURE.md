# Architecture

## Overview

```
User -> Cloudflare Zero Trust (email OTP) -> Next.js Worker (cyprus-case-law)
            |
            +-- /api/chat (POST, SSE streaming)
            |     Phase 1: LLM formulates search queries (fast, ~10s)
            |       - search_cases tool: Vectorize search only (no summarization)
            |       - Returns doc_ids + metadata to LLM
            |       - LLM decides if more searches needed (up to 10 rounds)
            |       - Sources emitted to UI progressively
            |     Phase 2: Batch summarization via Service Binding
            |       - All unique doc_ids sent to cylaw-summarizer Worker
            |       - Batches of 5, each Worker gets own 6-connection pool
            |       - Each summary emitted to UI as it completes
            |       - Progress bar: "15/40 (38%)"
            |     Structured JSON logging with userEmail + sessionId
            |
            +-- /api/doc (GET)
                  Document viewer -> R2 bucket (149,886 .md files)
                  Auto-appends .md if missing
```

## Two-Worker Architecture

```
cyprus-case-law (Main Worker)
    |
    +-- Phase 1: LLM tool-calling → Vectorize search (fast)
    |
    +-- Phase 2: Service Binding → cylaw-summarizer Worker
                                      |
                                      +-- R2 fetch (binding)
                                      +-- OpenAI GPT-4o summarize
                                      +-- Returns SummaryResult[]
```

Each Service Binding call = new request = fresh 6-connection pool. Solves the Workers connection limit permanently.

## Key Components

- **Main Worker**: `cyprus-case-law` — Next.js on Cloudflare Workers via @opennextjs/cloudflare
- **Summarizer Worker**: `cylaw-summarizer` — standalone Worker for document summarization
- **Document storage**: Cloudflare R2 bucket `cyprus-case-law-docs` (149,886 parsed .md files)
- **Vector search**: Cloudflare Vectorize index `cyprus-law-cases-search-revised`
- **Search in dev**: Vectorize REST API (`frontend/lib/vectorize-client.ts`)
- **Search in prod**: Vectorize Worker binding (zero-latency)
- **Observability**: Workers Logs with structured JSON logging (sessionId + userEmail)
- **Auth**: Cloudflare Zero Trust (email OTP), `Cf-Access-Authenticated-User-Email` header

## search_cases Tool Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `query` | Yes | Search query — short phrases a judge would write in a decision |
| `legal_context` | Yes | Brief legal framework note (1-2 sentences) |
| `court_level` | No | `"supreme"`, `"appeal"`, or `"foreign"` — filter by court level |
| `year_from` | No | Year range start |
| `year_to` | No | Year range end |

## Vectorize Index

> **PRODUCTION WARNING — DO NOT delete, drop, or recreate.**

| Property | Value |
|----------|-------|
| Index name | `cyprus-law-cases-search-revised` |
| Dimensions | 1536 |
| Metric | cosine |
| Embedding model | OpenAI `text-embedding-3-small` |
| Total vectors | 2,071,079 |
| Chunk format | Contextual header (court, jurisdiction, year, title) + cleaned text |
| Metadata fields | `doc_id`, `court`, `year`, `title`, `chunk_index`, `court_level`, `subcourt`, `jurisdiction` |
| Metadata indexes | `year`, `court`, `court_level`, `subcourt`, `jurisdiction` (all string) |
| Old index | `cyprus-law-cases-search` (~2.27M vectors, raw text, still on prod — do NOT delete yet) |

## Ingestion

| Script | Purpose | Status |
|--------|---------|--------|
| `scripts/batch_ingest.py` | **PRIMARY** — OpenAI Batch API -> Vectorize | Production |

Commands: `create-index`, `prepare`, `submit`, `status`, `download`, `upload`, `collect`, `reupload`, `full-reset`, `run`, `reset`

## Deployment

```bash
# Deploy summarizer worker first
cd summarizer-worker && source ../.env && npx wrangler deploy

# Deploy main worker
cd frontend && npm run deploy
```
