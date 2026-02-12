-- Schema for hybrid search (BM25 + optional vector)
-- PostgreSQL 17 + pgvector

CREATE EXTENSION IF NOT EXISTS vector;

-- Full documents for BM25 search
CREATE TABLE IF NOT EXISTS documents (
  id         SERIAL PRIMARY KEY,
  doc_id     TEXT NOT NULL UNIQUE,       -- e.g. "apofaseised/oik/2024/2320240403.md"
  court      TEXT NOT NULL,              -- e.g. "oik", "aad", "courtOfAppeal"
  court_level TEXT NOT NULL DEFAULT 'other', -- supreme, appeal, first_instance, etc.
  year       INT NOT NULL DEFAULT 0,
  title      TEXT NOT NULL DEFAULT '',   -- first line of document
  content    TEXT NOT NULL,              -- full document text
  tsv        tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_documents_doc_id ON documents (doc_id);
CREATE INDEX IF NOT EXISTS idx_documents_year ON documents (year);
CREATE INDEX IF NOT EXISTS idx_documents_court_level ON documents (court_level);
CREATE INDEX IF NOT EXISTS idx_documents_tsv ON documents USING GIN (tsv);

-- Stats for BM25 ranking
ANALYZE documents;
