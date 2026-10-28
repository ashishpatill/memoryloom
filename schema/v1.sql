-- ============================================================================
-- Bot memory — schema v1 (P0 spike A0.1)
-- Target: Neon Postgres + pgvector. Also validates on PG16 + pgvector >= 0.7.
-- Source: memory/plan/FINAL-PLAN-V2.md §12 (IDL v2.1), §13 (crash consistency).
--
-- v2.1 amendments applied: namespace is first-class; type gains `goals`;
-- grounding_ids required (legitimacy comes from cited grounding, Q6);
-- optimistic version; halfvec(384) in-column; NO trust tiers, NO per-bot ACLs,
-- NO contested state (contradictions resolve via evidence weighing, Q6).
--
-- P0 scope: memories + sync_log. pg-boss creates its own tables at runtime.
-- P1 adds: provenance / validity / review tables, replica watermarks.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE memories (
  id               TEXT PRIMARY KEY,  -- ULID, time-ordered
  namespace        TEXT NOT NULL,     -- preferences | project-* | decisions-* |
                                     -- errors-resolved-* | handoff-* | bot-* |
                                     -- feature-* | org.*
  type             TEXT NOT NULL CHECK (type IN
                     ('working','episodic','semantic','procedural','goals','reflective')),
  scope            TEXT NOT NULL DEFAULT 'global'
                     CHECK (scope IN ('global','node_local','edge')),
  node_id          TEXT,              -- set when scope = 'node_local'
  edge_id          TEXT,              -- set when scope = 'edge'
  text             TEXT NOT NULL,     -- atomic: one claim per record
  text_tsv         TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
  embedding        HALFVEC(384),      -- NULL until indexed (crash-consistency §13)
  index_status     TEXT NOT NULL DEFAULT 'staged'
                     CHECK (index_status IN ('staged','indexed')),
  importance       SMALLINT NOT NULL DEFAULT 5 CHECK (importance BETWEEN 1 AND 10),
  strength         REAL NOT NULL DEFAULT 5.0 CHECK (strength BETWEEN 0 AND 10),
  version          INTEGER NOT NULL DEFAULT 1,  -- optimistic concurrency
  pinned           BOOLEAN NOT NULL DEFAULT FALSE, -- identity/preference; human-write-only
  approval         TEXT NOT NULL DEFAULT 'live'
                     CHECK (approval IN ('live','staged','retired')),
  superseded_by    TEXT REFERENCES memories(id),
  merged_into      TEXT REFERENCES memories(id),
  valid_from       TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to         TIMESTAMPTZ,       -- NULL = currently valid; enables as_of time-travel
  last_recalled_at TIMESTAMPTZ,
  grounding_ids    TEXT[] NOT NULL DEFAULT '{}', -- cited memory IDs (Q6)
  links            TEXT[] NOT NULL DEFAULT '{}',
  provenance       JSONB NOT NULL,    -- {source_session, trajectory_ref, author,
                                     --  origin, created_at, embedding_model,
                                     --  evidence_refs, import_batch}
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hybrid retrieval (plan §7): tsvector/GIN leg + pgvector/HNSW leg, RRF-fused in SQL.
CREATE INDEX memories_text_gin ON memories USING gin (text_tsv);
CREATE INDEX memories_embedding_hnsw ON memories USING hnsw (embedding halfvec_cosine_ops);

-- Recall filters.
CREATE INDEX memories_recall_cover ON memories (namespace, type, approval, index_status);
CREATE INDEX memories_validity ON memories (valid_from, valid_to);
CREATE INDEX memories_node ON memories (node_id) WHERE node_id IS NOT NULL;
CREATE INDEX memories_pinned ON memories (pinned) WHERE pinned;

-- Replica sync: every mutation appends here; devices track last_seq (plan §13.5).
CREATE TABLE sync_log (
  seq        BIGSERIAL PRIMARY KEY,
  memory_id  TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  op         TEXT NOT NULL CHECK (op IN ('insert','update','retire')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sync_log_seq ON sync_log (seq);

CREATE OR REPLACE FUNCTION memories_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE TRIGGER memories_updated_at
  BEFORE UPDATE ON memories
  FOR EACH ROW EXECUTE FUNCTION memories_touch_updated_at();

CREATE OR REPLACE FUNCTION memories_append_sync_log()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO sync_log (memory_id, op) VALUES (NEW.id, TG_ARGV[0]);
  RETURN NEW;
END $$;

CREATE TRIGGER memories_sync_insert
  AFTER INSERT ON memories
  FOR EACH ROW EXECUTE FUNCTION memories_append_sync_log('insert');

CREATE TRIGGER memories_sync_update
  AFTER UPDATE OF text, embedding, strength, importance, approval, valid_to,
                  version, pinned, superseded_by, merged_into ON memories
  FOR EACH ROW EXECUTE FUNCTION memories_append_sync_log('update');
