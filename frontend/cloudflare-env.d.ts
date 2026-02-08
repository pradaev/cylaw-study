/**
 * Type declarations for Cloudflare Worker bindings.
 *
 * Regenerate with: npm run cf-typegen
 */

interface CloudflareEnv {
  /** R2 bucket containing parsed court case documents (.md files) */
  DOCS_BUCKET: R2Bucket;

  /** Vectorize index for semantic search (~2.27M vectors, all 15 courts) */
  VECTORIZE: Vectorize;

  /** Worker self-reference for internal routing */
  WORKER_SELF_REFERENCE: Fetcher;

  /** Static assets binding */
  ASSETS: Fetcher;
}
