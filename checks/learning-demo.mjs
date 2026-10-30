/**
 * Before / after demo evidence for the learning layer (Block 5).
 *
 * One task class, end to end, on the synthetic Project Lantern
 * corpus: "lodge a global factual claim so the gate auto-approves
 * it". Every step is recorded as a learning event, and the recall
 * receipt for the promoted lesson is the evidence trail.
 *
 *   BEFORE  grok lodges the firmware claim with no grounding
 *           -> gate escalates (fewer than 2 grounding records).
 *   TURN    an in-turn correction is logged with the verdict as its
 *           trigger evidence; grok retries with one citation
 *           -> still escalated; retries with two -> approved.
 *   LEARN   the episode becomes a learning event; the Jev gate
 *           promotes it into a standing playbook lesson.
 *   AFTER   moose — never corrected — recalls the lesson (receipt
 *           shown) and lodges a different claim of the same class
 *           with two citations -> approved first try.
 *
 * Usage: DATABASE_URL=postgres://... node checks/learning-demo.mjs
 */
process.env.MEMORYLOOM_ROUTER_MODE = 'live';
process.env.JEV_TIMEOUT_MS = process.env.JEV_TIMEOUT_MS || '15000';
import pg from 'pg';
import { decideGate } from '../lib/gate.mjs';
import { correctInTurn, listEvents, promoteEvent, recordEvent } from '../lib/learning.mjs';
import { embedStaged, recallWithReceipts } from '../lib/planes.mjs';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL missing'); process.exit(1); }
const NS = 'memoryloom-learning-demo';
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });
let failures = 0;
function assert(cond, label, extra = '') {
  if (cond) console.log(`  PASS ${label}`);
  else { failures++; console.log(`  FAIL ${label} ${extra}`); }
}

// ---- seed the grounding records (moose's sources) ------------------------
await pool.query(`DELETE FROM learning_events WHERE namespace = $1`, [NS]);
await pool.query(`DELETE FROM memories WHERE namespace = $1`, [NS]);
const SOURCES = [
  ['ld-g1', 'Bench log entry: the Lantern demo rig runs firmware 2.4.1 on the bench unit.'],
  ['ld-g2', 'Inventory sheet: the bench unit of the Lantern demo rig is loaded with firmware 2.4.1.'],
  ['ld-g3', 'Bench log entry: the Lantern field kit carries two spare batteries for the demo rig.'],
  ['ld-g4', 'Inventory sheet: two spare batteries for the Lantern demo rig are packed in the field kit.'],
];
for (const [id, text] of SOURCES) {
  await pool.query(
    `INSERT INTO memories (id, namespace, type, scope, text, importance, strength, pinned, index_status, approval, grounding_ids, provenance)
     VALUES ($1,$2,'semantic','global',$3,5,5.0,false,'staged','live','{}',$4::jsonb)`,
    [id, NS, text, JSON.stringify({ author: 'moose', origin: 'ingest_file', source_session: 'learning-demo', evidence_refs: [`source-${id}`] })]
  );
}
await embedStaged(pool, NS);
const evidenceFor = async (ids) => {
  const r = await pool.query(`SELECT id, text FROM memories WHERE id = ANY($1)`, [ids]);
  return r.rows;
};

const CLAIM_1 = 'The Lantern demo rig runs firmware 2.4.1 on the bench unit.';
const CLAIM_2 = 'The Lantern field kit carries two spare batteries for the demo rig.';
async function lodge(actor, text, groundingIds) {
  const decision = await decideGate({
    proposal: { text, type: 'semantic', scope: 'global', grounding_ids: groundingIds },
    evidence: await evidenceFor(groundingIds),
  });
  await recordEvent(pool, {
    namespace: NS, kind: 'proposal', actor,
    subject_type: 'task', subject_id: 'lodge-global-claim',
    summary: `${actor} lodged a global claim citing ${groundingIds.length} grounding records: ${text}`,
    evidence: { grounding_ids: groundingIds },
  });
  await recordEvent(pool, {
    namespace: NS, kind: 'gate_verdict', actor: 'jev',
    subject_type: 'task', subject_id: 'lodge-global-claim',
    summary: `Gate verdict: ${decision.decision} (${decision.reason}).`,
    evidence: { decision },
  });
  return decision;
}

