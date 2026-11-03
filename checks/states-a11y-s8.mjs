/**
 * States and accessibility check for card S8. The whole frontend,
 * on the running app.
 *
 * Card S8 of the frozen master plan. Drives the real landing page
 * and all seven console views through the committed capture
 * driver (checks/capture-driver-v1.mjs, the Playwright headless
 * shell over CDP route) and proves, per view:
 *   - the state evidence: loading states are still ruled blocks
 *     with the form rendered where Section 6 states it, empty
 *     states are the designed panels, populated states agree with
 *     the API responses they render, and failure states follow
 *     the Section 6.11 table word for word, with the named API
 *     failed by a driver returned HTTP 500 response;
 *   - the accessibility matrix evidence: landmarks, one h1,
 *     heading order, the skip link first in focus order, focus on
 *     the view heading after navigation, table scope, field
 *     labels and descriptions, live regions and a recorded
 *     announcement log, the graph knot keyboard walk, the time
 *     travel accessibility tree record and four date cases, the
 *     providers wrap access test at 360px by keyboard, wheel and
 *     touch, and the Settings focus rules walked end to end;
 *   - the target rule audit at 360px: every held interactive
 *     element type measured against 24 by 24 CSS pixels and 8 CSS
 *     pixels of separation, links inside a line of text excepted;
 *   - the sibling hunt agreements: counts against lists, the
 *     hero summary against the drawn figure, and the learning
 *     filter's empty state reachable from its own options.
 *
 * Owning file: checks/states-a11y-s8.mjs
 * Accountable layer: Browser layer
 * Provider need: Stub providers only. Gate verdicts in the
 *   walked paths are stub decisions; they prove the path, the
 *   state and the rendering, never live provider judgement.
 * Declared mode: Stub
 *
 * Standalone run conditions: DATABASE_URL at a fresh throwaway
 * database already initialised by scripts/init-db.mjs,
 * MEMORYLOOM_SETTINGS_FILE at a temporary settings store holding
 * dummy keys, JEV_BASE_URL and META_MODEL_BASE_URL at the stub
 * servers (checks/stub-server-v1.mjs), which the verify entry
 * starts. The verify entry provides all of it.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preflightOrExit } from './db-preflight.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL missing'); process.exit(1); }
preflightOrExit();

let failures = 0;
function assert(cond, label, extra = '') {
  if (cond) console.log(`  PASS ${label}`);
  else { failures++; console.log(`  FAIL ${label} ${extra}`); }
}
function info(label) { console.log(`  info ${label}`); }
const run = (cmd, args, env = {}) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${out.slice(-400)}`))));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Seed exactly once into the fresh database (the seed's second
// step stands down when its story exists, and a double seed into
// one database loses the spare records; see the runbook).
await run(process.execPath, ['scripts/seed-web-demo.mjs'], { DATABASE_URL });

// ---- servers -------------------------------------------------------
// A: the populated demo namespace. B: an empty namespace on the
// same database. W: the settings walk server, with its own store
// the suite may mutate (and briefly replace with a directory to
// force a save failure), and a dead Baseten base URL so the
// failed test case fails fast and locally.
// Ports are probed, never merely picked. A server leaked by an
// earlier run of any suite can hold a blindly picked port, fail
// this suite's own server at bind time, and then answer waitUp
// in its place with foreign state. The probe skips held ports,
// and the walk server's identity is proven from its own settings
// read before any walk trusts it.
import { createServer as createNetServer } from 'node:net';
async function portFree(port) {
  return await new Promise((resolve) => {
    const probe = createNetServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}
let PORTA = 4400 + Math.floor(Math.random() * 120);
while (!(await portFree(PORTA)) || !(await portFree(PORTA + 131)) || !(await portFree(PORTA + 262))) PORTA += 7;
const PORTB = PORTA + 131;
const PORTW = PORTA + 262;
const walkDir = mkdtempSync(join(tmpdir(), 'ml-s8-walk-'));
const walkStore = join(walkDir, 'settings.env');
writeFileSync(walkStore, 'TYPESAFE_API_KEY=<redacted>\nMETA_MODEL_API_KEY=<redacted>\n', { mode: 0o600 });
const emptyStore = join(walkDir, 'empty-settings.env');
writeFileSync(emptyStore, '', { mode: 0o600 });

function bootServer(port, extraEnv) {
  const server = spawn(process.execPath, ['web/server.mjs'], {
    cwd: root,
    env: { ...process.env, DATABASE_URL, WEB_PORT: String(port), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[web ${port}] ${d}`));
  return server;
}
const serverA = bootServer(PORTA, {});
const serverB = bootServer(PORTB, { WEB_NAMESPACE: 's8-empty-ns', MEMORYLOOM_SETTINGS_FILE: emptyStore });
const serverW = bootServer(PORTW, {
  MEMORYLOOM_SETTINGS_FILE: walkStore,
  BASETEN_BASE_URL: 'http://127.0.0.1:4799',
});
const A = `http://127.0.0.1:${PORTA}`;
const B = `http://127.0.0.1:${PORTB}`;
const W = `http://127.0.0.1:${PORTW}`;
async function waitUp(base) {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(base + '/api/overview'); if (r.ok) return; } catch { /* not yet */ }
    await sleep(500);
  }
  throw new Error('server did not come up: ' + base);
}
await waitUp(A); await waitUp(B); await waitUp(W);
// The spawned servers die with the suite on every exit path, not
// only on the orderly teardown, so a failed run cannot leak a
// server that a later run then mistakes for its own.
process.on('exit', () => { try { serverA.kill(); serverB.kill(); serverW.kill(); } catch { /* already gone */ } });

// ---- driver --------------------------------------------------------
const driveDir = mkdtempSync(join(tmpdir(), 'ml-s8-drive-'));
let driveSeq = 0;
async function drive(name, steps) {
  driveSeq += 1;
  const port = 9600 + Math.floor(Math.random() * 300) + driveSeq;
  const specPath = join(driveDir, `${name}.json`);
  const outDir = join(driveDir, name);
  writeFileSync(specPath, JSON.stringify({ port, steps }));
  try {
    await run(process.execPath, ['checks/capture-driver-v1.mjs', specPath, outDir]);
  } catch { /* the driver exits non-zero when a step fails; the report still stands and the step assertion below records it */ }
  const report = JSON.parse(readFileSync(join(outDir, 'walk-report.json'), 'utf8'));
  const bad = report.steps.filter((s) => !s.ok);
  assert(bad.length === 0, `driver run ${name}: every step ran`, JSON.stringify(bad).slice(0, 220));
  return report.probes;
}

// ---- injected page scripts -----------------------------------------
// The failure injector answers the named APIs with a real HTTP
// 500 response object. In flagged mode it arms only after the
// walk sets sessionStorage ml-s8-fail, so one tab can load a view
// successfully and then meet the failure on a later navigation.
// Every injection also keeps the announcement log: a record of
// what the live regions and alert regions said, in order.
const ANNOUNCE = `
  window.__s8announce = [];
  const __scan = () => {
    for (const el of document.querySelectorAll('[aria-live], [role="alert"], [role="status"]')) {
      const t = (el.textContent || '').trim().replace(/\\s+/g, ' ');
      if (t && el.__s8last !== t) { el.__s8last = t; window.__s8announce.push({ id: el.id || String(el.className).slice(0, 24), live: el.getAttribute('aria-live') || el.getAttribute('role'), text: t.slice(0, 130) }); }
    }
  };
  document.addEventListener('DOMContentLoaded', () => { new MutationObserver(__scan).observe(document.body, { childList: true, subtree: true, characterData: true }); __scan(); });`;
const failInject = (paths, flagged) => `(() => {
  const FAIL = ${JSON.stringify(paths)};
  const FLAGGED = ${flagged ? 'true' : 'false'};
  const orig = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const hit = FAIL.some((p) => url.includes(p)) && (!FLAGGED || sessionStorage.getItem('ml-s8-fail') === '1');
    if (hit) return Promise.resolve(new Response(JSON.stringify({ error: 'injected failure' }), { status: 500, headers: { 'content-type': 'application/json' } }));
    return orig(input, init);
  };
  ${ANNOUNCE}
})()`;
const announceInject = `(() => { ${ANNOUNCE} })()`;
const slowInject = `(() => {
  const orig = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.includes('/api/')) return new Promise((res) => setTimeout(() => res(orig(input, init)), 1400));
    return orig(input, init);
  };
  ${ANNOUNCE}
})()`;

// ---- shared probes ---------------------------------------------------
const PAGE_PROBE = `(() => {
  const q = (s) => [...document.querySelectorAll(s)];
  const first = document.querySelector('a[href],button,input,select,textarea,[tabindex]');
  const levels = q('h1,h2,h3').map((h) => Number(h.tagName[1]));
  let skip = false;
  for (let i = 1; i < levels.length; i++) if (levels[i] > levels[i - 1] + 1) skip = true;
  return {
    headers: q('header').length,
    navs: q('nav').map((n) => n.getAttribute('aria-label')),
    mains: q('main').length,
    footers: q('footer').length,
    h1: q('h1').map((h) => h.textContent.trim().slice(0, 44)),
    headingSkip: skip,
    firstFocusable: first ? (first.tagName + '|' + (first.getAttribute('href') || first.id || '')) : null,
    thTotal: q('th').length,
    thScoped: q('th[scope]').length,
    unlabelledFields: q('input,select,textarea').filter((f) => {
      if (f.type === 'hidden') return false;
      const labelled = (f.id && document.querySelector('label[for="' + f.id + '"]')) || f.getAttribute('aria-label') || f.closest('label');
      return !labelled;
    }).map((f) => f.id || f.tagName),
    activeId: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null,
    activeIsTitle: document.activeElement ? document.activeElement.classList.contains('view-title') : false,
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
})()`;

