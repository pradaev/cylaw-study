-- Schema for hybrid search (BM25 + optional vector)
-- PostgreSQL 17 + pgvector + Greek stemming

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- Greek text search: hunspell (word recognition + stop words) → custom legal dict → simple fallback
-- Requires: hunspell-el installed, cylaw_custom.dict/affix in tsearch_data/
CREATE TEXT SEARCH DICTIONARY IF NOT EXISTS greek_hunspell (
  TEMPLATE = ispell,
  DictFile = el_gr, AffFile = el_gr, StopWords = greek
);
CREATE TEXT SEARCH DICTIONARY IF NOT EXISTS cylaw_custom (
  TEMPLATE = ispell,
  DictFile = cylaw_custom, AffFile = cylaw_custom
);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'cylaw') THEN
    CREATE TEXT SEARCH CONFIGURATION cylaw (COPY = simple);
    ALTER TEXT SEARCH CONFIGURATION cylaw
      ALTER MAPPING FOR asciiword, asciihword, hword_asciipart
      WITH cylaw_custom, simple;
    ALTER TEXT SEARCH CONFIGURATION cylaw
      ALTER MAPPING FOR word, hword, hword_part
      WITH greek_hunspell, cylaw_custom, simple;
  END IF;
END $$;

-- Full documents for BM25 search
CREATE TABLE IF NOT EXISTS documents (
  id         SERIAL PRIMARY KEY,
  doc_id     TEXT NOT NULL UNIQUE,       -- e.g. "apofaseised/oik/2024/2320240403.md"
  court      TEXT NOT NULL,              -- e.g. "oik", "aad", "courtOfAppeal"
  court_level TEXT NOT NULL DEFAULT 'other', -- supreme, appeal, first_instance, etc.
  year       INT NOT NULL DEFAULT 0,
  title      TEXT NOT NULL DEFAULT '',   -- first line of document
  content    TEXT NOT NULL,              -- full document text
  tsv        tsvector GENERATED ALWAYS AS (to_tsvector('cylaw', content)) STORED
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_documents_doc_id ON documents (doc_id);
CREATE INDEX IF NOT EXISTS idx_documents_year ON documents (year);
CREATE INDEX IF NOT EXISTS idx_documents_court_level ON documents (court_level);
CREATE INDEX IF NOT EXISTS idx_documents_tsv ON documents USING GIN (tsv);

-- Stats for BM25 ranking
ANALYZE documents;

-- ── Chunks table for pgvector search (text-embedding-3-large, 3072d) ──

CREATE TABLE IF NOT EXISTS chunks (
  id           SERIAL PRIMARY KEY,
  doc_id       TEXT NOT NULL,                -- e.g. "apofaseised/oik/2024/2320240403.md"
  chunk_index  INT NOT NULL,                 -- 0-based chunk index within document
  content      TEXT NOT NULL,                -- chunk text (with contextual header)
  embedding    vector(2000) NOT NULL,        -- text-embedding-3-large (truncated from 3072 for HNSW)
  court        TEXT NOT NULL DEFAULT '',      -- court code
  court_level  TEXT NOT NULL DEFAULT 'other', -- supreme, appeal, first_instance, etc.
  year         INT NOT NULL DEFAULT 0,
  title        TEXT NOT NULL DEFAULT '',      -- first line of document
  subcourt     TEXT NOT NULL DEFAULT '',      -- subcourt code
  jurisdiction TEXT NOT NULL DEFAULT '',      -- jurisdiction type (ΠΕΡΙΟΥΣΙΑΚΩΝ ΔΙΑΦΟΡΩΝ, etc.)
  UNIQUE(doc_id, chunk_index)
);

-- Vector search index (IVFFlat: fast build for 2M+ vectors at 2000d)
-- pgvector HNSW limit: 2000 dimensions. IVFFlat chosen for faster build times.
-- Build AFTER bulk load for best performance. Set ivfflat.probes=30 at query time.
-- CREATE INDEX idx_chunks_embedding ON chunks
--   USING ivfflat (embedding vector_cosine_ops) WITH (lists = 1500);

-- Metadata filter indexes (replicate Vectorize metadata indexes)
CREATE INDEX IF NOT EXISTS idx_chunks_doc_id ON chunks (doc_id);
CREATE INDEX IF NOT EXISTS idx_chunks_court_level ON chunks (court_level);
CREATE INDEX IF NOT EXISTS idx_chunks_year ON chunks (year);
CREATE INDEX IF NOT EXISTS idx_chunks_court ON chunks (court);
CREATE INDEX IF NOT EXISTS idx_chunks_subcourt ON chunks (subcourt);
CREATE INDEX IF NOT EXISTS idx_chunks_jurisdiction ON chunks (jurisdiction);

ANALYZE chunks;
