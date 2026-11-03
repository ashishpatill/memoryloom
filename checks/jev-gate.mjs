/**
 * Jev decision layer check.
 *
 * Part 1 — live decision shapes: decideGate + the consolidation,
 * decay and promotion hooks return Jev provenance records.
 * Part 2 — FAIL CLOSED: with the Jev base URL pointed at a dead host,
 * every decision function returns its safe branch (escalate / keep /
 * do not promote) with failed=true, and the MCP write gate queues the
 * proposal instead of storing it.
 * Part 2b — FAIL CLOSED, NO KEY, WARM CACHE (5.3 re-review, Finding
 * D): a payload whose verdict already sits in the content-hash cache
 * must STILL fail closed once no key is configured anywhere — the
 * cache is never consulted before the key check.
 * Part 3 — MCP wiring: propose is decided by Jev whenever a Jev
 * key is configured, with no opt-in switch (card S3a). Needs
 * DATABASE_URL, throwaway DB.
 * Part 4 — the Jev budget (card S3b): the shared $5 pool entry,
 * the entry check, the cap test, the combined stop test, the per
 * iteration blocking test, the per iteration report test and the
 * spend class threading test.
 *
 * Usage: DATABASE_URL=postgres://... node checks/jev-gate.mjs
 * Owning file: checks/jev-gate.mjs
 * Accountable layer: Decision layer in lib/jev.mjs, lib/decisions.mjs and router/router.mjs
 * Provider need: Live Jev for part 1 claims, stub Jev for verify run shapes, none for the fail closed parts
 * Declared mode: Stub in the verify entry, live only inside its owning cards
 */
process.env.JEV_TIMEOUT_MS = process.env.JEV_TIMEOUT_MS || '8000';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { decideGate, decideConsolidation, decideDecayDrop, decidePromotion } from '../lib/gate.mjs';
import {
  thresholdsLive,
  jevEvaluate,
  jevBudgetEntry,
  jevBudgetBlock,
  jevIterationReport,
  JevError,
} from '../lib/jev.mjs';
import { readSpendLog } from '../router/spend.mjs';
import { preflightDbOrExit, preflightStoreOnly } from './db-preflight.mjs';

preflightStoreOnly();

const __dir = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function assert(cond, label, extra = '') {
  if (cond) console.log(`  PASS ${label}`);
  else { failures++; console.log(`  FAIL ${label} ${extra}`); }
}
const nonce = Date.now();
// The base URL this suite was started with. Part 2 points the
// variable at a dead host and deletes it, so Part 4 restores the
// starting value before its in-process calls (card S3b).
const SUITE_JEV_BASE_URL = process.env.JEV_BASE_URL;

// ---- Part 1: live shapes ----------------------------------------------------
console.log(`part 1: live Jev decision shapes (thresholds_live=${thresholdsLive()}):`);
const g = await decideGate({
  proposal: { text: `On Tuesday the field team tested the prototype in a community hall. (${nonce})`, type: 'episodic' },
  evidence: [],
});
assert(g.backend === 'jev' && g.failed === false, 'gate returns a Jev record', JSON.stringify(g).slice(0, 200));
assert(g.raw && g.calibrated && typeof g.raw.policy_approve === 'number', 'gate scores recorded as provenance');
assert(
  thresholdsLive() ? g.decision === 'approve' : g.decision === 'escalate' && g.shadow_decision === 'approve',
  thresholdsLive() ? 'episodic approves with live thresholds' : 'shadow mode escalates but records the would-be approve',
  JSON.stringify({ decision: g.decision, shadow: g.shadow_decision })
);
const cons = await decideConsolidation({
  records: [
    { id: 'jc-1', text: 'Hybrid recall fuses a keyword ranking with a vector ranking.' },
    { id: 'jc-2', text: 'hybrid recall fuses a keyword ranking with a vector ranking.' },
  ],
});
assert(cons.backend === 'jev' && cons.failed === false && typeof cons.accept === 'boolean', 'consolidation hook returns a Jev record');
const dec = await decideDecayDrop({
  memory: { id: 'jd-1', text: 'An old fairground hosted the first demo.', type: 'episodic', strength: 0.4 },
  stats: { age_days: 300, days_since_recall: null, recall_count: 0 },
});
assert(dec.backend === 'jev' && dec.failed === false && typeof dec.drop === 'boolean', 'decay hook returns a Jev record');
const prom = await decidePromotion({
  event: { summary: 'Receipts on recall results make errors easy to spot.', evidence: 'Applied in three review sessions; each time the bad result was traced in under a minute.', times_applied: 3, verified: true },
});
assert(prom.backend === 'jev' && prom.failed === false && typeof prom.promote === 'boolean', 'promotion hook returns a Jev record');