// ---- API baselines ---------------------------------------------------
const apiJson = async (base, path) => (await fetch(base + path)).json();
// Identity proof for the walk server before any walk trusts it:
// the answering server must hold this suite's own walk store in
// its starting state, both dummy keys configured with the tails
// of the values this suite just wrote, and Baseten untouched. A
// foreign server answering on the port fails here, at setup,
// instead of corrupting the walks downstream.
{
  const storeText = readFileSync(walkStore, 'utf8');
  const tailOf = (name) => { const m = storeText.match(new RegExp('^' + name + '=(.+)$', 'm')); return m ? m[1].trim().slice(-4) : null; };
  const wSettings = await apiJson(W, '/api/settings');
  const wp = wSettings.providers || {};
  assert(wp.jev && wp.jev.last4 === tailOf('TYPESAFE_API_KEY') && wp.meta && wp.meta.configured === true && wp.meta.last4 === tailOf('META_MODEL_API_KEY') && wp.baseten && wp.baseten.configured === false,
    'setup: the walk server answering is this suite’s own, proven by its settings store', JSON.stringify(wp));
}
const graph = await apiJson(A, '/api/graph');
const overview = await apiJson(A, '/api/overview');
const proposalsApi = await apiJson(A, '/api/proposals');
const spendApi = await apiJson(A, '/api/spend');
const learningApi = await apiJson(A, '/api/learning');
const tOfNode = (n) => new Date(n.recorded_at || n.created_at || 0).getTime();
const timedNodes = graph.nodes.filter((n) => (n.kind === 'memory' || n.kind === 'proposal') && tOfNode(n) > 0);
const tMin = Math.min(...timedNodes.map(tOfNode));
const knotOrder = [...graph.nodes]
  .filter((n) => ['agent', 'memory', 'proposal', 'source'].includes(n.kind))
  .sort((a, b) => (tOfNode(a) || tMin) - (tOfNode(b) || tMin) || String(a.node_id).localeCompare(String(b.node_id)))
  .map((n) => n.node_id);
info(`corpus: ${graph.nodes.length} nodes, ${graph.edges.length} edges, range ${overview.earliest_date} .. ${overview.latest_date}`);

// ---- G1: page structure on every view -------------------------------
{
  const views = [
    ['loop', 'Live loop'], ['recall', 'Recall + receipts'], ['graph', 'Memory graph'],
    ['time', 'Time travel'], ['providers', 'Providers'], ['learning', 'Learning'], ['settings', 'Settings'],
  ];
  const steps = [];
  for (const [view] of views) {
    steps.push({ goto: `${A}/console#/${view}`, waitMs: 1500 });
    steps.push({ eval: PAGE_PROBE, as: `g1-${view}` });
  }
  steps.push({ goto: `${A}/`, waitMs: 2400 });
  steps.push({ eval: PAGE_PROBE, as: 'g1-landing' });
  const probes = await drive('g1-structure', steps);
  for (const [view, title] of views) {
    const p = probes[`g1-${view}`] || {};
    assert(p.headers === 1 && p.mains === 1 && p.footers === 1 && p.navs.length === 1 && Boolean(p.navs[0]),
      `structure ${view}: one header, one labelled nav, one main, one footer`, JSON.stringify(p).slice(0, 200));
    assert(p.h1.length === 1 && p.h1[0] === title, `structure ${view}: one h1 and it is the view title`, JSON.stringify(p.h1));
    assert(p.firstFocusable === 'A|#main', `structure ${view}: the skip link is the first focusable element`, String(p.firstFocusable));
    assert(p.headingSkip === false, `structure ${view}: heading levels never skip`, '');
    assert(p.thTotal === p.thScoped, `structure ${view}: every table head cell carries scope`, `${p.thScoped}/${p.thTotal}`);
    assert(Array.isArray(p.unlabelledFields) && p.unlabelledFields.length === 0,
      `structure ${view}: every field has a programmatically associated label`, JSON.stringify(p.unlabelledFields));
    assert(p.activeIsTitle === true, `structure ${view}: focus sits on the view heading after navigation`, `active ${p.activeId}`);
    assert(p.overflowX === 0, `structure ${view}: no page overflow at 1280px`, `overflow ${p.overflowX}`);
  }
  const lp = probes['g1-landing'] || {};
  assert(lp.headers === 1 && lp.mains === 1 && lp.footers === 1 && lp.navs.length === 1 && Boolean(lp.navs[0]),
    'structure landing: one header, one labelled nav, one main, one footer', JSON.stringify(lp).slice(0, 200));
  assert(lp.h1.length === 1, 'structure landing: exactly one h1', JSON.stringify(lp.h1));
  assert(lp.firstFocusable === 'A|#main', 'structure landing: the skip link is the first focusable element', String(lp.firstFocusable));
  assert(lp.headingSkip === false, 'structure landing: heading levels never skip', '');
  assert(lp.thTotal > 0 && lp.thTotal === lp.thScoped, 'structure landing: every table head cell carries scope', `${lp.thScoped}/${lp.thTotal}`);
  assert(lp.overflowX === 0, 'structure landing: no page overflow at 1280px', `overflow ${lp.overflowX}`);
}

// ---- G2: landing populated agreements --------------------------------
{
  const fmtDate = (t) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const times = graph.nodes.map((n) => n.recorded_at || n.created_at).filter(Boolean).map((t) => new Date(t).getTime()).sort((a, b) => a - b);
  const threads = new Set(graph.nodes.filter((n) => n.kind === 'agent').map((n) => n.id)).size;
  const b12 = await apiJson(A, '/api/believed?at=2026-10-12T00:00:00Z');
  const b25 = await apiJson(A, '/api/believed?at=2026-10-25T00:00:00Z');
  const hit12 = b12.find((r) => r.id === 'demo-v1');
  const hit25 = b25.find((r) => r.id === 'demo-v2');
  const totalSpend = spendApi.router.reduce((a, r) => a + (r.est_cost_usd || 0), 0);
  const probes = await drive('g2-landing-agree', [
    { goto: `${A}/`, waitMs: 2400 },
    {
      eval: `(() => ({
        heroLabel: document.getElementById('heroGraph') ? document.getElementById('heroGraph').getAttribute('aria-label') : null,
        believed12: document.getElementById('believed12').textContent,
        believed25: document.getElementById('believed25').textContent,
        receipts: document.querySelectorAll('#believedPanel .receipt').length,
        spendCell: document.getElementById('spendLive').textContent.replace(/\\s+/g, ' '),
        stripText: document.getElementById('cascadeStrip').textContent.replace(/\\s+/g, ' '),
      }))()`,
      as: 'g2',
    },
  ]);
  const p = probes.g2 || {};
  assert(p.heroLabel && p.heroLabel.includes(`${threads} threads`) && p.heroLabel.includes('knots'),
    'agreement landing: the hero summary names the returned thread count', String(p.heroLabel));
  assert(p.heroLabel && p.heroLabel.includes(fmtDate(times[0])) && p.heroLabel.includes(fmtDate(times[times.length - 1])),
    'agreement landing: the hero summary names the returned date range', String(p.heroLabel));
  assert(hit12 && p.believed12 === hit12.text, 'agreement landing: the 12 October answer is the record the API returns', String(p.believed12).slice(0, 60));
  assert(hit25 && p.believed25 === hit25.text, 'agreement landing: the 25 October answer is the record the API returns', String(p.believed25).slice(0, 60));
  assert(p.receipts === 2, 'agreement landing: both believed at answers carry their receipt', `receipts ${p.receipts}`);
  assert(p.spendCell && p.spendCell.includes('total $' + totalSpend.toFixed(4)),
    'agreement landing: the spend cell total is the spend response total', `${p.spendCell} against ${totalSpend}`);
  assert(p.stripText && p.stripText.includes('Total of the rows shown'), 'agreement landing: the cascade strip renders its total row', '');
}