// ---- BEFORE ---------------------------------------------------------------
console.log('BEFORE: no lesson exists');
const before = await lodge('grok', CLAIM_1, []);
assert(before.decision === 'escalate', 'ungrounded global claim escalates', JSON.stringify(before).slice(0, 200));

// ---- IN-TURN CORRECTION -----------------------------------------------------
console.log('IN-TURN: correction logged with the verdict as trigger');
const corr = await correctInTurn(pool, {
  namespace: NS, actor: 'grok', task_ref: 'lodge-global-claim',
  signal: { source: 'gate', decision: before.decision, reason: before.reason, backend: before.backend },
  reflection: 'The gate escalated my claim because it cited no grounding records; a global claim needs at least two cited records whose text fully supports it.',
  correction: 'Cite at least two grounding records whose text fully supports the claim.',
});
assert(Boolean(corr.event_id), 'correction event recorded');
const oneCite = await lodge('grok', CLAIM_1, ['ld-g1']);
assert(oneCite.decision === 'escalate', 'one citation still escalates (min-evidence rule)', JSON.stringify(oneCite).slice(0, 160));
const twoCite = await lodge('grok', CLAIM_1, ['ld-g1', 'ld-g2']);
assert(twoCite.decision === 'approve', 'two supporting citations approve', JSON.stringify(twoCite).slice(0, 200));

// ---- LEARN: the episode becomes a gated lesson --------------------------------
console.log('LEARN: promotion through the Jev gate');
const LESSON = 'Global factual claims are auto-approved only when they cite at least two grounding records whose text fully supports the claim; with zero or one citation the gate escalates them to human review.';
const lessonEventId = await recordEvent(pool, {
  namespace: NS, kind: 'eval_outcome', actor: 'grok',
  subject_type: 'task', subject_id: 'lodge-global-claim',
  summary: LESSON,
  evidence: {
    lesson_text: LESSON,
    verified: true,
    verdicts: [
      { grounding: 0, decision: before.decision },
      { grounding: 1, decision: oneCite.decision },
      { grounding: 2, decision: twoCite.decision },
    ],
  },
});
await recordEvent(pool, {
  namespace: NS, kind: 'lesson_applied', actor: 'grok',
  subject_type: 'learning_event', subject_id: lessonEventId,
  summary: 'Applied the two-citation rule inside the same turn; the gate approved the firmware claim.',
  evidence: { outcome: 'approved', claim: CLAIM_1 },
});
const promo = await promoteEvent(pool, lessonEventId);
assert(promo.promoted === true, 'Jev promotes the lesson', JSON.stringify(promo.decision).slice(0, 240));

// ---- AFTER: a different agent, a different claim, first try ----------------------
console.log('AFTER: moose recalls the lesson and succeeds first try');
let receiptSeen = null;
const recall = await recallWithReceipts(pool, {
  namespace: NS,
  query: 'global factual claims cite at least two grounding records auto-approved',
  k: 5,
  onRecall: async (o) => {
    await recordEvent(pool, {
      namespace: NS, kind: o.results.length ? 'recall_hit' : 'recall_miss',
      actor: 'moose', subject_type: 'task', subject_id: 'lodge-global-claim',
      summary: `moose recalled guidance for the claim-lodging task (${o.results.length} results).`,
      evidence: { query: o.query, result_ids: o.results.map((r) => r.id) },
    });
  },
});
receiptSeen = recall.results.find((r) => r.id === promo.lesson_id);
assert(Boolean(receiptSeen), 'the promoted lesson is recalled', JSON.stringify(recall.results.map((r) => r.id)));
assert(receiptSeen?.receipt?.author === 'memoryloom-learning' || Boolean(receiptSeen?.receipt), 'recall carries a provenance receipt');
const after = await lodge('moose', CLAIM_2, ['ld-g3', 'ld-g4']);
assert(after.decision === 'approve', 'moose lodges a same-class claim with two citations: approved first try', JSON.stringify(after).slice(0, 200));

// ---- evidence trail ------------------------------------------------------------------
console.log('\nEVIDENCE TRAIL (learning events, in order):');
const events = await listEvents(pool, { namespace: NS });
for (const e of events) {
  console.log(`  [${e.kind}] ${e.actor || '-'}: ${e.summary.slice(0, 110)}`);
}
console.log('\nBEFORE vs AFTER:');
console.log(`  before: grok, 0 citations -> ${before.decision}`);
console.log(`  after:  moose, 2 citations, lesson recalled by receipt -> ${after.decision}`);

await pool.end();
console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
