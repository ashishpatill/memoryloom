/**
 * The transactional gate path for the covered MCP write tools
 * (frozen master plan, Section 5, card S3b).
 *
 * store, propose and ingest_file are covered by the request id
 * rule. Each call carries a request id. The first call runs the
 * gate and writes its whole outcome as one database transaction,
 * and the request records table stores the first result keyed on
 * the tool name, the namespace and the request id together, with
 * a hash of the call arguments. A retry returns the stored first
 * result and writes nothing twice. A reuse of the request id with
 * a different payload is refused on the stored hash.
 *
 * The write sets, each one transaction (Section 5, the named
 * transaction boundaries for this card).
 *
 * The live insert writes the memory row, its proposal event and
 * its gate verdict event and the request record together. A
 * failure between the insert and the event writes leaves no live
 * memory row, because every gate score is claimed as provenance.
 *
 * The queued branch writes the proposal row, the gate verdict
 * event and the request record together.
 *
 * The reject branch writes the gate verdict event and the request
 * record together.
 *
 * Ingest writes the proposal row, the chunk rows in rising chunk
 * index order, the gate verdict event and the request record
 * together. The file proposal row carries the source file name
 * and the chunk count. The chunk texts live in the file chunks
 * table and never travel through the proposal provenance or the
 * grounding id array.
 *
 * The gate itself is lib/gate.mjs, unchanged. This module owns
 * only the write mechanics around it.
 */
import { createHash, randomUUID } from 'node:crypto';
import { decideGate } from './gate.mjs';
import { recordEvent } from './learning.mjs';
import { failurePayload } from './errors.mjs';

const MEMORY_TYPES = new Set(['working', 'episodic', 'semantic', 'procedural', 'goals', 'reflective']);
const MEMORY_SCOPES = new Set(['global', 'node_local', 'edge']);

export const COVERED_TOOLS = new Set(['store', 'propose', 'ingest_file']);

/** Canonical JSON for hashing. Object keys are sorted at every depth. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The payload hash a request record stores for its call arguments. */
export function hashCallArgs(args) {
  return createHash('sha256').update(canonical(args)).digest('hex');
}

/** Read the stored first result for a covered call, or null. */
export async function lookupRequestRecord(db, tool, namespace, requestId) {
  const r = await db.query(
    `SELECT payload_hash, result FROM request_records
     WHERE tool = $1 AND namespace = $2 AND request_id = $3`,
    [tool, namespace, requestId]
  );
  return r.rows?.[0] || null;
}

async function withTx(db, fn) {
  const client = typeof db.connect === 'function' ? await db.connect() : db;
  const own = client !== db;
  try {
    if (own) await client.query('BEGIN');
    const out = await fn(client);
    if (own) await client.query('COMMIT');
    return out;
  } catch (e) {
    if (own) await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    if (own && typeof client.release === 'function') client.release();
  }
}