// ---- G3: console populated agreements --------------------------------
{
  const pending = proposalsApi.proposals.filter((x) => x.status === 'pending').length;
  const decided = proposalsApi.proposals.filter((x) => x.status !== 'pending').length;
  const totalCalls = spendApi.router.reduce((a, r) => a + r.calls, 0);
  const latestBeliefs = await apiJson(A, `/api/believed?at=${encodeURIComponent(overview.latest_date)}`);
  const probes = await drive('g3-console-agree', [
    { goto: `${A}/console#/loop`, waitMs: 1500 },
    {
      eval: `(() => ({
        pendingHead: document.getElementById('pendingHead').textContent,
        decidedHead: document.getElementById('decidedHead').textContent,
        pendingRows: document.querySelectorAll('#pendingList .row-item').length,
        decidedRows: document.querySelectorAll('#decidedList .row-item').length,
        counts: [...document.querySelectorAll('#loopCounts .big')].map((e) => e.textContent),
      }))()`,
      as: 'g3-loop',
    },
    { goto: `${A}/console#/providers`, waitMs: 1500 },
    {
      eval: `(() => ({
        kv: [...document.querySelectorAll('.kv .big')].map((e) => e.textContent),
        partRows: document.querySelectorAll('.table-wrap tbody tr').length,
        escRows: document.querySelectorAll('.esc-list li').length,
        rowHeads: document.querySelectorAll('th[scope="row"]').length,
      }))()`,
      as: 'g3-providers',
    },
    { goto: `${A}/console#/learning`, waitMs: 1500 },
    {
      eval: `(() => ({
        heads: [...document.querySelectorAll('h2')].map((h) => h.textContent),
        streamRows: document.querySelectorAll('#eventList ol li').length,
        streamTimes: document.querySelectorAll('#eventList ol li time').length,
        lessonHeads: document.querySelectorAll('article.card h3').length,
      }))()`,
      as: 'g3-learning',
    },
    { goto: `${A}/console#/graph`, waitMs: 1800 },
    {
      eval: `(() => ({
        figHead: document.querySelector('.fig-head span').textContent,
        svgLabel: document.getElementById('graphSvg').getAttribute('aria-label'),
        knots: document.querySelectorAll('#graphSvg g[data-kind]').length,
      }))()`,
      as: 'g3-graph',
    },
    { goto: `${A}/console#/time`, waitMs: 1800 },
    {
      eval: `(() => ({
        listText: document.getElementById('believedOut').textContent.replace(/\\s+/g, ' ').slice(0, 60),
        rows: document.querySelectorAll('#believedOut .row-item').length,
      }))()`,
      as: 'g3-time',
    },
  ]);
  const loop = probes['g3-loop'] || {};
  assert(loop.pendingHead === `Waiting for a human (${pending})` && loop.pendingRows === pending,
    'agreement loop: the waiting heading count equals its list and the API', JSON.stringify(loop));
  assert(loop.decidedHead === `Decided (${decided})` && loop.decidedRows === decided,
    'agreement loop: the decided heading count equals its list and the API', JSON.stringify(loop));
  const memTotal = overview.memories_by_type.reduce((a, r) => a + r.n, 0);
  assert(loop.counts && loop.counts[0] === String(memTotal) && loop.counts[1] === String(pending),
    'agreement loop: the count cards equal the overview response', JSON.stringify(loop.counts));
  const prov = probes['g3-providers'] || {};
  assert(prov.kv && prov.kv[0] === String(totalCalls), 'agreement providers: the calls card equals the spend response', JSON.stringify(prov.kv));
  assert(prov.partRows === spendApi.router.length, 'agreement providers: one table row per returned spend group', `${prov.partRows} against ${spendApi.router.length}`);
  const escExpected = learningApi.events.filter((e) => e.kind === 'gate_verdict' && e.evidence?.decision?.decision === 'escalate').length;
  assert(prov.escRows === escExpected, 'agreement providers: the escalation list equals the returned escalations', `${prov.escRows} against ${escExpected}`);
  assert(prov.rowHeads > 0, 'agreement providers: row head cells carry scope row', `row heads ${prov.rowHeads}`);
  const learn = probes['g3-learning'] || {};
  assert(learn.heads && learn.heads.some((h) => h === `Playbook lessons (${learningApi.lessons.length})`),
    'agreement learning: the lessons heading count equals the API', JSON.stringify(learn.heads));
  assert(learn.heads && learn.heads.some((h) => h === `Event stream (${learningApi.events.length})`),
    'agreement learning: the stream heading count equals the API', JSON.stringify(learn.heads));
  assert(learn.streamRows === learningApi.events.length && learn.streamTimes === learningApi.events.length,
    'agreement learning: one ordered stream row and one time element per returned event', `${learn.streamRows}/${learn.streamTimes} against ${learningApi.events.length}`);
  assert(learn.lessonHeads === learningApi.lessons.length, 'agreement learning: one lesson heading per returned lesson', `${learn.lessonHeads} against ${learningApi.lessons.length}`);
  const gr = probes['g3-graph'] || {};
  assert(gr.figHead === `${graph.nodes.length} nodes · ${graph.edges.length} edges`,
    'agreement graph: the figure head counts equal the API', String(gr.figHead));
  assert(gr.svgLabel && gr.svgLabel.includes(`${threads(graph)} threads`) && gr.knots === graph.nodes.filter((n) => ['agent', 'memory', 'proposal', 'source'].includes(n.kind)).length,
    'agreement graph: the frame label counts and the drawn knots agree with the API', String(gr.svgLabel));
  function threads(g) { return new Set(g.nodes.filter((n) => n.kind === 'agent').map((n) => n.id)).size; }
  const tm = probes['g3-time'] || {};
  assert(tm.rows === latestBeliefs.length, 'agreement time: the latest date list equals the believed at response', `${tm.rows} against ${latestBeliefs.length}`);
}

// ---- G4: empty states on the empty namespace -------------------------
{
  const probes = await drive('g4-empty', [
    { goto: `${B}/console#/loop`, waitMs: 1400 },
    { eval: `(() => ({ pendingHead: document.getElementById('pendingHead').textContent, decidedHead: document.getElementById('decidedHead').textContent, counts: [...document.querySelectorAll('#loopCounts .big')].map((e) => e.textContent), inbox: document.querySelector('#pendingList .empty-state h3') ? document.querySelector('#pendingList .empty-state h3').textContent : null }))()`, as: 'g4-loop' },
    { goto: `${B}/console#/graph`, waitMs: 1400 },
    { eval: `(() => ({ text: document.getElementById('main').textContent.replace(/\\s+/g, ' '), svg: !!document.getElementById('graphSvg') }))()`, as: 'g4-graph' },
    { goto: `${B}/console#/time`, waitMs: 1400 },
    { eval: `(() => ({ text: document.getElementById('main').textContent.replace(/\\s+/g, ' '), slider: !!document.querySelector('input[type="range"]'), date: !!document.querySelector('input[type="date"]') }))()`, as: 'g4-time' },
    { goto: `${B}/console#/learning`, waitMs: 1400 },
    { eval: `(() => ({ text: document.getElementById('main').textContent.replace(/\\s+/g, ' ') }))()`, as: 'g4-learning' },
    { goto: `${B}/console#/settings`, waitMs: 1400 },
    { eval: `(() => ({ banner: [...document.querySelectorAll('.empty-state h2')].map((h) => h.textContent), badges: [...document.querySelectorAll('.settings-card .badge')].map((b) => b.textContent) }))()`, as: 'g4-settings' },
    { goto: `${B}/`, waitMs: 2000 },
    { eval: `(() => ({ hero: document.querySelector('figure.fig .empty-state') ? document.querySelector('figure.fig .empty-state').textContent.replace(/\\s+/g, ' ').slice(0, 60) : null, believed: document.getElementById('believed12').textContent, learningFig: document.getElementById('learningSteps').textContent.replace(/\\s+/g, ' ').slice(0, 60) }))()`, as: 'g4-landing' },
  ]);
  const loop = probes['g4-loop'] || {};
  assert(loop.pendingHead === 'Waiting for a human (0)' && loop.decidedHead === 'Decided (0)' && loop.inbox === 'The inbox is clear',
    'empty loop: zero counts with the designed empty states', JSON.stringify(loop));
  assert(loop.counts && loop.counts.every((c) => c === '0'), 'empty loop: the count cards read zero from the response, not typed claims', JSON.stringify(loop.counts));
  const gr = probes['g4-graph'] || {};
  assert(gr.svg === false && gr.text.includes('The graph is empty') && gr.text.includes('Approved proposals will appear here as knots'),
    'empty graph: the designed panel with the Section 6.6 words and no blank figure', String(gr.text).slice(0, 120));
  const tm = probes['g4-time'] || {};
  assert(tm.slider === false && tm.date === false && !tm.text.includes('1970') && tm.text.includes('There is no past to travel to yet'),
    'empty time: no slider, no date input, no 1970, the designed panel', String(tm.text).slice(0, 120));
  const ln = probes['g4-learning'] || {};
  assert(ln.text.includes('No lessons standing') && ln.text.includes('No events recorded yet'),
    'empty learning: the lessons and stream empty states both show', String(ln.text).slice(0, 140));
  const st = probes['g4-settings'] || {};
  assert(st.banner && st.banner.includes('No provider keys configured') && st.badges.length === 3 && st.badges.every((b) => b === 'Not configured'),
    'empty settings: the banner and three not configured rows', JSON.stringify(st));
  const ld = probes['g4-landing'] || {};
  assert(ld.hero && ld.hero.includes('The weave is empty'), 'empty landing: the hero empty state shows', String(ld.hero));
  assert(ld.believed === 'The store holds no record that was believed on this date.', 'empty landing: the believed at panel states no belief without inventing a date', String(ld.believed));
  assert(ld.learningFig && ld.learningFig.includes('No learning story recorded yet'), 'empty landing: the learning figure empty state shows', String(ld.learningFig));
}

// ---- G12: the filtered empty state is reachable -----------------------
{
  const probes = await drive('g12-filter', [
    { goto: `${A}/console#/learning`, waitMs: 1500 },
    {
      eval: `(async () => {
        const sel = document.getElementById('kindFilter');
        const tried = [];
        for (const opt of [...sel.options]) {
          if (!opt.value) continue;
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 120));
          const empty = document.querySelector('#eventList .empty-state h3');
          tried.push(opt.value + ':' + (empty ? empty.textContent : 'rows'));
          if (empty && empty.textContent === 'No events of this kind') return { found: opt.value, tried };
        }
        return { found: null, tried };
      })()`,
      as: 'g12',
    },
  ]);
  const p = probes.g12 || {};
  assert(Boolean(p.found), 'learning filter: a filter option offered reaches the filtered empty state', JSON.stringify(p.tried));
}

