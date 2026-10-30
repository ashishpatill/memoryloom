/**
 * Two-plane memory check, on dedicated namespaces of a throwaway DB:
 *  - Plane 2 rebuild: wipe the derived index, rebuild from Plane 1.
 *  - Recall receipts: every result dereferences to a live Plane-1
 *    record with provenance, or is dropped with a reason.
 *  - Deterministic decay: same state + same `now` = same strengths.
 *  - Jev keep/drop inside decay, and Jev-accepted consolidation with
 *    the merged atom written through the router (Wonder).
 *  - Triage drafting on the Wonder medium tier through the router.
 *
 * Usage: DATABASE_URL=postgres://... node checks/two-plane.mjs
 */
process.env.MEMORYLOOM_ROUTER_MODE = 'live';
process.env.JEV_TIMEOUT_MS = process.env.JEV_TIMEOUT_MS || '15000';
import pg from 'pg';
import { route } from '../router/router.mjs';
import {
  applyDecay,
  consolidateNamespace,
  embedStaged,
  recallWithReceipts,
  rebuildRecallIndex,
} from '../lib/planes.mjs';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL missing'); process.exit(1); }
const NS = 'memoryloom-planes';
const NSD = 'memoryloom-decay';
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });
let failures = 0;
function assert(cond, label, extra = '') {
  if (cond) console.log(`  PASS ${label}`);
  else { failures++; console.log(`  FAIL ${label} ${extra}`); }
}