// ---- Part 1b: fabricated citations never satisfy the evidence rule ----------
// Iteration 5.3, Finding A: the structural min-evidence rule counts
// records that resolve, not id strings. Two invented ids with no
// evidence records behind them must escalate on structure alone,
// whatever the scorer says.
console.log('part 1b: fabricated citations (5.3 regression):');
const gFake = await decideGate({
  proposal: { text: `The Lantern demo rig runs firmware 2.4.1 on the bench unit. (${nonce}-fake)`, type: 'semantic', scope: 'global', grounding_ids: ['demo-does-not-exist', 'demo-also-fake-99'] },
  evidence: [],
});
assert(gFake.decision === 'escalate', 'fabricated citations escalate through the gate', JSON.stringify(gFake).slice(0, 200));
assert(gFake.grounding_resolved === 0 && gFake.grounding_cited === 2, 'gate records cited=2, resolved=0 for fabricated citations', JSON.stringify({ cited: gFake.grounding_cited, resolved: gFake.grounding_resolved }));

// ---- Part 2: fail closed on a dead backend -----------------------------------
console.log('part 2: fail-closed with a dead Jev backend:');
process.env.JEV_BASE_URL = 'https://api.typesafe.ai.invalid';
const gDead = await decideGate({
  proposal: { text: `A grounded claim that must not slip through. (${nonce}-dead)`, type: 'semantic', grounding_ids: ['a', 'b'] },
  evidence: [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }],
});
assert(gDead.failed === true && gDead.fail_closed === true && gDead.decision === 'escalate', 'gate escalates on backend failure', JSON.stringify(gDead).slice(0, 200));
const consDead = await decideConsolidation({ records: [{ id: 'jx-1', text: `Same fact ${nonce}` }, { id: 'jx-2', text: `Same fact ${nonce}` }] });
assert(consDead.failed === true && consDead.accept === false, 'consolidation keeps originals on backend failure');
const decDead = await decideDecayDrop({ memory: { id: 'jx-3', text: 'stale', strength: 0.1 }, stats: { age_days: 999 } });
assert(decDead.failed === true && decDead.drop === false, 'decay keeps the memory on backend failure');
const promDead = await decidePromotion({ event: { summary: `lesson ${nonce}`, verified: true, times_applied: 5 } });
assert(promDead.failed === true && promDead.promote === false, 'promotion does not promote on backend failure');
delete process.env.JEV_BASE_URL;

// ---- Part 2b: no key + warm cache still fails closed -------------------------
console.log('part 2b: unconfigured with a warm cache (5.3 regression):');
const warmProposal = {
  proposal: { text: `On Tuesday the field team tested the prototype in a community hall. (${nonce})`, type: 'episodic' },
  evidence: [],
};
const gWarm = await decideGate(warmProposal);
assert(gWarm.failed === false && gWarm.cached === true, 'repeat decision is served from cache while configured, and says so', JSON.stringify({ failed: gWarm.failed, cached: gWarm.cached }));
const prevSettingsFile = process.env.MEMORYLOOM_SETTINGS_FILE;
const prevTypesafeKey = process.env.TYPESAFE_API_KEY;
const emptyStore = join(tmpdir(), `ml-jev-empty-store-${nonce}.env`);
writeFileSync(emptyStore, '', { mode: 0o600 });
process.env.MEMORYLOOM_SETTINGS_FILE = emptyStore;
delete process.env.TYPESAFE_API_KEY;
const gNoKey = await decideGate(warmProposal);
assert(gNoKey.failed === true && gNoKey.fail_closed === true && gNoKey.decision === 'escalate', 'same payload fails closed with no key configured, cache notwithstanding', JSON.stringify(gNoKey).slice(0, 200));
if (prevSettingsFile === undefined) delete process.env.MEMORYLOOM_SETTINGS_FILE;
else process.env.MEMORYLOOM_SETTINGS_FILE = prevSettingsFile;
if (prevTypesafeKey !== undefined) process.env.TYPESAFE_API_KEY = prevTypesafeKey;

