-- 005-daemon-presence.sql — X1+X2: daemon presence + sync cursors (additive).
--
-- daemon_presence: one row per daemon node; last_beat is written on every wake
-- and periodically while awake. A reader decides online/offline by staleness:
--   SELECT now() - last_beat < make_interval(secs => 300) AS online ...
-- sync_state: per-direction high-water marks for replica sync.
-- IMPORTANT: each daemon keeps its own copy in its LOCAL replica (one account =
-- one always-on store, N daemons). A wiped replica re-pulls from seq 0 safely.

CREATE TABLE IF NOT EXISTS daemon_presence (
  node       TEXT PRIMARY KEY,               -- e.g. 'daemon-primary'
  last_beat  TIMESTAMPTZ NOT NULL DEFAULT now(),
  version    TEXT,                            -- daemon build/version string
  meta       JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS sync_state (
  key        TEXT PRIMARY KEY,                -- 'pull:neon->local', 'push:local->neon'
  last_seq   BIGINT NOT NULL DEFAULT 0,       -- sync_log.seq high-water mark
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Replica-sync echo guard: sync applies set sync.is_replica_apply=1 in their
-- transaction so pulled/pushed rows do not re-enter the local sync_log.
-- (Additive change to the v1 trigger function; v1.sql itself stays frozen.)
CREATE OR REPLACE FUNCTION memories_append_sync_log()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('sync.is_replica_apply', true) = '1' THEN
    RETURN NEW;
  END IF;
  INSERT INTO sync_log (memory_id, op) VALUES (NEW.id, TG_ARGV[0]);
  RETURN NEW;
END $$;
