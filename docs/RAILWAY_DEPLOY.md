# Railway / Node Deployment

For deployment outside Cloudflare Workers (Railway, Fly.io, Render, VPS).

## Prerequisites

- Docker
- Next.js built with `output: 'standalone'` (set in next.config when `BUILD_TARGET=node`)

## Environment

```
OPENAI_API_KEY=...
CLOUDFLARE_ACCOUNT_ID=...            # for Vectorize + R2 S3 API
CLOUDFLARE_API_TOKEN=...             # for Vectorize queries
CLOUDFLARE_R2_ACCESS_KEY_ID=...
CLOUDFLARE_R2_SECRET_ACCESS_KEY=...
```

## Docker

Use a Node-based Dockerfile with `next build` and `next start`. Set `DEPLOY_TARGET=node` or deploy to Railway (auto-detected via `RAILWAY_ENVIRONMENT`).

## Note

The app uses R2 for documents. In Node (no Worker binding), it uses the S3-compatible API (r2FetchViaS3). Ensure R2 credentials are set.