// ---- Part 3: MCP wiring --------------------------------------------------------
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.log('part 3 skipped: DATABASE_URL missing');
} else {
  preflightDbOrExit();
  console.log('part 3: MCP propose with the Jev backend:');
  const NS = 'memoryloom-jev';
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
  // Request records go too (card S3b). Part 3 reuses fixed request
  // ids, and a stored first result from an earlier run against the
  // same database would replay instead of writing a fresh proposal.
  await pool.query(`DELETE FROM file_chunks WHERE proposal_id IN (SELECT id FROM proposals WHERE namespace = $1)`, [NS]);
  await pool.query(`DELETE FROM request_records WHERE namespace = $1`, [NS]);
  await pool.query(`DELETE FROM proposals WHERE namespace = $1`, [NS]);
  await pool.query(`DELETE FROM memories WHERE namespace = $1`, [NS]);

  async function runMcp(env, calls) {
    const srv = spawn('node', [join(__dir, '..', 'mcp', 'index.mjs')], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let reqId = 0;
    const pending = new Map();
    let buf = '';
    srv.stdout.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id != null && pending.has(msg.id)) { const { resolve } = pending.get(msg.id); pending.delete(msg.id); resolve(msg); }
      }
    });
    const rpc = (method, params) => new Promise((resolve) => {
      const id = ++reqId; pending.set(id, { resolve });
      srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'jev-check', version: '1' } });
    srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
    const out = [];
    for (const [name, args] of calls) {
      const res = await rpc('tools/call', { name, arguments: args });
      out.push(JSON.parse(res.result.content[0].text));
    }
    srv.kill();
    return out;
  }

  const live = thresholdsLive();
  const [jevApprove, jevQueue] = await runMcp({}, [
    ['propose', { namespace: NS, text: 'On Tuesday the field team tested the prototype in a community hall.', request_id: 'jev-p3-1', metadata: { type: 'episodic', author: 'jev-check' } }],
    ['propose', { namespace: NS, text: 'The moon base opens to visitors in 2027.', request_id: 'jev-p3-2', metadata: { type: 'semantic', author: 'jev-check' } }],
  ]);
  if (live) {
    assert(jevApprove.decision === 'auto_approved' && jevApprove.backend === 'jev', 'jev backend approves episodic through MCP', JSON.stringify(jevApprove).slice(0, 160));
  } else {
    assert(jevApprove.decision === 'queued_for_review', 'shadow mode queues even approve-class proposals', JSON.stringify(jevApprove).slice(0, 160));
  }
  assert(jevQueue.decision === 'queued_for_review' && jevQueue.reason === 'jev-escalate', 'ungrounded claim escalates to the queue', JSON.stringify(jevQueue).slice(0, 160));
  const [jevFake] = await runMcp({}, [
    ['propose', { namespace: NS, text: 'The Lantern demo rig runs firmware 2.4.1 on the bench unit.', request_id: 'jev-p3-3', metadata: { type: 'semantic', author: 'jev-check', grounding_ids: ['demo-does-not-exist', 'demo-also-fake-99'] } }],
  ]);
  assert(jevFake.decision === 'queued_for_review', 'fabricated citations escalate through MCP propose (jev backend)', JSON.stringify(jevFake).slice(0, 160));
  const fakeStored = await pool.query(`SELECT count(*)::int n FROM memories WHERE namespace = $1 AND text LIKE 'The Lantern demo rig runs firmware%'`, [NS]);
  assert(fakeStored.rows[0].n === 0, 'fabricated-citation proposal is not in the truth store');
  // Scoped to the moon-base proposal: since 5.3 the fabricated-
  // citation propose below is a second jev-escalate row in this
  // namespace, so a bare count of escalate rows is no longer 1.
  const prov = await pool.query(`SELECT provenance FROM proposals WHERE namespace = $1 AND route_reason = 'jev-escalate' AND text LIKE 'The moon base%'`, [NS]);
  assert(prov.rows.length === 1 && prov.rows[0].provenance.jev?.backend === 'jev', 'jev score persisted in proposal provenance');

  const [deadOut] = await runMcp({ JEV_BASE_URL: 'https://api.typesafe.ai.invalid', JEV_TIMEOUT_MS: '8000' }, [
    ['propose', { namespace: NS, text: 'On Friday the field team packed the demo kit.', request_id: 'jev-p3-4', metadata: { type: 'episodic', author: 'jev-check' } }],
  ]);
  assert(deadOut.decision === 'queued_for_review' && deadOut.reason === 'jev-unavailable-fail-closed', 'dead Jev backend queues, never stores', JSON.stringify(deadOut).slice(0, 160));
  const stored = await pool.query(`SELECT count(*)::int n FROM memories WHERE namespace = $1 AND text LIKE 'On Friday%'`, [NS]);
  assert(stored.rows[0].n === 0, 'fail-closed proposal is not in the truth store');
  await pool.end();
}

