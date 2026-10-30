/**
 * Seed everything the console + site render, into the demo namespace:
 *
 *   1. The Project Lantern corpus (scripts/seed-demo.mjs).
 *   2. The learning story, recorded as real learning events through
 *      the same libraries the product uses — grok lodges a global
 *      claim with 0, then 1, then 2 citations (real Jev verdicts),
 *      an in-turn correction is logged, the episode is promoted
 *      through the Jev gate into a standing playbook lesson, and
 *      moose then lodges a different claim of the same class and is
 *      approved first try after recalling the lesson by receipt.
 *
 * The story mirrors checks/learning-demo.mjs (which proves the same
 * flow at 8/8 on its own namespace); here it exists so the console's
 * Learning view has real records to show. Idempotent: if the demo
 * namespace already holds learning events, step 2 is skipped.
 *
 * CLI: DATABASE_URL=postgres://… node scripts/seed-web-demo.mjs [namespace]
 */
import pg from 'pg';
import { seedDemo, DEMO_NAMESPACE } from './seed-demo.mjs';
import { decideGate } from '../lib/gate.mjs';
import { correctInTurn, listEvents, promoteEvent, recordEvent } from '../lib/learning.mjs';
import { recallWithReceipts } from '../lib/planes.mjs';
import { runDaemonCycle } from '../lib/daemon.mjs';

/** One daemon cycle: emits proposals only (contradiction flags,
 *  consolidation and decay candidates) for the console to show.
 *  Signature-deduped, so reseeding never duplicates its items. */
async function runDaemonOnce(pool, namespace) {
  const run = await runDaemonCycle(pool, { namespace });
  console.log('daemon cycle:', JSON.stringify(run.emitted || run));
}

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL missing'); process.exit(1); }
const namespace = process.argv[2] || DEMO_NAMESPACE;
const pool = new pg.Pool({ connectionString: url, max: 3 });

const base = await seedDemo(pool, { namespace });
console.log('corpus:', JSON.stringify(base));

const existing = await listEvents(pool, { namespace, limit: 1 });
if (existing.length) {
  console.log('learning story already seeded — skipping step 2');
  await runDaemonOnce(pool, namespace);
  await pool.end();
  process.exit(0);
}

const TASK = 'lodge-global-claim';
const CLAIM_1 = 'The Lantern demo rig runs firmware 2.4.1 on the bench unit.';
const CLAIM_2 = 'The Lantern field kit carries two spare batteries for the demo rig.';
const SPARE_1 = ['demo-web-s1', 'Bench log entry: the Lantern field kit carries two spare batteries for the demo rig.'];
const SPARE_2 = ['demo-web-s2', 'Inventory sheet: two spare batteries for the Lantern demo rig are packed in the field kit.'];
for (const [id, text] of [SPARE_1, SPARE_2]) {
  await pool.query(
    `INSERT INTO memories (id, namespace, type, scope, text, importance, strength, pinned, index_status, approval, grounding_ids, provenance)
     VALUES ($1,$2,'semantic','global',$3,5,5.0,false,'staged','live','{}',$4::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [id, namespace, text, JSON.stringify({ author: 'moose', origin: 'ingest_file', source_session: 'web-demo-seed', created_at: '2026-10-22T09:00:00Z', evidence_refs: [`source-${id}`] })]
  );
}
const { embedStaged } = await import('../lib/planes.mjs');
await embedStaged(pool, namespace);

const evidenceFor = async (ids) => {
  const r = await pool.query('SELECT id, text FROM memories WHERE id = ANY($1)', [ids]);
  return r.rows;
};
async function lodge(actor, text, groundingIds) {
  const decision = await decideGate({
    proposal: { text, type: 'semantic', scope: 'global', grounding_ids: groundingIds },
    evidence: await evidenceFor(groundingIds),
  });
  await recordEvent(pool, {
    namespace, kind: 'proposal', actor, subject_type: 'task', subject_id: TASK,
    summary: `${actor} lodged a global claim citing ${groundingIds.length} grounding records: ${text}`,
    evidence: { grounding_ids: groundingIds },
  });
  await recordEvent(pool, {
    namespace, kind: 'gate_verdict', actor: 'jev', subject_type: 'task', subject_id: TASK,
    summary: `Gate verdict: ${decision.decision} (${decision.reason}).`,
    evidence: { decision },
  });
  return decision;
}

const before = await lodge('grok', CLAIM_1, []);
await correctInTurn(pool, {
  namespace, actor: 'grok', task_ref: TASK,
  signal: { source: 'gate', decision: before.decision, reason: before.reason, backend: before.backend },
  reflection: 'The gate escalated my claim because it cited no grounding records; a global claim needs at least two cited records whose text fully supports it.',
  correction: 'Cite at least two grounding records whose text fully supports the claim.',
});
await lodge('grok', CLAIM_1, ['demo-g2']);
const twoCite = await lodge('grok', CLAIM_1, ['demo-g2', 'demo-g3']);

const LESSON = 'Global factual claims are auto-approved only when they cite at least two grounding records whose text fully supports the claim; with zero or one citation the gate escalates them to human review.';
const lessonEventId = await recordEvent(pool, {
  namespace, kind: 'eval_outcome', actor: 'grok', subject_type: 'task', subject_id: TASK,
  summary: LESSON,
  evidence: {
    lesson_text: LESSON, verified: true,
    verdicts: [
      { grounding: 0, decision: before.decision },
      { grounding: 2, decision: twoCite.decision },
    ],
  },
});
const promotion = await promoteEvent(pool, lessonEventId, { decided_by: 'memoryloom-learning' });
console.log('promotion:', JSON.stringify({ promoted: promotion.promoted, lesson_id: promotion.lesson_id }));

if (promotion.promoted) {
  const recall = await recallWithReceipts(pool, { namespace, query: 'global claim two grounding records escalate', k: 5 });
  const hit = recall.results.find((r) => r.id === promotion.lesson_id);
  await recordEvent(pool, {
    namespace, kind: 'lesson_applied', actor: 'moose', subject_type: 'learning_event', subject_id: lessonEventId,
    summary: hit
      ? `moose recalled the playbook lesson by receipt (${hit.id}) before lodging a claim of the same class.`
      : 'moose attempted to recall the playbook lesson; no receipt matched.',
    evidence: { lesson_id: promotion.lesson_id, receipt: hit ? hit.receipt : null },
  });
  const after = await lodge('moose', CLAIM_2, [SPARE_1[0], SPARE_2[0]]);
  console.log('after (moose, first try):', after.decision);
}

await runDaemonOnce(pool, namespace);

const events = await listEvents(pool, { namespace, limit: 500 });
console.log(`learning events in ${namespace}: ${events.length}`);
await pool.end();
