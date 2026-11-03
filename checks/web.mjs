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
 * Owning file: checks/web.mjs
 * Accountable layer: Backend HTTP layer and browser layer
 * Provider need: None in the verify run, its gate paths assert the fail closed states
 * Declared mode: Keyless
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import pg from 'pg';
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
const run = (cmd, args, env = {}) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${out.slice(-400)}`))));
});

// The suite's premise is a configured Jev key with the decision
// cache answering identical questions (live Jev behaviour is the
// jev-gate suite's job, not this one's). The key lives in a temp
// store owned by this suite. Checks never read or write the real
// store (Iteration 6.1 correction: the gate flows in this suite
// once passed only because a dummy key sat in the real store and
// unlocked the decision cache).
const suiteStore = join(mkdtempSync(join(tmpdir(), 'memoryloom-web-')), 'settings.env');
writeFileSync(suiteStore, 'TYPESAFE_API_KEY=<redacted>\n', { mode: 0o600 });

// Seed through the documented path.
await run(process.execPath, ['scripts/seed-web-demo.mjs'], { DATABASE_URL, MEMORYLOOM_SETTINGS_FILE: suiteStore });

const PORT = 4300 + Math.floor(Math.random() * 400);
const server = spawn(process.execPath, ['web/server.mjs'], {
  cwd: root,
  env: { ...process.env, DATABASE_URL, WEB_PORT: String(PORT), MEMORYLOOM_SETTINGS_FILE: suiteStore },
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
  assert(home.text.includes('/tokens.css') && !home.text.includes('/styles.css'), 'landing page is on design tokens v2 only (tokens.css linked, styles.css gone)');
  assert(!home.text.includes('gradient'), 'landing page carries no gradient (design law)');
  for (const id of ['helps', 'loop', 'learning', 'providers', 'proof', 'start']) {
    assert(home.text.includes(`id="${id}"`), `landing section present: #${id}`);
  }
  assert(home.text.includes('/landing.js') && home.text.includes('id="learningSteps"') && home.text.includes('id="spendLive"'), 'landing live regions present: learning steps + spend cell render from the backend');
  const consolePage = await getText('/console');
  assert(consolePage.status === 200 && consolePage.text.includes('console-nav'), 'console page serves');
  assert(consolePage.text.includes('data-nav="settings"') && consolePage.text.includes('#/settings'), 'console nav carries the Settings entry');
  // Iteration 5.2: the console finished to design tokens v2.
  assert(consolePage.text.includes('/tokens.css') && !consolePage.text.includes('/styles.css'), 'console page is on design tokens v2 only (tokens.css linked, styles.css gone)');
  assert(!consolePage.text.includes('gradient'), 'console page carries no gradient (design law: the v1 skeleton shimmer is gone)');
  assert(home.text.includes('/graph.js') && home.text.indexOf('/graph.js') < home.text.indexOf('/landing.js'), 'landing loads the shared graph renderer before landing.js (one renderer, 5.2)');
  const consoleJs = await getText('/console.js');
  assert(consoleJs.text.includes('data-state="escalated"') && consoleJs.text.includes('escalated · awaiting a human'), 'console verdicts ride the tokens badge, escalated in its full gloss form');
  assert(!/badge (ok|bad|warn|thread|grok|moose)/.test(consoleJs.text), 'console.js carries no v1 colour badge classes');
  assert(!consoleJs.text.includes('woven'), 'console graph figure has no woven texture class (v1 law debt closed)');
  assert(!consoleJs.text.includes('JSON.stringify(i.payload'), 'daemon review items never dump a raw JSON payload');
  assert(consoleJs.text.includes('There is no past to travel to yet') && consoleJs.text.includes('The graph is empty'), 'console has designed empty states for the empty graph and empty time travel');
  // Iteration 5.3 minors (Findings G, H, J): plain-word badges and
  // route glosses, the empty-stream learning state, the derived
  // Fig. 3 evidence line, the styled slider, progressive reveal.
  assert(consoleJs.text.includes('No events recorded yet') && consoleJs.text.includes('The stream is empty'), 'learning view: an empty stream gets its own true empty state (5.3, Finding G)');
  assert(consoleJs.text.includes("'gate verdict'") && consoleJs.text.includes("'in-turn correction'") && consoleJs.text.includes("'eval outcome'"), 'learning view: event-kind badges render in plain words, not snake_case (5.3, Finding J1)');
  assert(consoleJs.text.includes('imported contradiction') && consoleJs.text.includes('at least two cited records resolved'), 'console: daemon kinds and gate route reasons render with plain-word glosses (5.3, Finding J2)');
  const consoleHtml = await getText('/console.html');
  assert(consoleHtml.text.includes('::-webkit-slider-thumb') && consoleHtml.text.includes('::-moz-range-thumb'), 'time-travel slider is styled within the tokens, track and thumb (5.3, Finding J3)');
  const landingJs = await getText('/landing.js');
  assert(!landingJs.text.includes('0 citations escalated, 2 citations approved') && landingJs.text.includes('tally'), 'landing Fig. 3 evidence line is derived from the recorded verdicts, not hardcoded (5.3, Finding H)');
  assert(landingJs.text.includes('The weave is empty'), 'landing hero has an honest empty-corpus state (5.3, Finding I)');
  const tokensCss = await getText('/tokens.css');
  assert(tokensCss.text.includes('.reveal.armed') && !tokensCss.text.includes('.reveal { opacity: 0'), 'reveal is progressive: figures are visible by default, JS arms the hidden start (5.3, Finding J5)');
  const graphJs = await getText('/graph.js');
  assert(!graphJs.text.includes('% (SPAN + HOLD)') && graphJs.text.includes('onFinish'), 'graph sweep plays once and settles — no modulo loop (5.3, Finding J4)');
  assert(graphJs.text.includes('MemoryLoomGraph') && graphJs.text.includes('memoryloom-learning'), 'shared graph renderer knows the third author thread (the learning promotion)');
  assert(!/#2f5d50|#a97b12|#a62b1f/i.test(graphJs.text), 'shared graph renderer carries no v1 hues (pine, gold, bad-red all retired)');

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
  assert(rec.body.answerable === true && rec.body.no_answer === false, 'answerable recall is marked answerable (5.3, Finding B)', JSON.stringify({ answerable: rec.body.answerable, no_answer: rec.body.no_answer }));

  // Unanswerable recall (5.3, Finding B): nearest neighbours exist,
  // but the payload must say there is no answer rather than letting
  // them render as one.
  const wifi = await get('/api/recall?q=' + encodeURIComponent('what is the wifi password?'));
  assert(wifi.body.no_answer === true && wifi.body.answerable === false, 'unanswerable recall is marked no_answer (5.3, Finding B)', JSON.stringify({ answerable: wifi.body.answerable, no_answer: wifi.body.no_answer, top: wifi.body.results[0]?.rrf }));
  const consoleJsRecall = await getText('/console.js');
  assert(consoleJsRecall.text.includes('No receipts, no answer') && consoleJsRecall.text.includes('do not answer'), 'console recall renders the no-answer state with near-misses labelled as not answering (5.3, Finding B)');

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
  // Since Iteration 6.1 (2026-10-31) Baseten has done real, logged
  // work (the Tier 0 calibration), so the honest expectation is
  // meta + jev + baseten: the panel lists only providers that did work.
  assert(spend.body.router.every((r) => ['meta', 'jev', 'baseten'].includes(r.provider)), 'spend panel lists only providers that did work (meta + jev + baseten)', JSON.stringify([...new Set(spend.body.router.map((r) => r.provider))]));
  assert(spend.body.router.some((r) => r.provider === 'jev' && r.task === 'gate_decision'), 'gate decisions appear in the spend log as jev rows');
  assert(spend.body.jev_decisions_in_namespace >= 1, 'gate verdicts are counted in the namespace');

  // The live loop, end to end through the API.
  const escalate = await post('/api/propose', { author: 'grok', type: 'semantic', text: 'The Lantern demo rig charges from a 240 watt supply.', grounding_ids: [] });
  assert(escalate.body.decision === 'queued_for_review', 'ungrounded claim escalates through the real gate', JSON.stringify(escalate.body).slice(0, 160));
  const decide = await post(`/api/proposals/${escalate.body.proposal_id}/decide`, { decision: 'approve' });
  assert(decide.body.status === 'ok' && decide.body.decision === 'approved', 'human approval promotes the escalated proposal', JSON.stringify(decide.body).slice(0, 160));
  const approve = await post('/api/propose', { author: 'moose', type: 'semantic', text: 'The Lantern demo rig runs firmware 2.4.1 on the bench unit.', grounding_ids: ['demo-g2', 'demo-g3'] });
  assert(approve.body.decision === 'auto_approved', 'grounded claim is auto-approved by the gate', JSON.stringify(approve.body).slice(0, 160));

  // Fabricated citations (5.3, Finding A regression, web path): two
  // invented grounding ids must escalate, never auto-approve; and a
  // human approval afterwards must store a record whose grounding —
  // and therefore whose receipt — names none of the invented ids.
  const fake = await post('/api/propose', { author: 'grok', type: 'semantic', text: 'The Lantern demo rig runs firmware 2.4.1 on the bench unit.', grounding_ids: ['demo-does-not-exist', 'demo-also-fake-99'] });
  assert(fake.body.decision === 'queued_for_review', 'fabricated citations escalate through the web propose path (5.3, Finding A)', JSON.stringify(fake.body).slice(0, 160));
  const fakeDecide = await post(`/api/proposals/${fake.body.proposal_id}/decide`, { decision: 'approve' });
  assert(fakeDecide.body.status === 'ok', 'human approval of the fabricated-citation proposal is recorded', JSON.stringify(fakeDecide.body).slice(0, 160));
  const mems = await get('/api/memories');
  const fakeMem = mems.body.memories.find((mm) => mm.id === (fakeDecide.body.promoted_id || fakeDecide.body.memory_id));
  assert(Boolean(fakeMem) && Array.isArray(fakeMem.grounding_ids) && fakeMem.grounding_ids.length === 0, 'promoted fabricated-citation record stores no unresolved grounding (5.3, Finding A)', JSON.stringify(fakeMem?.grounding_ids));
  const fakeTrail = await get('/api/trail/' + encodeURIComponent(fakeMem.id));
  assert(fakeTrail.body.grounding.length === 0, 'the promoted record rests on nothing fabricated — its trail lists no grounding (5.3, Finding A)');

  const missing = await fetch(base + '/api/nope');
  assert(missing.status === 404, 'unknown API route returns 404');

  // ---- File proposals, the decide route guard, stable errors (card S3b) ----
  console.log('file proposals + decide route guard:');
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
  const FILE_PID = 'web-file-prop-1';
  await pool.query(`DELETE FROM file_chunks WHERE proposal_id = $1`, [FILE_PID]);
  await pool.query(`DELETE FROM proposals WHERE id = $1`, [FILE_PID]);
  await pool.query(
    `INSERT INTO proposals (id, namespace, type, scope, text, importance, strength, pinned,
                            grounding_ids, provenance, route_reason, source_file_name, chunk_count)
     VALUES ($1, 'memoryloom-demo', 'semantic', 'global', 'console-notes.md: two chunks about the console', 5, 5.0, false,
             '{}', '{"author":"grok","origin":"ingest_file"}'::jsonb, 'ingest-file-queued', 'console-notes.md', 2)`,
    [FILE_PID]
  );
  await pool.query(`INSERT INTO file_chunks (proposal_id, chunk_index, text) VALUES ($1, 0, 'first chunk text about the console'), ($1, 1, 'second chunk text about the console')`, [FILE_PID]);
  const props2 = await get('/api/proposals');
  const fp = props2.body.proposals.find((p) => p.id === FILE_PID);
  assert(fp && fp.source_file_name === 'console-notes.md' && fp.chunk_count === 2, 'proposals payload returns the source file name and the chunk count (card S3b)');
  assert(fp && Array.isArray(fp.chunks) && fp.chunks.length === 2 && fp.chunks[0].chunk_index === 0 && fp.chunks[0].text.includes('first chunk') && fp.chunks[1].chunk_index === 1 && fp.chunks[1].text.includes('second chunk'), 'proposals payload returns the chunk texts in chunk index order (card S3b)');
  // The decide route refuses a non local request, in the same way
  // the Settings routes refuse one. A raw request carries the
  // forged Host, because fetch will not send one.
  const rawDecide = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: `/api/proposals/${FILE_PID}/decide`, method: 'POST', headers: { host: 'preview.example.com', 'content-type': 'application/json' } },
      (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b) })); }
    );
    req.on('error', reject);
    req.end(JSON.stringify({ decision: 'approve' }));
  });
  assert(rawDecide.status === 403 && rawDecide.body.error === 'FORBIDDEN', 'the decide route guard test: a non local decide is refused (card S3b)', JSON.stringify(rawDecide.body));
  const fpAfter = await pool.query(`SELECT status FROM proposals WHERE id = $1`, [FILE_PID]);
  assert(fpAfter.rows[0].status === 'pending', 'the refused decide changed no proposal state');
  // A malformed body reaches the failure path and returns the
  // stable error name shape, never a raw error message.
  const badBodyRes = await fetch(base + '/api/propose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
  const badBody = await badBodyRes.json();
  assert(badBodyRes.status === 500 && badBody.status === 'error' && badBody.error === 'VALIDATION' && typeof badBody.detail === 'string', 'the stable error name test: a malformed body returns a stable error name (card S3b)', JSON.stringify(badBody));
  // The loopback decide on the file proposal still works, and the
  // approval creates one memory per chunk.
  const fpDecide = await post(`/api/proposals/${FILE_PID}/decide`, { decision: 'approve' });
  assert(fpDecide.body.status === 'ok' && Array.isArray(fpDecide.body.created_memory_ids) && fpDecide.body.created_memory_ids.length === 2, 'console approval of a file proposal creates one memory per chunk (card S3b)', JSON.stringify(fpDecide.body).slice(0, 200));
  await pool.end();

  // ---- Settings view: the real console.js against a stubbed settings
  // API. A minimal DOM stands in for the browser and fetch is stubbed,
  // so no provider is ever called and every key below is a dummy.
  console.log('settings view (stubbed API):');
  const UI_GOOD = 'stub-ui-good-key-13579bdf';
  const UI_ENV = 'stub-ui-env-key-24680ace';
  const NONE = { configured: false, last4: null, source: null };
  const noneProviders = () => ({ meta: { ...NONE }, baseten: { ...NONE }, jev: { ...NONE } });
  let uiState; let uiCalls; let uiTestResponder; let uiGate;
  function resetUi(providers) {
    uiState = { providers };
    uiCalls = [];
    uiGate = null;
    uiTestResponder = () => ({ ok: true, http_status: 200, latency_ms: 7, source: 'candidate' });
  }
  const uiRespond = (body) => ({ ok: true, status: 200, json: async () => body });
  const uiFetch = async (path, opts = {}) => {
    const method = opts.method || 'GET';
    let parsedBody = {};
    try { parsedBody = opts.body ? JSON.parse(opts.body) : {}; } catch { /* keep {} */ }
    uiCalls.push({ path, method, body: parsedBody });
    if (uiGate && path === '/api/settings' && method === 'GET') await uiGate;
    if (path === '/api/settings' && method === 'GET') return uiRespond({ providers: JSON.parse(JSON.stringify(uiState.providers)) });
    let m;
    if ((m = path.match(/^\/api\/settings\/([a-z]+)$/)) && method === 'POST') {
      const key = String(parsedBody.api_key || '');
      uiState.providers[m[1]] = { configured: true, last4: key.length < 8 ? null : key.slice(-4), source: 'store' };
      return uiRespond({ provider: m[1], ...uiState.providers[m[1]] });
    }
    if ((m = path.match(/^\/api\/settings\/([a-z]+)$/)) && method === 'DELETE') {
      uiState.providers[m[1]] = { configured: false, last4: null, source: null };
      return uiRespond({ provider: m[1], ...uiState.providers[m[1]] });
    }
    if ((m = path.match(/^\/api\/settings\/([a-z]+)\/test$/)) && method === 'POST') return uiRespond(uiTestResponder(m[1], parsedBody));
    return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
  };
  const flushUi = async () => { for (let i = 0; i < 25; i++) await new Promise((r) => setTimeout(r, 0)); };
  class FakeEl {
    constructor(id = '') {
      this.id = id; this.listeners = {}; this.value = ''; this.disabled = false;
      this.textContent = ''; this.className = ''; this.dataset = {}; this.style = {}; this._innerHTML = '';
    }
    set innerHTML(v) {
      this._innerHTML = String(v);
      if (this._isMain) {
        for (const key of [...uiRegistry.keys()]) if (key !== 'main') uiRegistry.delete(key);
        for (const mm of this._innerHTML.matchAll(/id="([^"]+)"/g)) uiRegistry.set(mm[1], new FakeEl(mm[1]));
      }
    }
    get innerHTML() { return this._innerHTML; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    // Real elements all carry focus(). The settings focus rules
    // (Section 6.10) call it after a save, a remove and a test, so
    // the fake records the call instead of throwing on it.
    focus() { this.focused = true; }
    async click() { for (const fn of this.listeners.click || []) await fn({ target: this }); }
    querySelectorAll() { return []; }
    querySelector() { return null; }
    appendChild() {}
  }
  const uiRegistry = new Map();
  const uiMain = new FakeEl('main');
  uiMain._isMain = true;
  uiRegistry.set('main', uiMain);
  const uiWindowListeners = {};
  const uiLocation = { hash: '#/settings' };
  const uiSandbox = {
    document: {
      getElementById: (id) => uiRegistry.get(id) || null,
      querySelectorAll: () => [],
      createElement: () => new FakeEl(),
    },
    window: { addEventListener: (t, fn) => { (uiWindowListeners[t] ||= []).push(fn); } },
    location: uiLocation,
    fetch: uiFetch,
    MemoryLoomGraph: {},
    setTimeout,
    clearTimeout,
  };
  const dispatchRoute = () => { for (const fn of uiWindowListeners.hashchange || []) fn(); };
  const showSettings = async () => { uiLocation.hash = '#/settings'; dispatchRoute(); await flushUi(); };

  resetUi(noneProviders());
  vm.runInNewContext(readFileSync(join(root, 'web/public/console.js'), 'utf8'), uiSandbox, { filename: 'console.js' });
  await flushUi();

  // Loading: hold the settings GET open and read the skeleton.
  let releaseGate;
  uiGate = new Promise((r) => { releaseGate = r; });
  dispatchRoute();
  assert(uiMain.innerHTML.includes('skeleton'), 'settings view: loading state renders the skeleton while the API is in flight');
  releaseGate();
  uiGate = null;
  await flushUi();

  // Empty: nothing configured.
  const emptyHtml = uiMain.innerHTML;
  assert(emptyHtml.includes('No provider keys configured') && emptyHtml.includes('runs locally without keys'), 'settings empty state: explains that MemoryLoom runs locally without keys');
  assert(emptyHtml.includes('Meta Model API') && emptyHtml.includes('Baseten') && emptyHtml.includes('Jev (TypeSafe)'), 'settings empty state: all three provider sections render');
  assert(emptyHtml.includes('dev.meta.ai') && emptyHtml.includes('Baseten workspace settings') && emptyHtml.includes('from TypeSafe'), 'settings empty state: where to get each key, in plain words');
  assert(emptyHtml.includes('operations tier') && emptyHtml.includes('can be tested here'), 'settings empty state: Baseten unlocks copy states the calibrated operations tier honestly (no product path yet)');
  assert(!emptyHtml.includes('hosted model calls through Baseten') && !emptyHtml.includes('Baseten for hosted model calls'), 'settings empty state: Baseten copy does NOT promise hosted model calls');
  assert((emptyHtml.match(/Not configured/g) || []).length >= 3, 'settings empty state: every provider is marked not configured');
  assert(emptyHtml.includes('type="password"'), 'settings view: key inputs are password fields');

  // Save flow: type a dummy key for Baseten and save it.
  uiRegistry.get('set-baseten-key').value = UI_GOOD;
  await uiRegistry.get('set-baseten-save').click();
  await flushUi();
  const saveCall = uiCalls.find((c) => c.path === '/api/settings/baseten' && c.method === 'POST');
  assert(Boolean(saveCall) && saveCall.body.api_key === UI_GOOD, 'settings save: posts the typed key to the settings API');
  assert(uiMain.innerHTML.includes('Configured in Settings') && uiMain.innerHTML.includes(UI_GOOD.slice(-4)), 'settings save: the re-read masked view shows the store source and the tail');
  assert(!uiMain.innerHTML.includes(UI_GOOD), 'settings save: the full key is never rendered');
  assert(uiMain.innerHTML.includes('Saved'), 'settings save: an in-place confirmation is shown after the re-read');

  // Test success with an unsaved candidate (Meta): no save may happen.
  uiCalls = [];
  uiRegistry.get('set-meta-key').value = UI_GOOD;
  await uiRegistry.get('set-meta-test').click();
  await flushUi();
  const testCall = uiCalls.find((c) => c.path === '/api/settings/meta/test');
  assert(Boolean(testCall) && testCall.body.api_key === UI_GOOD, 'settings test: a typed key is sent as an unsaved candidate');
  assert(!uiCalls.some((c) => c.path === '/api/settings/meta' && c.method === 'POST'), 'settings test: testing does not save the key first');
  assert(uiRegistry.get('set-meta-result').textContent.includes('Connected'), 'settings test: success is shown in place as connected');
  assert(uiRegistry.get('set-meta-key').value === UI_GOOD, 'settings test: the typed key stays in the field');

  // Test failure (Jev): the real error text, verbatim, key kept.
  uiTestResponder = () => ({ ok: false, http_status: 401, latency_ms: 5, source: 'candidate', error: 'Jev (TypeSafe) returned HTTP 401 — the provider rejected this key' });
  uiRegistry.get('set-jev-key').value = UI_GOOD;
  await uiRegistry.get('set-jev-test').click();
  await flushUi();
  assert(uiRegistry.get('set-jev-result').textContent.includes('Jev (TypeSafe) returned HTTP 401 — the provider rejected this key'), "settings test: the provider's real error is shown verbatim in place");
  assert(uiRegistry.get('set-jev-key').value === UI_GOOD, 'settings test: a failed test keeps the typed key in the field');

  // Populated: one env provider, one short stored key, one unset.
  resetUi({
    meta: { configured: true, last4: UI_ENV.slice(-4), source: 'env' },
    baseten: { configured: true, last4: null, source: 'store' },
    jev: { ...NONE },
  });
  await showSettings();
  const popHtml = uiMain.innerHTML;
  assert(popHtml.includes('Configured by environment') && popHtml.includes(UI_ENV.slice(-4)), 'settings populated: the env provider shows its source and masked tail');
  assert(!popHtml.includes(UI_ENV), 'settings populated: the full env key is never rendered');
  assert(popHtml.includes('Configured in Settings') && popHtml.includes('tail is unavailable'), 'settings populated: a short stored key reports configured with no tail shown');
  assert(!popHtml.includes('No provider keys configured'), 'settings populated: the empty-state explanation is gone once any key exists');

  // Remove flow: Baseten is store-configured, so Remove is live.
  await uiRegistry.get('set-baseten-remove').click();
  await flushUi();
  assert(uiCalls.some((c) => c.path === '/api/settings/baseten' && c.method === 'DELETE'), 'settings remove: issues the DELETE to the settings API');
  assert(uiState.providers.baseten.configured === false && uiMain.innerHTML.includes('Key removed.'), 'settings remove: in-place confirmation and the re-read view shows it gone');

  // Test with the field empty: the configured key is tested, no candidate.
  uiCalls = [];
  await uiRegistry.get('set-meta-test').click();
  await flushUi();
  const savedTest = uiCalls.find((c) => c.path === '/api/settings/meta/test');
  assert(Boolean(savedTest) && !('api_key' in savedTest.body), 'settings test: with the field empty, the configured key is tested (no candidate sent)');

  // ---- Live loop view: a file proposal renders its chunks in
  // chunk index order (card S3b). The stubbed payload hands the
  // chunks over out of order on purpose. The view sorts them, so
  // the rendered row reads in file order. This harness collects
  // appended children, because the settings harness above does
  // not need them and drops them.
  console.log('live loop view (stubbed API):');
  const loopRegistry = new Map();
  class LoopEl {
    constructor(id = '') {
      this.id = id; this.listeners = {}; this.value = ''; this.disabled = false;
      this.textContent = ''; this.className = ''; this.dataset = {}; this.style = {}; this._innerHTML = ''; this.children = [];
    }
    set innerHTML(v) {
      this._innerHTML = String(v);
      if (this._isMain) {
        for (const key of [...loopRegistry.keys()]) if (key !== 'main') loopRegistry.delete(key);
        for (const mm of this._innerHTML.matchAll(/id="([^"]+)"/g)) loopRegistry.set(mm[1], new LoopEl(mm[1]));
      }
    }
    get innerHTML() { return this._innerHTML; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    querySelectorAll() { return []; }
    querySelector() { return null; }
    appendChild(child) { this.children.push(child); return child; }
  }
  const loopMain = new LoopEl('main');
  loopMain._isMain = true;
  loopRegistry.set('main', loopMain);
  const loopFileProposal = {
    id: 'loop-file-1', status: 'pending', type: 'semantic',
    text: 'loop-notes.md: a two chunk file about the loop',
    route_reason: 'ingest-file-queued', created_at: new Date().toISOString(),
    grounding_ids: [], provenance: { author: 'grok' },
    source_file_name: 'loop-notes.md', chunk_count: 2,
    chunks: [
      { chunk_index: 1, text: 'rendered chunk two text' },
      { chunk_index: 0, text: 'rendered chunk one text' },
    ],
  };
  const loopWindowListeners = {};
  const loopSandbox = {
    document: {
      getElementById: (id) => loopRegistry.get(id) || null,
      querySelectorAll: () => [],
      createElement: () => new LoopEl(),
    },
    window: { addEventListener: (t, fn) => { (loopWindowListeners[t] ||= []).push(fn); } },
    location: { hash: '#/loop' },
    fetch: async (path) => {
      if (path === '/api/overview') return { ok: true, status: 200, json: async () => ({ memories_by_type: [], lessons: 0, learning_events: 0 }) };
      if (path === '/api/proposals') return { ok: true, status: 200, json: async () => ({ proposals: [loopFileProposal], daemon_review_items: [], daemon_runs: [] }) };
      return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
    },
    MemoryLoomGraph: {},
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(consoleJs.text, loopSandbox, { filename: 'console.js' });
  await flushUi();
  const pendingList = loopRegistry.get('pendingList');
  assert(pendingList && pendingList.children.length === 1, 'loop view renders the file proposal row');
  const rowHtml = pendingList && pendingList.children.length ? pendingList.children[0].innerHTML : '';
  const firstAt = rowHtml.indexOf('rendered chunk one text');
  const secondAt = rowHtml.indexOf('rendered chunk two text');
  assert(firstAt >= 0 && secondAt > firstAt, 'the rendered console view shows the chunks in chunk index order (card S3b)');
  assert(rowHtml.includes('loop-notes.md') && rowHtml.includes('2 chunks, shown in file order'), 'the rendered row names the source file and its chunk count');
} finally {
  server.kill('SIGTERM');
}

console.log(failures ? `\n${failures} FAILURES` : '\nALL GREEN');
process.exit(failures ? 1 : 0);
