# Railway / Node Deployment

For deployment outside Cloudflare Workers (Railway, Fly.io, Render, VPS).

## Prerequisites

- Docker
- Next.js built with `output: 'standalone'` (set in next.config when `BUILD_TARGET=node`)

## Weaviate + Document-Level Search

1. **Start Weaviate**: `docker compose up -d`
2. **Create schema**: `python scripts/weaviate_schema.py`
3. **Ingest** (subset first): `python scripts/ingest_to_weaviate.py --limit 1000`
4. **Full ingest**: `python scripts/ingest_to_weaviate.py` (~150K docs, several hours)

## Environment

Set for Node/Railway:

```
OPENAI_API_KEY=...
WEAVIATE_URL=http://localhost:8080   # or your Weaviate Cloud URL
SEARCH_BACKEND=weaviate
CLOUDFLARE_ACCOUNT_ID=...            # for R2 S3 API (documents)
CLOUDFLARE_R2_ACCESS_KEY_ID=...
CLOUDFLARE_R2_SECRET_ACCESS_KEY=...
```

Without Weaviate, use `SEARCH_BACKEND=vectorize` and Cloudflare Vectorize credentials.

## Docker

Use a Node-based Dockerfile with `next build` and `next start`. Set `DEPLOY_TARGET=node` or deploy to Railway (auto-detected via `RAILWAY_ENVIRONMENT`).

## Note

The app uses R2 for documents. In Node (no Worker binding), it uses the S3-compatible API (r2FetchViaS3). Ensure R2 credentials are set.
