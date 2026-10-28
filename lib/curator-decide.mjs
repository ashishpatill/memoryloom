/**
 * Curator decision helpers (P1.G2) — promote / reject proposals and
 * approve / reject / resolve review_items. Identity stamped as decided_by
 * (default `svc:curator` per FINAL-PLAN-V2.md §8).
 *
 * Works against any Queryable (pg Pool or stub with .query).
 */
import { randomUUID } from 'node:crypto';

export const CURATOR_IDENTITY = 'svc:curator';

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
            promoted_id, created_at
     FROM proposals
     WHERE status = $1
     ORDER BY created_at ASC
     LIMIT 100`,
    [propStatus]
  );
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
    proposals: proposals.rows || [],
    review_items: reviews.rows || [],
    counts: {
      proposals: (proposals.rows || []).length,
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
  if (row.status !== 'pending') {
    return { status: 'error', error: 'CONFLICT', detail: `proposal status=${row.status}` };
  }

  const memory_id = randomUUID();
  const createdAt = new Date().toISOString();
  const provenance = {
    ...(typeof row.provenance === 'string' ? JSON.parse(row.provenance) : row.provenance || {}),
    author: decided_by,
    origin: 'promote',
    promoted_from: proposal_id,
    decided_by,
    created_at: createdAt,
  };
  if (opts.note) provenance.decision_note = opts.note;

  const client = typeof db.connect === 'function' ? await db.connect() : db;
  try {
    if (client !== db) await client.query('BEGIN');
    await client.query(
      `INSERT INTO memories (
         id, namespace, type, scope, text, importance, strength, pinned,
         index_status, approval, grounding_ids, provenance
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8,
         'staged', 'live', $9, $10::jsonb
       )`,
      [
        memory_id,
        row.namespace,
        row.type,
        row.scope,
        row.text,
        row.importance,
        row.strength,
        row.pinned,
        row.grounding_ids || [],
        JSON.stringify(provenance),
      ]
    );
    await client.query(
      `UPDATE proposals
       SET status = 'approved', decided_by = $2, decided_at = now(), promoted_id = $3
       WHERE id = $1 AND status = 'pending'`,
      [proposal_id, decided_by, memory_id]
    );
    if (client !== db) await client.query('COMMIT');
  } catch (e) {
    if (client !== db) await client.query('ROLLBACK').catch(() => {});
    return { status: 'error', error: String(e.message || e) };
  } finally {
    if (client !== db && typeof client.release === 'function') client.release();
  }

  return {
    status: 'ok',
    decision: 'approved',
    proposal_id,
    promoted_id: memory_id,
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
  const got = await db.query(`SELECT id, status FROM proposals WHERE id = $1`, [proposal_id]);
  const row = got.rows?.[0];
  if (!row) return { status: 'error', error: 'NOT_FOUND', detail: `proposal ${proposal_id}` };
  if (row.status !== 'pending') {
    return { status: 'error', error: 'CONFLICT', detail: `proposal status=${row.status}` };
  }
  await db.query(
    `UPDATE proposals
     SET status = 'rejected', decided_by = $2, decided_at = now()
     WHERE id = $1`,
    [proposal_id, decided_by]
  );
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

  await db.query(
    `UPDATE review_items
     SET status = $2, decided_by = $3, decided_at = now(), payload = $4::jsonb
     WHERE id = $1`,
    [id, newStatus, decided_by, JSON.stringify(payload)]
  );

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
      return promoteProposal(db, { proposal_id: id, decided_by, note: opts.note });
    }
    if (decision === 'reject') {
      return rejectProposal(db, { proposal_id: id, decided_by, note: opts.note });
    }
    return { status: 'error', error: 'VALIDATION', detail: 'proposal decision must be approve|promote|reject' };
  }

  if (!['approve', 'reject', 'resolve'].includes(decision)) {
    return { status: 'error', error: 'VALIDATION', detail: 'review_item decision must be approve|reject|resolve' };
  }
  return decideReviewItem(db, { id, decision, decided_by, note: opts.note });
}
