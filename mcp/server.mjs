/**
 * Shared MCP server construction for MemoryLoom.
 *
 * This module builds the McpServer with all ten tools registered.
 * Transport entries (stdio in mcp/index.mjs, local HTTP in
 * mcp/http.mjs, and the hosted function in api/mcp.mjs) all build
 * their server through this factory so the tool surface, the gate
 * contract, and the response shapes stay identical on every
 * transport.
 *
 * The factory takes a getPool function that returns a pg Pool for
 * the target database, plus the databaseUrl used for the embed
 * queue and an optional queue name. It performs no database gate
 * check and reads no environment on its own. Each entry point
 * enforces its own startup rules before calling this factory.
 */
import {
  reviewList,
  promoteProposal,
  rejectProposal,
  reviewDecide,
  CURATOR_IDENTITY,
} from '../lib/curator-decide.mjs';
import { recordEvent } from '../lib/learning.mjs';
import { coveredStoreOrPropose, coveredIngestFile } from '../lib/gatepath.mjs';
import { failurePayload } from '../lib/errors.mjs';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PgBoss } from 'pg-boss';
import { buildRecallContract } from '../lib/cold-start-contract.mjs';
import { recallAnswers, recallWithReceipts } from '../lib/planes.mjs';

const MEMORY_TYPES = new Set(['working', 'episodic', 'semantic', 'procedural', 'goals', 'reflective']);
const MEMORY_SCOPES = new Set(['global', 'node_local', 'edge']);

export function buildMemoryServer({ getPool, databaseUrl, queue = 'memory-embed' } = {}) {
  if (typeof getPool !== 'function') throw new Error('buildMemoryServer needs a getPool function');
  const QUEUE = queue;
  const DATABASE_URL = databaseUrl;

  async function learn(event) {
    try {
      await recordEvent(getPool(), event);
    } catch (e) {
      console.error('[mcp] learning capture failed:', e.message);
    }
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
 * Shape a covered call outcome into the tool response. The fresh
 * result and the stored first result take the same path, so a
 * retry reads exactly like the first call, apart from the live
 * embed job id on a fresh store approval.
 */
function coveredResponse(outcome, shape) {
  if (outcome.outcome === 'reused') {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            status: 'error',
            error: 'REQUEST_ID_REUSED',
            detail: 'this request id was already used with a different payload',
          }),
        },
      ],
    };
  }
  if (outcome.outcome === 'invalid') return validationError(outcome.detail);
  if (outcome.outcome === 'failed') {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(outcome.failure) }],
    };
  }
  const r = outcome.result;
  const payload =
    shape === 'propose'
      ? r.decision === 'auto_approved'
        ? { status: r.status, decision: r.decision, reason: r.reason, backend: r.backend, id: r.id }
        : r.decision === 'queued_for_review'
          ? { status: r.status, decision: r.decision, reason: r.reason, backend: r.backend, proposal_id: r.proposal_id }
          : { status: r.status, decision: r.decision, reason: r.reason, backend: r.backend }
      : r;
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

server.registerTool(
  'store',
  {
    description:
      'Propose a memory fact through the write gate. The gate decides approve, reject or escalate. Approved records are stored as live truth with the gate verdict in provenance. Escalated proposals, including every proposal made while no decision backend is configured, are queued for a human and nothing becomes live. Rejected proposals store nothing. A request id is required. A retry with the same request id and the same arguments returns the first result and writes nothing twice.',
    inputSchema: {
      namespace: z.string().describe('Canonical namespace, e.g. preferences, project-foo, feature-auth'),
      text: z.string().describe('Atomic fact / learning text'),
      request_id: z.string().describe('A unique id for this call. Retries of the same call reuse it'),
      metadata: z
        .record(z.string(), z.any())
        .optional()
        .describe('Optional metadata: type, scope, pinned, grounding_ids, author, origin, source_session, importance, strength, bot_id (folded into provenance)'),
    },
  },
  async ({ namespace, text, metadata = {}, request_id }) => {
    if (!request_id) return validationError('request_id is required for store');
    const outcome = await coveredStoreOrPropose({
      db: getPool(), tool: 'store', namespace, text, metadata,
      requestId: request_id, args: { namespace, text, metadata },
    });
    if (outcome.outcome === 'approved') {
      // The embed job is queued after the write commits. The job
      // id is an operational extra on the live response only, and
      // the stored first result keeps it null.
      let jobId = null;
      let enqueueError = null;
      try {
        jobId = await enqueueEmbed(outcome.memory_id);
      } catch (e) {
        enqueueError = 'the embed job could not be queued';
        console.error('[mcp] embed enqueue failed:', e);
      }
      const payload = { ...outcome.result, embed_job_id: jobId, enqueue_error: enqueueError };
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    }
    return coveredResponse(outcome, 'store');
  }
);

