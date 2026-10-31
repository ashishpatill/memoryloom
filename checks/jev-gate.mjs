/**
 * Jev decision layer check.
 *
 * Part 1 — live decision shapes: decideGate + the consolidation,
 * decay and promotion hooks return Jev provenance records.
 * Part 2 — FAIL CLOSED: with the Jev base URL pointed at a dead host,
 * every decision function returns its safe branch (escalate / keep /
 * do not promote) with failed=true, and the MCP write gate queues the
 * proposal instead of storing it.
 * Part 3 — MCP wiring: with MEMORYLOOM_GATE_BACKEND=jev, propose is
 * decided by Jev (needs DATABASE_URL, throwaway DB).
 *
 * Usage: DATABASE_URL=postgres://... node checks/jev-gate.mjs
 */
process.env.JEV_TIMEOUT_MS = process.env.JEV_TIMEOUT_MS || '8000';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { decideGate, decideConsolidation, decideDecayDrop, decidePromotion } from '../lib/gate.mjs';
import { thresholdsLive } from '../lib/jev.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function assert(cond, label, extra = '') {
  if (cond) console.log(`  PASS ${label}`);
  else { failures++; console.log(`  FAIL ${label} ${extra}`); }
}
const nonce = Date.now();

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

// ---- Part 3: MCP wiring --------------------------------------------------------
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.log('part 3 skipped: DATABASE_URL missing');
} else {
  console.log('part 3: MCP propose with the Jev backend:');
  const NS = 'memoryloom-jev';
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
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
  const [jevApprove, jevQueue] = await runMcp({ MEMORYLOOM_GATE_BACKEND: 'jev' }, [
    ['propose', { namespace: NS, text: 'On Tuesday the field team tested the prototype in a community hall.', metadata: { type: 'episodic', author: 'jev-check' } }],
    ['propose', { namespace: NS, text: 'The moon base opens to visitors in 2027.', metadata: { type: 'semantic', author: 'jev-check' } }],
  ]);
  if (live) {
    assert(jevApprove.decision === 'auto_approved' && jevApprove.backend === 'jev', 'jev backend approves episodic through MCP', JSON.stringify(jevApprove).slice(0, 160));
  } else {
    assert(jevApprove.decision === 'queued_for_review', 'shadow mode queues even approve-class proposals', JSON.stringify(jevApprove).slice(0, 160));
  }
  assert(jevQueue.decision === 'queued_for_review' && jevQueue.reason === 'jev-escalate', 'ungrounded claim escalates to the queue', JSON.stringify(jevQueue).slice(0, 160));
  const [jevFake] = await runMcp({ MEMORYLOOM_GATE_BACKEND: 'jev' }, [
    ['propose', { namespace: NS, text: 'The Lantern demo rig runs firmware 2.4.1 on the bench unit.', metadata: { type: 'semantic', author: 'jev-check', grounding_ids: ['demo-does-not-exist', 'demo-also-fake-99'] } }],
  ]);
  assert(jevFake.decision === 'queued_for_review', 'fabricated citations escalate through MCP propose (jev backend)', JSON.stringify(jevFake).slice(0, 160));
  const fakeStored = await pool.query(`SELECT count(*)::int n FROM memories WHERE namespace = $1 AND text LIKE 'The Lantern demo rig runs firmware%'`, [NS]);
  assert(fakeStored.rows[0].n === 0, 'fabricated-citation proposal is not in the truth store');
  // Scoped to the moon-base proposal: since 5.3 the fabricated-
  // citation propose below is a second jev-escalate row in this
  // namespace, so a bare count of escalate rows is no longer 1.
  const prov = await pool.query(`SELECT provenance FROM proposals WHERE namespace = $1 AND route_reason = 'jev-escalate' AND text LIKE 'The moon base%'`, [NS]);
  assert(prov.rows.length === 1 && prov.rows[0].provenance.jev?.backend === 'jev', 'jev score persisted in proposal provenance');

  const [deadOut] = await runMcp({ MEMORYLOOM_GATE_BACKEND: 'jev', JEV_BASE_URL: 'https://api.typesafe.ai.invalid', JEV_TIMEOUT_MS: '8000' }, [
    ['propose', { namespace: NS, text: 'On Friday the field team packed the demo kit.', metadata: { type: 'episodic', author: 'jev-check' } }],
  ]);
  assert(deadOut.decision === 'queued_for_review' && deadOut.reason === 'jev-unavailable-fail-closed', 'dead Jev backend queues, never stores', JSON.stringify(deadOut).slice(0, 160));
  const stored = await pool.query(`SELECT count(*)::int n FROM memories WHERE namespace = $1 AND text LIKE 'On Friday%'`, [NS]);
  assert(stored.rows[0].n === 0, 'fail-closed proposal is not in the truth store');
  await pool.end();
}

console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