// ---- Part 4: the Jev budget (card S3b) --------------------------------------
// The budget entry stands in the router config as one shared pool
// of $5 across the gate_calibration, product and drill classes,
// with a per iteration cap of $1. The client checks the budget
// before a paid call and fails closed at the cap, and its own
// entry check rejects a class outside the entry. The cap cases
// run against synthetic spend rows through the client's test
// seam, so no fake rows enter the real spend log.
console.log('part 4: Jev budget entry, caps and class threading:');
if (SUITE_JEV_BASE_URL) process.env.JEV_BASE_URL = SUITE_JEV_BASE_URL;
const entry = jevBudgetEntry();
assert(entry && entry.total === 5 && entry.per_iteration_cap === 1, 'the Jev budget entry stands with a $5 pool and a $1 per iteration cap', JSON.stringify(entry));
assert(entry && ['drill', 'gate_calibration', 'product'].every((c) => c in entry.classes), 'the pool classes are gate_calibration, product and drill');
// The entry check rejects a class outside the entry, at the
// client directly and through the gate, which fails closed.
let entryThrew = false;
try {
  await jevEvaluate('entry_check', 'state', {}, { spendClass: 'not-a-class' });
} catch (e) {
  entryThrew = e instanceof JevError;
}
assert(entryThrew, 'the entry check rejects a spend class outside the budget entry (card S3b)');
const badClass = await decideGate({
  proposal: { text: `On Saturday the field team checked the budget entry. (${nonce})`, type: 'episodic' },
  evidence: [],
  spendClass: 'not-a-class',
});
assert(badClass.failed === true && badClass.decision === 'escalate', 'a class outside the entry fails the gate closed (card S3b)', JSON.stringify(badClass).slice(0, 200));
// The cap test. Rows at the pool total block the next call, and
// rows just under it do not.
const rowAt = (cls, cost, iteration = null) => ({
  provider: 'jev', spend_class: cls, est_cost_usd: cost, cached: false, iteration,
});
assert(jevBudgetBlock({}, [rowAt('product', 5)]) !== null, 'the cap test: spend at the $5 pool total blocks (card S3b)');
assert(jevBudgetBlock({}, [rowAt('product', 4.99)]) === null, 'spend under the pool total proceeds');
// The combined stop test. Two classes together reach the pool
// total and stop, though neither class reaches it alone.
assert(
  jevBudgetBlock({}, [rowAt('gate_calibration', 2.5), rowAt('product', 2.5)]) !== null,
  'the combined stop test: two classes together stop at the $5 pool total (card S3b)'
);
assert(
  jevBudgetBlock({}, [rowAt('gate_calibration', 2.5), rowAt('product', 2.4)]) === null,
  'two classes under the pool total together proceed'
);
// The blocking test at the per iteration cap. One iteration at
// its $1 total is blocked while another iteration is not.
const iterRows = [rowAt('product', 1, 'cap-iter-a'), rowAt('drill', 0.5, 'cap-iter-b')];
assert(jevBudgetBlock({ iteration: 'cap-iter-a' }, iterRows) !== null, 'the blocking test: an iteration at its $1 cap is blocked (card S3b)');
assert(jevBudgetBlock({ iteration: 'cap-iter-b' }, iterRows) === null, 'an iteration under its cap proceeds');
// The per iteration report test. The report names the iteration
// and its total against the $1 cap.
const reportA = jevIterationReport('cap-iter-a', iterRows);
assert(reportA.iteration === 'cap-iter-a' && reportA.total_usd === 1 && reportA.cap_usd === 1 && reportA.within_cap === false,
  'the per iteration report test: the report names the iteration and its total against the cap (card S3b)', JSON.stringify(reportA));
const reportB = jevIterationReport('cap-iter-b', iterRows);
assert(reportB.total_usd === 0.5 && reportB.within_cap === true, 'the per iteration report shows an iteration inside its cap');
// The threading test. One real decision under a named class and a
// named iteration, and every spend row it produces, the paid row
// and the cached row on the repeat, carries that class and that
// iteration.
const threadClass = 'gate_calibration';
const threadIter = 'jev-gate-part-4';
const beforeRows = readSpendLog().length;
const threadText = `On Sunday the field team threaded the spend class through the gate. (${nonce})`;
const t1 = await decideGate({
  proposal: { text: threadText, type: 'episodic' },
  evidence: [],
  spendClass: threadClass,
  iteration: threadIter,
});
assert(t1.backend === 'jev' && t1.failed === false, 'the threading decision ran on the Jev backend', JSON.stringify(t1).slice(0, 160));
const t2 = await decideGate({
  proposal: { text: threadText, type: 'episodic' },
  evidence: [],
  spendClass: threadClass,
  iteration: threadIter,
});
assert(t2.cached === true, 'the repeated threading decision is served from the cache');
const newJevRows = readSpendLog().slice(beforeRows).filter((r) => r.provider === 'jev');
assert(newJevRows.length === 2, 'the threading decision produced a paid row and a cached row', `got ${newJevRows.length}`);
assert(newJevRows.every((r) => r.spend_class === threadClass), 'every spend row of the decision carries the named class (card S3b)', JSON.stringify(newJevRows.map((r) => r.spend_class)));
assert(newJevRows.every((r) => r.iteration === threadIter), 'every spend row of the decision carries the iteration identity (card S3b)', JSON.stringify(newJevRows.map((r) => r.iteration)));
assert(newJevRows.some((r) => r.cached === true) && newJevRows.some((r) => r.cached === false), 'the cached row and the paid row both carry the class');

console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