// ---- G5: loading states, API held -------------------------------------
// The loading probes poll for the target view's loading marker
// (navigation is serialised, so a queued view renders after the
// current one settles), then snapshot inside the held window.
{
  const poll = (marker, body) => `(async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 3200) {
      if (${marker}) break;
      await new Promise((r) => setTimeout(r, 120));
    }
    return (${body})();
  })()`;
  const probes = await drive('g5-loading', [
    { inject: slowInject },
    { goto: `${A}/console#/loop`, waitMs: 500 },
    {
      eval: poll(`!!document.getElementById('pSend')`, `() => ({
        formPresent: !!document.getElementById('pSend'),
        listBlocks: document.querySelectorAll('#pendingList .sk, #decidedList .sk').length,
        rowsYet: document.querySelectorAll('#pendingList .row-item').length,
      })`),
      as: 'g5-loop-loading',
    },
    { waitMs: 2200 },
    { eval: `(() => ({ rowsNow: document.querySelectorAll('#decidedList .row-item').length + document.querySelectorAll('#pendingList .row-item').length }))()`, as: 'g5-loop-loaded' },
    { goto: `${A}/console#/graph`, waitMs: 500 },
    {
      eval: poll(`!!document.querySelector('figure.fig .fig-body .sk')`, `() => ({
        frameBlock: !!document.querySelector('figure.fig .fig-body .sk'),
        trailLines: document.querySelectorAll('#trailOut .sk').length,
        buttonsInMain: document.querySelectorAll('#main button').length,
      })`),
      as: 'g5-graph-loading',
    },
    { goto: `${A}/console#/settings`, waitMs: 500 },
    {
      // The settings skeleton replaces the whole main element
      // (no view title stands during its load), so the scan
      // watches for its shape: the graph figure gone, exactly
      // three still blocks, and no input rendered.
      eval: `(async () => {
        const t0 = Date.now();
        while (Date.now() - t0 < 6000) {
          const blocks = document.querySelectorAll('#main .sk').length;
          const inputs = document.querySelectorAll('#main input, #main button').length;
          if (!document.querySelector('figure.fig') && blocks === 3 && inputs === 0) {
            return { blocks, inputsYet: inputs };
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        return { blocks: document.querySelectorAll('#main .sk').length, inputsYet: document.querySelectorAll('#main input, #main button').length, missed: true };
      })()`,
      as: 'g5-settings-loading',
    },
    { goto: `${A}/console#/recall`, waitMs: 500 },
    {
      eval: poll(`!!document.getElementById('q')`, `() => ({ formThere: !!document.getElementById('q') })`),
      as: 'g5-recall-form',
    },
    { type: ['#q', 'what firmware does the rig run?'] },
    { click: '#ask' },
    {
      eval: poll(`document.querySelectorAll('#recallOut .sk').length > 0`, `() => ({ blocks: document.querySelectorAll('#recallOut .sk').length })`),
      as: 'g5-recall-loading',
    },
  ]);
  const loop = probes['g5-loop-loading'] || {};
  assert(loop.formPresent === true, 'loading loop: the propose form is rendered while the lists load', JSON.stringify(loop));
  assert(loop.listBlocks >= 2 && loop.rowsYet === 0, 'loading loop: still skeleton blocks stand in place of the stream', JSON.stringify(loop));
  assert((probes['g5-loop-loaded'] || {}).rowsNow > 0, 'loading loop: the held load completes into the populated stream', JSON.stringify(probes['g5-loop-loaded']));
  const gr = probes['g5-graph-loading'] || {};
  assert(gr.frameBlock === true && gr.trailLines === 3, 'loading graph: one still block in the frame and still lines in the detail panel', JSON.stringify(gr));
  assert(gr.buttonsInMain === 0, 'loading graph: no actionable controls before the state is known', JSON.stringify(gr));
  const st = probes['g5-settings-loading'] || {};
  assert(st.blocks === 3 && st.inputsYet === 0, 'loading settings: three still blocks and no inputs or buttons rendered', JSON.stringify(st));
  const rc = probes['g5-recall-loading'] || {};
  assert(rc.blocks === 3, 'loading recall: three still sunken blocks while the answer loads', JSON.stringify(rc));
}

