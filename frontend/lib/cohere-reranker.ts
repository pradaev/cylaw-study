/**
 * Cohere Rerank — cross-encoder reranker using rerank-v3.5 (multilingual, supports Greek).
 *
 * Advantages over GPT-4o-mini reranker:
 * - Purpose-built cross-encoder: compares query-document pairs directly
 * - No batch noise: each doc scored independently, not relative to batch
 * - Handles up to 1000 docs per call (no need for batching)
 * - Auto-truncates long docs (max_tokens_per_doc)
 *
 * Cost: $2.00 per 1000 searches (first 1000 free/month)
 * Latency: ~1-3s for 60 docs
 */

const COHERE_RERANK_URL = "https://api.cohere.com/v2/rerank";
const COHERE_MODEL = "rerank-v3.5";

interface CohereRerankResult {
  index: number;
  relevance_score: number;
}

interface CohereRerankResponse {
  results: CohereRerankResult[];
  id: string;
  meta?: {
    billed_units?: { search_units?: number };
  };
}

export interface RerankScoredDoc {
  index: number;
  score: number;
}

/**
 * Rerank documents using Cohere rerank-v3.5.
 *
 * @param query - User's search query
 * @param documents - Array of document preview texts
 * @param topN - Max number of results to return (default: all)
 * @returns Sorted array of { index, score } where score is 0-1 relevance
 */
export async function cohereRerank(
  query: string,
  documents: string[],
  topN?: number,
): Promise<RerankScoredDoc[]> {
  const apiKey = process.env.COHERE_API_KEY;
  if (!apiKey) {
    throw new Error("COHERE_API_KEY not set");
  }

  const body: Record<string, unknown> = {
    model: COHERE_MODEL,
    query,
    documents,
  };
  if (topN) {
    body.top_n = topN;
  }

  const response = await fetch(COHERE_RERANK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Cohere rerank failed (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as CohereRerankResponse;

  return data.results.map((r) => ({
    index: r.index,
    score: r.relevance_score,
  }));
}
