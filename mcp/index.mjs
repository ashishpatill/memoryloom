/**
 * memory-mcp (P1.M4) — stdio MCP exposing the IDL §12 tool surface
 * against Postgres + pgvector (schema v1.sql + migrations).
 *
 * Bot-facing: store / recall (hybrid RRF) / list_namespaces / ingest_file
 * IDL:        get / propose (routing stub per write gates)
 *
 * Run:  DATABASE_URL=... node mcp/index.mjs
 *
 * store: INSERT staged memory (embedding NULL, index_status=staged,
 *        approval=live) with provenance jsonb; sync_log is trigger-appended.
 * recall: RRF-fused hybrid — keyword leg (tsvector/ts_rank_cd, staged+indexed)
 *         + vector leg (halfvec cosine, indexed only); RRF k=60 (A0 winner).
 * get: fetch one memory by id.
 * ingest_file: base64 file → paragraph chunks → one staged memory per chunk.
 * propose: write-gate routing — episodic/node-local auto-approve (stored);
 *          procedural/pinned → human-always; global semantic auto-approves
 *          iff grounding_ids >= 2 (IDL min_evidence_auto), else queued in
 *          proposals table for curator/human review.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  reviewList,
  promoteProposal,
  rejectProposal,
  reviewDecide,
  CURATOR_IDENTITY,
} from '../lib/curator-decide.mjs';
import dotenv from 'dotenv';
import pg from 'pg';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PgBoss } from 'pg-boss';
import { buildRecallContract } from '../lib/cold-start-contract.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

const DATABASE_URL = process.env.DATABASE_URL;
const QUEUE = process.env.MEMORY_QUEUE || 'memory-embed';

const MEMORY_TYPES = new Set(['working', 'episodic', 'semantic', 'procedural', 'goals', 'reflective']);
const MEMORY_SCOPES = new Set(['global', 'node_local', 'edge']);

if (!DATABASE_URL) {
  console.error('[mcp] DATABASE_URL missing');
  process.exit(1);
}

/** Lazy pooled client — one connection reused for the stdio session. */
let pool = null;
function getPool() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: DATABASE_URL,
      max: 2,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 15_000,
    });
  }
  return pool;
}

/** Lazy MiniLM-L6-v2 embedder (384-dim, matches halfvec(384)). Loaded on
 *  first hybrid recall; the ~90MB model download happens once. */
let embedder = null;
async function getEmbedder() {
  if (!embedder) {
    const { pipeline } = await import('@xenova/transformers');
    embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return embedder;
}

function halfvecLiteral(arr) {
  const parts = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) parts[i] = Number(arr[i]).toFixed(6);
  return '[' + parts.join(',') + ']';
}

async function embedText(text) {
  const ex = await getEmbedder();
  const out = await ex(text, { pooling: 'mean', normalize: true });
  return halfvecLiteral(Array.from(out.data));
}

async function enqueueEmbed(memoryId) {
  const boss = new PgBoss({
    connectionString: DATABASE_URL,
    migrate: true,
    supervise: false,
    schedule: false,
  });
  try {
    await boss.start();
    try {
      await boss.createQueue(QUEUE);
    } catch {
      /* exists */
    }
    const jobId = await boss.send(QUEUE, {
      kind: 'embed',
      memory_id: memoryId,
      enqueued_at: new Date().toISOString(),
    });
    return jobId;
  } finally {
    await boss.stop({ graceful: false, timeout: 5000 }).catch(() => {});
  }
}

const server = new McpServer({
  name: 'memory-mcp',
  version: '0.0.1-c0',
});

function validationError(detail) {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'VALIDATION', detail }) }],
  };
}

/**
 * Shared staged-memory insert (store + propose auto-path).
 * Returns { ok:true, id, namespace, index_status, approval, embed_job_id, enqueue_error, created_at }
 * or { ok:false, ...validationError }.
 */