async function insertRequestRecord(client, { tool, namespace, requestId, payloadHash, result }) {
  await client.query(
    `INSERT INTO request_records (tool, namespace, request_id, payload_hash, result)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [tool, namespace, requestId, payloadHash, JSON.stringify(result)]
  );
}

/**
 * Resolve the citations on a proposal. Only records that actually
 * dereference in the store count as grounding (Iteration 5.3,
 * Finding A). Returns the resolved ids, the unresolved ids and the
 * evidence rows the gate scores against.
 */
export async function resolveGrounding(db, citedIds) {
  const cited = Array.isArray(citedIds) ? citedIds : [];
  if (!cited.length) return { resolvedIds: [], unresolvedIds: [], evidence: [] };
  const er = await db.query('SELECT id, text FROM memories WHERE id = ANY($1)', [cited]);
  const evidence = er.rows;
  const found = new Set(evidence.map((r) => r.id));
  return {
    resolvedIds: cited.filter((id) => found.has(id)),
    unresolvedIds: cited.filter((id) => !found.has(id)),
    evidence,
  };
}

function validateShape(metadata) {
  const type = metadata.type || 'semantic';
  const scope = metadata.scope || 'global';
  if (!MEMORY_TYPES.has(type)) return `type must be one of ${[...MEMORY_TYPES].join(',')}`;
  if (!MEMORY_SCOPES.has(scope)) return `scope must be one of ${[...MEMORY_SCOPES].join(',')}`;
  const importance = metadata.importance ?? 5;
  if (typeof importance !== 'number' || importance < 1 || importance > 10) return 'importance must be 1..10';
  return null;
}

function memoryProvenance(metadata, { origin, decision, unresolvedIds }) {
  const provenance = {
    source_session: metadata.source_session || `mcp-${Date.now()}`,
    author: metadata.author || 'mcp',
    origin,
    created_at: new Date().toISOString(),
    embedding_model: null,
  };
  if (metadata.bot_id) provenance.bot_id = metadata.bot_id;
  if (metadata.caller_node_id) provenance.caller_node_id = metadata.caller_node_id;
  if (metadata.trajectory_ref) provenance.trajectory_ref = metadata.trajectory_ref;
  if (metadata.evidence_refs) provenance.evidence_refs = metadata.evidence_refs;
  if (metadata.import_batch) provenance.import_batch = metadata.import_batch;
  if (metadata.filename) provenance.filename = metadata.filename;
  // The gate score that approved this record is provenance. Every
  // live record written through the gate carries the verdict that
  // let it in, and any cited id that did not resolve is named as a
  // transparency note, never as grounding.
  if (decision) provenance.jev = decision;
  if (Array.isArray(unresolvedIds) && unresolvedIds.length) {
    provenance.unresolved_citations = unresolvedIds;
  }
  return provenance;
}

function proposalProvenance(metadata, { origin, decision, extra }) {
  const provenance = {
    source_session: metadata.source_session || `propose-${Date.now()}`,
    author: metadata.author || 'mcp',
    origin: metadata.origin || origin,
    created_at: new Date().toISOString(),
    embedding_model: null,
    ...(extra || {}),
  };
  if (decision) provenance.jev = decision;
  return provenance;
}

/**
 * The shared gate path for store and propose, with the request id
 * rule applied. Returns one of
 *   { outcome: 'replayed', result }
 *   { outcome: 'reused' }
 *   { outcome: 'invalid', detail }
 *   { outcome: 'failed', failure }
 *   { outcome: 'approved', result, memory_id }
 *   { outcome: 'rejected', result }
 *   { outcome: 'queued', result, proposal_id }
 * where result is the payload the first call returned and the
 * request record stored.
 */
export async function coveredStoreOrPropose({ db, tool, namespace, text, metadata = {}, requestId, args }) {
  const payloadHash = hashCallArgs(args);
  const prior = await lookupRequestRecord(db, tool, namespace, requestId);
  if (prior) {
    if (prior.payload_hash !== payloadHash) return { outcome: 'reused' };
    return { outcome: 'replayed', result: prior.result };
  }
  const invalid = validateShape(metadata);
  if (invalid) return { outcome: 'invalid', detail: invalid };

  const type = metadata.type || 'semantic';
  const scope = metadata.scope || 'global';
  const pinned = Boolean(metadata.pinned);
  const { resolvedIds, unresolvedIds, evidence } = await resolveGrounding(db, metadata.grounding_ids);
  const d = await decideGate({
    proposal: { text, type, scope, pinned, grounding_ids: resolvedIds },
    evidence,
  });

  try {
    if (d.decision === 'approve') {
      const id = metadata.id || randomUUID();
      const provenance = memoryProvenance(metadata, {
        origin: metadata.origin || (tool === 'store' ? 'mcp-store' : 'propose-jev'),
        decision: d,
        unresolvedIds,
      });
      let storedRow = null;
      let result = null;
      await withTx(db, async (client) => {
        const ins = await client.query(
          `INSERT INTO memories (
             id, namespace, type, scope, text, importance, strength, pinned,
             index_status, approval, grounding_ids, provenance
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8,
             'staged', 'live', $10, $9::jsonb
           ) RETURNING id, namespace, index_status, approval, created_at`,
          [
            id, namespace, type, scope, text,
            metadata.importance ?? 5, metadata.strength ?? 5.0, pinned,
            JSON.stringify(provenance), resolvedIds,
          ]
        );
        storedRow = ins.rows[0];
        await recordEvent(client, {
          namespace, kind: 'proposal', actor: metadata.author || 'mcp',
          subject_type: 'memory', subject_id: id,
          summary: `Proposal approved by the gate via ${tool}: ${String(text).slice(0, 200)}`,
          evidence: { tool },
        });
        await recordEvent(client, {
          namespace, kind: 'gate_verdict', actor: 'jev',
          subject_type: 'memory', subject_id: id,
          summary: `Gate verdict: approve (${d.reason}).`,
          evidence: { decision: d },
        });
        result = {
          status: 'ok',
          decision: 'auto_approved',
          reason: d.reason,
          backend: d.backend,
          id: storedRow.id,
          namespace: storedRow.namespace,
          index_status: storedRow.index_status,
          approval: storedRow.approval,
          embedding: null,
          embed_job_id: null,
          enqueue_error: null,
          created_at: storedRow.created_at,
        };
        await insertRequestRecord(client, { tool, namespace, requestId, payloadHash, result });
      });
      return { outcome: 'approved', result, memory_id: id };
    }

    if (d.decision === 'reject') {
      const result = { status: 'ok', decision: 'rejected', reason: d.reason, backend: d.backend };
      await withTx(db, async (client) => {
        await recordEvent(client, {
          namespace, kind: 'gate_verdict', actor: 'jev',
          subject_type: 'proposal', subject_id: requestId,
          summary: `Gate verdict: reject (${d.reason}).`,
          evidence: { decision: d, tool, request_id: requestId, text: String(text).slice(0, 200) },
        });
        await insertRequestRecord(client, { tool, namespace, requestId, payloadHash, result });
      });
      return { outcome: 'rejected', result };
    }

    const routeReason = d.failed ? 'jev-unavailable-fail-closed' : 'jev-escalate';
    const proposalId = metadata.id || randomUUID();
    const result = {
      status: 'ok',
      decision: 'queued_for_review',
      reason: routeReason,
      backend: d.backend,
      proposal_id: proposalId,
      namespace,
    };
    await withTx(db, async (client) => {
      await client.query(
        `INSERT INTO proposals (id, namespace, type, scope, text, importance, strength,
                                pinned, grounding_ids, provenance, route_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
        [
          proposalId, namespace, type, scope, text,
          metadata.importance ?? 5, metadata.strength ?? 5.0, pinned, resolvedIds,
          JSON.stringify(proposalProvenance(metadata, {
            origin: 'propose',
            decision: d,
            extra: unresolvedIds.length ? { unresolved_citations: unresolvedIds } : {},
          })),
          routeReason,
        ]
      );
      await recordEvent(client, {
        namespace, kind: 'proposal', actor: metadata.author || 'mcp',
        subject_type: 'proposal', subject_id: proposalId,
        summary: `Proposal queued for review via ${tool} (${routeReason}): ${String(text).slice(0, 200)}`,
        evidence: { tool, route_reason: routeReason },
      });
      await recordEvent(client, {
        namespace, kind: 'gate_verdict', actor: 'jev',
        subject_type: 'proposal', subject_id: proposalId,
        summary: `Gate verdict: escalate (${routeReason}).`,
        evidence: { decision: d },
      });
      await insertRequestRecord(client, { tool, namespace, requestId, payloadHash, result });
    });
    return { outcome: 'queued', result, proposal_id: proposalId };
  } catch (e) {
    // A concurrent call with the same request id may have won the
    // request record insert. Its stored first result is then the
    // answer, and this call has written nothing.
    if (e && e.code === '23505') {
      const winner = await lookupRequestRecord(db, tool, namespace, requestId);
      if (winner) {
        if (winner.payload_hash !== payloadHash) return { outcome: 'reused' };
        return { outcome: 'replayed', result: winner.result };
      }
    }
    console.error('[gatepath] covered write failed:', e);
    return { outcome: 'failed', failure: failurePayload(e) };
  }
}

