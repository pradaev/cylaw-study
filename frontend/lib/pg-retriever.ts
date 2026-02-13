/**
 * Hybrid retriever — combines vector search with PostgreSQL BM25 via RRF.
 *
 * Architecture (when pgvector embeddings are available):
 *   1. pgvector: embed query → cosine similarity → top-K chunks → dedup by doc → SearchResult[]
 *   2. PostgreSQL: BM25 full-text search on documents table → top-K docs by ts_rank
 *   3. RRF fusion: merge rankings using Reciprocal Rank Fusion (k=60)
 *   4. Return merged, deduplicated SearchResult[]
 *
 * Fallback (no pgvector embeddings): uses Vectorize for vector search instead.
 */

import OpenAI from "openai";
import { Pool } from "pg";
import type { SearchResult } from "./types";
import type { SearchFn } from "./llm-client";

// ── Config ──────────────────────────────────────────────

const BM25_TOP_K = 100;           // max docs to retrieve from BM25
const PGVECTOR_TOP_K = 100;       // max chunks to retrieve from pgvector
const RRF_K = 60;                 // RRF constant (standard value)
const MAX_DOCUMENTS = 30;         // max merged results to return

// Score-based filtering (matches retriever.ts)
const MIN_SCORE_THRESHOLD = 0.42; // absolute floor for cosine similarity
const SCORE_DROP_FACTOR = 0.75;   // adaptive: drop docs scoring < 75% of best