const PROV = { author: 'planes-check', origin: 'seed', source_session: 'planes-check' };
async function seedRow(id, namespace, text, { type = 'semantic', approval = 'live', strength = 5.0, pinned = false, ageDays = 0 } = {}) {
  await pool.query(
    `INSERT INTO memories (id, namespace, type, scope, text, importance, strength, pinned,
                           index_status, approval, grounding_ids, provenance)
     VALUES ($1,$2,$3,'global',$4,5,$5,$6,'staged',$7,'{}',$8::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [id, namespace, type, text, strength, pinned, approval, JSON.stringify(PROV)]
  );
  if (ageDays) {
    await pool.query(
      `UPDATE memories SET created_at = now() - ($2 || ' days')::interval,
                           valid_from = now() - ($2 || ' days')::interval
       WHERE id = $1`,
      [id, String(ageDays)]
    );
  }
}

// ---- seed ---------------------------------------------------------------------
await pool.query(`DELETE FROM memories WHERE namespace = ANY($1)`, [[NS, NSD]]);
const T1 = 'Hybrid recall fuses a keyword ranking with a vector ranking.';
const T2 = 'Decay lowers the strength of memories that are never recalled.';
await seedRow('pl-a1', NS, T1);
await seedRow('pl-a2', NS, T1.toLowerCase());
await seedRow('pl-a3', NS, 'Hybrid recall  fuses a keyword ranking   with a vector ranking.');
await seedRow('pl-b1', NS, T2);
await seedRow('pl-b2', NS, T2.toLowerCase());
await seedRow('pl-c1', NS, 'Recall returns a receipt that cites the record id for every result.');
await seedRow('pl-r1', NS, 'An outdated note about receipts from an old layout.', { approval: 'retired' });
await seedRow('dc-stale', NSD, 'The old fairground site hosted the very first demo.', { strength: 2.0, ageDays: 200 });
await seedRow('dc-fresh', NSD, 'The team reviewed the demo script this morning.', { strength: 5.0, ageDays: 5 });
await seedRow('dc-pinned', NSD, 'The team name for the demo is MemoryLoom.', { strength: 2.0, pinned: true, ageDays: 200 });

// ---- Plane 2 rebuild ------------------------------------------------------------
console.log('plane 2 rebuild:');
const embedded = await embedStaged(pool, NS);
assert(embedded === 6, 'seed embedded 6 live rows', `got ${embedded}`);
const rb = await rebuildRecallIndex(pool, NS);
assert(rb.before.indexed === 6 && rb.after.indexed === 6 && rb.rebuilt === 6, 'index wiped and rebuilt from Plane 1', JSON.stringify(rb));

// ---- receipts ---------------------------------------------------------------------
console.log('recall receipts:');
const rc = await recallWithReceipts(pool, {
  namespace: NS,
  query: 'unused',
  candidates: ['pl-c1', 'pl-r1', 'ghost-id'],
});
assert(rc.results.length === 1 && rc.results[0].id === 'pl-c1', 'only the live record survives dereferencing', JSON.stringify(rc.dropped));
assert(rc.results[0].receipt.author === 'planes-check' && rc.results[0].receipt.origin === 'seed', 'receipt carries provenance');
assert(rc.dropped.length === 2 && rc.dropped.some((d) => d.why.includes('retired')) && rc.dropped.some((d) => d.why.includes('no Plane-1')), 'retired and ghost candidates dropped with reasons');
const rc2 = await recallWithReceipts(pool, { namespace: NS, query: 'receipt cites the record id', k: 3 });
assert(rc2.results.length >= 1 && rc2.results[0].id === 'pl-c1' && rc2.results[0].receipt.memory_id === 'pl-c1', 'hybrid recall returns receipts', JSON.stringify(rc2.results.map((r) => r.id)));

// ---- triage on Wonder medium ---------------------------------------------------------
console.log('triage (Wonder medium via router):');
const tri = await route('triage', {
  proposals: [
    { id: 'tp-1', text: 'On Tuesday the field team tested the prototype.', type: 'episodic' },
    { id: 'tp-2', text: 'The workspace key is written on a sticky note by the door.', type: 'semantic' },
    { id: 'tp-3', text: 'To reset the demo device, hold the side button for five seconds.', type: 'procedural' },
  ],
}, { synthetic: true, spendClass: 'demo_final' });
assert(tri.provider_used === 'meta' && tri.result.labels.length === 3, 'triage served by meta with 3 labels', JSON.stringify(tri.attempts).slice(0, 200));
console.log(`  triage labels: ${JSON.stringify(tri.result.labels)}`);

// ---- deterministic decay ------------------------------------------------------------
console.log('deterministic decay:');
const NOW = new Date('2026-10-30T00:00:00Z');
// align ages to the fixed clock: dc-stale created ~200d before real now;
// recompute expectations from the DB instead of assuming exact ages.
async function strengths() {
  const r = await pool.query(`SELECT id, strength FROM memories WHERE namespace = $1 ORDER BY id`, [NSD]);
  return Object.fromEntries(r.rows.map((x) => [x.id, x.strength]));
}
const snap0 = await strengths();
const dA = await applyDecay(pool, { namespace: NSD, now: NOW, halfLifeDays: 30, useJev: false });
const snapA = await strengths();
for (const [id, s] of Object.entries(snap0)) {
  await pool.query(`UPDATE memories SET strength = $2 WHERE id = $1`, [id, s]);
}
const dB = await applyDecay(pool, { namespace: NSD, now: NOW, halfLifeDays: 30, useJev: false });
const snapB = await strengths();
assert(JSON.stringify(snapA) === JSON.stringify(snapB), 'same state + same now = same decayed strengths', `${JSON.stringify(snapA)} vs ${JSON.stringify(snapB)}`);
assert(snapA['dc-fresh'] > snapA['dc-stale'], 'stale memory decayed further than fresh');
assert(snapA['dc-pinned'] === snap0['dc-pinned'], 'pinned memory never decays');
assert(dA.decayed >= 2 && dB.decayed >= 2, 'decay pass updated strengths');

// ---- decay with Jev keep/drop ----------------------------------------------------------
console.log('decay keep/drop via Jev:');
const dC = await applyDecay(pool, { namespace: NSD, now: NOW, halfLifeDays: 30, useJev: true });
const staleDecision = dC.decisions.find((d) => d.id === 'dc-stale');
assert(Boolean(staleDecision), 'stale weak memory was put to the Jev decision');
if (staleDecision) {
  assert(staleDecision.decision.backend === 'jev' && staleDecision.decision.failed === false, 'jev decision recorded', JSON.stringify(staleDecision.decision).slice(0, 200));
  assert(dC.retired.includes('dc-stale') === staleDecision.decision.drop, 'retirement matches the Jev verdict');
  console.log(`  dc-stale verdict: ${staleDecision.decision.decision} (raw ${JSON.stringify(staleDecision.decision.raw)})`);
}

// ---- consolidation ----------------------------------------------------------------------
console.log('consolidation (Jev accept + Wonder writing):');
const cons = await consolidateNamespace(pool, { namespace: NS });
assert(cons.groups_found === 2, 'two duplicate groups found', `got ${cons.groups_found}`);
assert(cons.merged.length === 2, 'both groups merged after Jev accept', JSON.stringify(cons.skipped.map((s) => s.reason)));
for (const m of cons.merged) {
  console.log(`  merged ${m.from.join('+')} -> ${m.new_id} (written by ${m.written_by})`);
  const atom = await pool.query(`SELECT provenance, approval FROM memories WHERE id = $1`, [m.new_id]);
  assert(atom.rows[0].provenance.origin === 'consolidation' && Array.isArray(atom.rows[0].provenance.merged_from), 'atom provenance carries merged_from');
  const orig = await pool.query(`SELECT count(*)::int n FROM memories WHERE id = ANY($1) AND approval = 'retired' AND merged_into = $2`, [m.from, m.new_id]);
  assert(orig.rows[0].n === m.from.length, 'originals retired and marked merged_into');
}
const rc3 = await recallWithReceipts(pool, { namespace: NS, query: 'hybrid recall keyword ranking fusion', k: 3 });
const groupA = cons.merged.find((m) => m.from.includes('pl-a1'));
assert(groupA && rc3.results.some((r) => r.id === groupA.new_id), 'post-consolidation recall returns the merged atom', JSON.stringify(rc3.results.map((r) => r.id)));
assert(groupA && rc3.results.find((r) => r.id === groupA.new_id)?.receipt.merged_from.includes('pl-a1'), 'atom receipt shows merged_from provenance');

await pool.end();
console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
