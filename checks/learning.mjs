/**
 * Learning layer check (Block 5), on a throwaway DB:
 *
 * Part A (library):
 *  - Ingestion completeness: one event of every kind lands, each
 *    provenance-stamped; the table refuses UPDATE and DELETE.
 *  - Recall capture via the planes onRecall hook (hit + miss).
 *  - Promotion only via the gate: writeLessonDirect refuses; a
 *    forged lesson insert is quarantined by auditLessons; a dead
 *    Jev backend promotes nothing (fail closed).
 *  - A real promotion: Jev verdict recorded, lesson stored as a
 *    memory with the verdict in provenance, embedded for recall.
 *  - Deterministic decay applies to the lesson like any memory.
 *
 * Part B (MCP over stdio, Jev gate backend on):
 *  - store / propose / recall / promote / reject through the real
 *    tool surface land their learning events (proposal, gate_verdict,
 *    recall_hit, recall_miss, human_approval, human_rejection).
 *
 * Usage: DATABASE_URL=postgres://... node checks/learning.mjs
 */
process.env.MEMORYLOOM_ROUTER_MODE = 'live';
process.env.JEV_TIMEOUT_MS = process.env.JEV_TIMEOUT_MS || '15000';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  auditLessons,
  correctInTurn,
  listEvents,
  promoteEvent,
  recordEvent,
  writeLessonDirect,
} from '../lib/learning.mjs';
import { applyDecay, embedStaged, recallWithReceipts } from '../lib/planes.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL missing'); process.exit(1); }
const NS = 'memoryloom-learning';
const NS_MCP = 'memoryloom-learning-mcp';
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });
let failures = 0;
function assert(cond, label, extra = '') {
  if (cond) console.log(`  PASS ${label}`);
  else { failures++; console.log(`  FAIL ${label} ${extra}`); }
}

// =====================================================================
// Part A — library
// =====================================================================
console.log('part A: ingestion completeness');
await pool.query(`DELETE FROM learning_events WHERE namespace = ANY($1)`, [[NS, NS_MCP]]);
await pool.query(`DELETE FROM memories WHERE namespace = $1`, [NS]);

const directKinds = [
  'proposal', 'gate_verdict', 'human_approval', 'human_rejection',
  'human_correction', 'recall_hit', 'recall_miss', 'eval_outcome',
];
for (const kind of directKinds) {
  await recordEvent(pool, {
    namespace: NS, kind, actor: 'learning-check',
    subject_type: 'task', subject_id: 'completeness-probe',
    summary: `Completeness probe event of kind ${kind}.`,
    evidence: { probe: kind },
  });
}
const corr = await correctInTurn(pool, {
  namespace: NS, actor: 'grok', task_ref: 'task-1',
  signal: { source: 'gate', decision: 'escalate', reason: 'structural: fewer than 2 grounding records' },
  reflection: 'I lodged a global claim with no grounding records and the gate escalated it.',
  correction: 'Cite at least two grounding records whose text fully supports the claim.',
});
assert(corr.directive.includes('two grounding records'), 'in-turn correction returns the directive');
const all = await listEvents(pool, { namespace: NS });
const kindsSeen = new Set(all.map((e) => e.kind));
assert([...directKinds, 'in_turn_correction'].every((k) => kindsSeen.has(k)), 'every event kind lands', [...kindsSeen].join(','));
assert(all.every((e) => e.provenance?.author && e.provenance?.origin === 'learning-event'), 'every event is provenance-stamped');
const corrEvent = all.find((e) => e.kind === 'in_turn_correction');
assert(corrEvent.evidence.trigger.decision === 'escalate' && corrEvent.evidence.correction.includes('two grounding'), 'correction event carries its trigger evidence');

console.log('part A: append-only enforcement');
let updateThrew = false;
try { await pool.query(`UPDATE learning_events SET summary = 'edited' WHERE namespace = $1`, [NS]); } catch { updateThrew = true; }
assert(updateThrew, 'UPDATE on learning_events is refused by trigger');
let deleteThrew = false;
try { await pool.query(`DELETE FROM learning_events WHERE namespace = $1`, [NS]); } catch { deleteThrew = true; }
assert(deleteThrew, 'DELETE on learning_events is refused by trigger');

