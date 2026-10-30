/**
 * Web check — the site + console API against a fresh database.
 *
 * Boots the real server (web/server.mjs) on an ephemeral port,
 * seeded by the documented path (scripts/seed-web-demo.mjs), and
 * asserts the flows the console renders: overview, graph, the
 * propose inbox, a live propose through the real Jev gate, a human
 * decision, recall with receipts, time travel both sides of a
 * supersession, provenance trail, supersession chain, the learning
 * story, the provider panel, and the API-level empty states.
 *
 *   DATABASE_URL=postgres://… npm run check:web
 * (run scripts/init-db.mjs against the same URL first)
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL missing'); process.exit(1); }

let failures = 0;
function assert(cond, label, extra = '') {
  if (cond) console.log(`  PASS ${label}`);
  else { failures++; console.log(`  FAIL ${label} ${extra}`); }
}
const run = (cmd, args, env = {}) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${out.slice(-400)}`))));
});

// Seed through the documented path.
await run(process.execPath, ['scripts/seed-web-demo.mjs'], { DATABASE_URL });

const PORT = 4300 + Math.floor(Math.random() * 400);
const server = spawn(process.execPath, ['web/server.mjs'], {
  cwd: root,
  env: { ...process.env, DATABASE_URL, WEB_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const base = `http://localhost:${PORT}`;
async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(base + '/api/overview'); if (r.ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server did not come up');
}
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json().catch(() => null), text: '' }; };
const getText = async (p) => { const r = await fetch(base + p); return { status: r.status, text: await r.text() }; };
const post = async (p, body) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

try {
  await waitUp();

  const home = await getText('/');
  assert(home.status === 200 && home.text.includes('MemoryLoom'), 'site home serves');
  const consolePage = await getText('/console');
  assert(consolePage.status === 200 && consolePage.text.includes('console-nav'), 'console page serves');

  const ov = await get('/api/overview');
  assert(ov.body.namespace === 'memoryloom-demo', 'overview namespace is the demo namespace');
  assert(ov.body.agents.includes('grok') && ov.body.agents.includes('moose'), 'overview lists both demo agents');
  const memTotal = ov.body.memories_by_type.reduce((a, r) => a + r.n, 0);
  assert(memTotal >= 13, 'overview counts the corpus memories', `got ${memTotal}`);

  const graph = await get('/api/graph');
  const kinds = new Set(graph.body.nodes.map((n) => n.kind));
  assert(kinds.has('agent') && kinds.has('memory') && kinds.has('source'), 'graph has agent, memory and source nodes');
  assert(graph.body.edges.some((e) => e.type === 'supersedes'), 'graph has a supersession edge');
  assert(graph.body.edges.some((e) => e.type === 'contradicts'), 'graph has a contradiction edge');

  const props = await get('/api/proposals');
  const p2 = props.body.proposals.find((p) => p.id === 'demo-p2');
  assert(p2 && p2.status === 'pending', 'fixture escalation demo-p2 waits in the inbox');

  const rec = await get('/api/recall?q=' + encodeURIComponent('what firmware does the rig run'));
  const g4 = rec.body.results.find((r) => r.id === 'demo-g4');
  assert(Boolean(g4), 'recall returns the firmware memory');
  assert(g4 && g4.receipt && g4.receipt.grounding_ids.length === 2, 'the receipt names both grounding records');

  const b12 = await get('/api/believed?at=2026-10-12T00:00:00Z');
  assert(b12.body.some((r) => r.id === 'demo-v1') && !b12.body.some((r) => r.id === 'demo-v2'), 'believed on Oct 12: Hall A held, Hall B not yet');
  const b25 = await get('/api/believed?at=2026-10-25T00:00:00Z');
  assert(b25.body.some((r) => r.id === 'demo-v2') && !b25.body.some((r) => r.id === 'demo-v1'), 'believed on Oct 25: Hall B held, Hall A expired');
  const bEmpty = await get('/api/believed?at=2026-01-01T00:00:00Z');
  assert(Array.isArray(bEmpty.body) && bEmpty.body.length === 0, 'believed before the corpus: honest empty set');

  const trail = await get('/api/trail/demo-g4');
  assert(trail.body.grounding.length === 2, 'trail for the firmware memory lists its two grounding records');
  assert(trail.body.decisions.length >= 1, 'trail carries the decision record');
  const chain = await get('/api/chain/demo-v2');
  assert(Array.isArray(chain.body) && chain.body.length === 2 && chain.body[0].id === 'demo-v1' && chain.body[1].id === 'demo-v2', 'supersession chain runs Hall A → Hall B');
  const hood = await get('/api/neighbourhood/nobody');
  assert(hood.body.found === false, 'unknown agent neighbourhood: found=false (empty state)');

  const learn = await get('/api/learning');
  assert(learn.body.lessons.length === 1, 'exactly one gate-promoted lesson stands');
  assert(learn.body.audit.forged_lesson_ids.length === 0, 'no forged lessons in the seeded story');
  const decisions = learn.body.before_after.verdicts.map((v) => v.decision?.decision);
  assert(decisions.includes('escalate') && decisions[decisions.length - 1] === 'approve', 'before/after verdicts run escalate → approve', JSON.stringify(decisions));

  const spend = await get('/api/spend');
  assert(spend.body.budgets_usd.meta.total === 150, 'provider panel carries the Meta budget');
  assert(spend.body.router.every((r) => ['meta', 'jev'].includes(r.provider)), 'spend panel lists only providers that did work (meta + jev)', JSON.stringify([...new Set(spend.body.router.map((r) => r.provider))]));
  assert(spend.body.router.some((r) => r.provider === 'jev' && r.task === 'gate_decision'), 'gate decisions appear in the spend log as jev rows');
  assert(spend.body.jev_decisions_in_namespace >= 1, 'gate verdicts are counted in the namespace');

  // The live loop, end to end through the API.
  const escalate = await post('/api/propose', { author: 'grok', type: 'semantic', text: 'The Lantern demo rig charges from a 240 watt supply.', grounding_ids: [] });
  assert(escalate.body.decision === 'queued_for_review', 'ungrounded claim escalates through the real gate', JSON.stringify(escalate.body).slice(0, 160));
  const decide = await post(`/api/proposals/${escalate.body.proposal_id}/decide`, { decision: 'approve' });
  assert(decide.body.status === 'ok' && decide.body.decision === 'approved', 'human approval promotes the escalated proposal', JSON.stringify(decide.body).slice(0, 160));
  const approve = await post('/api/propose', { author: 'moose', type: 'semantic', text: 'The Lantern demo rig runs firmware 2.4.1 on the bench unit.', grounding_ids: ['demo-g2', 'demo-g3'] });
  assert(approve.body.decision === 'auto_approved', 'grounded claim is auto-approved by the gate', JSON.stringify(approve.body).slice(0, 160));

  const missing = await fetch(base + '/api/nope');
  assert(missing.status === 404, 'unknown API route returns 404');
} finally {
  server.kill('SIGTERM');
}

console.log(failures ? `\n${failures} FAILURES` : '\nALL GREEN');
process.exit(failures ? 1 : 0);
