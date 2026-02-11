/**
 * Weaviate retriever — vector search with text-embedding-3-large (3072d).
 *
 * Uses document-level embeddings. For hybrid (vector+BM25) we would need
 * Weaviate's vectorizer or a future API; for now vector-only.
 * Use when SEARCH_BACKEND=weaviate and WEAVIATE_URL is set.
 */

import OpenAI from "openai";

import type { SearchResult } from "./types";
import type { SearchFn } from "./llm-client";

const EMBEDDING_MODEL = "text-embedding-3-large";
const TOP_K = 100;
const MAX_DOCUMENTS = 30;
const MIN_SCORE_THRESHOLD = 0.42;
const SCORE_DROP_FACTOR = 0.75;

interface WeaviateResult {
  doc_id?: string;
  title?: string;
  court?: string;
  year?: string;
  _additional?: { distance?: number; score?: string };
}

function buildWhereClause(courtLevel?: string): string | null {
  if (courtLevel && ["supreme", "appeal", "foreign"].includes(courtLevel)) {
    return `{ path: ["court_level"], operator: Equal, valueText: "${courtLevel}" }`;
  }
  return null;
}

/**
 * Create a search function backed by Weaviate (hybrid: vector + BM25).
 */
export function createWeaviateSearchFn(weaviateUrl: string): SearchFn {
  return async (
    query: string,
    courtLevel?: string,
    yearFrom?: number,
    yearTo?: number,
  ): Promise<SearchResult[]> => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.log(JSON.stringify({ event: "weaviate_search_error", error: "Missing OPENAI_API_KEY" }));
      return [];
    }

    try {
      const openai = new OpenAI({ apiKey });
      const emb = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: query });
      const vector = emb.data[0].embedding;

      const where = buildWhereClause(courtLevel);
      const whereStr = where ? `, where: ${where}` : "";

      const queryStr = `
        {
          Get {
            CourtCase(
              limit: ${TOP_K}
              nearVector: {
                vector: [${vector.join(",")}]
              }${whereStr}
            ) {
              doc_id
              title
              court
              year
              _additional { distance }
            }
          }
        }
      `;

      const res = await fetch(`${weaviateUrl.replace(/\/$/, "")}/v1/graphql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: queryStr }),
      });

      if (!res.ok) {
        throw new Error(`Weaviate HTTP ${res.status}: ${await res.text()}`);
      }

      const json = (await res.json()) as { data?: { Get?: { CourtCase?: WeaviateResult[] } }; errors?: unknown[] };
      if (json.errors?.length) {
        throw new Error(JSON.stringify(json.errors[0]));
      }

      const items = json.data?.Get?.CourtCase ?? [];
      if (items.length === 0) {
        console.log(JSON.stringify({ event: "weaviate_search", query: query.slice(0, 200), returned: 0 }));
        return [];
      }

      // Cosine distance: lower = more similar. Convert to 0-1 score (1 - distance for cosine)
      const scored = items.map((o) => {
        const dist = o._additional?.distance ?? 1;
        const score = typeof dist === "number" ? Math.max(0, 1 - dist) : parseFloat(o._additional?.score ?? "0");
        return {
          doc_id: o.doc_id ?? "",
          title: o.title ?? "",
          court: o.court ?? "",
          year: o.year ?? "",
          score,
        };
      });

      // Year filter (Weaviate where may not support both bounds easily)
      let filtered = scored;
      if (yearFrom != null || yearTo != null) {
        filtered = scored.filter((s) => {
          const y = parseInt(String(s.year), 10);
          if (isNaN(y)) return true;
          if (yearFrom != null && y < yearFrom) return false;
          if (yearTo != null && y > yearTo) return false;
          return true;
        });
      }

      const bestScore = filtered[0]?.score ?? 0;
      const adaptiveThreshold = bestScore * SCORE_DROP_FACTOR;
      const effectiveThreshold = Math.max(MIN_SCORE_THRESHOLD, adaptiveThreshold);
      const topDocs = filtered
        .filter((s) => s.score >= effectiveThreshold)
        .slice(0, MAX_DOCUMENTS);

      console.log(JSON.stringify({
        event: "weaviate_search",
        query: query.slice(0, 200),
        courtLevel: courtLevel ?? null,
        yearFrom,
        yearTo,
        rawCount: items.length,
        returned: topDocs.length,
        topScore: bestScore,
      }));

      return topDocs.map((s) => ({
        doc_id: s.doc_id,
        title: s.title,
        court: s.court,
        year: String(s.year),
        score: s.score,
        text: "[Metadata only — use summarize_documents to analyze full text]",
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(JSON.stringify({ event: "weaviate_search_error", query: query.slice(0, 200), error: message }));
      return [{
        doc_id: "",
        title: "SEARCH ERROR",
        court: "",
        year: "",
        text: `Search failed: ${message}. Please try again.`,
        score: 0,
      }];
    }
  };
}
