-- ============================================================================
-- MemoryLoom — migration 007: learning events (Block 5).
-- Additive only: v1.sql and migrations 002-006 are NOT modified.
-- Apply order: v1.sql → 002 → 003 → 004 → 005 → 006 → 007.
--
-- learning_events: the ingestion layer of the learning loop. Every
-- interaction that could teach the team something — memory proposals,
-- gate verdicts, human approvals / rejections / corrections, recall
-- hits and misses, eval outcomes, in-turn corrections, promotion
-- decisions — lands here as a provenance-stamped event in Plane 1.
--
-- The table is APPEND-ONLY, enforced by trigger: no UPDATE, no
-- DELETE. A wrong event is answered by a later event, never by an
-- edit — the same discipline as the truth store itself.
--
-- Lessons (playbook entries) are NOT a separate table: a promoted
-- lesson is a memory (type 'procedural', provenance.origin =
-- 'learning-promotion'), so recall, decay and the graph treat it
-- like any other truth record.
-- ============================================================================

CREATE TABLE IF NOT EXISTS learning_events (
  id           TEXT PRIMARY KEY,
  namespace    TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN (
                 'proposal', 'gate_verdict',
                 'human_approval', 'human_rejection', 'human_correction',
                 'recall_hit', 'recall_miss', 'eval_outcome',
                 'in_turn_correction', 'promotion_decision', 'lesson_applied'
               )),
  actor        TEXT,              -- agent or human identity, when known
  subject_type TEXT,              -- memory | proposal | task | learning_event | lesson | ingest
  subject_id   TEXT,
  summary      TEXT NOT NULL,
  evidence     JSONB NOT NULL DEFAULT '{}'::jsonb,
  provenance   JSONB NOT NULL,    -- {author, origin, source_session, created_at}
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS learning_events_ns_time ON learning_events (namespace, created_at);
CREATE INDEX IF NOT EXISTS learning_events_kind ON learning_events (kind);
CREATE INDEX IF NOT EXISTS learning_events_subject ON learning_events (subject_id) WHERE subject_id IS NOT NULL;

CREATE OR REPLACE FUNCTION learning_events_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'learning_events is append-only: % refused', TG_OP;
END $$;

DROP TRIGGER IF EXISTS learning_events_no_update ON learning_events;
CREATE TRIGGER learning_events_no_update
  BEFORE UPDATE ON learning_events
  FOR EACH ROW EXECUTE FUNCTION learning_events_append_only();

DROP TRIGGER IF EXISTS learning_events_no_delete ON learning_events;
CREATE TRIGGER learning_events_no_delete
  BEFORE DELETE ON learning_events
  FOR EACH ROW EXECUTE FUNCTION learning_events_append_only();
