/**
 * Production retriever — queries Cloudflare Vectorize for semantic search.
 *
 * Same code runs in dev and production. Only the Vectorize client differs:
 *   - Production: Worker binding (createBindingClient)
 *   - Dev: Cloudflare REST API (createHttpClient)
 *
 * Flow:
 *   1. Embed the query text via OpenAI API (text-embedding-3-small, 1536 dims)
 *   2. Query Vectorize with topK=100, optional court_level filter
 *   3. Group matching chunks by doc prefix → unique documents
 *   4. Fetch metadata via getByIds() for ALL unique docs
 *   5. Apply court-level score boost (supreme ×1.15, appeal ×1.10)
 *   6. Apply year filtering if yearFrom/yearTo provided
 *   7. Take top MAX_DOCUMENTS from filtered set
 *   8. Return SearchResult[] with metadata (no full text)
 */

import OpenAI from "openai";

import type { SearchResult } from "./types";
import type { SearchFn } from "./llm-client";
import type { VectorizeClient } from "./vectorize-client";

const EMBEDDING_MODEL = "text-embedding-3-small";
const VECTORIZE_TOP_K = 100;
const MAX_DOCUMENTS = 15; // keep low to avoid Worker timeout (each doc = R2 fetch + GPT-4o summarize)

/** Extract doc prefix from vector ID: "doc_id::chunk_N" → "doc_id" */
function extractDocPrefix(vectorId: string): string {
  const sep = vectorId.lastIndexOf("::");
  return sep !== -1 ? vectorId.slice(0, sep) : vectorId;
}

/**
 * Create a search function backed by Vectorize.
 * Accepts a VectorizeClient — same logic for binding and HTTP.
 */
export function createVectorizeSearchFn(client: VectorizeClient): SearchFn {
  return async (
    query: string,
    _court?: string,
    yearFrom?: number,
    yearTo?: number,
  ): Promise<SearchResult[]> => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.log(JSON.stringify({ event: "vectorize_search_error", error: "Missing OPENAI_API_KEY" }));
      return [];
    }

    try {
      // 1. Embed the query
      const openai = new OpenAI({ apiKey });
      const embeddingResponse = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: query,
      });
      const queryVector = embeddingResponse.data[0].embedding;

      // 2. Query Vectorize (no metadata → allows topK up to 100)
      const results = await client.query(queryVector, {
        topK: VECTORIZE_TOP_K,
        returnMetadata: "none",
        returnValues: false,
      });

      if (!results.matches || results.matches.length === 0) {
        console.log(JSON.stringify({ event: "vectorize_search", query: query.slice(0, 200), chunksMatched: 0, returned: 0 }));
        return [];
      }

      // 3. Group by doc prefix, keep best score per document
      const docMap = new Map<string, { score: number; representativeId: string }>();

      for (const match of results.matches) {
        const docPrefix = extractDocPrefix(match.id);
        const existing = docMap.get(docPrefix);

        if (existing) {
          if (match.score > existing.score) {
            existing.score = match.score;
            existing.representativeId = match.id;
          }
        } else {
          docMap.set(docPrefix, {
            score: match.score,
            representativeId: match.id,
          });
        }
      }

      // 4. Sort by score (all unique docs, before filtering)
      const sortedDocs = Array.from(docMap.entries())
        .sort((a, b) => b[1].score - a[1].score);

      // 5. Fetch metadata for ALL unique docs (need year + court_level for filtering/boost)
      const representativeIds = sortedDocs.map(([, doc]) => doc.representativeId);
      const vectors = await client.getByIds(representativeIds);

      const metaLookup = new Map<string, Record<string, string>>();
      for (const vec of vectors) {
        if (vec.metadata) {
          metaLookup.set(vec.id, vec.metadata);
        }
      }

      // 6. Apply year filtering if yearFrom/yearTo provided
      let filteredDocs = sortedDocs;
      if (yearFrom || yearTo) {
        filteredDocs = sortedDocs.filter(([, doc]) => {
          const meta = metaLookup.get(doc.representativeId);
          if (!meta?.year) return true;
          const year = parseInt(meta.year, 10);
          if (isNaN(year)) return true;
          if (yearFrom && year < yearFrom) return false;
          if (yearTo && year > yearTo) return false;
          return true;
        });
      }

      // 8. Take top MAX_DOCUMENTS from filtered set
      const topDocs = filteredDocs.slice(0, MAX_DOCUMENTS);

      console.log(JSON.stringify({
        event: "vectorize_search",
        query: query.slice(0, 200),
        yearFrom,
        yearTo,
        chunksMatched: results.matches.length,
        uniqueDocs: sortedDocs.length,
        afterYearFilter: filteredDocs.length,
        returned: topDocs.length,
        topScore: topDocs[0]?.[1]?.score ?? 0,
      }));

      // 9. Return as SearchResult (metadata only, no full text)
      return topDocs.map(([, doc]) => {
        const meta = metaLookup.get(doc.representativeId) ?? {};
        return {
          doc_id: meta.doc_id ?? "",
          title: meta.title ?? "",
          court: meta.court ?? "",
          year: meta.year ?? "",
          score: doc.score,
          text: "[Metadata only — use summarize_documents to analyze full text]",
        };
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(JSON.stringify({
        event: "vectorize_search_error",
        query: query.slice(0, 200),
        error: message,
      }));
      return [{
        doc_id: "",
        title: "SEARCH ERROR",
        court: "",
        year: "",
        text: `Search failed: ${message}. Please tell the user there was a temporary search error.`,
        score: 0,
      }];
    }
  };
}