console.log('part A: recall capture via onRecall');
await pool.query(
  `INSERT INTO memories (id, namespace, type, scope, text, importance, strength, pinned, index_status, approval, grounding_ids, provenance)
   VALUES ('ln-doc1', $1, 'semantic', 'global', 'The Lantern workshop stores spare rig batteries in the blue cabinet.', 5, 5.0, false, 'staged', 'live', '{}', $2::jsonb)`,
  [NS, JSON.stringify({ author: 'moose', origin: 'seed', source_session: 'learning-check' })]
);
await embedStaged(pool, NS);
const capture = async (o) => {
  await recordEvent(pool, {
    namespace: o.namespace, kind: o.results.length ? 'recall_hit' : 'recall_miss',
    actor: 'learning-check', subject_type: 'task',
    summary: `Recall ${o.results.length ? 'hit' : 'miss'}: ${o.query}`,
    evidence: { query: o.query, result_ids: o.results.map((r) => r.id), dropped: o.dropped.length },
  });
};
const hit = await recallWithReceipts(pool, { namespace: NS, query: 'spare rig batteries cabinet', onRecall: capture });
assert(hit.results.some((r) => r.id === 'ln-doc1'), 'recall finds the seeded record');
const miss = await recallWithReceipts(pool, { namespace: 'memoryloom-empty', query: 'anything at all', onRecall: capture });
assert(miss.results.length === 0, 'recall on an empty namespace returns nothing');
const captured = await pool.query(
  `SELECT kind, namespace FROM learning_events WHERE evidence->>'query' IS NOT NULL`
);
assert(captured.rows.some((r) => r.kind === 'recall_hit' && r.namespace === NS), 'recall hit captured as an event');
assert(captured.rows.some((r) => r.kind === 'recall_miss' && r.namespace === 'memoryloom-empty'), 'recall miss captured as an event');

console.log('part A: promotion only via the gate');
let directThrew = false;
try { await writeLessonDirect(pool, { namespace: NS, text: 'forged' }); } catch { directThrew = true; }
assert(directThrew, 'writeLessonDirect refuses');
await pool.query(
  `INSERT INTO memories (id, namespace, type, scope, text, importance, strength, pinned, index_status, approval, grounding_ids, provenance)
   VALUES ('ln-forged', $1, 'procedural', 'global', 'Forged lesson with no gate verdict.', 5, 5.0, false, 'staged', 'live', '{}', $2::jsonb)`,
  [NS, JSON.stringify({ author: 'attacker', origin: 'learning-promotion', source_session: 'forge' })]
);
const quarantined = await auditLessons(pool, NS);
assert(quarantined.includes('ln-forged'), 'auditLessons quarantines the forged lesson');
const forgedRow = await pool.query(`SELECT approval FROM memories WHERE id = 'ln-forged'`);
assert(forgedRow.rows[0].approval === 'retired', 'forged lesson is retired');

const nonce = Date.now();
const deadEventId = await recordEvent(pool, {
  namespace: NS, kind: 'eval_outcome', actor: 'learning-check',
  subject_type: 'task', subject_id: 'dead-backend-probe',
  summary: `A reusable, evidence-backed lesson about rehearsal run sheets (${nonce}).`,
  evidence: { verified: true, lesson_text: `Rehearsal run sheets must name a fallback operator (${nonce}).` },
});
// Save/restore, not delete (Iteration 5.3 closure): in-process
// callers read JEV_BASE_URL directly, so deleting it here would
// silently retarget the real promotion below at the hosted default
// instead of the backend this run was configured with. The fail-
// closed assertions that follow are unaffected: the probe itself
// runs while the override is in force.
const savedJevBaseUrl = process.env.JEV_BASE_URL;
process.env.JEV_BASE_URL = 'https://api.typesafe.ai.invalid';
const dead = await promoteEvent(pool, deadEventId);
if (savedJevBaseUrl === undefined) delete process.env.JEV_BASE_URL;
else process.env.JEV_BASE_URL = savedJevBaseUrl;
assert(dead.promoted === false && dead.decision.failed === true && dead.decision.fail_closed === true, 'dead Jev backend: promotion fails closed', JSON.stringify(dead.decision).slice(0, 200));
const deadLesson = await pool.query(
  `SELECT count(*)::int n FROM memories WHERE namespace = $1 AND provenance->>'learning_event_id' = $2`,
  [NS, deadEventId]
);
assert(deadLesson.rows[0].n === 0, 'dead Jev backend: no lesson stored');