async function insertMemory(namespace, text, metadata = {}) {
  const type = metadata.type || 'semantic';
  const scope = metadata.scope || 'global';
  const author = metadata.author || 'mcp';
  const origin = metadata.origin || 'mcp-store';
  const source_session = metadata.source_session || `mcp-${Date.now()}`;
  const importance = metadata.importance ?? 5;
  const strength = metadata.strength ?? 5.0;
  const pinned = Boolean(metadata.pinned);
  const id = metadata.id || randomUUID(); // TEXT PK
  const createdAt = new Date().toISOString();

  const provenance = {
    source_session,
    author,
    origin,
    created_at: createdAt,
    embedding_model: null,
  };
  if (metadata.bot_id) provenance.bot_id = metadata.bot_id;
  if (metadata.caller_node_id) provenance.caller_node_id = metadata.caller_node_id;
  if (metadata.trajectory_ref) provenance.trajectory_ref = metadata.trajectory_ref;
  if (metadata.evidence_refs) provenance.evidence_refs = metadata.evidence_refs;
  if (metadata.import_batch) provenance.import_batch = metadata.import_batch;
  if (metadata.filename) provenance.filename = metadata.filename;

  if (!MEMORY_TYPES.has(type)) {
    return { ok: false, response: validationError(`type must be one of ${[...MEMORY_TYPES].join(',')}`) };
  }
  if (!MEMORY_SCOPES.has(scope)) {
    return { ok: false, response: validationError(`scope must be one of ${[...MEMORY_SCOPES].join(',')}`) };
  }
  if (typeof importance !== 'number' || importance < 1 || importance > 10) {
    return { ok: false, response: validationError('importance must be 1..10') };
  }
  const grounding_ids = Array.isArray(metadata.grounding_ids) ? metadata.grounding_ids : [];

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    // sync_log is appended by AFTER INSERT trigger — do not INSERT manually.
    const ins = await client.query(
      `INSERT INTO memories (
         id, namespace, type, scope, text, importance, strength, pinned,
         index_status, approval, grounding_ids, provenance
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8,
         'staged', 'live', $10, $9::jsonb
       ) RETURNING id, namespace, index_status, approval, created_at`,
      [id, namespace, type, scope, text, importance, strength, pinned, JSON.stringify(provenance), grounding_ids]
    );
    const row = ins.rows[0];
    await client.query('COMMIT');

    let jobId = null;
    let enqueue_error = null;
    try {
      jobId = await enqueueEmbed(row.id);
    } catch (e) {
      enqueue_error = String(e.message || e);
    }
    return {
      ok: true,
      id: row.id,
      namespace: row.namespace,
      index_status: row.index_status,
      approval: row.approval,
      embed_job_id: jobId,
      enqueue_error,
      created_at: row.created_at,
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    return { ok: false, response: { isError: true, content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: String(e.message || e) }) }] } };
  } finally {
    client.release();
  }
}

server.registerTool(
  'store',
  {
    description:
      'Store a memory fact in a namespace. Writes staged row (embedding NULL, index_status=staged, approval=live) with provenance jsonb; sync_log is trigger-appended. Enqueues an embed job. Returns the new memory id.',
    inputSchema: {
      namespace: z.string().describe('Canonical namespace, e.g. preferences, project-foo, feature-auth'),
      text: z.string().describe('Atomic fact / learning text'),
      metadata: z
        .record(z.string(), z.any())
        .optional()
        .describe('Optional metadata: type, scope, author, origin, source_session, importance, strength, bot_id (folded into provenance)'),
    },
  },
  async ({ namespace, text, metadata = {} }) => {
    const r = await insertMemory(namespace, text, metadata);
    if (!r.ok) return r.response;
    const payload = {
      status: 'ok',
      id: r.id,
      namespace: r.namespace,
      index_status: r.index_status,
      approval: r.approval,
      embedding: null,
      embed_job_id: r.embed_job_id,
      enqueue_error: r.enqueue_error,
      created_at: r.created_at,
    };
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  }
);