server.registerTool(
  'recall',
  {
    description:
      'Recall top-k memories in a namespace through the library receipt path. Hybrid recall proposes candidates, and every candidate is dereferenced to a truth record before it is returned. Each result carries a receipt with its author, origin and grounding records. Results that cannot dereference are dropped with a reason. The payload states whether the best fusion score clears the answer threshold, as answerable and no_answer. Returns cold_start, thin or ok plus the cold start contract.',
    inputSchema: {
      namespace: z.string().describe('Namespace to search within'),
      query: z.string().describe('Search query'),
      k: z.number().int().min(1).max(50).optional().describe('Max results (default 8)'),
    },
  },
  async ({ namespace, query, k = 8 }) => {
    try {
      // One recall path only (card S3a). The library path in
      // lib/planes.mjs owns the hybrid query, the provenance drop
      // rule and the receipts, so the MCP surface and the console
      // can never diverge on what recall returns.
      const out = await recallWithReceipts(getPool(), {
        namespace, query, k,
        onRecall: async ({ results, dropped }) => {
          await learn({
            namespace, kind: results.length ? 'recall_hit' : 'recall_miss', actor: 'mcp',
            subject_type: 'task', subject_id: null,
            summary: results.length
              ? `Recall hit: "${String(query).slice(0, 120)}" returned ${results.length} memories.`
              : `Recall miss: "${String(query).slice(0, 120)}" returned nothing.`,
            evidence: { tool: 'recall', query, count: results.length, result_ids: results.map((x) => x.id), dropped: dropped.length },
          });
        },
      });

      const meta = await getPool().query(
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
      if (out.results.length === 0) {
        status = m.live === 0 ? 'cold_start' : 'thin';
      }

      const contract = buildRecallContract({
        source: 'neon',
        indexedCount: m.indexed,
        pendingEmbeddings: m.pending,
        lastSeq: Number(m.last_seq),
        replicaLag: null,
      });

      const answerable = recallAnswers(out.results);
      const payload = {
        status,
        namespace,
        query,
        k,
        count: out.results.length,
        contract,
        answerable,
        no_answer: out.results.length > 0 && !answerable,
        dropped: out.dropped,
        results: out.results.map((row) => ({
          id: row.id,
          text: row.text,
          type: row.type,
          importance: row.importance,
          rrf: row.rrf,
          created_at: row.receipt.record_created_at,
          receipt: row.receipt,
        })),
      };
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    } catch (e) {
      console.error('[mcp] recall failed:', e);
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify(failurePayload(e)) }],
      };
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
      console.error('[mcp] list_namespaces failed:', e);
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify(failurePayload(e)) }],
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
      console.error('[mcp] get failed:', e);
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify(failurePayload(e)) }],
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
      'File drop path. Decodes a base64 file and splits it into paragraph chunks of at most 2000 characters, then creates one queued proposal for the whole file. The chunk texts are stored in the file chunks table for the deciding human, and the proposal row carries the source file name and the chunk count. Nothing from a file becomes live at ingest, in any backend state. A request id is required. A retry with the same request id and the same arguments returns the first result and writes nothing twice. Returns the proposal id, the queued state and the chunk count.',
    inputSchema: {
      namespace: z.string().describe('Namespace to queue the file proposal in'),
      filename: z.string().describe('Original filename (recorded on the proposal)'),
      content_base64: z.string().describe('File content, base64-encoded (UTF-8 text)'),
      request_id: z.string().describe('A unique id for this call. Retries of the same call reuse it'),
      metadata: z.record(z.string(), z.any()).optional().describe('Optional metadata: type (default semantic), scope, author, source_session, importance'),
    },
  },
  async ({ namespace, filename, content_base64, metadata = {}, request_id }) => {
    if (!request_id) return validationError('request_id is required for ingest_file');
    let text;
    try {
      text = Buffer.from(content_base64, 'base64').toString('utf8');
    } catch (e) {
      return validationError('content_base64 is not valid base64');
    }
    if (!text.trim()) return validationError('decoded file is empty');
    const type = metadata.type || 'semantic';
    const scope = metadata.scope || 'global';
    if (!MEMORY_TYPES.has(type)) return validationError(`type must be one of ${[...MEMORY_TYPES].join(',')}`);
    if (!MEMORY_SCOPES.has(scope)) return validationError(`scope must be one of ${[...MEMORY_SCOPES].join(',')}`);
    const chunks = chunkText(text);
    if (!chunks.length) return validationError('decoded file produced no chunks');
    // The gate scores the file proposal and its verdict is kept as
    // provenance, exactly as on the other write paths. The outcome
    // at ingest is always the queue. A file becomes truth only when
    // a human approves the proposal.
    const outcome = await coveredIngestFile({
      db: getPool(), namespace, filename, chunks, metadata,
      requestId: request_id, args: { namespace, filename, content_base64, metadata },
    });
    return coveredResponse(outcome, 'ingest');
  }
);

