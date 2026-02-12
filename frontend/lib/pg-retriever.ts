/**
 * Hybrid retriever — combines Vectorize vector search with PostgreSQL BM25 via RRF.
 *
 * Architecture:
 *   1. Vectorize: embed query → cosine similarity → top-K chunks → dedup by doc → SearchResult[]
 *   2. PostgreSQL: BM25 full-text search on documents table → top-K docs by ts_rank
 *   3. RRF fusion: merge rankings using Reciprocal Rank Fusion (k=60)
 *   4. Return merged, deduplicated SearchResult[]
 *
 * This retriever wraps an existing Vectorize SearchFn and adds BM25 results.
 * If DATABASE_URL is not set, it falls back to Vectorize-only search.
 */

import { Pool } from "pg";
import type { SearchResult } from "./types";
import type { SearchFn } from "./llm-client";

// ── Config ──────────────────────────────────────────────

const BM25_TOP_K = 100;           // max docs to retrieve from BM25
const RRF_K = 60;                 // RRF constant (standard value)
const MAX_DOCUMENTS = 30;         // max merged results to return

// ── PostgreSQL connection pool ──────────────────────────

let _pool: Pool | null = null;

function getPool(): Pool | null {
  if (_pool) return _pool;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return null;

  _pool = new Pool({
    connectionString: databaseUrl,
    max: 3,
    idleTimeoutMillis: 30000,
  });

  return _pool;
}

// ── BM25 search via PostgreSQL ──────────────────────────

interface BM25Result {
  doc_id: string;
  title: string;
  court: string;
  court_level: string;
  year: number;
  rank: number;
}

async function bm25Search(
  query: string,
  yearFrom?: number,
  yearTo?: number,
): Promise<BM25Result[]> {
  const pool = getPool();
  if (!pool) return [];

  // Build tsquery with OR logic for better recall
  // Split query into words and join with |
  const words = query
    .split(/\s+/)
    .filter((w) => w.length >= 2)
    .map((w) => w.replace(/[^a-zA-Zα-ωΑ-Ωά-ώ0-9]/g, ""))
    .filter(Boolean);

  if (words.length === 0) return [];

  const tsQuery = words.join(" | ");

  let sql = `
    SELECT doc_id, title, court, court_level, year,
      ts_rank(tsv, to_tsquery('simple', $1)) AS rank
    FROM documents
    WHERE tsv @@ to_tsquery('simple', $1)
  `;
  const params: (string | number)[] = [tsQuery];
  let paramIdx = 2;

  if (yearFrom) {
    sql += ` AND year >= $${paramIdx}`;
    params.push(yearFrom);
    paramIdx++;
  }
  if (yearTo) {
    sql += ` AND year <= $${paramIdx}`;
    params.push(yearTo);
    paramIdx++;
  }

  sql += ` ORDER BY rank DESC LIMIT $${paramIdx}`;
  params.push(BM25_TOP_K);

  try {
    const result = await pool.query(sql, params);
    return result.rows as BM25Result[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify({ event: "bm25_search_error", error: msg }));
    return [];
  }
}

// ── RRF Fusion ──────────────────────────────────────────

interface FusedDoc {
  doc_id: string;
  title: string;
  court: string;
  year: string;
  vectorScore: number;
  vectorRank: number;
  bm25Score: number;
  bm25Rank: number;
  rrfScore: number;
}

function rrfFusion(
  vectorResults: SearchResult[],
  bm25Results: BM25Result[],
): FusedDoc[] {
  const docMap = new Map<string, FusedDoc>();

  // Add vector results with their ranks
  for (let i = 0; i < vectorResults.length; i++) {
    const doc = vectorResults[i];
    docMap.set(doc.doc_id, {
      doc_id: doc.doc_id,
      title: doc.title,
      court: doc.court,
      year: doc.year,
      vectorScore: doc.score ?? 0,
      vectorRank: i + 1,
      bm25Score: 0,
      bm25Rank: 0,
      rrfScore: 1 / (RRF_K + i + 1),
    });
  }

  // Add/merge BM25 results
  for (let i = 0; i < bm25Results.length; i++) {
    const bm = bm25Results[i];
    const existing = docMap.get(bm.doc_id);
    const bm25RrfContrib = 1 / (RRF_K + i + 1);

    if (existing) {
      existing.bm25Score = bm.rank;
      existing.bm25Rank = i + 1;
      existing.rrfScore += bm25RrfContrib;
    } else {
      docMap.set(bm.doc_id, {
        doc_id: bm.doc_id,
        title: bm.title,
        court: bm.court,
        year: String(bm.year),
        vectorScore: 0,
        vectorRank: 0,
        bm25Score: bm.rank,
        bm25Rank: i + 1,
        rrfScore: bm25RrfContrib,
      });
    }
  }

  // Sort by RRF score descending
  return Array.from(docMap.values()).sort((a, b) => b.rrfScore - a.rrfScore);
}

// ── Hybrid search function ──────────────────────────────

/**
 * Create a hybrid search function that combines Vectorize + BM25.
 * Falls back to Vectorize-only if DATABASE_URL is not set.
 */
export function createHybridSearchFn(vectorizeSearchFn: SearchFn): SearchFn {
  return async (
    query: string,
    courtLevel?: string,
    yearFrom?: number,
    yearTo?: number,
  ): Promise<SearchResult[]> => {
    // Run vector search and BM25 in parallel
    const [vectorResults, bm25Results] = await Promise.all([
      vectorizeSearchFn(query, courtLevel, yearFrom, yearTo),
      bm25Search(query, yearFrom, yearTo),
    ]);

    // If no BM25 results (no DATABASE_URL), return vector-only
    if (bm25Results.length === 0) {
      return vectorResults;
    }

    // RRF fusion
    const fused = rrfFusion(vectorResults, bm25Results);
    const topDocs = fused.slice(0, MAX_DOCUMENTS);

    // Log hybrid search results
    const bothFound = topDocs.filter((d) => d.vectorRank > 0 && d.bm25Rank > 0).length;
    const vectorOnly = topDocs.filter((d) => d.vectorRank > 0 && d.bm25Rank === 0).length;
    const bm25Only = topDocs.filter((d) => d.vectorRank === 0 && d.bm25Rank > 0).length;

    console.log(JSON.stringify({
      event: "hybrid_search",
      query: query.slice(0, 200),
      vectorResults: vectorResults.length,
      bm25Results: bm25Results.length,
      fusedTotal: fused.length,
      returned: topDocs.length,
      bothFound,
      vectorOnly,
      bm25Only,
    }));

    // Convert to SearchResult[] — include BM25 rank so reranker can force-keep BM25 hits
    return topDocs.map((doc) => ({
      doc_id: doc.doc_id,
      title: doc.title,
      court: doc.court,
      year: doc.year,
      score: doc.rrfScore,
      text: "[Metadata only — use summarize_documents to analyze full text]",
      bm25Rank: doc.bm25Rank > 0 ? doc.bm25Rank : undefined,
    }));
  };
}