const PGVECTOR_EMBEDDING_MODEL = "text-embedding-3-large";
const PGVECTOR_DIMS = 2000;  // text-embedding-3-large truncated (pgvector 2000d index limit for both HNSW and IVFFlat)

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

  // Set ivfflat.probes on each new connection for good recall
  // sqrt(1500 lists) ≈ 39, using 30 for balance of speed/recall
  _pool.on("connect", (client) => {
    client.query("SET ivfflat.probes = 30").catch(() => {});
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
    .map((w) => w.replace(/[^a-zA-Zα-ωΑ-Ωά-ώ0-9./()]/g, ""))
    .filter(Boolean);

  if (words.length === 0) return [];

  const tsQuery = words.join(" | ");

  let sql = `
    SELECT doc_id, title, court, court_level, year,
      ts_rank(tsv, to_tsquery('cylaw', $1)) AS rank
    FROM documents
    WHERE tsv @@ to_tsquery('cylaw', $1)
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
    const orResults = result.rows as BM25Result[];

    // Also run phrase search — critical for matching exact statute/article/case refs
    // phraseto_tsquery preserves word order: "Ν. 216(Ι)/2012" matches documents with those words adjacent
    const phraseResults = await bm25PhraseSearch(query, yearFrom, yearTo);

    // Merge: phrase results get priority (lower rank = higher priority)
    const merged = new Map<string, BM25Result>();
    for (const r of phraseResults) {
      merged.set(r.doc_id, r);
    }
    for (const r of orResults) {
      if (!merged.has(r.doc_id)) {
        merged.set(r.doc_id, r);
      }
    }

    // Sort by rank descending and cap
    return Array.from(merged.values())
      .sort((a, b) => b.rank - a.rank)
      .slice(0, BM25_TOP_K);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify({ event: "bm25_search_error", error: msg }));
    return [];
  }
}

/**
 * BM25 phrase search — preserves word order for exact matches.
 * Critical for matching statute references like "Ν. 216(Ι)/2012" or case numbers.
 */
async function bm25PhraseSearch(
  query: string,
  yearFrom?: number,
  yearTo?: number,
): Promise<BM25Result[]> {
  const pool = getPool();
  if (!pool) return [];

  // Only run phrase search if query looks like it might contain an exact reference
  // (has numbers, dots, parentheses, or is short enough to be specific)
  const hasExactRef = /[0-9]/.test(query) || /[.()\/]/.test(query) || query.split(/\s+/).length <= 6;
  if (!hasExactRef) return [];

  let sql = `
    SELECT doc_id, title, court, court_level, year,
      ts_rank(tsv, phraseto_tsquery('cylaw', $1)) AS rank
    FROM documents
    WHERE tsv @@ phraseto_tsquery('cylaw', $1)
  `;
  const params: (string | number)[] = [query];
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

  sql += ` ORDER BY rank DESC LIMIT 20`;

  try {
    const result = await pool.query(sql, params);
    if (result.rows.length > 0) {
      console.log(JSON.stringify({
        event: "bm25_phrase_match",
        query: query.slice(0, 200),
        found: result.rows.length,
      }));
    }
    return result.rows as BM25Result[];
  } catch (err) {
    // Phrase search can fail on some query patterns — that's OK, OR search covers it
    const msg = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify({ event: "bm25_phrase_search_error", error: msg }));
    return [];
  }
}

// ── pgvector search ─────────────────────────────────────

/** Check if chunks table has embeddings (cached, checked once per process) */
let _hasPgvectorEmbeddings: boolean | null = null;

async function hasPgvectorEmbeddings(): Promise<boolean> {
  if (_hasPgvectorEmbeddings !== null) return _hasPgvectorEmbeddings;
  const pool = getPool();
  if (!pool) {
    _hasPgvectorEmbeddings = false;
    return false;
  }
  try {
    const result = await pool.query(
      "SELECT EXISTS (SELECT 1 FROM chunks LIMIT 1) AS has_data",
    );
    _hasPgvectorEmbeddings = result.rows[0]?.has_data === true;
  } catch {
    _hasPgvectorEmbeddings = false;
  }
  return _hasPgvectorEmbeddings;
}

interface PgvectorChunkResult {
  doc_id: string;
  court: string;
  court_level: string;
  year: number;
  title: string;
  score: number;
}

/**
 * Search via pgvector: embed query with text-embedding-3-large, then cosine similarity
 * on chunks table. Groups by doc_id (best chunk score per doc), applies score filtering.
 */
async function pgvectorSearch(
  query: string,
  courtLevel?: string,
  yearFrom?: number,
  yearTo?: number,
): Promise<SearchResult[]> {
  const pool = getPool();
  if (!pool) return [];

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return [];

  // 1. Embed query
  const openai = new OpenAI({ apiKey });
  const embResponse = await openai.embeddings.create({
    model: PGVECTOR_EMBEDDING_MODEL,
    input: query,
    dimensions: PGVECTOR_DIMS,
  });
  const queryVector = embResponse.data[0].embedding;
  const vectorStr = `[${queryVector.join(",")}]`;

  // 2. Query pgvector with optional metadata filters
  let sql = `
    SELECT doc_id, court, court_level, year, title,
           1 - (embedding <=> $1::vector) AS score
    FROM chunks
    WHERE 1=1
  `;
  const params: (string | number)[] = [vectorStr];
  let paramIdx = 2;

  if (courtLevel && ["supreme", "appeal", "foreign"].includes(courtLevel)) {
    sql += ` AND court_level = $${paramIdx}`;
    params.push(courtLevel);
    paramIdx++;
  }
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

  sql += ` ORDER BY embedding <=> $1::vector LIMIT $${paramIdx}`;
  params.push(PGVECTOR_TOP_K);

  try {
    const result = await pool.query(sql, params);
    const chunks = result.rows as PgvectorChunkResult[];

    // 3. Group by doc_id, keep best chunk score per document
    const docMap = new Map<string, PgvectorChunkResult>();
    for (const chunk of chunks) {
      const existing = docMap.get(chunk.doc_id);
      if (!existing || chunk.score > existing.score) {
        docMap.set(chunk.doc_id, chunk);
      }
    }

    // 4. Sort by score descending
    const sorted = Array.from(docMap.values()).sort((a, b) => b.score - a.score);

    // 5. Score filtering (same logic as retriever.ts)
    const bestScore = sorted[0]?.score ?? 0;
    const adaptiveThreshold = bestScore * SCORE_DROP_FACTOR;
    const effectiveThreshold = Math.max(MIN_SCORE_THRESHOLD, adaptiveThreshold);
    const filtered = sorted.filter((d) => d.score >= effectiveThreshold);

    // 6. Cap at MAX_DOCUMENTS
    const topDocs = filtered.slice(0, MAX_DOCUMENTS);

    console.log(JSON.stringify({
      event: "pgvector_search",
      query: query.slice(0, 200),
      courtLevel: courtLevel || null,
      yearFrom,
      yearTo,
      chunksMatched: chunks.length,
      uniqueDocs: sorted.length,
      afterScoreFilter: filtered.length,
      returned: topDocs.length,
      topScore: bestScore,
      scoreThreshold: parseFloat(effectiveThreshold.toFixed(4)),
    }));

    return topDocs.map((d) => ({
      doc_id: d.doc_id,
      title: d.title,
      court: d.court,
      year: String(d.year),
      score: d.score,
      text: "[Metadata only — use summarize_documents to analyze full text]",
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify({ event: "pgvector_search_error", error: msg }));
    return [];
  }
}

/**
 * Create a search function using pgvector (text-embedding-3-large 3072d).
 * This replaces Vectorize for vector search when embeddings exist in PostgreSQL.
 */
export function createPgvectorSearchFn(): SearchFn {
  return pgvectorSearch;
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
 * Create a hybrid search function that combines vector search + BM25.
 *
 * Vector search priority:
 *   1. pgvector (text-embedding-3-large 3072d) — if chunks table has data
 *   2. Vectorize (text-embedding-3-small 1536d) — fallback
 *
 * Falls back to vector-only if DATABASE_URL is not set.
 */
export function createHybridSearchFn(vectorizeSearchFn: SearchFn): SearchFn {
  return async (
    query: string,
    courtLevel?: string,
    yearFrom?: number,
    yearTo?: number,
  ): Promise<SearchResult[]> => {
    // Choose vector search backend: pgvector if available, else Vectorize
    const usePgvector = await hasPgvectorEmbeddings();
    const vectorSearchFn = usePgvector ? pgvectorSearch : vectorizeSearchFn;

    // Run vector search and BM25 in parallel
    const [vectorResults, bm25Results] = await Promise.all([
      vectorSearchFn(query, courtLevel, yearFrom, yearTo),
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