server.registerTool(
  'recall',
  {
    description:
      'Recall top-k memories in a namespace (hybrid RRF: keyword tsvector leg + halfvec vector leg, RRF k=60). Staged rows contribute keyword-only. Filters approval=live. Returns cold_start|thin|ok plus contract {index,daemon,last_seq,replica_lag} (P1.M9).',
    inputSchema: {
      namespace: z.string().describe('Namespace to search within'),
      query: z.string().describe('Search query'),
      k: z.number().int().min(1).max(50).optional().describe('Max results (default 8)'),
    },
  },
  async ({ namespace, query, k = 8 }) => {
    const client = await getPool().connect();
    try {
      // Vector leg needs a query embedding; embed failures degrade to keyword-only.
      let qEmb = null;
      try {
        qEmb = await embedText(query);
      } catch (e) {
        console.error('[mcp] embed failed, keyword-only recall:', e.message);
      }

      let rows;
      const legs = { keyword: 0, vector: 0 };
      if (qEmb) {
        const r = await client.query(
          `WITH kw AS (
             SELECT id, row_number() OVER (ORDER BY ts_rank_cd(text_tsv, plainto_tsquery('english', $2)) DESC) AS rnk
             FROM memories
             WHERE namespace = $1 AND approval = 'live'
               AND index_status IN ('indexed','staged')
               AND text_tsv @@ plainto_tsquery('english', $2)
             LIMIT 50
           ),
           vec AS (
             SELECT id, row_number() OVER (ORDER BY embedding <=> $3::halfvec) AS rnk
             FROM memories
             WHERE namespace = $1 AND approval = 'live' AND index_status = 'indexed'
               AND embedding IS NOT NULL
             ORDER BY embedding <=> $3::halfvec
             LIMIT 50
           ),
           fused AS (
             SELECT COALESCE(kw.id, vec.id) AS id,
                    COALESCE(1.0/(60+kw.rnk),0) + COALESCE(1.0/(60+vec.rnk),0) AS rrf,
                    kw.rnk AS kw_rnk, vec.rnk AS vec_rnk
             FROM kw FULL OUTER JOIN vec ON kw.id = vec.id
           )
           SELECT m.id, m.namespace, m.text, m.index_status, m.approval, m.type,
                  m.importance, m.created_at, f.rrf, f.kw_rnk, f.vec_rnk
           FROM fused f JOIN memories m ON m.id = f.id
           ORDER BY f.rrf DESC
           LIMIT $4`,
          [namespace, query, qEmb, k]
        );
        rows = r.rows;
        legs.keyword = rows.filter((x) => x.kw_rnk != null).length;
        legs.vector = rows.filter((x) => x.vec_rnk != null).length;
      } else {
        const r = await client.query(
          `SELECT id, namespace, text, index_status, approval, type, importance, created_at,
                  ts_rank_cd(text_tsv, plainto_tsquery('english', $2)) AS rrf,
                  NULL::int AS kw_rnk, NULL::int AS vec_rnk
           FROM memories
           WHERE namespace = $1 AND approval = 'live'
             AND index_status IN ('indexed','staged')
             AND text_tsv @@ plainto_tsquery('english', $2)
           ORDER BY ts_rank_cd(text_tsv, plainto_tsquery('english', $2)) DESC, created_at DESC
           LIMIT $3`,
          [namespace, query, k]
        );
        rows = r.rows;
        legs.keyword = rows.length;
      }

      const meta = await client.query(
        `SELECT
           (SELECT count(*)::int FROM memories
             WHERE namespace = $1 AND approval = 'live'
               AND index_status IN ('indexed','staged')) AS live,
           (SELECT count(*)::int FROM memories
             WHERE namespace = $1 AND approval = 'live'
               AND index_status = 'indexed' AND embedding IS NOT NULL) AS indexed,
           (SELECT count(*)::int FROM memories
             WHERE namespace = $1 AND approval = 'live' AND embedding IS NULL) AS pending,
           (SELECT coalesce(max(seq), 0)::bigint FROM sync_log) AS last_seq`,
        [namespace]
      );
      const m = meta.rows[0];
      let status = 'ok';
      if (rows.length === 0) {
        status = m.live === 0 ? 'cold_start' : 'thin';
      }

      const contract = buildRecallContract({
        source: 'neon',
        indexedCount: m.indexed,
        pendingEmbeddings: m.pending,
        lastSeq: Number(m.last_seq),
        replicaLag: null,
      });

      const payload = {
        status,
        namespace,
        query,
        k,
        legs,
        hybrid: Boolean(qEmb),
        count: rows.length,
        contract,
        results: rows.map((row) => ({
          id: row.id,
          text: row.text,
          index_status: row.index_status,
          approval: row.approval,
          type: row.type,
          importance: row.importance,
          rrf: Number(row.rrf),
          created_at: row.created_at,
        })),
      };
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    } catch (e) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: String(e.message || e) }) }],
      };
    } finally {
      client.release();
    }
  }
);

server.registerTool(
  'list_namespaces',
  {
    description: 'List live namespaces with memory counts (approval=live).',
    inputSchema: {},
  },
  async () => {
    const client = await getPool().connect();
    try {
      const r = await client.query(
        `SELECT namespace, count(*)::int AS n
         FROM memories
         WHERE approval = 'live'
         GROUP BY namespace
         ORDER BY namespace`
      );
      const payload = {
        status: 'ok',
        count: r.rows.length,
        namespaces: r.rows,
      };
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    } catch (e) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: String(e.message || e) }) }],
      };
    } finally {
      client.release();
    }
  }
);

