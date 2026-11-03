/**
 * Curator decision helpers (P1.G2) — promote / reject proposals and
 * approve / reject / resolve review_items. Identity stamped as decided_by
 * (default `svc:curator` per FINAL-PLAN-V2.md §8).
 *
 * Works against any Queryable (pg Pool or stub with .query).
 *
 * Decision guards (frozen master plan, Section 5, card S3b). Every
 * decide function here changes state through a conditional update
 * that names the expected current status, reads the row count from
 * that update, and fails unless exactly one row changed. Promote
 * claims the proposal row first, inside its transaction, and only
 * the winning call may insert the created memories. Any later
 * failure rolls the claim back with everything else.
 *
 * A caller may pass an `event` in the options. The event is then
 * written as a learning event inside the same transaction as the
 * state change it records, so an event write failure rolls the
 * state change back and no decision is ever reported as done
 * unless the state change and the event commit together.
 *
 * Approval of a file proposal creates one memory per chunk from
 * the file chunks table, in chunk index order, and records every
 * created id in the proposal row created memory ids array. A
 * repeated promote returns that recorded first result and creates
 * nothing twice. The chunk rows stay in place after approval and
 * after rejection. They are provenance records.
 */
import { randomUUID } from 'node:crypto';
import { recordEvent } from './learning.mjs';
import { failurePayload } from './errors.mjs';

export const CURATOR_IDENTITY = 'svc:curator';

/**
 * Run fn on one client inside a transaction when the db can hand
 * out clients. A bare client (some test doubles) runs without an
 * explicit transaction, exactly as these helpers behaved before.
 */
