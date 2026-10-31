/**
 * Router smoke: local fallback is live, hosted providers fall through
 * when not armed (default mode), gate fallback fails closed, Baseten
 * is live. Baseten (Tier 0) coverage is keyless: a child process runs
 * in live mode with a dummy key from a temp settings file against a
 * local HTTP stub, so no real key or network is needed. No database.
 * Run: node checks/router-smoke.mjs
 */
import { route, providerStatus } from '../router/router.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let failures = 0;
function assert(cond, label, extra = '') {
  if (cond) console.log(`  PASS ${label}`);
  else { failures++; console.log(`  FAIL ${label} ${extra}`); }
}

console.log('provider status:');
for (const p of providerStatus()) console.log(`  ${p.id}: live=${p.live} configured=${p.configured}`);

assert(providerStatus().find((p) => p.id === 'baseten').live === true, 'baseten provider live');
assert(providerStatus().find((p) => p.id === 'meta').live === true, 'meta provider wired live');

console.log('consolidate (meta not armed -> local fallback):');
const c = await route('consolidate', {
  episodes: [
    { id: 'e1', text: 'The demo corpus is fictional.' },
    { id: 'e2', text: 'the demo corpus   is fictional.' },
    { id: 'e3', text: 'Recall receipts cite record ids.' },
  ],
});
assert(c.provider_used === 'local', 'fell back to local', JSON.stringify(c.attempts));
assert(c.result.atoms.length === 2 && c.result.merged === 1, 'duplicates merged', JSON.stringify(c.result));
assert(c.attempts.length === 2 && c.attempts[0].provider === 'meta' && c.attempts[0].ok === false, 'meta attempt logged before fallback');

console.log('gate_score (local placeholder fails closed — real decisions are Jev, lib/gate.mjs):');
const g1 = await route('gate_score', { proposal: { text: 'A grounded fact.', type: 'semantic', grounding_ids: ['a', 'b'] } });
assert(g1.result.decision === 'escalate', 'local fallback never approves (fail closed)');
const g2 = await route('gate_score', { proposal: { text: 'A new procedure.', type: 'procedural' } });
assert(g2.result.decision === 'escalate', 'procedural escalates');
const g3 = await route('gate_score', { proposal: { text: '   ', type: 'semantic' } });
assert(g3.result.decision === 'reject', 'empty text rejects (validation)');

console.log('triage (meta not armed -> local provisional labels):');
const t = await route('triage', { proposals: [{ id: 'p1', text: 'A fact.', type: 'semantic' }, { id: 'p2', text: 'A step.', type: 'procedural' }] });
assert(t.provider_used === 'local' && t.result.labels.length === 2 && t.result.labels.every((l) => l.provisional), 'local triage labels are provisional');

console.log('narrate:');
const n = await route('narrate', { query: 'receipts', results: [{ id: 'm-1', text: 'Recall receipts cite record ids.' }] });
assert(n.provider_used === 'local' && n.result.receipts[0] === 'm-1', 'narration carries receipt');
const n0 = await route('narrate', { query: 'nothing', results: [] });
assert(n0.result.receipts.length === 0 && /No memories/.test(n0.result.narration), 'empty recall narrates honestly');

console.log('baseten stub (child, live mode, keyless stub):');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stubTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoryloom-baseten-stub-'));
const stubSettingsFile = path.join(stubTmpDir, 'settings');
fs.writeFileSync(stubSettingsFile, 'BASETEN_API_KEY=dummy-tier0-key\n');

