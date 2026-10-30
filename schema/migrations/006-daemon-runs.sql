-- ============================================================================
-- MemoryLoom — migration 006: daemon run log (Block 4).
-- Additive only: v1.sql and migrations 002-005 are NOT modified.
-- Apply order: v1.sql → 002 → 003 → 004 → 005 → 006.
--
-- daemon_runs: one row per daemon cycle. A cycle inserts its row as
-- 'running' and finishes it with counts + the watermark it advanced
-- to. A row left 'running' means the cycle died mid-flight; the next
-- cycle marks it 'abandoned' and resumes from the persisted
-- watermark in sync_state (key 'daemon:memoryloom:last_seq'), which
-- only moves at the end of a finished cycle — so reprocessing is
-- expected and safe (emitted review items are signature-deduped).
-- ============================================================================

CREATE TABLE IF NOT EXISTS daemon_runs (
  id               TEXT PRIMARY KEY,
  daemon           TEXT NOT NULL DEFAULT 'memoryloom-daemon',
  namespace        TEXT,              -- null = all namespaces in scope
  status           TEXT NOT NULL DEFAULT 'running'
                     CHECK (status IN ('running','finished','abandoned')),
  watermark_before BIGINT NOT NULL DEFAULT 0,
  watermark_after  BIGINT,
  scanned          INT NOT NULL DEFAULT 0,
  emitted          JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS daemon_runs_status ON daemon_runs (status, started_at);
