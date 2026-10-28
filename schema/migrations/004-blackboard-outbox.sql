-- ============================================================================
-- Bot memory — migration 004: blackboard + outbox (P1.G1)
-- Graph topology: blackboard-first shared board + outbox event bus on Neon
-- (FINAL-PLAN-V2.md §11). Additive; v1.sql is NOT modified.
-- Apply order: v1.sql → 002 → 003 → 004. Target: Neon branch p1-v1 only
-- until production main cutover.
-- ============================================================================

-- Shared board (supervisor + nodes read/write structured slots).
CREATE TABLE IF NOT EXISTS blackboard (
  id           BIGSERIAL PRIMARY KEY,
  run_id       TEXT NOT NULL DEFAULT 'global',  -- job / work-graph id; 'global' = long-lived
  key          TEXT NOT NULL,                   -- slot name within the run
  value        JSONB NOT NULL DEFAULT '{}'::jsonb,
  version      INTEGER NOT NULL DEFAULT 1,       -- optimistic concurrency
  updated_by   TEXT,                            -- node_id or svc:*
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, key)
);

CREATE INDEX IF NOT EXISTS blackboard_run_id ON blackboard (run_id);
CREATE INDEX IF NOT EXISTS blackboard_updated_at ON blackboard (updated_at DESC);

CREATE OR REPLACE FUNCTION blackboard_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS blackboard_updated_at ON blackboard;
CREATE TRIGGER blackboard_updated_at
  BEFORE UPDATE ON blackboard
  FOR EACH ROW EXECUTE FUNCTION blackboard_touch_updated_at();

-- Event bus (deterministic routing; claim with SKIP LOCKED later in G2+).
CREATE TABLE IF NOT EXISTS outbox (
  id           BIGSERIAL PRIMARY KEY,
  topic        TEXT NOT NULL,                   -- edge type / event: task|handoff|verdict|…
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  trace_id     TEXT,
  from_node    TEXT,
  to_node      TEXT,
  run_id       TEXT,
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','claimed','done','dead')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at   TIMESTAMPTZ,
  done_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS outbox_status_created ON outbox (status, created_at);
CREATE INDEX IF NOT EXISTS outbox_run_id ON outbox (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS outbox_topic ON outbox (topic);
