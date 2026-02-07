/**
 * Local development retriever.
 *
 * Calls the Python search server (rag/search_server.py) running
 * on localhost:8100 to query the local ChromaDB vector store.
 *
 * Usage:
 *   1. Start the search server: python -m rag.search_server
 *   2. Start Next.js: npm run dev
 *   3. The chat will use real vector search via the local server
 */

import type { SearchResult } from "./types";
import type { SearchFn } from "./llm-client";

const SEARCH_SERVER_URL = process.env.SEARCH_SERVER_URL ?? "http://localhost:8100";

export const localSearchFn: SearchFn = async (
  query: string,
  court?: string,
  yearFrom?: number,
  yearTo?: number,
): Promise<SearchResult[]> => {
  const params = new URLSearchParams({ query, n_results: "10" });
  if (court) params.set("court", court);
  if (yearFrom) params.set("year_from", String(yearFrom));
  if (yearTo) params.set("year_to", String(yearTo));

  try {
    const res = await fetch(`${SEARCH_SERVER_URL}/search?${params}`, {
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      console.error(`[search] Server returned ${res.status}`);
      return [];
    }

    const data = (await res.json()) as SearchResult[];
    return data;
  } catch (err) {
    console.error("[search] Local search server unavailable:", err instanceof Error ? err.message : err);
    return [];
  }
};