server.registerTool(
  'get',
  {
    description: 'Fetch one memory by id (any approval/index state). Returns the full row incl. provenance.',
    inputSchema: {
      id: z.string().describe('Memory id'),
    },
  },
  async ({ id }) => {
    const client = await getPool().connect();
    try {
      const r = await client.query(
        `SELECT id, namespace, type, scope, text, importance, strength, version,
                pinned, approval, index_status, superseded_by, merged_into,
                valid_from, valid_to, last_recalled_at, grounding_ids, links,
                provenance, created_at, updated_at
         FROM memories WHERE id = $1`,
        [id]
      );
      if (r.rows.length === 0) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'NOT_FOUND', detail: `no memory ${id}` }) }],
        };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'ok', memory: r.rows[0] }, null, 2) }] };
    } catch (e) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: String(e.message || e) }) }],
      };
    } finally {
      client.release();
    }
  }
);

function chunkText(text, maxChars = 2000) {
  const paras = String(text).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let cur = '';
  for (const p of paras) {
    if ((cur + '\n\n' + p).trim().length <= maxChars) {
      cur = cur ? cur + '\n\n' + p : p;
    } else {
      if (cur) chunks.push(cur);
      if (p.length <= maxChars) {
        cur = p;
      } else {
        for (let i = 0; i < p.length; i += maxChars) chunks.push(p.slice(i, i + maxChars));
        cur = '';
      }
    }
  }
  if (cur) chunks.push(cur);
  return chunks.filter((c) => c.trim().length > 0);
}

server.registerTool(
  'ingest_file',
  {
    description:
      'File-drop path (Moose): decode a base64 file, split into paragraph chunks (<=2000 chars), store one staged memory per chunk with provenance.filename. Returns chunk ids.',
    inputSchema: {
      namespace: z.string().describe('Namespace to store chunks in'),
      filename: z.string().describe('Original filename (recorded in provenance)'),
      content_base64: z.string().describe('File content, base64-encoded (UTF-8 text)'),
      metadata: z.record(z.string(), z.any()).optional().describe('Optional metadata: type (default semantic), author, source_session, importance'),
    },
  },
  async ({ namespace, filename, content_base64, metadata = {} }) => {
    let text;
    try {
      text = Buffer.from(content_base64, 'base64').toString('utf8');
    } catch (e) {
      return validationError('content_base64 is not valid base64');
    }
    if (!text.trim()) return validationError('decoded file is empty');
    const chunks = chunkText(text);
    const ids = [];
    const errors = [];
    let n = 0;
    for (const chunk of chunks) {
      n += 1;
      const r = await insertMemory(namespace, chunk, {
        ...metadata,
        type: metadata.type || 'semantic',
        origin: 'ingest_file',
        filename,
        source_session: metadata.source_session || `ingest-${Date.now()}`,
        import_batch: metadata.import_batch || `file:${filename}`,
      });
      if (r.ok) ids.push(r.id);
      else errors.push({ chunk: n, error: r.response });
      if (errors.length > 5) break;
    }
    const payload = {
      status: errors.length ? 'partial' : 'ok',
      filename,
      chunks: chunks.length,
      stored: ids.length,
      ids,
      errors: errors.slice(0, 5),
    };
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  }
);

const MIN_EVIDENCE_AUTO = 2; // IDL §12 config: min_evidence_auto

