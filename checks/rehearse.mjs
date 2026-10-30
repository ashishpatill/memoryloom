/**
 * Demo rehearsal driver — the automated twin of docs/demo-script.md.
 *
 * Runs the frozen demo script end to end against a FRESH database:
 * init + seed (setup, timed separately), start the web app, then the
 * three beats exactly as scripted (propose through the Jev gate with
 * a human decision on the escalation; fresh recall with receipts and
 * a provenance trail; time travel + the learning before/after +
 * provider panel), plus the narration beat through the router in
 * live mode. Records per-beat timings, assertion results and the
 * router spend delta for the run.
 *
 * Rehearsals are capped by the credit-efficiency plan: freeze the
 * script first, then at most 3 full runs. This driver is run 1..3.
 *
 * Usage: DATABASE_URL=postgres://… node checks/rehearse.mjs <run-number>
 * Writes: checks/out/rehearsal-<n>.json
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, '..');
const runNo = Number(process.argv[2] || 1);
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL missing'); process.exit(1); }
const PORT = 4300 + runNo;
const BASE = `http://localhost:${PORT}`;
const SPEND_LOG = join(root, 'router', 'spend-log.jsonl');

const spendLines = () => readFileSync(SPEND_LOG, 'utf8').trim().split('\n').filter(Boolean).length;
const spendDelta = (fromLine) => {
  const lines = readFileSync(SPEND_LOG, 'utf8').trim().split('\n').filter(Boolean).slice(fromLine);
  const by = {};
  let total = 0;
  for (const l of lines) {
    const e = JSON.parse(l);
    if (e.cached) continue;
    by[e.provider] = (by[e.provider] || 0) + (e.est_cost_usd || 0);
    total += e.est_cost_usd || 0;
  }
  return { total_usd: Math.round(total * 1e6) / 1e6, by_provider: by, paid_calls: lines.filter((l) => !JSON.parse(l).cached).length };
};

function run(cmd, args, env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(' ')} -> ${code}: ${err.slice(-400)}`))));
  });
}

const beats = [];
let failures = 0;
async function beat(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    beats.push({ name, ms: Date.now() - t0, ok: true, detail });
    console.log(`  PASS ${name} (${Date.now() - t0}ms) ${detail || ''}`);
  } catch (e) {
    failures++;
    beats.push({ name, ms: Date.now() - t0, ok: false, detail: String(e.message || e) });
    console.log(`  FAIL ${name} (${Date.now() - t0}ms) ${e.message || e}`);
  }
}
function expect(cond, msg) { if (!cond) throw new Error(msg); }

async function api(path, opts = {}) {
  const r = await fetch(BASE + path, opts);
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
}
const post = (path, body) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// ---- setup (not part of the timed script) --------------------------------------
const spendFrom = spendLines();
const tSetup = Date.now();
await run('node', ['scripts/init-db.mjs'], { DATABASE_URL });
await run('node', ['scripts/seed-web-demo.mjs'], { DATABASE_URL });
const setupMs = Date.now() - tSetup;
console.log(`rehearsal ${runNo}: setup ${setupMs}ms (init + seed on a fresh DB)`);

const server = spawn('node', ['web/server.mjs'], {
  cwd: root,
  env: { ...process.env, DATABASE_URL, WEB_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
try {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + '/api/overview'); if (r.status === 200) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }

  let proposalId = null;
  await beat('beat1 propose: global claim with two citations is approved by the gate', async () => {
    const { j } = await post('/api/propose', {
      author: 'grok', type: 'semantic',
      text: 'The Lantern demo rig runs firmware 2.4.1 on the bench unit.',
      grounding_ids: ['demo-g2', 'demo-g3'],
    });
    expect(j.decision === 'auto_approved', `decision=${j.decision}`);
    expect(j.backend === 'jev', `backend=${j.backend}`);
    return `decision ${j.decision} via ${j.backend}`;
  });
  await beat('beat1 propose: procedural proposal escalates, human approves, it is promoted', async () => {
    const { j } = await post('/api/propose', {
      author: 'moose', type: 'procedural',
      text: 'To reset the Lantern demo rig, hold the side button for ten seconds.',
      grounding_ids: [],
    });
    expect(j.decision === 'queued_for_review', `decision=${j.decision}`);
    proposalId = j.proposal_id;
    const d = await post(`/api/proposals/${proposalId}/decide`, { decision: 'approve' });
    expect(d.j.status === 'ok' && d.j.promoted_id, `decide=${JSON.stringify(d.j).slice(0, 120)}`);
    return `escalated then promoted as ${d.j.promoted_id.slice(0, 8)}…`;
  });
  await beat('beat2 recall: fresh-session recall returns the firmware answer with receipts', async () => {
    const { j } = await api('/api/recall?q=' + encodeURIComponent('which firmware does the bench unit run') + '&k=5');
    const ids = j.results.map((r) => r.id);
    expect(ids.includes('demo-g2') && ids.includes('demo-g4'), `ids=${ids.join(',')}`);
    expect(j.results.every((r) => r.receipt && r.receipt.memory_id === r.id), 'a result lacks a matching receipt');
    return `${j.results.length} results, every one receipted`;
  });
  await beat('beat2 trail: the receipt dereferences to a provenance trail', async () => {
    const { status, j } = await api('/api/trail/demo-g4');
    expect(status === 200 && j.memory && j.memory.id === 'demo-g4', `status=${status}`);
    return 'trail for demo-g4 resolved';
  });
  await beat('beat3 time travel: Hall A on 12 Oct, Hall B on 25 Oct', async () => {
    const a = await api('/api/believed?at=2026-10-12T00:00:00Z');
    const b = await api('/api/believed?at=2026-10-25T00:00:00Z');
    const aIds = a.j.map((r) => r.id), bIds = b.j.map((r) => r.id);
    expect(aIds.includes('demo-v1') && !aIds.includes('demo-v2'), 'Oct 12 beliefs wrong');
    expect(bIds.includes('demo-v2'), 'Oct 25 beliefs wrong');
    return 'beliefs differ across the supersession, as designed';
  });
  await beat('beat3 learning: the before/after gate story is on record', async () => {
    const { j } = await api('/api/learning');
    const seq = (j.before_after.verdicts || []).map((v) => v.decision && v.decision.decision);
    expect(seq.includes('escalate') && seq.includes('approve'), `verdicts=${seq.join(',')}`);
    expect((j.lessons || []).length >= 1, 'no standing lesson');
    expect((j.audit.forged_lesson_ids || []).length === 0, 'forged lessons present');
    return `verdicts ${seq.join(' -> ')}; ${j.lessons.length} lesson standing`;
  });
  await beat('beat3 providers: the panel shows the work each provider did', async () => {
    const { j } = await api('/api/spend');
    expect(j.jev_decisions_in_namespace >= 1, 'no Jev decisions recorded');
    expect((j.router || []).length >= 1, 'router panel empty');
    return `${j.jev_decisions_in_namespace} Jev decisions in namespace, ${j.router.length} router rows`;
  });
} finally {
  server.kill('SIGTERM');
}

let narration = null;
await beat('narration: the router narrates the recall with receipts (live mode)', async () => {
  const out = await run('node', ['scripts/narrate-demo.mjs'], { DATABASE_URL, MEMORYLOOM_ROUTER_MODE: 'live' });
  narration = JSON.parse(out);
  expect(narration.receipts.includes('demo-g2'), `receipts=${narration.receipts.join(',')}`);
  return `provider ${narration.provider_used}${narration.cached ? ' (cached)' : ''}, receipts ${narration.receipts.join(', ')}`;
});

const totalMs = beats.reduce((a, b) => a + b.ms, 0);
const spend = spendDelta(spendFrom);
const record = {
  run: runNo, at: new Date().toISOString(), setup_ms: setupMs,
  beats, beats_total_ms: totalMs, failures, narration, spend_delta: spend,
};
mkdirSync(join(__dir, 'out'), { recursive: true });
writeFileSync(join(__dir, 'out', `rehearsal-${runNo}.json`), JSON.stringify(record, null, 2));
console.log(`rehearsal ${runNo}: ${beats.filter((b) => b.ok).length}/${beats.length} beats ok, beats total ${totalMs}ms, spend delta $${spend.total_usd} (${spend.paid_calls} paid calls)`);
process.exit(failures ? 1 : 0);
