/**
 * Vectorize client abstraction — same interface for binding (production) and HTTP (dev).
 *
 * Both implementations hit the SAME production Vectorize index (cyprus-law-cases-search).
 * - Production: uses Cloudflare Worker binding (zero-latency, no auth needed)
 * - Dev: uses Cloudflare REST API over HTTPS (needs API token)
 */

const INDEX_NAME = "cyprus-law-cases-search";

// ── Shared types ────────────────────────────────────────

export interface VectorizeMatch {
  id: string;
  score: number;
  metadata?: Record<string, string>;
}

export interface VectorizeQueryResult {
  count: number;
  matches: VectorizeMatch[];
}

export interface VectorizeVector {
  id: string;
  metadata?: Record<string, string>;
}

export type MetadataFilterValue = string | number | boolean | null | {
  $eq?: string | number | boolean | null;
  $ne?: string | number | boolean | null;
  $in?: (string | number | boolean | null)[];
  $nin?: (string | number | boolean | null)[];
  $lt?: string | number;
  $lte?: string | number;
  $gt?: string | number;
  $gte?: string | number;
};

export interface VectorizeQueryOptions {
  topK: number;
  returnMetadata: "none" | "indexed" | "all";
  returnValues: boolean;
  filter?: Record<string, MetadataFilterValue>;
}

export interface VectorizeClient {
  query(vector: number[], options: VectorizeQueryOptions): Promise<VectorizeQueryResult>;
  getByIds(ids: string[]): Promise<VectorizeVector[]>;
}

// ── Production: Worker binding ──────────────────────────

export function createBindingClient(env: CloudflareEnv): VectorizeClient {
  return {
    async query(vector, options) {
      const result = await env.VECTORIZE.query(vector, {
        topK: options.topK,
        returnMetadata: options.returnMetadata,
        returnValues: options.returnValues,
        ...(options.filter ? { filter: options.filter } : {}),
      });
      return {
        count: result.count,
        matches: (result.matches ?? []).map((m) => ({
          id: m.id,
          score: m.score,
          metadata: m.metadata as Record<string, string> | undefined,
        })),
      };
    },
    async getByIds(ids) {
      // Worker binding also has 20 ID limit per request
      const BATCH_SIZE = 20;
      const allVectors: VectorizeVector[] = [];

      for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        const batch = ids.slice(i, i + BATCH_SIZE);
        const vectors = await env.VECTORIZE.getByIds(batch);
        allVectors.push(
          ...vectors.map((v) => ({
            id: v.id,
            metadata: v.metadata as Record<string, string> | undefined,
          })),
        );
      }

      return allVectors;
    },
  };
}

// ── Dev: Cloudflare REST API ────────────────────────────

export function createHttpClient(): VectorizeClient {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;

  if (!accountId || !apiToken) {
    throw new Error(
      "[vectorize-client] Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN in env",
    );
  }

  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/vectorize/v2/indexes/${INDEX_NAME}`;
  const headers = {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
  };

  return {
    async query(vector, options) {
      const res = await fetch(`${baseUrl}/query`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          vector,
          topK: options.topK,
          returnMetadata: options.returnMetadata,
          returnValues: options.returnValues,
          ...(options.filter ? { filter: options.filter } : {}),
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Vectorize query HTTP ${res.status}: ${text.slice(0, 200)}`);
      }

      const json = (await res.json()) as {
        result: { count: number; matches: VectorizeMatch[] };
        success: boolean;
      };

      if (!json.success) {
        throw new Error("Vectorize query failed: response.success=false");
      }

      return json.result;
    },

    async getByIds(ids) {
      // Vectorize REST API limits getByIds to 20 IDs per request
      const BATCH_SIZE = 20;
      const allVectors: VectorizeVector[] = [];

      for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        const batch = ids.slice(i, i + BATCH_SIZE);
        const res = await fetch(`${baseUrl}/get_by_ids`, {
          method: "POST",
          headers,
          body: JSON.stringify({ ids: batch }),
        });

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Vectorize getByIds HTTP ${res.status}: ${text.slice(0, 200)}`);
        }

        const json = (await res.json()) as {
          result: VectorizeVector[];
          success: boolean;
        };

        if (!json.success) {
          throw new Error("Vectorize getByIds failed: response.success=false");
        }

        allVectors.push(...json.result);
      }

      return allVectors;
    },
  };
}
