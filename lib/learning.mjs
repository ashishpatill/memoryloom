/**
 * Continual / in-turn learning layer (Block 5).
 *
 * Research basis (patterns, not claims):
 * ACE's playbooks that accumulate through generation, reflection and
 * curation; Reflexion's verbal reflections kept in episodic memory;
 * Voyager's retrievable skill library; Harness²'s two-level split
 * (task-level correction now, harness-level improvement later).
 *
 * The MemoryLoom shape of those patterns:
 *  - INGESTION: every interaction is recorded as an append-only
 *    learning event (migration 007) — proposals, gate verdicts,
 *    human approvals / rejections / corrections, recall hits and
 *    misses, eval outcomes, in-turn corrections, promotion
 *    decisions. Events are Plane-1 truth: provenance-stamped,
 *    never edited, never deleted.
 *  - PROMOTION: a learning event becomes a standing playbook lesson
 *    ONLY through promoteEvent, which asks the Jev gate
 *    (decidePromotion, fail closed) and, on a promote verdict,
 *    stores the lesson as a memory with the Jev record in its
 *    provenance. There is no other write path: writeLessonDirect
 *    refuses, and auditLessons quarantines any lesson-shaped record
 *    that lacks a Jev promote verdict (e.g. a forged direct insert).
 *  - DECAY: lessons are memories, so deterministic decay and the
 *    Jev keep/drop gate apply to them exactly as to any record.
 *  - IN-TURN CORRECTION: when a gate or eval signal shows an agent
 *    going wrong mid-task, correctInTurn stores the verbal
 *    reflection + trigger evidence as an event and returns the
 *    corrected directive for the same turn.
 */
import { randomUUID } from 'node:crypto';
import { decidePromotion } from './gate.mjs';
import { embedOne } from './planes.mjs';

export const EVENT_KINDS = [
  'proposal', 'gate_verdict',
  'human_approval', 'human_rejection', 'human_correction',
  'recall_hit', 'recall_miss', 'eval_outcome',
  'in_turn_correction', 'promotion_decision', 'lesson_applied',
];

export class LearningError extends Error {}

/** Record one learning event. Returns the event id. */
export async function recordEvent(pool, {
  namespace,
  kind,
  actor = null,
  subject_type = null,
  subject_id = null,
  summary,
  evidence = {},
  session = null,
} = {}) {
  if (!EVENT_KINDS.includes(kind)) {
    throw new LearningError(`unknown learning event kind: ${kind}`);
  }
  if (!namespace || !summary) {
    throw new LearningError('learning event needs namespace and summary');
  }
  const id = randomUUID();
  const provenance = {
    author: actor,
    origin: 'learning-event',
    source_session: session || `learning-${Date.now()}`,
    created_at: new Date().toISOString(),
  };
  await pool.query(
    `INSERT INTO learning_events (id, namespace, kind, actor, subject_type, subject_id, summary, evidence, provenance)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`,
    [id, namespace, kind, actor, subject_type, subject_id, String(summary), JSON.stringify(evidence || {}), JSON.stringify(provenance)]
  );
  return id;
}

/** Read events back, newest last. Filters: kind, subject_id. */
export async function listEvents(pool, { namespace, kind = null, subject_id = null, limit = 200 } = {}) {
  const clauses = ['namespace = $1'];
  const params = [namespace];
  if (kind) { params.push(kind); clauses.push(`kind = $${params.length}`); }
  if (subject_id) { params.push(subject_id); clauses.push(`subject_id = $${params.length}`); }
  params.push(limit);
  const r = await pool.query(
    `SELECT id, namespace, kind, actor, subject_type, subject_id, summary, evidence, provenance, created_at
     FROM learning_events WHERE ${clauses.join(' AND ')} ORDER BY created_at, id LIMIT $${params.length}`,
    params
  );
  return r.rows;
}

/** How many times a learning event has been applied (lesson_applied events pointing at it). */
export async function countApplications(pool, eventId) {
  const r = await pool.query(
    `SELECT count(*)::int AS n FROM learning_events
     WHERE kind = 'lesson_applied' AND subject_type = 'learning_event' AND subject_id = $1`,
    [eventId]
  );
  return r.rows[0].n;
}

/**
 * The ONLY path from a learning event to a standing lesson.
 * Asks the Jev gate (decidePromotion — fail closed: a backend
 * failure never promotes), records the promotion decision as an
 * event either way, and on a promote verdict stores the lesson as
 * a procedural memory whose provenance carries the Jev record.
 */
