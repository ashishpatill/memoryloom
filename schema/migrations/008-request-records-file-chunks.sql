-- ============================================================================
-- MemoryLoom, migration 008, request records, file chunks, proposal
-- decision columns and the decay anchor (card S3b).
-- Additive only. v1.sql and migrations 002 to 007 are NOT modified.
-- Apply order, v1.sql, then 002, 003, 004, 005, 006, 007, 008.
--
-- request_records holds one row per covered MCP write call, for the
-- store, propose and ingest_file tools. The row is keyed on the tool
-- name, the namespace and the request id together. It stores the
-- first result of the call and a hash of the call arguments, so a
-- retry returns the first result and writes nothing twice, and a
-- reuse of the request id with a different payload is refused.
--
-- file_chunks holds one row per chunk of an ingested file, with the
-- proposal id, the chunk index and the chunk text. The pair formed
-- by the proposal id and the chunk index is unique, and the database
-- refuses a second row with the same pair. Chunk rows are provenance
-- records. No approval flow and no rejection flow deletes them.
--
-- The proposals table gains a created memory ids array column, which
-- records every memory an approval created in creation order, and a
-- source file name column and a chunk count column, which a file
-- proposal always carries. A proposal that is not a file proposal
-- carries neither field, and both stay null.
--
-- The memories table gains a decay anchor column named
-- decay_anchor_at. A decay strength update writes the run time into
-- this column in the same update, and decay measures age from this
-- column first, then from last_recalled_at, then from created_at.
-- ============================================================================

CREATE TABLE IF NOT EXISTS request_records (
  tool         TEXT NOT NULL,
  namespace    TEXT NOT NULL,
  request_id   TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  result       JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tool, namespace, request_id)
);

CREATE TABLE IF NOT EXISTS file_chunks (
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  chunk_index INTEGER NOT NULL,
  text        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (proposal_id, chunk_index)
);

ALTER TABLE proposals ADD COLUMN IF NOT EXISTS created_memory_ids TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS source_file_name TEXT;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS chunk_count INTEGER;

ALTER TABLE memories ADD COLUMN IF NOT EXISTS decay_anchor_at TIMESTAMPTZ;