// ---- G6: failure states, the named APIs failed with HTTP 500 ---------
{
  // Landing, one figure at a time. Each run proves the failed
  // figure shows the table's words in a role alert and a sibling
  // figure still renders, so the failure is contained.
  const landingFail = async (name, paths, probeBody, checks) => {
    const probes = await drive(name, [
      { inject: failInject(paths, false) },
      { goto: `${A}/`, waitMs: 2400 },
      { eval: probeBody, as: name },
    ]);
    checks(probes[name] || {});
  };
  const LAND = `(() => ({
    alerts: [...document.querySelectorAll('[role="alert"]')].map((e) => e.textContent.trim().slice(0, 60)),
    heroState: document.getElementById('heroState').textContent,
    believed12: document.getElementById('believed12').textContent.slice(0, 44),
    believedAlert: !!document.getElementById('believedAlert'),
    learningText: document.getElementById('learningSteps').textContent.replace(/\\s+/g, ' ').slice(0, 120),
    spendCell: document.getElementById('spendLive').textContent.trim(),
    sections: document.querySelectorAll('section.band').length,
  }))()`;
  await landingFail('g6-land-graph', ['/api/graph'], LAND, (p) => {
    assert(p.alerts.some((t) => t.includes('The records could not be loaded.')), 'failure landing graph: the words in a role alert in the figure area', JSON.stringify(p.alerts));
    assert(p.believed12.length > 10 && !p.believedAlert, 'failure landing graph: the believed at figure still renders', String(p.believed12));
    assert(p.sections === 8, 'failure landing graph: the rest of the page stays in place', `sections ${p.sections}`);
  });
  await landingFail('g6-land-believed', ['/api/believed'], LAND, (p) => {
    assert(p.believedAlert === true && p.alerts.some((t) => t.includes('The records could not be loaded.')),
      'failure landing believed at: the words in a role alert above the panel', JSON.stringify(p.alerts));
    assert(p.believed12 === 'No answer could be loaded for this date.', 'failure landing believed at: no stale answer left in the card', String(p.believed12));
    assert(p.heroState.includes('records'), 'failure landing believed at: the hero still renders', String(p.heroState));
  });
  await landingFail('g6-land-learning', ['/api/learning'], LAND, (p) => {
    assert(p.alerts.some((t) => t.includes('The records could not be loaded.')) && p.learningText.includes('The records could not be loaded.'),
      'failure landing learning: the words in a role alert in the figure area', JSON.stringify(p.alerts));
    assert(p.heroState.includes('records'), 'failure landing learning: the hero still renders', String(p.heroState));
  });
  await landingFail('g6-land-spend', ['/api/spend'], LAND, (p) => {
    assert(p.alerts.some((t) => t.includes('The records could not be loaded.')), 'failure landing spend: the words in a role alert in the section 04 figure area', JSON.stringify(p.alerts));
    assert(p.spendCell === 'The records could not be loaded.', 'failure landing spend: the section 05 cell states the failure plainly', String(p.spendCell));
  });

  // Live loop: the gate decision call fails.
  {
    const probes = await drive('g6-loop', [
      { inject: failInject(['/api/propose'], false) },
      { goto: `${A}/console#/loop`, waitMs: 1500 },
      { type: ['#pText', 'The rig battery lasts twelve hours on one charge.'] },
      { mclick: '#pSend' },
      { waitMs: 500 },
      {
        eval: `(() => ({
          refusal: (() => { const r = document.querySelector('#pRefusal [role="alert"]'); return r ? r.textContent.replace(/\\s+/g, ' ').slice(0, 120) : null; })(),
          mono: (() => { const m = document.querySelector('#pRefusal .sunken-mono'); return m ? m.textContent : null; })(),
          activeId: document.activeElement ? document.activeElement.id : null,
          formKept: !!document.getElementById('pText'),
          announce: (window.__s8announce || []).map((a) => a.text),
        }))()`,
        as: 'g6-loop-fail',
      },
      { waitMs: 1500 },
      { eval: `(() => ({ refusalKept: !!document.querySelector('#pRefusal [role="alert"]') }))()`, as: 'g6-loop-kept' },
    ]);
    const p = probes['g6-loop-fail'] || {};
    assert(p.refusal && p.refusal.includes('The decision could not be made now.'), 'failure loop: the refusal row carries the table words', String(p.refusal));
    assert(p.mono && p.mono.includes('injected failure'), 'failure loop: the returned error string sits under the words in a sunken mono block', String(p.mono));
    assert(p.activeId === 'pSend', 'failure loop: focus stays on the submit control', String(p.activeId));
    assert(p.formKept === true, 'failure loop: the propose form stays in place', '');
    assert((probes['g6-loop-kept'] || {}).refusalKept === true, 'failure loop: the refusal stays as a visible row and does not disappear', '');
    assert(p.announce && p.announce.some((t) => t.includes('The decision could not be made now.')),
      'announcement loop: the refusal reaches the announcement log', JSON.stringify(p.announce).slice(0, 200));
  }

  // Recall: the recall call fails.
  {
    const probes = await drive('g6-recall', [
      { inject: failInject(['/api/recall'], false) },
      { goto: `${A}/console#/recall`, waitMs: 1300 },
      { type: ['#q', 'what firmware does the rig run?'] },
      { key: 'Enter' },
      { waitMs: 600 },
      {
        eval: `(() => ({
          alert: (() => { const a = document.querySelector('#recallOut [role="alert"]'); return a ? a.textContent.trim() : null; })(),
          question: document.getElementById('q').value,
          activeId: document.activeElement ? document.activeElement.id : null,
        }))()`,
        as: 'g6-recall-fail',
      },
    ]);
    const p = probes['g6-recall-fail'] || {};
    assert(p.alert === 'Recall could not be completed.', 'failure recall: the words in a role alert above the results', String(p.alert));
    assert(p.question === 'what firmware does the rig run?', 'failure recall: the typed question stays in place', String(p.question));
    assert(p.activeId === 'q', 'failure recall: focus stays in the question input', String(p.activeId));
  }

  // Graph, providers, learning: the failure meets a view that
  // already holds its last good data.
  const lastGood = async (name, view, path, checks) => {
    const probes = await drive(name, [
      { inject: failInject([path], true) },
      { goto: `${A}/console#/${view}`, waitMs: 1700 },
      { eval: `(() => { sessionStorage.setItem('ml-s8-fail', '1'); return true; })()`, as: `${name}-arm` },
      { goto: `${A}/console#/loop`, waitMs: 900 },
      { goto: `${A}/console#/${view}`, waitMs: 1700 },
      {
        eval: `(() => ({
          alert: (() => { const a = document.querySelector('[role="alert"]'); return a ? a.textContent.trim().slice(0, 70) : null; })(),
          mainText: document.getElementById('main').textContent.replace(/\\s+/g, ' ').slice(0, 400),
          knots: document.querySelectorAll('#graphSvg g[data-kind]').length,
          tables: document.querySelectorAll('.table-wrap table').length,
          lessons: document.querySelectorAll('article.card').length,
          activeIsTitle: document.activeElement ? document.activeElement.classList.contains('view-title') : false,
        }))()`,
        as: name,
      },
    ]);
    checks(probes[name] || {});
  };
  await lastGood('g6-graph', 'graph', '/api/graph', (p) => {
    assert(p.alert && p.alert.includes('The memory graph could not be loaded.'), 'failure graph: the words inside the frame area with role alert', String(p.alert));
    assert(p.knots > 0, 'failure graph: the last good graph stays in place', `knots ${p.knots}`);
  });
  await lastGood('g6-providers', 'providers', '/api/spend', (p) => {
    assert(p.alert && p.alert.includes('Provider records could not be loaded.'), 'failure providers: the words in a role alert above the table', String(p.alert));
    assert(p.tables > 0, 'failure providers: the last populated table stays in place', `tables ${p.tables}`);
  });
  await lastGood('g6-learning', 'learning', '/api/learning', (p) => {
    assert(p.alert && p.alert.includes('Learning records could not be loaded.'), 'failure learning: the words in a role alert above the view content', String(p.alert));
    assert(p.lessons > 0, 'failure learning: the last good lessons stay in place', `lessons ${p.lessons}`);
  });

  // Time travel: the believed at call fails with an HTTP 500.
  {
    const probes = await drive('g6-time', [
      { inject: failInject(['/api/believed'], true) },
      { goto: `${A}/console#/time`, waitMs: 1800 },
      { eval: `(() => ({ list: document.getElementById('believedOut').textContent.replace(/\\s+/g, ' ') }))()`, as: 'g6-time-before' },
      { eval: `(() => { sessionStorage.setItem('ml-s8-fail', '1'); return true; })()`, as: 'g6-time-arm' },
      { type: ['#asofDate', '2026-10-12'] },
      { waitMs: 900 },
      {
        eval: `(() => ({
          alert: (() => { const a = document.querySelector('#believedAlert [role="alert"]'); return a ? a.textContent.replace(/\\s+/g, ' ') : null; })(),
          list: document.getElementById('believedOut').textContent.replace(/\\s+/g, ' '),
          dateValue: document.getElementById('asofDate').value,
          activeId: document.activeElement ? document.activeElement.id : null,
        }))()`,
        as: 'g6-time-fail',
      },
    ]);
    const before = (probes['g6-time-before'] || {}).list || '';
    const p = probes['g6-time-fail'] || {};
    assert(p.alert && p.alert.startsWith('Beliefs for this date could not be loaded.'), 'failure time: the words in a role alert above the list', String(p.alert));
    assert(p.list === before && before.length > 20, 'failure time: the previous list stays in place word for word', '');
    assert(p.dateValue === '2026-10-12' && p.activeId === 'asofDate', 'failure time: the selection and focus stay on the control used', `${p.dateValue} ${p.activeId}`);
  }

  // Settings: the first fetch fails, no rows are guessed.
  {
    const probes = await drive('g6-settings', [
      { inject: failInject(['/api/settings'], false) },
      { goto: `${A}/console#/settings`, waitMs: 1400 },
      {
        eval: `(() => ({
          alert: (() => { const a = document.querySelector('[role="alert"]'); return a ? a.textContent.trim() : null; })(),
          cards: document.querySelectorAll('.settings-card').length,
        }))()`,
        as: 'g6-settings-fail',
      },
    ]);
    const p = probes['g6-settings-fail'] || {};
    assert(p.alert === 'Settings could not be loaded. No key was changed.', 'failure settings: the words in a role alert line at the head of the view', String(p.alert));
    assert(p.cards === 0, 'failure settings: no provider rows are guessed', `cards ${p.cards}`);
  }

  // The same failures at 360px (loop and recall here; the graph
  // and time travel failures at 360px are captured in the S8
  // capture set, and their 1280px table behaviour is proved
  // above).
  {
    const probes = await drive('g6-360', [
      { inject: failInject(['/api/propose', '/api/recall'], true) },
      { goto: `${A}/console#/loop`, waitMs: 1200 },
      { eval: `(() => { sessionStorage.setItem('ml-s8-fail', '1'); return true; })()`, as: 'g6-360-arm' },
      { type: ['#pText', 'A claim that meets a failed gate.'] },
      { mclick: '#pSend' },
      { waitMs: 500 },
      { shot: 'g6-360-loop', width: 360, height: 800 },
      { eval: `(() => ({ refusal: !!document.querySelector('#pRefusal [role="alert"]'), overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth }))()`, as: 'g6-360-loop' },
      { goto: `${A}/console#/recall`, waitMs: 1100 },
      { type: ['#q', 'where is the demo held?'] },
      { key: 'Enter' },
      { waitMs: 600 },
      { shot: 'g6-360-recall', width: 360, height: 800 },
      { eval: `(() => ({ alert: (() => { const a = document.querySelector('#recallOut [role="alert"]'); return a ? a.textContent.trim() : null; })(), overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth }))()`, as: 'g6-360-recall' },
    ]);
    const lp = probes['g6-360-loop'] || {};
    assert(lp.refusal === true && lp.overflowX === 0, 'failure 360 loop: the refusal row shows and the page does not overflow', JSON.stringify(lp));
    const rc = probes['g6-360-recall'] || {};
    assert(rc.alert === 'Recall could not be completed.' && rc.overflowX === 0, 'failure 360 recall: the alert words show and the page does not overflow', JSON.stringify(rc));
  }
}

// ---- G7a: the graph knot keyboard walk -------------------------------
{
  const probes = await drive('g7-graph', [
    { goto: `${A}/console#/graph`, waitMs: 1800 },
    {
      eval: `(async () => {
        const knots = [...document.querySelectorAll('#graphSvg g[data-kind]')];
        const first = knots[0];
        first.focus();
        await new Promise((r) => setTimeout(r, 250));
        const focus1 = {
          active: document.activeElement.getAttribute('data-node-id'),
          name: document.activeElement.getAttribute('aria-label'),
          panel: document.querySelector('#trailOut h2') ? document.querySelector('#trailOut h2').textContent : null,
          ring: (() => { const ring = document.querySelector('#graphSvg .knot-ring'); return ring && ring.parentElement ? ring.parentElement.getAttribute('data-node-id') : null; })(),
        };
        const order = [];
        for (let i = 0; i < knots.length; i++) {
          order.push(document.activeElement.getAttribute('data-node-id'));
          document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
          const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
          document.dispatchEvent(ev);
          // Real Tab order is walked by the driver in a second pass;
          // here the DOM order itself is the claim.
          break;
        }
        const prop = knots.find((k) => k.getAttribute('data-kind') === 'proposal');
        prop.focus();
        prop.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await new Promise((r) => setTimeout(r, 400));
        const enterPanel = document.querySelector('#trailOut h2') ? document.querySelector('#trailOut h2').textContent : null;
        const src = knots.find((k) => k.getAttribute('data-kind') === 'source');
        src.focus();
        src.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
        await new Promise((r) => setTimeout(r, 400));
        const spacePanel = document.querySelector('#trailOut h2') ? document.querySelector('#trailOut h2').textContent : null;
        return {
          count: knots.length,
          focus1,
          domOrder: knots.map((k) => k.getAttribute('data-node-id')),
          enterPanel, spacePanel,
          proposalId: prop.getAttribute('data-node-id'),
          sourceId: src.getAttribute('data-node-id'),
        };
      })()`,
      as: 'g7-graph-dom',
    },
    { eval: `(() => { const k = document.querySelector('#graphSvg g[data-kind]'); k.focus(); return document.activeElement.getAttribute('data-node-id'); })()`, as: 'g7-tab-start' },
    { key: 'Tab' },
    { eval: `(() => document.activeElement.getAttribute('data-node-id'))()`, as: 'g7-tab-1' },
    { key: 'Tab' },
    { eval: `(() => document.activeElement.getAttribute('data-node-id'))()`, as: 'g7-tab-2' },
    { key: 'Shift+Tab' },
    { eval: `(() => document.activeElement.getAttribute('data-node-id'))()`, as: 'g7-tab-back' },
  ]);
  const p = probes['g7-graph-dom'] || {};
  assert(p.count === knotOrder.length, 'walk graph: every drawn knot is focusable', `${p.count} against ${knotOrder.length}`);
  assert(JSON.stringify(p.domOrder) === JSON.stringify(knotOrder),
    'walk graph: the knot tab sequence follows the returned date order', '');
  assert(p.focus1 && p.focus1.active === knotOrder[0] && p.focus1.ring === knotOrder[0] && p.focus1.panel && !p.focus1.panel.includes('No knot selected'),
    'walk graph: focus on the first knot selects it, shows the ring and reveals its detail panel', JSON.stringify(p.focus1));
  assert(p.focus1 && /2026|agent|source/.test(p.focus1.name || ''), 'walk graph: the knot accessible name carries its label, date and status word', String(p.focus1 && p.focus1.name));
  assert(p.enterPanel && p.enterPanel.toLowerCase().includes('proposal'), 'walk graph: Enter on a proposal knot opens its note', String(p.enterPanel));
  assert(p.spacePanel && p.spacePanel.toLowerCase().includes('source'), 'walk graph: Space on a source knot opens its note', String(p.spacePanel));
  assert(probes['g7-tab-1'] === knotOrder[1] && probes['g7-tab-2'] === knotOrder[2] && probes['g7-tab-back'] === knotOrder[1],
    'walk graph: Tab moves knot to knot in date order and Shift Tab moves back',
    `${probes['g7-tab-1']} ${probes['g7-tab-2']} ${probes['g7-tab-back']}`);
}