server.registerTool(
  'propose',
  {
    description:
      'Propose a memory through the write gate. The gate decides approve, reject or escalate with a fixed choice set. Approved proposals are stored as live truth with the gate verdict in provenance. Escalated proposals, including every proposal made while no decision backend is configured, are queued for a human. Rejected proposals store nothing. Local rules never approve a proposal. A request id is required. A retry with the same request id and the same arguments returns the first result and writes nothing twice.',
    inputSchema: {
      namespace: z.string().describe('Canonical namespace'),
      text: z.string().describe('Atomic fact / learning text'),
      request_id: z.string().describe('A unique id for this call. Retries of the same call reuse it'),
      metadata: z
        .record(z.string(), z.any())
        .optional()
        .describe('Optional metadata: type, scope, pinned, grounding_ids, author, importance, strength'),
    },
  },
  async ({ namespace, text, metadata = {}, request_id }) => {
    if (!request_id) return validationError('request_id is required for propose');
    const outcome = await coveredStoreOrPropose({
      db: getPool(), tool: 'propose', namespace, text, metadata,
      requestId: request_id, args: { namespace, text, metadata },
    });
    return coveredResponse(outcome, 'propose');
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
      console.error('[mcp] review_list failed:', e);
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify(failurePayload(e)) }],
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
    // The decision event is written inside the decide transaction
    // in lib/curator-decide.mjs, so a failed event write rolls the
    // promotion back rather than leaving a silent gap.
    const result = await promoteProposal(getPool(), {
      proposal_id,
      decided_by: decided_by || CURATOR_IDENTITY,
      note,
      event: {
        kind: 'human_approval',
        actor: decided_by || CURATOR_IDENTITY,
        summary: `Proposal ${proposal_id} approved and promoted${note ? `: ${note}` : ''}.`,
        evidence: { tool: 'promote', note: note || null },
      },
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
      event: {
        kind: 'human_rejection',
        actor: decided_by || CURATOR_IDENTITY,
        summary: `Proposal ${proposal_id} rejected${note ? `: ${note}` : ''}.`,
        evidence: { tool: 'reject_proposal', note: note || null },
      },
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
    const kind =
      decision === 'reject' ? 'human_rejection'
      : decision === 'resolve' && note ? 'human_correction'
      : 'human_approval';
    const result = await reviewDecide(getPool(), {
      target,
      id,
      decision,
      decided_by: decided_by || CURATOR_IDENTITY,
      note,
      event: {
        kind,
        actor: decided_by || CURATOR_IDENTITY,
        summary: `Review decision '${decision}' on ${target} ${id}${note ? `: ${note}` : ''}.`,
        evidence: { tool: 'review_decide', decision, note: note || null },
      },
    });
    return {
      isError: result.status === 'error',
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
);


  return server;
}