// The child starts its own HTTP stub on an ephemeral port and sets
// BASETEN_BASE_URL=http://127.0.0.1:<port> itself before importing the
// router (BASETEN_BASE_URL is read per call, so this is safe). Imports
// inside the child use absolute file URLs derived from MEMORYLOOM_REPO_ROOT
// because the child runs with the inherited cwd via `node -e`.
const childCode = `
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let failures = 0;
function assert(cond, label, extra) {
  if (cond) console.log('  PASS ' + label);
  else { failures++; console.log('  FAIL ' + label + ' ' + (extra || '')); }
}

const repoRoot = process.env.MEMORYLOOM_REPO_ROOT;
if (!repoRoot) {
  console.log('  FAIL baseten stub: MEMORYLOOM_REPO_ROOT not set');
  process.exit(1);
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ lean: 'escalate', grounding_ok: false, reason: 'stub pre-screen answer' }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 0 } },
      }));
    });
  } else {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.BASETEN_BASE_URL = 'http://127.0.0.1:' + server.address().port;

try {
  const routerUrl = pathToFileURL(path.join(repoRoot, 'router', 'router.mjs')).href;
  const spendUrl = pathToFileURL(path.join(repoRoot, 'router', 'spend.mjs')).href;
  const { route } = await import(routerUrl);
  const { readSpendLog } = await import(spendUrl);

  const payload = { proposal: { text: 'A stub proposal.', type: 'semantic' }, evidence: [] };

  const beforeLog = await readSpendLog();
  const beforeCount = Array.isArray(beforeLog)
    ? beforeLog.filter((e) => e.provider === 'baseten' && e.task === 'prescreen').length
    : 0;

  const r1 = await route('prescreen', payload, { provider: 'baseten', synthetic: true, spendClass: 'calibration' });
  assert(r1.provider_used === 'baseten', 'baseten stub: provider_used baseten', JSON.stringify(r1.attempts || r1));
  assert(r1.result && r1.result.lean === 'escalate', 'baseten stub: result.lean escalate', JSON.stringify(r1.result));

  const afterLog = await readSpendLog();
  const basetenPrescreen = Array.isArray(afterLog)
    ? afterLog.filter((e) => e.provider === 'baseten' && e.task === 'prescreen')
    : [];
  assert(basetenPrescreen.length > beforeCount, 'baseten stub: spend log gained baseten prescreen entry', 'before=' + beforeCount + ' after=' + basetenPrescreen.length);
  const last = basetenPrescreen[basetenPrescreen.length - 1];
  assert(last && last.tier === 'tier0', 'baseten stub: spend entry tier tier0', JSON.stringify(last));
  assert(last && last.model === 'meta-models/muse-spark-open-1026', 'baseten stub: spend entry model pinned', JSON.stringify(last));

  const rBad = await route('prescreen', payload, { provider: 'baseten', synthetic: true, spendClass: 'calibration', model: 'some-other-model' });
  assert(rBad.provider_used === null, 'baseten stub: forced different model refused', JSON.stringify(rBad.attempts || rBad));

  const rCached = await route('prescreen', payload, { provider: 'baseten', synthetic: true, spendClass: 'calibration' });
  assert(rCached.provider_used === 'baseten' && rCached.cached === true, 'baseten stub: second call served from cache', JSON.stringify(rCached));

  fs.writeFileSync(process.env.MEMORYLOOM_SETTINGS_FILE, '');
  delete process.env.BASETEN_API_KEY;
  const rNoKey = await route('prescreen', payload, { provider: 'baseten', synthetic: true, spendClass: 'calibration' });
  assert(rNoKey.provider_used === null, 'baseten stub: cache not served once unconfigured (no key)', JSON.stringify(rNoKey.attempts || rNoKey));
} catch (err) {
  failures++;
  console.log('  FAIL baseten stub: unexpected error ' + (err && err.stack ? err.stack : String(err)));
}

if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
server.close();
console.log(failures === 0 ? '  baseten stub suite: ALL GREEN' : '  baseten stub suite: ' + failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
`;

const childEnv = {
  ...process.env,
  MEMORYLOOM_ROUTER_MODE: 'live',
  MEMORYLOOM_SETTINGS_FILE: stubSettingsFile,
  MEMORYLOOM_REPO_ROOT: repoRoot,
};
delete childEnv.BASETEN_API_KEY;

const child = spawnSync(process.execPath, ['--input-type=module', '-e', childCode], {
  env: childEnv,
  encoding: 'utf8',
});
if (child.stdout) process.stdout.write(child.stdout);
if (child.stderr) process.stderr.write(child.stderr);
assert(child.status === 0, 'baseten stub suite (child) green', child.error ? String(child.error) : `exit=${child.status}`);

console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
