-- ============================================================================
-- Bot memory — migration 002: proposals (P1.M4)
-- Human/curator review queue for the propose() path (IDL v2.1 §12).
-- v1.sql is NOT modified; this is an additive P1 migration.
-- Apply order: v1.sql, then migrations/002-proposals.sql.
-- Source: memory/plan/FINAL-PLAN-V2.md §12 (write gates), §10 (resolution).
-- ============================================================================

CREATE TABLE IF NOT EXISTS proposals (
  id               TEXT PRIMARY KEY,  -- ULID-ish, time-ordered
  namespace        TEXT NOT NULL,
  type             TEXT NOT NULL CHECK (type IN
                     ('working','episodic','semantic','procedural','goals','reflective')),
  scope            TEXT NOT NULL DEFAULT 'global'
                     CHECK (scope IN ('global','node_local','edge')),
  text             TEXT NOT NULL,     -- atomic: one claim per proposal
  importance       SMALLINT NOT NULL DEFAULT 5 CHECK (importance BETWEEN 1 AND 10),
  strength         REAL NOT NULL DEFAULT 5.0 CHECK (strength BETWEEN 0 AND 10),
  pinned           BOOLEAN NOT NULL DEFAULT FALSE,
  grounding_ids    TEXT[] NOT NULL DEFAULT '{}', -- cited memory IDs (Q6)
  provenance       JSONB NOT NULL,
  -- routing outcome of propose(): why it landed in the queue
  route_reason     TEXT NOT NULL,     -- e.g. 'procedural-human-always',
                                     -- 'pinned-human-always', 'low-evidence'
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','approved','rejected')),
  decided_by       TEXT,              -- curator id / 'human' on decision
  decided_at       TIMESTAMPTZ,
  promoted_id      TEXT REFERENCES memories(id), -- set when approved → memory
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS proposals_status ON proposals (status, created_at);
CREATE INDEX IF NOT EXISTS proposals_namespace ON proposals (namespace);