console.log('part A: a real promotion');
const lessonEventId = await recordEvent(pool, {
  namespace: NS, kind: 'eval_outcome', actor: 'grok',
  subject_type: 'task', subject_id: 'rehearsal-2026-10-12',
  summary: 'When a rehearsal run is scheduled, the run sheet must name the operator and the fallback operator before the run starts.',
  evidence: {
    lesson_text: 'When a rehearsal run is scheduled, the run sheet must name the operator and the fallback operator before the run starts.',
    incident: 'The 12 Oct rehearsal stalled for twenty minutes because the operator was ill and no fallback operator had been named.',
    resolution: 'Naming a fallback operator on the run sheet is now the standing fix, applied at the 19 Oct and 26 Oct rehearsals.',
    verified: true,
  },
});
await recordEvent(pool, {
  namespace: NS, kind: 'lesson_applied', actor: 'moose',
  subject_type: 'learning_event', subject_id: lessonEventId,
  summary: 'Applied the fallback-operator lesson while preparing the 26 Oct rehearsal run sheet.',
  evidence: { outcome: 'run sheet named a fallback operator' },
});
const promo = await promoteEvent(pool, lessonEventId);
assert(promo.promoted === true && promo.decision.backend === 'jev' && promo.decision.failed === false, 'Jev promotes the evidence-backed lesson', JSON.stringify(promo.decision).slice(0, 240));
if (promo.promoted) {
  const lesson = await pool.query(`SELECT * FROM memories WHERE id = $1`, [promo.lesson_id]);
  assert(lesson.rows[0].type === 'procedural' && lesson.rows[0].provenance.origin === 'learning-promotion', 'lesson stored as a procedural memory');
  assert(lesson.rows[0].provenance.jev.promote === true && lesson.rows[0].provenance.learning_event_id === lessonEventId, 'lesson provenance carries the Jev promote verdict');
  assert(lesson.rows[0].index_status === 'indexed' && lesson.rows[0].embedding !== null, 'lesson embedded for recall');
  const clean = await auditLessons(pool, NS);
  assert(!clean.includes(promo.lesson_id), 'auditLessons leaves the gated lesson live');

  console.log('part A: deterministic decay applies to lessons');
  await pool.query(
    `UPDATE memories SET created_at = now() - interval '200 days', last_recalled_at = NULL, strength = 2.0 WHERE id = $1`,
    [promo.lesson_id]
  );
  const before = (await pool.query(`SELECT strength FROM memories WHERE id = $1`, [promo.lesson_id])).rows[0].strength;
  await applyDecay(pool, { namespace: NS, now: new Date(), halfLifeDays: 30, useJev: false });
  const after = (await pool.query(`SELECT strength FROM memories WHERE id = $1`, [promo.lesson_id])).rows[0].strength;
  assert(after < before && after < 0.1, 'lesson strength decays deterministically', `${before} -> ${after}`);
}
const promoDecisions = await listEvents(pool, { namespace: NS, kind: 'promotion_decision' });
assert(promoDecisions.length === 2, 'both promotion decisions recorded as events', `got ${promoDecisions.length}`);

// =====================================================================
// Part B — MCP over stdio
// =====================================================================
console.log('part B: MCP tool surface lands learning events');
function runMcp(env, calls) {
  return new Promise((resolve, reject) => {
    const srv = spawn('node', [join(__dir, '..', 'mcp', 'index.mjs')], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const pending = new Map();
    let buf = '';
    let reqId = 0;
    srv.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id != null && pending.has(msg.id)) {
          const { resolve: res } = pending.get(msg.id);
          pending.delete(msg.id);
          res(msg);
        }
      }
    });
    srv.on('error', reject);
    const rpc = (method, params) => new Promise((res) => {
      const id = ++reqId;
      pending.set(id, { resolve: res });
      srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    (async () => {
      await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'learning-check', version: '1' } });
      srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
      const out = [];
      for (const [name, args] of calls) {
        const res = await rpc('tools/call', { name, arguments: args });
        out.push(JSON.parse(res.result.content[0].text));
      }
      srv.kill();
      resolve(out);
    })().catch(reject);
  });
}