server.registerTool(
  'propose',
  {
    description:
      'Propose a memory through the write gates (IDL §12): episodic/node_local auto-approve (stored immediately); procedural or pinned → human-always (queued in proposals); global semantic auto-approves iff grounding_ids >= 2, else queued for curator/human review.',
    inputSchema: {
      namespace: z.string().describe('Canonical namespace'),
      text: z.string().describe('Atomic fact / learning text'),
      metadata: z
        .record(z.string(), z.any())
        .optional()
        .describe('Optional metadata: type, scope, pinned, grounding_ids, author, importance, strength'),
    },
  },
  async ({ namespace, text, metadata = {} }) => {
    const type = metadata.type || 'semantic';
    const scope = metadata.scope || 'global';
    const pinned = Boolean(metadata.pinned);
    const grounding_ids = Array.isArray(metadata.grounding_ids) ? metadata.grounding_ids : [];
    if (!MEMORY_TYPES.has(type)) return validationError(`type must be one of ${[...MEMORY_TYPES].join(',')}`);
    if (!MEMORY_SCOPES.has(scope)) return validationError(`scope must be one of ${[...MEMORY_SCOPES].join(',')}`);

    // Gate 1: episodic / node-local → automatic
    if (type === 'episodic' || scope === 'node_local') {
      const r = await insertMemory(namespace, text, { ...metadata, origin: metadata.origin || 'propose-auto' });
      if (!r.ok) return r.response;
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'ok', decision: 'auto_approved', reason: 'episodic-or-node_local', id: r.id }, null, 2) }],
      };
    }

    // Gate 2: procedural / pinned → human-always
    let route_reason = null;
    if (type === 'procedural') route_reason = 'procedural-human-always';
    else if (pinned) route_reason = 'pinned-human-always';
    else if (grounding_ids.length < MIN_EVIDENCE_AUTO) route_reason = 'low-evidence';

    // Gate 3: global semantic with enough cited grounding → auto-approve
    if (!route_reason) {
      const r = await insertMemory(namespace, text, { ...metadata, origin: metadata.origin || 'propose-auto' });
      if (!r.ok) return r.response;
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'ok', decision: 'auto_approved', reason: `grounding_ids>=${MIN_EVIDENCE_AUTO}`, id: r.id }, null, 2) }],
      };
    }

    // Queue for curator/human review (proposals table, migration 002)
    const id = metadata.id || randomUUID();
    const provenance = {
      source_session: metadata.source_session || `propose-${Date.now()}`,
      author: metadata.author || 'mcp',
      origin: metadata.origin || 'propose',
      created_at: new Date().toISOString(),
      embedding_model: null,
    };
    const client = await getPool().connect();
    try {
      await client.query(
        `INSERT INTO proposals (id, namespace, type, scope, text, importance, strength,
                                pinned, grounding_ids, provenance, route_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
        [id, namespace, type, scope, text, metadata.importance ?? 5, metadata.strength ?? 5.0,
         pinned, grounding_ids, JSON.stringify(provenance), route_reason]
      );
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'ok', decision: 'queued_for_review', reason: route_reason, proposal_id: id }, null, 2) }],
      };
    } catch (e) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: String(e.message || e) }) }],
      };
    } finally {
      client.release();
    }
  }
);


// ---- P1.G2 curator / review tools (IDL §8) ---------------------------------
server.registerTool(
  'review_list',
  {
    description:
      'List pending proposals and queued review_items for curator/human review (IDL review_list).',
    inputSchema: {
      status: z
        .string()
        .optional()
        .describe("Filter: 'pending'/'queued' (default pending proposals + queued review_items)"),
    },
  },
  async ({ status } = {}) => {
    try {
      const result = await reviewList(getPool(), { status });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: String(e.message || e) }) }],
      };
    }
  }
);

server.registerTool(
  'promote',
  {
    description:
      'Promote a pending proposal into memories as svc:curator (or decided_by). Stamps provenance.author/decided_by.',
    inputSchema: {
      proposal_id: z.string().describe('Proposal id to approve and promote'),
      decided_by: z.string().optional().describe('Default svc:curator'),
      note: z.string().optional().describe('Optional decision note stored in provenance'),
    },
  },
  async ({ proposal_id, decided_by, note }) => {
    const result = await promoteProposal(getPool(), {
      proposal_id,
      decided_by: decided_by || CURATOR_IDENTITY,
      note,
    });
    const isError = result.status === 'error';
    return {
      isError,
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.registerTool(
  'reject_proposal',
  {
    description: 'Reject a pending proposal (curator as svc:curator by default).',
    inputSchema: {
      proposal_id: z.string(),
      decided_by: z.string().optional(),
      note: z.string().optional(),
    },
  },
  async ({ proposal_id, decided_by, note }) => {
    const result = await rejectProposal(getPool(), {
      proposal_id,
      decided_by: decided_by || CURATOR_IDENTITY,
      note,
    });
    return {
      isError: result.status === 'error',
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.registerTool(
  'review_decide',
  {
    description:
      'Unified decide API: target proposal|review_item with decision approve|reject|promote|resolve. Default decided_by=svc:curator.',
    inputSchema: {
      target: z.enum(['proposal', 'review_item']).describe('Which queue'),
      id: z.string().describe('proposal_id or review_item id'),
      decision: z.string().describe('approve|reject|promote|resolve'),
      decided_by: z.string().optional(),
      note: z.string().optional(),
    },
  },
  async ({ target, id, decision, decided_by, note }) => {
    const result = await reviewDecide(getPool(), {
      target,
      id,
      decision,
      decided_by: decided_by || CURATOR_IDENTITY,
      note,
    });
    return {
      isError: result.status === 'error',
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
);


async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is MCP JSON-RPC
  console.error('[memory-mcp] stdio ready (store, recall[hybrid], list_namespaces, get, ingest_file, propose, review_list, promote, reject_proposal, review_decide)');
}

main().catch((e) => {
  console.error('[memory-mcp] fatal', e);
  process.exit(1);
});

process.on('SIGINT', async () => {
  if (pool) await pool.end().catch(() => {});
  process.exit(0);
});