async function withClient(db, fn) {
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

/** Write the caller supplied decide event on the deciding client. */
async function writeDecideEvent(client, { event, namespace, decided_by, subject_id, defaultKind, defaultSummary, evidence }) {
  if (!event) return;
  await recordEvent(client, {
    namespace: event.namespace || namespace || 'unknown',
    kind: event.kind || defaultKind,
    actor: event.actor || decided_by,
    subject_type: event.subject_type || 'proposal',
    subject_id,
    summary: event.summary || defaultSummary,
    evidence: { ...(event.evidence || {}), ...(evidence || {}) },
  });
}

/** The recorded first result of a promote, returned on a repeat. */
function recordedPromoteResult(row) {
  const ids = Array.isArray(row.created_memory_ids) ? row.created_memory_ids : [];
  return {
    status: 'ok',
    decision: 'approved',
    proposal_id: row.id,
    promoted_id: row.promoted_id || ids[0] || null,
    created_memory_ids: ids,
    decided_by: row.decided_by || null,
    replayed: true,
  };
}

/**
 * @param {import('../graph/store.ts').Queryable | {query: Function}} db
 * @param {{ status?: string }} [opts]
 */
export async function reviewList(db, opts = {}) {
  const propStatus = opts.status === 'queued' ? 'pending' : opts.status || 'pending';
  const reviewStatus = opts.status === 'pending' ? 'queued' : opts.status || 'queued';

  const proposals = await db.query(
    `SELECT id, namespace, type, scope, text, importance, strength, pinned,
            grounding_ids, provenance, route_reason, status, decided_by, decided_at,
            promoted_id, created_memory_ids, source_file_name, chunk_count, created_at
     FROM proposals
     WHERE status = $1
     ORDER BY created_at ASC
     LIMIT 100`,
    [propStatus]
  );
  const proposalRows = proposals.rows || [];
  // A file proposal carries its chunk texts with it, in chunk
  // index order, so the deciding human reads the file itself and
  // not a summary of it.
  const fileRows = proposalRows.filter((p) => p.source_file_name != null);
  if (fileRows.length) {
    const cr = await db.query(
      `SELECT proposal_id, chunk_index, text FROM file_chunks
       WHERE proposal_id = ANY($1) ORDER BY chunk_index`,
      [fileRows.map((p) => p.id)]
    );
    const byProposal = new Map();
    for (const c of cr.rows || []) {
      if (!byProposal.has(c.proposal_id)) byProposal.set(c.proposal_id, []);
      byProposal.get(c.proposal_id).push({ chunk_index: c.chunk_index, text: c.text });
    }
    for (const p of fileRows) p.chunks = byProposal.get(p.id) || [];
  }
  const reviews = await db.query(
    `SELECT id, kind, payload, status, created_at, decided_at, decided_by
     FROM review_items
     WHERE status = $1
     ORDER BY created_at ASC
     LIMIT 100`,
    [reviewStatus]
  );
  return {
    status: 'ok',
    proposals: proposalRows,
    review_items: reviews.rows || [],
    counts: {
      proposals: proposalRows.length,
      review_items: (reviews.rows || []).length,
    },
  };
}

/**
 * Promote a pending proposal → memories row; stamp decided_by.
 * @param {object} db
 * @param {{ proposal_id: string, decided_by?: string, note?: string }} opts
 */
export async function promoteProposal(db, opts) {
  const decided_by = opts.decided_by || CURATOR_IDENTITY;
  const proposal_id = opts.proposal_id;
  if (!proposal_id) {
    return { status: 'error', error: 'VALIDATION', detail: 'proposal_id required' };
  }

  const got = await db.query(`SELECT * FROM proposals WHERE id = $1`, [proposal_id]);
  const row = got.rows?.[0];
  if (!row) return { status: 'error', error: 'NOT_FOUND', detail: `proposal ${proposal_id}` };
  // A repeated promote of an approved proposal returns the
  // recorded first result and creates nothing a second time.
  if (row.status === 'approved') return recordedPromoteResult(row);
  if (row.status !== 'pending') {
    return { status: 'error', error: 'CONFLICT', detail: `proposal status=${row.status}` };
  }

  // A file proposal promotes from its chunk rows. The chunk count
  // on the proposal row must equal the number of its chunk rows,
  // and a mismatch refuses the promotion outright.
  const isFile = row.source_file_name != null;
  let chunks = [];
  if (isFile) {
    const cr = await db.query(
      `SELECT chunk_index, text FROM file_chunks WHERE proposal_id = $1 ORDER BY chunk_index`,
      [proposal_id]
    );
    chunks = cr.rows || [];
    if (Number(row.chunk_count) !== chunks.length) {
      return {
        status: 'error',
        error: 'CONFLICT',
        detail: `file proposal chunk count ${row.chunk_count} does not match its ${chunks.length} stored chunk rows`,
      };
    }
  }

  const createdAt = new Date().toISOString();
  const baseProvenance = {
    ...(typeof row.provenance === 'string' ? JSON.parse(row.provenance) : row.provenance || {}),
    author: decided_by,
    origin: 'promote',
    promoted_from: proposal_id,
    decided_by,
    created_at: createdAt,
  };
  if (opts.note) baseProvenance.decision_note = opts.note;

  // Resolved citations only (Iteration 5.3, Finding A): a human
  // approval promotes the claim, but it does not conjure evidence.
  // Grounding ids that do not dereference to a stored record are
  // dropped from the promoted record's grounding — its receipt then
  // shows what it truly rests on (the resolved records, or, when
  // none resolve, the human decision recorded in this provenance) —
  // and the dropped ids are named here as a transparency note.
  let groundingIds = Array.isArray(row.grounding_ids) ? row.grounding_ids : [];
  if (groundingIds.length) {
    try {
      const er = await db.query(`SELECT id FROM memories WHERE id = ANY($1)`, [groundingIds]);
      const found = new Set((er.rows || []).map((r) => r.id));
      const unresolved = groundingIds.filter((id) => !found.has(id));
      if (unresolved.length) baseProvenance.unresolved_citations = unresolved;
      groundingIds = groundingIds.filter((id) => found.has(id));
    } catch {
      // A store that cannot answer the dereference keeps the cited
      // list untouched rather than silently dropping real evidence.
    }
  }

  const insertMemory = async (client, memoryId, text, provenance) => {
    await client.query(
      `INSERT INTO memories (
         id, namespace, type, scope, text, importance, strength, pinned,
         index_status, approval, grounding_ids, provenance
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8,
         'staged', 'live', $9, $10::jsonb
       )`,
      [
        memoryId,
        row.namespace,
        row.type,
        row.scope,
        text,
        row.importance,
        row.strength,
        row.pinned,
        groundingIds,
        JSON.stringify(provenance),
      ]
    );
  };

  let claimed = false;
  let createdIds = [];
  try {
    await withClient(db, async (client) => {
      // The claim comes first. A conditional update on the
      // expected current status, with the row count read, decides
      // which call may insert the created memories. Any later
      // failure rolls the claim back with everything else, so the
      // proposal is left ready to claim again.
      const claim = await client.query(
        `UPDATE proposals
         SET status = 'approved', decided_by = $2, decided_at = now()
         WHERE id = $1 AND status = 'pending'`,
        [proposal_id, decided_by]
      );
      if (claim.rowCount !== 1) return;
      claimed = true;
      if (isFile) {
        for (const chunk of chunks) {
          const memoryId = randomUUID();
          await insertMemory(client, memoryId, chunk.text, {
            ...baseProvenance,
            source_file_name: row.source_file_name,
            chunk_index: chunk.chunk_index,
          });
          createdIds.push(memoryId);
        }
      } else {
        const memoryId = randomUUID();
        await insertMemory(client, memoryId, row.text, baseProvenance);
        createdIds.push(memoryId);
      }
      await client.query(
        `UPDATE proposals SET promoted_id = $2, created_memory_ids = $3 WHERE id = $1`,
        [proposal_id, createdIds[0] || null, createdIds]
      );
      await writeDecideEvent(client, {
        event: opts.event,
        namespace: row.namespace,
        decided_by,
        subject_id: proposal_id,
        defaultKind: 'human_approval',
        defaultSummary: `Proposal ${proposal_id} approved and promoted.`,
        evidence: { promoted_id: createdIds[0] || null, created_memory_ids: createdIds },
      });
    });
  } catch (e) {
    return failurePayload(e);
  }
  if (!claimed) {
    // The claim changed no row. Either another call won the claim,
    // in which case the recorded first result is the answer, or
    // the proposal left the pending state in some other way.
    const again = await db.query(`SELECT * FROM proposals WHERE id = $1`, [proposal_id]);
    const fresh = again.rows?.[0];
    if (fresh && fresh.status === 'approved') return recordedPromoteResult(fresh);
    return {
      status: 'error',
      error: 'CONFLICT',
      detail: `proposal status=${fresh ? fresh.status : 'missing'}`,
    };
  }

  return {
    status: 'ok',
    decision: 'approved',
    proposal_id,
    promoted_id: createdIds[0] || null,
    created_memory_ids: createdIds,
    decided_by,
  };
}

/**
 * Reject a pending proposal.
 */
export async function rejectProposal(db, opts) {
  const decided_by = opts.decided_by || CURATOR_IDENTITY;
  const proposal_id = opts.proposal_id;
  if (!proposal_id) {
    return { status: 'error', error: 'VALIDATION', detail: 'proposal_id required' };
  }
  const got = await db.query(`SELECT id, status, namespace FROM proposals WHERE id = $1`, [proposal_id]);
  const row = got.rows?.[0];
  if (!row) return { status: 'error', error: 'NOT_FOUND', detail: `proposal ${proposal_id}` };
  if (row.status !== 'pending') {
    return { status: 'error', error: 'CONFLICT', detail: `proposal status=${row.status}` };
  }
  let changed = 0;
  try {
    await withClient(db, async (client) => {
      // The guard is the conditional update itself, not the read
      // above. The row count decides whether this call made the
      // change, and the decide event commits with the change.
      const upd = await client.query(
        `UPDATE proposals
         SET status = 'rejected', decided_by = $2, decided_at = now()
         WHERE id = $1 AND status = 'pending'`,
        [proposal_id, decided_by]
      );
      changed = upd.rowCount || 0;
      if (changed !== 1) return;
      await writeDecideEvent(client, {
        event: opts.event,
        namespace: row.namespace,
        decided_by,
        subject_id: proposal_id,
        defaultKind: 'human_rejection',
        defaultSummary: `Proposal ${proposal_id} rejected.`,
      });
    });
  } catch (e) {
    return failurePayload(e);
  }
  if (changed !== 1) {
    return {
      status: 'error',
      error: 'CONFLICT',
      detail: 'the proposal changed state before this decision could be recorded',
    };
  }
  return { status: 'ok', decision: 'rejected', proposal_id, decided_by, note: opts.note || null };
}

/**
 * Decide a review_item: approve | reject | resolve.
 * approve on kind=proposal payload may optionally promote nested proposal fields.
 */
export async function decideReviewItem(db, opts) {
  const decided_by = opts.decided_by || CURATOR_IDENTITY;
  const id = opts.id;
  const decision = opts.decision; // approve | reject | resolve
  if (!id) return { status: 'error', error: 'VALIDATION', detail: 'id required' };
  if (!['approve', 'reject', 'resolve'].includes(decision)) {
    return { status: 'error', error: 'VALIDATION', detail: 'decision must be approve|reject|resolve' };
  }

  const got = await db.query(`SELECT * FROM review_items WHERE id = $1`, [id]);
  const row = got.rows?.[0];
  if (!row) return { status: 'error', error: 'NOT_FOUND', detail: `review_item ${id}` };
  if (row.status !== 'queued') {
    return { status: 'error', error: 'CONFLICT', detail: `review_item status=${row.status}` };
  }

  const statusMap = { approve: 'approved', reject: 'rejected', resolve: 'resolved' };
  const newStatus = statusMap[decision];

  let promoted_id = null;
  // If approving an import_contradiction / proposal-shaped payload with text, leave as status only
  // (promotion of nested proposal rows goes through promoteProposal). Optional: stamp note into payload.
  const payload =
    typeof row.payload === 'string' ? JSON.parse(row.payload) : { ...(row.payload || {}) };
  if (opts.note) payload.decision_note = opts.note;
  payload.decided_by = decided_by;

  let changed = 0;
  try {
    await withClient(db, async (client) => {
      // The guard is the conditional update itself, not the read
      // above. The row count decides whether this call made the
      // change, and the decide event commits with the change.
      const upd = await client.query(
        `UPDATE review_items
         SET status = $2, decided_by = $3, decided_at = now(), payload = $4::jsonb
         WHERE id = $1 AND status = 'queued'`,
        [id, newStatus, decided_by, JSON.stringify(payload)]
      );
      changed = upd.rowCount || 0;
      if (changed !== 1) return;
      await writeDecideEvent(client, {
        event: opts.event,
        namespace: payload.namespace || null,
        decided_by,
        subject_id: id,
        defaultKind:
          decision === 'approve'
            ? 'human_approval'
            : decision === 'reject'
              ? 'human_rejection'
              : 'human_decision',
        defaultSummary: `Review item ${id} decided ${newStatus}.`,
        evidence: { review_item_id: id, kind: row.kind, decision: newStatus },
      });
    });
  } catch (e) {
    return failurePayload(e);
  }
  if (changed !== 1) {
    return {
      status: 'error',
      error: 'CONFLICT',
      detail: 'the review item changed state before this decision could be recorded',
    };
  }

  return {
    status: 'ok',
    decision: newStatus,
    review_item_id: id,
    kind: row.kind,
    decided_by,
    promoted_id,
  };
}

/**
 * Unified review_decide entry (IDL §8).
 * target: 'proposal' | 'review_item'
 * decision: approve|reject|promote|resolve
 *   - proposal + approve|promote → promoteProposal
 *   - proposal + reject → rejectProposal
 *   - review_item + approve|reject|resolve → decideReviewItem
 */
export async function reviewDecide(db, opts) {
  const target = opts.target || opts.kind;
  const decision = opts.decision;
  const decided_by = opts.decided_by || CURATOR_IDENTITY;
  const id = opts.id || opts.proposal_id || opts.review_item_id;

  if (!target || !['proposal', 'review_item'].includes(target)) {
    return { status: 'error', error: 'VALIDATION', detail: 'target must be proposal|review_item' };
  }
  if (!id) return { status: 'error', error: 'VALIDATION', detail: 'id required' };

  if (target === 'proposal') {
    if (decision === 'approve' || decision === 'promote') {
      return promoteProposal(db, { proposal_id: id, decided_by, note: opts.note, event: opts.event });
    }
    if (decision === 'reject') {
      return rejectProposal(db, { proposal_id: id, decided_by, note: opts.note, event: opts.event });
    }
    return { status: 'error', error: 'VALIDATION', detail: 'proposal decision must be approve|promote|reject' };
  }

  if (!['approve', 'reject', 'resolve'].includes(decision)) {
    return { status: 'error', error: 'VALIDATION', detail: 'review_item decision must be approve|reject|resolve' };
  }
  return decideReviewItem(db, { id, decision, decided_by, note: opts.note, event: opts.event });
}