await pool.query(`DELETE FROM proposals WHERE namespace = $1`, [NS_MCP]);
await pool.query(`DELETE FROM memories WHERE namespace = $1`, [NS_MCP]);
const [stored, propOk, propQueued] = await runMcp(
  { DATABASE_URL, MEMORYLOOM_GATE_BACKEND: 'jev' },
  [
    ['store', { namespace: NS_MCP, text: 'The Lantern workshop stores spare rig batteries in the blue cabinet.', metadata: { author: 'grok' } }],
    ['propose', { namespace: NS_MCP, text: 'On Wednesday the field team charged the Lantern rig batteries.', metadata: { type: 'episodic', author: 'grok' } }],
    ['propose', { namespace: NS_MCP, text: 'The Lantern rig batteries last exactly 26 hours.', metadata: { type: 'semantic', author: 'moose' } }],
  ]
);
assert(stored.status === 'ok', 'MCP store works', JSON.stringify(stored).slice(0, 160));
assert(propOk.decision === 'auto_approved', 'MCP propose (episodic) approved through the Jev gate', JSON.stringify(propOk).slice(0, 160));
assert(propQueued.decision === 'queued_for_review', 'MCP propose (ungrounded claim) queued', JSON.stringify(propQueued).slice(0, 160));

const [hitCall, missCall] = await runMcp(
  { DATABASE_URL, MEMORYLOOM_GATE_BACKEND: 'jev' },
  [
    ['recall', { namespace: NS_MCP, query: 'spare rig batteries blue cabinet' }],
    // A genuine miss needs an empty namespace: the vector leg always
    // returns nearest neighbours in a populated one.
    ['recall', { namespace: 'memoryloom-learning-empty', query: 'underwater basket weaving championship' }],
  ]
);
assert(hitCall.count >= 1, 'MCP recall hits', JSON.stringify(hitCall).slice(0, 160));
assert(missCall.count === 0, 'MCP recall misses cleanly on an empty namespace', JSON.stringify(missCall).slice(0, 160));

const [promoted] = await runMcp(
  { DATABASE_URL, MEMORYLOOM_GATE_BACKEND: 'jev' },
  [['promote', { proposal_id: propQueued.proposal_id, decided_by: 'human' }]]
);
assert(promoted.status === 'ok', 'MCP promote works', JSON.stringify(promoted).slice(0, 160));

const [, propQueued2] = await runMcp(
  { DATABASE_URL, MEMORYLOOM_GATE_BACKEND: 'jev' },
  [
    ['propose', { namespace: NS_MCP, text: 'On Thursday the field team inventoried the Lantern cables.', metadata: { type: 'episodic', author: 'grok' } }],
    ['propose', { namespace: NS_MCP, text: 'The Lantern cables are exactly twelve metres long.', metadata: { type: 'semantic', author: 'moose' } }],
  ]
);
const [rejected] = await runMcp(
  { DATABASE_URL, MEMORYLOOM_GATE_BACKEND: 'jev' },
  [['reject_proposal', { proposal_id: propQueued2.proposal_id, decided_by: 'human' }]]
);
assert(rejected.status === 'ok', 'MCP reject works', JSON.stringify(rejected).slice(0, 160));

const mcpEvents = await listEvents(pool, { namespace: NS_MCP });
const missEvents = await listEvents(pool, { namespace: 'memoryloom-learning-empty', kind: 'recall_miss' });
const mcpKinds = new Set(mcpEvents.map((e) => e.kind));
if (missEvents.length) mcpKinds.add('recall_miss (empty namespace)');
for (const kind of ['proposal', 'gate_verdict', 'recall_hit', 'human_approval', 'human_rejection']) {
  assert(mcpKinds.has(kind), `MCP landed a ${kind} event`, [...mcpKinds].join(','));
}
assert(missEvents.length === 1, 'MCP landed a recall_miss event');
assert(mcpEvents.every((e) => e.provenance?.origin === 'learning-event'), 'MCP events are provenance-stamped');

await pool.end();
console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
