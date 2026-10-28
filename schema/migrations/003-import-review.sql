-- ============================================================================
-- Bot memory — migration 003: import review queue + content-hash dedup (P1.M6)
-- Additive only: v1.sql and 002-proposals.sql are NOT modified.
-- Apply order: v1.sql → 002-proposals.sql → 003-import-review.sql.
-- Source: memory/plan/FINAL-PLAN-V2.md §10 (honesty / contradiction resolution),
--         §12 (write gates), Mem0 ADD/UPDATE/DELETE/NOOP ingestion op-set;
--         TASKS.md P1.M6 (JSONL import → review queue for contradictions).
--
-- review_items expands the plan sketch (proposal|resolution) with
-- import_contradiction for the bot-memory JSONL import path, plus decided_*
-- columns so a human/curator can approve/reject/resolve later (M7+).
-- content_hash stays inside provenance JSONB (spike export shape); the unique
-- index below is an expression index for O(1) dedup lookup.
-- ============================================================================

CREATE TABLE IF NOT EXISTS review_items (
  id          TEXT PRIMARY KEY,              -- ULID-ish / uuid string
  kind        TEXT NOT NULL
                CHECK (kind IN ('proposal', 'resolution', 'import_contradiction')),
  payload     JSONB NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'approved', 'rejected', 'resolved')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at  TIMESTAMPTZ,
  decided_by  TEXT                           -- curator id / 'human' on decision
);

CREATE INDEX IF NOT EXISTS review_items_status ON review_items (status, created_at);
CREATE INDEX IF NOT EXISTS review_items_kind ON review_items (kind);

-- Content-hash dedup: provenance->>'content_hash' (sha256 of normalized text).
-- Partial unique index — only rows that carry a hash participate.
CREATE UNIQUE INDEX IF NOT EXISTS memories_content_hash_uq
  ON memories ((provenance->>'content_hash'))
  WHERE provenance->>'content_hash' IS NOT NULL;