/**
 * The ingest path, with the request id rule applied. A file always
 * queues. Returns one of
 *   { outcome: 'replayed', result }
 *   { outcome: 'reused' }
 *   { outcome: 'failed', failure }
 *   { outcome: 'queued', result, proposal_id }
 */
export async function coveredIngestFile({ db, namespace, filename, chunks, metadata = {}, requestId, args }) {
  const tool = 'ingest_file';
  const payloadHash = hashCallArgs(args);
  const prior = await lookupRequestRecord(db, tool, namespace, requestId);
  if (prior) {
    if (prior.payload_hash !== payloadHash) return { outcome: 'reused' };
    return { outcome: 'replayed', result: prior.result };
  }
  const type = metadata.type || 'semantic';
  const scope = metadata.scope || 'global';
  const summary = chunks[0].replace(/\s+/g, ' ').slice(0, 200);
  const proposalText = `${filename}: ${summary}`;
  const d = await decideGate({
    proposal: { text: proposalText, type, scope, pinned: false, grounding_ids: [] },
    evidence: [],
  });
  const proposalId = randomUUID();
  const result = {
    status: 'ok',
    decision: 'queued_for_review',
    state: 'queued',
    proposal_id: proposalId,
    filename,
    chunks: chunks.length,
    chunk_count: chunks.length,
    stored: 0,
    ids: [],
    gate_decision: d.decision,
    backend: d.backend,
  };
  try {
    await withTx(db, async (client) => {
      await client.query(
        `INSERT INTO proposals (id, namespace, type, scope, text, importance, strength,
                                pinned, grounding_ids, provenance, route_reason,
                                source_file_name, chunk_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)`,
        [
          proposalId, namespace, type, scope, proposalText,
          metadata.importance ?? 5, metadata.strength ?? 5.0, false, [],
          JSON.stringify(proposalProvenance(
            { ...metadata, source_session: metadata.source_session || `ingest-${Date.now()}` },
            {
              origin: 'ingest_file',
              decision: d,
              extra: {
                filename,
                source_file_name: filename,
                chunk_count: chunks.length,
                import_batch: metadata.import_batch || `file:${filename}`,
              },
            }
          )),
          'ingest-file-queued',
          filename,
          chunks.length,
        ]
      );
      for (let i = 0; i < chunks.length; i += 1) {
        await client.query(
          `INSERT INTO file_chunks (proposal_id, chunk_index, text) VALUES ($1, $2, $3)`,
          [proposalId, i, chunks[i]]
        );
      }
      await recordEvent(client, {
        namespace, kind: 'proposal', actor: metadata.author || 'mcp',
        subject_type: 'proposal', subject_id: proposalId,
        summary: `File queued as one proposal: ${filename} with ${chunks.length} chunks held for review.`,
        evidence: { tool: 'ingest_file', filename, chunks: chunks.length },
      });
      await recordEvent(client, {
        namespace, kind: 'gate_verdict', actor: 'jev',
        subject_type: 'proposal', subject_id: proposalId,
        summary: `Gate verdict on the file proposal: ${d.decision} (${d.reason}). The file queues for a human in every state.`,
        evidence: { decision: d },
      });
      await insertRequestRecord(client, { tool, namespace, requestId, payloadHash, result });
    });
  } catch (e) {
    if (e && e.code === '23505') {
      const winner = await lookupRequestRecord(db, tool, namespace, requestId);
      if (winner) {
        if (winner.payload_hash !== payloadHash) return { outcome: 'reused' };
        return { outcome: 'replayed', result: winner.result };
      }
    }
    console.error('[gatepath] ingest write failed:', e);
    return { outcome: 'failed', failure: failurePayload(e) };
  }
  return { outcome: 'queued', result, proposal_id: proposalId };
}