export async function promoteEvent(pool, eventId, { decided_by = 'memoryloom-learning', embedFn = null } = {}) {
  const r = await pool.query(`SELECT * FROM learning_events WHERE id = $1`, [eventId]);
  const event = r.rows[0];
  if (!event) return { promoted: false, reason: 'learning event not found', decision: null };
  const evidence = event.evidence || {};
  const applications = (await countApplications(pool, eventId)) + (Number(evidence.applications) || 0);
  const decision = await decidePromotion({
    event: {
      summary: event.summary,
      evidence: JSON.stringify(evidence).slice(0, 800),
      times_applied: applications,
      verified: evidence.verified === true,
    },
  });
  if (!decision.promote) {
    await recordEvent(pool, {
      namespace: event.namespace,
      kind: 'promotion_decision',
      actor: decided_by,
      subject_type: 'learning_event',
      subject_id: eventId,
      summary: `Promotion declined by the gate (${decision.reason}).`,
      evidence: { decision, lesson_id: null },
    });
    return { promoted: false, lesson_id: null, decision };
  }
  const lessonId = randomUUID();
  const provenance = {
    source_session: `promotion-${eventId}`,
    author: decided_by,
    origin: 'learning-promotion',
    created_at: new Date().toISOString(),
    embedding_model: null,
    learning_event_id: eventId,
    jev: decision,
  };
  // The promotion boundary (frozen master plan, Section 5, card
  // S3b). The lesson insert, the scoped embedding step for that
  // lesson only and the promotion event row are one transaction.
  // A failure at the embedding step or at the event write rolls
  // the whole promotion back, so no lesson row and no promotion
  // event remain, the source event is unchanged and promotion can
  // run again. The namespace wide embedding sweep no longer runs
  // on this path.
  const client = typeof pool.connect === 'function' ? await pool.connect() : pool;
  const ownClient = client !== pool;
  try {
    if (ownClient) await client.query('BEGIN');
    await client.query(
      `INSERT INTO memories (id, namespace, type, scope, text, importance, strength, pinned,
                             index_status, approval, grounding_ids, provenance)
       VALUES ($1,$2,'procedural','global',$3,7,5.0,false,'staged','live','{}',$4::jsonb)`,
      [lessonId, event.namespace, String(evidence.lesson_text || event.summary), JSON.stringify(provenance)]
    );
    await embedOne(client, lessonId, { embedFn });
    await recordEvent(client, {
      namespace: event.namespace,
      kind: 'promotion_decision',
      actor: decided_by,
      subject_type: 'learning_event',
      subject_id: eventId,
      summary: `Promotion approved by the gate; lesson stored as ${lessonId}.`,
      evidence: { decision, lesson_id: lessonId },
    });
    if (ownClient) await client.query('COMMIT');
  } catch (e) {
    if (ownClient) await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    if (ownClient && typeof client.release === 'function') client.release();
  }
  return { promoted: true, lesson_id: lessonId, decision };
}

/**
 * There is deliberately no direct lesson writer. This function
 * exists so the refusal is explicit, testable, and greppable.
 */
export async function writeLessonDirect() {
  throw new LearningError(
    'direct lesson writes are refused: lessons are created only by promoteEvent through the Jev gate'
  );
}

/**
 * Enforcement sweep: any memory claiming to be a promoted lesson
 * (provenance.origin = 'learning-promotion') whose provenance lacks
 * a Jev promote verdict is quarantined (retired). Returns the ids.
 */
export async function auditLessons(pool, namespace) {
  const r = await pool.query(
    `SELECT id, provenance FROM memories
     WHERE namespace = $1 AND approval = 'live'
       AND provenance->>'origin' = 'learning-promotion'`,
    [namespace]
  );
  const quarantined = [];
  for (const row of r.rows) {
    const jev = row.provenance?.jev;
    if (!jev || jev.promote !== true) {
      await pool.query(
        `UPDATE memories SET approval = 'retired', valid_to = now() WHERE id = $1`,
        [row.id]
      );
      quarantined.push(row.id);
    }
  }
  return quarantined;
}

/**
 * In-turn correction (Reflexion, tightened to the same turn;
 * Harness² task level). `signal` is the trigger evidence — a gate
 * verdict, an eval outcome, a failed check — and `reflection` is the
 * agent's verbal account of what went wrong. The correction itself
 * is returned as the directive for the rest of the turn, and the
 * whole exchange is stored as a learning event.
 */
export async function correctInTurn(pool, {
  namespace,
  actor,
  task_ref = null,
  signal,
  reflection,
  correction,
  session = null,
} = {}) {
  if (!signal || typeof signal !== 'object') {
    throw new LearningError('in-turn correction needs trigger evidence (signal)');
  }
  const eventId = await recordEvent(pool, {
    namespace,
    kind: 'in_turn_correction',
    actor,
    subject_type: 'task',
    subject_id: task_ref,
    summary: String(reflection || ''),
    evidence: { trigger: signal, correction: String(correction || '') },
    session,
  });
  return { event_id: eventId, directive: String(correction || '') };
}
