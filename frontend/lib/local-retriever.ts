/**
 * Local development retriever.
 *
 * Calls the Python search server (rag/search_server.py) running
 * on localhost:8100 to query the local ChromaDB vector store.
 *
 * - localSearchFn: returns metadata only (no full text) for search_cases tool
 * - fetchDocumentText: fetches full text of a single document for summarization
 */

import type { SearchResult, DocumentMeta } from "./types";
import type { SearchFn, FetchDocumentFn } from "./llm-client";

const SEARCH_SERVER_URL = process.env.SEARCH_SERVER_URL ?? "http://localhost:8100";

let healthCache: { ok: boolean; checkedAt: number } = { ok: false, checkedAt: 0 };

async function isSearchServerUp(): Promise<boolean> {
  if (Date.now() - healthCache.checkedAt < 30000) return healthCache.ok;
  try {
    const res = await fetch(`${SEARCH_SERVER_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    healthCache = { ok: res.ok, checkedAt: Date.now() };
    return res.ok;
  } catch {
    healthCache = { ok: false, checkedAt: Date.now() };
    return false;
  }
}

/**
 * Search — returns metadata only (doc_id, title, court, year, score).
 * No full text is loaded at this stage.
 */
export const localSearchFn: SearchFn = async (
  query: string,
  court?: string,
  yearFrom?: number,
  yearTo?: number,
): Promise<SearchResult[]> => {
  const serverUp = await isSearchServerUp();
  if (!serverUp) {
    console.error("[search] Search server is not running on port 8100");
    return [{
      doc_id: "",
      title: "SEARCH UNAVAILABLE",
      court: "",
      year: "",
      text: "The case search database is currently unavailable. Please tell the user that the search service is temporarily down and they should try again in a moment.",
      score: 0,
    }];
  }

  const params = new URLSearchParams({
    query,
    n_results: "60",
    max_documents: "30",
  });
  if (court) params.set("court", court);
  if (yearFrom) params.set("year_from", String(yearFrom));
  if (yearTo) params.set("year_to", String(yearTo));

  try {
    const res = await fetch(`${SEARCH_SERVER_URL}/search?${params}`, {
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      console.error(`[search] Server returned ${res.status}`);
      return [];
    }

    const docs = (await res.json()) as DocumentMeta[];
    console.log(`[search] query="${query.slice(0, 50)}" → ${docs.length} docs`);

    // Return as SearchResult with metadata only (text field = brief info)
    return docs.map((d) => ({
      doc_id: d.doc_id,
      title: d.title,
      court: d.court,
      year: d.year,
      score: d.score,
      text: `[Metadata only — use summarize_documents to analyze full text]`,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[search] Search request failed:", message);
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

/**
 * Fetch full text of a single document from the search server (dev with Python server).
 */
export const localFetchDocument: FetchDocumentFn = async (
  docId: string,
): Promise<string | null> => {
  // Try search server first (dev mode with Python server running)
  try {
    const serverUp = await isSearchServerUp();
    if (serverUp) {
      const res = await fetch(
        `${SEARCH_SERVER_URL}/document?doc_id=${encodeURIComponent(docId)}`,
        { signal: AbortSignal.timeout(15000) },
      );
      if (res.ok) {
        const data = (await res.json()) as { text: string };
        return data.text;
      }
    }
  } catch {
    // Fall through to disk
  }

  // Fallback: read directly from disk
  return diskFetchDocument(docId);
};

/**
 * Fetch full text of a document directly from disk (cases_parsed directory).
 */
export const diskFetchDocument: FetchDocumentFn = async (
  docId: string,
): Promise<string | null> => {
  const { readFile } = await import("fs/promises");
  const { join, resolve } = await import("path");

  const normalizedDocId = docId.endsWith(".md") ? docId : `${docId}.md`;

  // Try relative to cwd/../data/cases_parsed (dev + standalone Docker)
  const casesDir = join(process.cwd(), "..", "data", "cases_parsed");
  const filePath = resolve(casesDir, normalizedDocId);

  // Prevent traversal
  if (!filePath.startsWith(resolve(casesDir))) return null;

  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
};