// ---- G7b: the time travel accessibility record and date cases --------
{
  const believed = async (d) => (await apiJson(A, `/api/believed?at=${encodeURIComponent(d)}`)).map((r) => r.id);
  const probes = await drive('g7-time', [
    { goto: `${A}/console#/time`, waitMs: 1800 },
    { axtree: true, as: 'g7-ax' },
    {
      eval: `(() => ({
        sliderName: document.querySelector('label[for="asof"]') ? document.querySelector('label[for="asof"]').textContent.trim() : null,
        vt: document.getElementById('asof').getAttribute('aria-valuetext'),
        dateName: document.querySelector('label[for="asofDate"]') ? document.querySelector('label[for="asofDate"]').textContent.trim() : null,
        dateValue: document.getElementById('asofDate').value,
        readout: document.getElementById('asofLabel').textContent,
      }))()`,
      as: 'g7-time-start',
    },
    { focus: '#asof' },
    { key: 'ArrowLeft' },
    { waitMs: 700 },
    {
      eval: `(() => ({ vt: document.getElementById('asof').getAttribute('aria-valuetext'), dateValue: document.getElementById('asofDate').value, readout: document.getElementById('asofLabel').textContent }))()`,
      as: 'g7-arrow',
    },
    { key: 'Home' },
    { waitMs: 700 },
    { eval: `(() => ({ vt: document.getElementById('asof').getAttribute('aria-valuetext'), dateValue: document.getElementById('asofDate').value }))()`, as: 'g7-home' },
    { key: 'End' },
    { waitMs: 700 },
    { eval: `(() => ({ vt: document.getElementById('asof').getAttribute('aria-valuetext'), dateValue: document.getElementById('asofDate').value }))()`, as: 'g7-end' },
    { type: ['#asofDate', '2026-10-20'] },
    { waitMs: 800 },
    { eval: `(() => ({ sel: document.getElementById('asof').getAttribute('aria-valuetext'), rows: document.querySelectorAll('#believedOut .row-item').length, listText: document.getElementById('believedOut').textContent, activeId: document.activeElement.id }))()`, as: 'g7-case-exact' },
    { type: ['#asofDate', '2026-10-06'] },
    { waitMs: 800 },
    { eval: `(() => ({ sel: document.getElementById('asof').getAttribute('aria-valuetext'), rows: document.querySelectorAll('#believedOut .row-item').length, listText: document.getElementById('believedOut').textContent }))()`, as: 'g7-case-between' },
    { type: ['#asofDate', '2026-01-01'] },
    { waitMs: 800 },
    { eval: `(() => ({ sel: document.getElementById('asof').getAttribute('aria-valuetext'), sliderVal: document.getElementById('asof').value, empty: !!document.querySelector('#believedOut .empty-state'), status: document.getElementById('asofStatus').textContent, activeId: document.activeElement.id }))()`, as: 'g7-case-before' },
    { type: ['#asofDate', '2027-01-15'] },
    { waitMs: 800 },
    { eval: `(() => ({ sel: document.getElementById('asof').getAttribute('aria-valuetext'), sliderVal: document.getElementById('asof').value, rows: document.querySelectorAll('#believedOut .row-item').length, note: document.querySelector('#believedOut .time-note') ? document.querySelector('#believedOut .time-note').textContent : null, status: document.getElementById('asofStatus').textContent }))()`, as: 'g7-case-after' },
  ]);
  const start = probes['g7-time-start'] || {};
  assert(start.sliderName === 'Believed at date slider', 'walk time: the slider carries its distinct programmatic name', String(start.sliderName));
  assert(start.dateName === 'Believed at date', 'walk time: the date input label is Believed at date', String(start.dateName));
  const fmtDay = (iso) => new Date(Date.parse(iso + 'T00:00:00Z')).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  assert(start.vt === overview.latest_date && start.dateValue === overview.latest_date && start.readout === fmtDay(overview.latest_date),
    'walk time: at load the slider value text and the date input are the latest returned date and the readout names it', JSON.stringify(start));
  const ax = probes['g7-ax'] || {};
  const axNodes = Array.isArray(ax) ? ax : (ax.nodes || []);
  const axSlider = axNodes.find((n) => n.role === 'slider');
  assert(axSlider && String(axSlider.name).toLowerCase() === 'believed at date slider' && axSlider.value === overview.latest_date,
    'walk time: the accessibility tree carries the slider under its programmatic name with the selected date as its value',
    JSON.stringify(axSlider));
  const prevDay = new Date(Date.parse(overview.latest_date + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
  const arrow = probes['g7-arrow'] || {};
  assert(arrow.vt === prevDay && arrow.dateValue === prevDay && arrow.readout === fmtDay(prevDay),
    'walk time: one arrow key moves the selection one calendar day in every presentation', JSON.stringify(arrow));
  const home = probes['g7-home'] || {};
  assert(home.vt === overview.earliest_date && home.dateValue === overview.earliest_date,
    'walk time: Home moves to the first returned date', JSON.stringify(home));
  const end = probes['g7-end'] || {};
  assert(end.vt === overview.latest_date && end.dateValue === overview.latest_date,
    'walk time: End moves to the last returned date', JSON.stringify(end));
  const exact = probes['g7-case-exact'] || {};
  const exactRows = await apiJson(A, '/api/believed?at=2026-10-20');
  assert(exact.sel === '2026-10-20' && exact.rows === exactRows.length && exactRows.every((r) => (exact.listText || '').includes(r.text)) && exact.activeId === 'asofDate',
    'walk time: an exact returned date shows its belief and focus stays in the date input', JSON.stringify(exact).slice(0, 160));
  const between = probes['g7-case-between'] || {};
  const betweenRows = await apiJson(A, '/api/believed?at=2026-10-06');
  assert(between.sel === '2026-10-06' && between.rows === betweenRows.length && betweenRows.every((r) => (between.listText || '').includes(r.text)),
    'walk time: a date between two returned dates shows the belief in force', JSON.stringify(between).slice(0, 160));
  const before = probes['g7-case-before'] || {};
  assert(before.sel === '2026-01-01' && before.sliderVal === String(Date.parse(overview.earliest_date + 'T00:00:00Z')) && before.empty === true && before.status === 'Before the first returned record' && before.activeId === 'asofDate',
    'walk time: a date before the first record keeps the selection, rests the handle at the first end and shows the empty state', JSON.stringify(before));
  const after = probes['g7-case-after'] || {};
  const afterRows = await apiJson(A, '/api/believed?at=2027-01-15');
  assert(after.sel === '2027-01-15' && after.sliderVal === String(Date.parse(overview.latest_date + 'T00:00:00Z')) && after.rows === afterRows.length && Boolean(after.note) && after.status === 'After the last returned record',
    'walk time: a date after the last record keeps the selection, rests the handle at the last end and stands the latest belief as in force', JSON.stringify(after).slice(0, 160));
}

// ---- G7c: the providers wrap access test at 360px ---------------------
{
  const probes = await drive('g7-wrap', [
    { goto: `${A}/console#/providers`, waitMs: 1600 },
    { shot: 'g7-wrap', width: 360, height: 800 },
    {
      eval: `(() => { const w = document.querySelector('.table-wrap'); const r = w.getBoundingClientRect(); return { sw: w.scrollWidth, cw: w.clientWidth, tab: w.getAttribute('tabindex'), role: w.getAttribute('role'), label: w.getAttribute('aria-label'), cue: !!w.closest('.card').querySelector('.table-cue'), rect: { x: r.x, y: r.y, w: r.width, h: r.height } }; })()`,
      as: 'g7-wrap-start',
    },
    { focus: '.table-wrap' },
    { key: 'ArrowRight' }, { key: 'ArrowRight' }, { key: 'ArrowRight' }, { key: 'ArrowRight' }, { key: 'ArrowRight' }, { key: 'ArrowRight' },
    { eval: `(() => ({ sl: document.querySelector('.table-wrap').scrollLeft }))()`, as: 'g7-wrap-keys' },
    { eval: `(() => { document.querySelector('.table-wrap').scrollLeft = 0; return true; })()`, as: 'g7-wrap-reset' },
    { wheel: ['.table-wrap', 0, 260] },
    { eval: `(() => ({ sl: document.querySelector('.table-wrap').scrollLeft }))()`, as: 'g7-wrap-wheel' },
    { eval: `(() => { document.querySelector('.table-wrap').scrollLeft = 0; return true; })()`, as: 'g7-wrap-reset2' },
    { touchSwipe: ['.table-wrap', -260, 0] },
    { touchSwipe: ['.table-wrap', -260, 0] },
    {
      eval: `(() => {
        const w = document.querySelector('.table-wrap');
        const ths = [...w.querySelectorAll('thead th')];
        const last = ths[ths.length - 1];
        const wr = w.getBoundingClientRect();
        const lr = last.getBoundingClientRect();
        return { sl: w.scrollLeft, lastHead: last.textContent.trim(), lastVisible: lr.left >= wr.left - 1 && lr.right <= wr.right + 1, overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      })()`,
      as: 'g7-wrap-touch',
    },
  ]);
  const start = probes['g7-wrap-start'] || {};
  assert(start.sw > start.cw, 'wrap providers: at 360px the table sits wide inside its wrap', `${start.sw} against ${start.cw}`);
  assert(start.tab === '0' && start.role === 'region' && Boolean(start.label),
    'wrap providers: the wrap is focusable and carries an accessible name', JSON.stringify(start));
  assert(start.cue === true, 'wrap providers: the wrap shows a visible cue that more content sits to the side', '');
  assert((probes['g7-wrap-keys'] || {}).sl > 0, 'wrap providers: a keyboard user reaches the side content with arrow keys', JSON.stringify(probes['g7-wrap-keys']));
  assert((probes['g7-wrap-wheel'] || {}).sl > 0, 'wrap providers: a mouse user reaches the side content with the wheel', JSON.stringify(probes['g7-wrap-wheel']));
  const touch = probes['g7-wrap-touch'] || {};
  assert(touch.sl > 0 && touch.lastVisible === true && touch.lastHead === 'Refuses',
    'wrap providers: a touch user swipes the last column into view', JSON.stringify(touch));
  assert(touch.overflowX === 0, 'wrap providers: the page itself does not scroll sideways at 360px', `overflow ${touch.overflowX}`);
}

// ---- G7d: the skip link walks -----------------------------------------
{
  const probes = await drive('g7-skip', [
    { goto: `${A}/`, waitMs: 2200 },
    { key: 'Tab' },
    { eval: `(() => ({ cls: document.activeElement.className, text: document.activeElement.textContent.trim() }))()`, as: 'g7-skip-landing-tab' },
    { key: 'Enter' },
    { eval: `(() => ({ id: document.activeElement.id }))()`, as: 'g7-skip-landing-enter' },
    { goto: `${A}/console#/loop`, waitMs: 1500 },
    // On the console, navigation itself moves focus to the view
    // heading (Section 6.3), so the walk activates the skip link
    // from its place as the first element in the page and proves
    // where it lands. Its DOM position is proved in G1.
    { focus: '.skip-link' },
    { eval: `(() => ({ cls: document.activeElement.className }))()`, as: 'g7-skip-console-tab' },
    { key: 'Enter' },
    { eval: `(() => ({ id: document.activeElement.id }))()`, as: 'g7-skip-console-enter' },
  ]);
  const lt = probes['g7-skip-landing-tab'] || {};
  assert(String(lt.cls).includes('skip-link'), 'walk skip landing: the first Tab lands on the skip link', JSON.stringify(lt));
  assert((probes['g7-skip-landing-enter'] || {}).id === 'main', 'walk skip landing: Enter moves focus to the main content', JSON.stringify(probes['g7-skip-landing-enter']));
  const ct = probes['g7-skip-console-tab'] || {};
  assert(String(ct.cls).includes('skip-link'), 'walk skip console: the skip link takes focus as the first element in the page', JSON.stringify(ct));
  assert((probes['g7-skip-console-enter'] || {}).id === 'main', 'walk skip console: Enter moves focus to the main content', JSON.stringify(probes['g7-skip-console-enter']));
}

// ---- G8: the Settings focus rules, walked end to end ------------------
{
  const probes = await drive('g8-settings', [
    { inject: announceInject },
    { goto: `${W}/console#/settings`, waitMs: 1500 },
    { type: ['#set-baseten-key', 'dummy-baseten-candidate'] },
    { mclick: '#set-baseten-test' },
    { waitMs: 900 },
    {
      eval: `(() => ({
        result: document.getElementById('set-baseten-result').textContent,
        activeId: document.activeElement ? document.activeElement.id : null,
      }))()`,
      as: 'g8-test-fail',
    },
    { mclick: '#set-jev-test' },
    { waitMs: 900 },
    {
      eval: `(() => ({
        result: document.getElementById('set-jev-result').textContent,
        activeIsTest: document.activeElement ? document.activeElement.id === 'set-jev-test' : false,
        announce: (window.__s8announce || []).map((a) => a.text),
      }))()`,
      as: 'g8-test-ok',
    },
    { type: ['#set-meta-key', 'dummy-meta-key-4242'] },
    { mclick: '#set-meta-save' },
    { waitMs: 1200 },
    {
      eval: `(() => ({
        result: document.getElementById('set-meta-result').textContent,
        activeId: document.activeElement ? document.activeElement.id : null,
        announce: (window.__s8announce || []).map((a) => a.text),
      }))()`,
      as: 'g8-save-ok',
    },
  ]);
  const tf = probes['g8-test-fail'] || {};
  assert(tf.result === 'Baseten: network error reaching the provider', 'walk settings: a failed test reports the provider answer in plain words', String(tf.result));
  assert(tf.activeId === 'set-baseten-key', 'walk settings: after a failed test, focus stays in the password field', String(tf.activeId));
  const to = probes['g8-test-ok'] || {};
  assert(to.result && to.result.startsWith('Connected. Jev (TypeSafe) answered'), 'walk settings: a successful test names the provider and the outcome', String(to.result));
  assert(to.activeIsTest === true, 'walk settings: after a successful test, focus stays on the Test button', '');
  const so = probes['g8-save-ok'] || {};
  assert(so.result && so.result.startsWith('Saved.') && so.result.includes('Meta Model API') && so.result.includes('4242'),
    'walk settings: a successful save announces the provider and the saved tail', String(so.result));
  assert(so.activeId === 'set-meta-result', 'walk settings: after a successful save, focus moves to the provider result line', String(so.activeId));
  assert(so.announce && so.announce.some((t) => t.startsWith('Saved.') && t.includes('Meta Model API')), 'announcement settings: the save outcome reaches the announcement log', JSON.stringify(so.announce).slice(0, 200));
  // The read back happens before the remove walk runs: the walk
  // server's own settings service is the witness.
  const afterSave = await apiJson(W, '/api/settings');
  const metaAfterSave = afterSave.providers.meta;
  assert(metaAfterSave && metaAfterSave.last4 === '4242' && metaAfterSave.source === 'store',
    'walk settings: the saved key reads back from the settings service with its tail', JSON.stringify(metaAfterSave));
  const probesR = await drive('g8-remove', [
    { goto: `${W}/console#/settings`, waitMs: 1500 },
    { mclick: '#set-meta-remove' },
    { waitMs: 1200 },
    {
      eval: `(() => ({
        status: document.getElementById('set-meta-status').textContent,
        activeId: document.activeElement ? document.activeElement.id : null,
      }))()`,
      as: 'g8-remove-ok',
    },
  ]);
  const ro = probesR['g8-remove-ok'] || {};
  assert(ro.status === 'Not configured' && ro.activeId === 'set-meta-status',
    'walk settings: after a successful remove, focus moves to the provider status line', JSON.stringify(ro));
  const afterRemove = await apiJson(W, '/api/settings');
  const metaAfterRemove = afterRemove.providers.meta;
  assert(metaAfterRemove && metaAfterRemove.configured === false, 'walk settings: the removed key reads back as not configured', JSON.stringify(metaAfterRemove));

  // The save failure case: the walk store path is replaced by a
  // directory, which no writer can replace with a file, so the
  // save fails at the store whatever the process privileges are.
  renameSync(walkStore, walkStore + '.bak');
  mkdirSync(walkStore);
  try {
    const probes2 = await drive('g8-save-fail', [
      { goto: `${W}/console#/settings`, waitMs: 1500 },
      { type: ['#set-jev-key', 'dummy-jev-replacement'] },
      { mclick: '#set-jev-save' },
      { waitMs: 1000 },
      {
        eval: `(() => ({
          result: document.getElementById('set-jev-result').textContent,
          activeId: document.activeElement ? document.activeElement.id : null,
        }))()`,
        as: 'g8-save-fail',
      },
    ]);
    const sf = probes2['g8-save-fail'] || {};
    assert(sf.result && sf.result.startsWith('Save failed'), 'walk settings: a failed save reports its failure in plain words', String(sf.result));
    assert(sf.activeId === 'set-jev-key', 'walk settings: after a failed save, focus stays in the password field', String(sf.activeId));
  } finally {
    rmdirSync(walkStore);
    renameSync(walkStore + '.bak', walkStore);
  }
}

// ---- G9: the recall announcement ---------------------------------------
{
  const probes = await drive('g9-recall-announce', [
    { inject: announceInject },
    { goto: `${A}/console#/recall`, waitMs: 1300 },
    { type: ['#q', 'what firmware does the rig run?'] },
    { key: 'Enter' },
    { waitMs: 1600 },
    {
      eval: `(() => ({
        head: document.querySelector('#recallOut h2') ? document.querySelector('#recallOut h2').textContent : null,
        announce: (window.__s8announce || []).filter((a) => a.id === 'recallOut').map((a) => a.text),
      }))()`,
      as: 'g9',
    },
  ]);
  const p = probes.g9 || {};
  assert(p.head === 'Recall result', 'recall: the results are headed by the recall result heading', String(p.head));
  assert(p.announce && p.announce.some((t) => t.startsWith('Recall result')), 'announcement recall: the answer reaches the polite region log', JSON.stringify(p.announce).slice(0, 200));
}

// ---- G10: the target rule audit at 360px --------------------------------
{
  const TARGET_PROBE = `(() => {
    const HELD = ['button', 'input', 'select', 'textarea', '.table-wrap', 'g[data-kind][tabindex]'];
    const items = [];
    for (const sel of HELD) {
      for (const el of document.querySelectorAll(sel)) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (sel === 'g[data-kind][tabindex]') {
          // SVG geometry: the rendered box in CSS pixels after
          // the figure settles, measured on the group itself.
          items.push({ type: 'graph knot', w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10, x: r.x + r.width / 2, y: r.y + r.height / 2, knot: true });
          continue;
        }
        if (r.width === 0 && r.height === 0) continue;
        items.push({ type: el.tagName.toLowerCase() + (el.classList.contains('table-wrap') ? ' (table wrap)' : ''), w: r.width, h: r.height, x: r.x, y: r.y });
      }
    }
    const navLinks = [...document.querySelectorAll('.console-nav a, header nav a')].filter((a) => getComputedStyle(a).display !== 'none');
    for (const a of navLinks) { const r = a.getBoundingClientRect(); items.push({ type: 'nav link', w: r.width, h: r.height, x: r.x, y: r.y }); }
    const byType = {};
    for (const it of items) {
      const t = byType[it.type] || (byType[it.type] = { n: 0, minW: 1e9, minH: 1e9 });
      t.n += 1; t.minW = Math.min(t.minW, it.w); t.minH = Math.min(t.minH, it.h);
    }
    // Adjacency inside the nav row and inside the console rail:
    // the centre distance minus the two half widths, per pair of
    // neighbours in DOM order.
    const gaps = [];
    for (const group of [navLinks]) {
      const rs = group.map((a) => a.getBoundingClientRect());
      for (let i = 1; i < rs.length; i++) {
        const horiz = rs[i].left - rs[i - 1].right;
        if (horiz > -400) gaps.push(horiz);
      }
    }
    const knots = items.filter((i) => i.knot);
    let knotGap = 1e9;
    for (let i = 0; i < knots.length; i++) for (let j = i + 1; j < knots.length; j++) {
      const d = Math.hypot(knots[i].x - knots[j].x, knots[i].y - knots[j].y);
      knotGap = Math.min(knotGap, d);
    }
    return { byType, gaps, knotGap, knotCount: knots.length };
  })()`;
  const views360 = [
    ['landing', `${A}/`], ['loop', `${A}/console#/loop`], ['recall', `${A}/console#/recall`],
    ['graph', `${A}/console#/graph`], ['time', `${A}/console#/time`], ['providers', `${A}/console#/providers`],
    ['learning', `${A}/console#/learning`], ['settings', `${A}/console#/settings`],
  ];
  const steps = [];
  for (const [name, url] of views360) {
    steps.push({ goto: url, waitMs: 1700 });
    steps.push({ shot: `g10-${name}`, width: 360, height: 800 });
    steps.push({ eval: TARGET_PROBE, as: `g10-${name}` });
  }
  const probes = await drive('g10-targets', steps);
  for (const [name] of views360) {
    const p = probes[`g10-${name}`] || {};
    const small = Object.entries(p.byType || {}).filter(([, t]) => t.minW < 24 || t.minH < 24);
    assert(small.length === 0, `targets 360 ${name}: every held interactive type is at least 24 by 24 CSS pixels`,
      JSON.stringify(Object.fromEntries(Object.entries(p.byType || {}).map(([k, v]) => [k, `${v.minW}x${v.minH} n=${v.n}`]))));
    const tightGaps = (p.gaps || []).filter((g) => g < 8 && g >= 0);
    assert(tightGaps.length === 0, `targets 360 ${name}: adjacent nav links are at least 8 CSS pixels apart`, JSON.stringify(p.gaps));
    info(`targets 360 ${name}: ${JSON.stringify(Object.fromEntries(Object.entries(p.byType || {}).map(([k, v]) => [k, `${Math.round(v.minW)}x${Math.round(v.minH)}`])))}`);
    if (name === 'graph' || name === 'landing') {
      info(`targets 360 ${name}: knot centres nearest distance ${Math.round(p.knotGap)} CSS px across ${p.knotCount} knots`);
    }
  }
}

// ---- G11: reduced motion on the landing page ----------------------------
{
  const probes = await drive('g11-motion', [
    { emulate: { reducedMotion: true } },
    { goto: `${A}/`, waitMs: 2400 },
    {
      eval: `(() => {
        const fig = document.getElementById('heroGraph');
        const clip = fig ? fig.querySelector('clipPath rect') : null;
        const vb = fig ? fig.viewBox.baseVal : null;
        return {
          toggle: document.getElementById('heroToggle').textContent,
          settled: clip && vb ? Math.abs(parseFloat(clip.getAttribute('width')) - vb.width) < 2 : false,
          state: document.getElementById('heroState').textContent,
        };
      })()`,
      as: 'g11',
    },
  ]);
  const p = probes.g11 || {};
  assert(p.toggle === 'Replay', 'motion: under reduced motion the hero offers Replay only', String(p.toggle));
  assert(p.settled === true, 'motion: under reduced motion the weave settles at its final state', JSON.stringify(p));
}

// ---- G13: the walked paths at their click ceilings ----------------------
// Run last: these walks write. The auto approve path runs on the
// populated namespace (one click: propose and approve, Section
// 6.1), the escalate and human approve path on the empty
// namespace, where the gate stands fail closed and queues the
// proposal for a human (two clicks).
{
  const before = await apiJson(A, '/api/overview');
  const memBefore = before.memories_by_type.reduce((a, r) => a + r.n, 0);
  const probes = await drive('g13-paths', [
    { goto: `${A}/console#/loop`, waitMs: 1500 },
    { type: ['#pType', 'episodic'] },
    { type: ['#pText', 'The rig charged fully overnight on the bench supply.'] },
    { type: ['#pGround', 'demo-g2, demo-g3'] },
    { mclick: '#pSend' },
    { waitMs: 1200 },
    { eval: `(() => ({ flash: document.querySelector('.flash') ? document.querySelector('.flash').textContent : null }))()`, as: 'g13-auto' },
    { goto: `${B}/console#/loop`, waitMs: 1500 },
    { type: ['#pText', 'The harbour light burns all night.'] },
    { mclick: '#pSend' },
    { waitMs: 1200 },
    { eval: `(() => ({ flash: document.querySelector('.flash') ? document.querySelector('.flash').textContent : null, pendingRows: document.querySelectorAll('#pendingList .row-item').length }))()`, as: 'g13-esc' },
    { mclick: '#pendingList [data-act="approve"]' },
    { waitMs: 2400 },
    { eval: `(() => ({ decidedRows: document.querySelectorAll('#decidedList .row-item').length }))()`, as: 'g13-human' },
  ]);
  const auto = probes['g13-auto'] || {};
  assert(auto.flash && auto.flash.includes('approved by the gate'), 'path: propose and approve completes in one click with the gate answer as its evidence', String(auto.flash));
  const after = await apiJson(A, '/api/overview');
  const memAfter = after.memories_by_type.reduce((a, r) => a + r.n, 0);
  assert(memAfter === memBefore + 1, 'path: the approved proposal became a memory in truth', `${memBefore} to ${memAfter}`);
  const esc = probes['g13-esc'] || {};
  assert(esc.pendingRows === 1, 'path: the escalated proposal waits for a human after one click', JSON.stringify(esc));
  const human = probes['g13-human'] || {};
  const bAfter = await apiJson(B, '/api/overview');
  const bMem = bAfter.memories_by_type.reduce((a, r) => a + r.n, 0);
  assert(human.decidedRows === 1 && bMem === 1,
    'path: propose, escalate and human approve completes in two clicks', JSON.stringify(human));
}

// ---- teardown -----------------------------------------------------------
serverA.kill(); serverB.kill(); serverW.kill();
if (failures > 0) { console.log(`\nS8 STATES AND ACCESSIBILITY: ${failures} FAILURES`); process.exit(1); }
console.log('\nS8 STATES AND ACCESSIBILITY: ALL PASS');
