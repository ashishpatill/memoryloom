/**
 * Settings check — the configuration service (Iteration 1.1).
 *
 * Covers the done list: resolution order (env beats store), the
 * store file at 0600 and untracked by git, masked read-back showing
 * last4 only, save / test / remove through the real HTTP API, an
 * honest bad-key failure from the test endpoint, non-local requests
 * rejected, and store edge cases (empty file, corrupt line,
 * unrelated lines preserved).
 *
 * Dummy keys only. Provider probes in this check NEVER reach a
 * real provider: the web server under test is pointed at a local
 * stub (via the providers' base-url env overrides) that accepts
 * exactly one dummy key and rejects everything else with 401, so
 * the bad-key path is exercised end to end at zero cost.
 *
 *   DATABASE_URL=postgres://… node checks/settings.mjs
 * (the URL is only needed because web/server.mjs requires one; the
 * settings routes themselves never touch the database)
 * Owning file: checks/settings.mjs
 * Accountable layer: Backend HTTP layer and the Settings store
 * Provider need: Stub server for connection tests, live only for real key claims
 * Declared mode: Stub, with its stub server run inside the suite
 */
import { spawn, execFileSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  maskedEntry,
  maskedSettings,
  providerDef,
  removeProviderKey,
  resolveProviderKey,
  saveProviderKey,
  testProvider,
} from '../lib/config.mjs';
import { preflightOrExit } from './db-preflight.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL missing'); process.exit(1); }
preflightOrExit();

let failures = 0;
let passes = 0;
function assert(cond, label, extra = '') {
  if (cond) { passes++; console.log(`  PASS ${label}`); }
  else { failures++; console.log(`  FAIL ${label} ${extra}`); }
}

const DUMMY_META = 'dummy-meta-key-00001111aaaa';
const DUMMY_ENV = 'dummy-env-key-99998888zzzz';
const DUMMY_JEV = 'dummy-jev-key-55556666bbbb';
const GOOD = 'stub-good-key-12345678wxyz';
const BAD = 'stub-bad-key-87654321dcba';

// ---------------------------------------------------------------- unit level
console.log('config service (unit, temp store):');
const tmp = mkdtempSync(join(tmpdir(), 'memoryloom-settings-'));
const store = join(tmp, '.env.local');
const opts = { storePath: store };
const savedEnv = process.env.META_MODEL_API_KEY;
delete process.env.META_MODEL_API_KEY;

assert(providerDef('typesafe')?.id === 'jev' && providerDef('nope') === null, 'provider registry resolves aliases and rejects unknown ids');

let view = maskedSettings(opts);
assert(view.meta.configured === false && view.meta.last4 === null && view.meta.source === null, 'empty store: meta not configured, no tail, no source');

const save1 = saveProviderKey('meta', DUMMY_META, opts);
assert(save1.status === 200 && save1.payload.configured === true, 'save meta returns 200 + configured');
assert(save1.payload.last4 === 'aaaa' && save1.payload.source === 'store', 'masked read-back after save: last4 only, source=store');
assert(!JSON.stringify(save1.payload).includes(DUMMY_META), 'save response never carries the full key');
assert((statSync(store).mode & 0o777) === 0o600, 'store file created with permissions 0600', `mode=${(statSync(store).mode & 0o777).toString(8)}`);
chmodSync(store, 0o644); // loosen it, then prove the next write tightens it again
saveProviderKey('jev', DUMMY_JEV, opts);
assert((statSync(store).mode & 0o777) === 0o600, 'a later write restores 0600 on a loosened store file');
assert(readFileSync(store, 'utf8').includes('TYPESAFE_API_KEY='), 'second provider lands in the same store file');

process.env.META_MODEL_API_KEY = DUMMY_ENV;
const resolved = resolveProviderKey('meta', opts);
assert(resolved.key === DUMMY_ENV && resolved.source === 'env', 'resolution order: environment beats store');
view = maskedSettings(opts);
assert(view.meta.source === 'env' && view.meta.last4 === 'zzzz', 'masked view reports the env key tail and source=env');
delete process.env.META_MODEL_API_KEY;
assert(resolveProviderKey('meta', opts).key === DUMMY_META, 'with the env var gone, resolution falls back to the store');

const badSave = saveProviderKey('meta', 'has whitespace in it', opts);
assert(badSave.status === 400 && !readFileSync(store, 'utf8').includes('has whitespace'), 'a key with whitespace is rejected and never written');
assert(saveProviderKey('nope', DUMMY_META, opts).status === 400, 'save for an unknown provider is rejected');

const rm = removeProviderKey('meta', opts);
assert(rm.payload.configured === false && rm.payload.last4 === null && rm.payload.source === null, 'remove works: masked view back to not configured');
assert(!readFileSync(store, 'utf8').includes('META_MODEL_API_KEY'), 'remove deletes the key line from the store');

// Edge cases: empty file, corrupt lines, unrelated content preserved.
writeFileSync(store, '', { mode: 0o600 });
assert(maskedEntry('jev', opts).configured === false, 'empty store file reads as not configured');
writeFileSync(store, '# a comment\nthis line is corrupt\n="no name"\nBROKEN="unterminated\nUNRELATED_SETTING=keep-me\nTYPESAFE_API_KEY=' + DUMMY_JEV + '\n', { mode: 0o600 });
assert(resolveProviderKey('jev', opts).key === DUMMY_JEV, 'corrupt lines are skipped; the valid key still resolves');
saveProviderKey('meta', DUMMY_META, opts);
const afterSave = readFileSync(store, 'utf8');
assert(afterSave.includes('UNRELATED_SETTING=keep-me'), 'unrelated store lines survive a save');
assert(afterSave.includes('# a comment'), 'comments survive a save');

saveProviderKey('baseten', 'tiny', opts);
assert(maskedEntry('baseten', opts).configured === true && maskedEntry('baseten', opts).last4 === null, 'a very short stored value shows no tail (its tail would be the key)');
removeProviderKey('baseten', opts);

// Probe unit behaviour with an injected fetch: no network at all.
const noKey = await testProvider('baseten', { fetchImpl: async () => { throw new Error('must not be called'); }, ...opts });
assert(noKey.ok === false && /no key configured/.test(noKey.error), 'test with nothing configured fails honestly without a call');
const seenAuth = [];
const stubFetch = async (url, init) => {
  seenAuth.push(init.headers.Authorization);
  return { status: init.headers.Authorization === `Bearer ${GOOD}` ? 200 : 401, text: async () => '{}' };
};
const goodProbe = await testProvider('meta', { candidateKey: GOOD, fetchImpl: stubFetch });
assert(goodProbe.ok === true && goodProbe.http_status === 200 && goodProbe.source === 'candidate', 'probe: a good candidate key passes the models read');
const badProbe = await testProvider('meta', { candidateKey: BAD, fetchImpl: stubFetch });
assert(badProbe.ok === false && badProbe.http_status === 401 && /HTTP 401/.test(badProbe.error), 'probe: a bad key fails honestly with the real status');
assert(!JSON.stringify(badProbe).includes(BAD), 'probe result never carries the key');
assert(seenAuth.every((a) => a.startsWith('Bearer ')), 'probe sends the key as a bearer token only');

// ------------------------------------------------- git: store untracked + real store untouched
// Checks only ever use temporary store paths; the real store is read
// for a byte comparison and never written (a dummy key left in the
// real store once made Settings read as configured when it was not
// — Iteration 6.1 correction).
const realStore = join(root, '.env.local');
const realStoreBefore = existsSync(realStore) ? readFileSync(realStore) : null;
if (!process.env.MEMORYLOOM_SETTINGS_FILE) {
  process.env.MEMORYLOOM_SETTINGS_FILE = join(tmp, 'git-section.env.local');
}
let envLocalIgnored = false;
try {
  execFileSync('git', ['check-ignore', '-q', '.env.local'], { cwd: root });
  envLocalIgnored = true;
} catch {
  envLocalIgnored = false;
}
assert(envLocalIgnored, 'git check-ignore confirms .env.local is ignored');
saveProviderKey('meta', DUMMY_META);
const gitStatusAfterSave = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
assert(!gitStatusAfterSave.split('\n').some((line) => line.includes('.env.local')), 'git status stays clean after a save (temp store override)');
removeProviderKey('meta');
const tempStoreContents = existsSync(process.env.MEMORYLOOM_SETTINGS_FILE) ? readFileSync(process.env.MEMORYLOOM_SETTINGS_FILE, 'utf8') : '';
assert(!tempStoreContents.includes('META_MODEL_API_KEY'), 'save and remove without opts act on the temp store, never the repo store');
const realStoreAfter = existsSync(realStore) ? readFileSync(realStore) : null;
assert((realStoreBefore === null && realStoreAfter === null) || (realStoreBefore !== null && realStoreAfter !== null && realStoreBefore.equals(realStoreAfter)), 'real repo store is byte-identical after the git section');
assert(existsSync(realStore) === (realStoreBefore !== null), 'real repo store existence unchanged by the check');

// ---------------------------------------------------------------- HTTP level
console.log('settings API (real web server, stub provider):');
const stub = createServer((req, res) => {
  const ok = req.headers.authorization === `Bearer ${GOOD}`;
  res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
  res.end(JSON.stringify(ok ? { data: [{ id: 'stub-model' }] } : { error: 'unauthorized' }));
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const stubBase = `http://127.0.0.1:${stub.address().port}`;

const httpStore = join(tmp, 'http.env.local');
const PORT = 4500 + Math.floor(Math.random() * 400);
const childEnv = { ...process.env, DATABASE_URL, WEB_PORT: String(PORT), MEMORYLOOM_SETTINGS_FILE: httpStore, META_MODEL_BASE_URL: stubBase, BASETEN_BASE_URL: stubBase, JEV_BASE_URL: stubBase };
delete childEnv.META_MODEL_API_KEY; delete childEnv.BASETEN_API_KEY; delete childEnv.TYPESAFE_API_KEY;
const server = spawn(process.execPath, ['web/server.mjs'], { cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOut = '';
server.stdout.on('data', (d) => (serverOut += d));
server.stderr.on('data', (d) => (serverOut += d));
const base = `http://localhost:${PORT}`;
async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(base + '/api/settings'); if (r.ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server did not come up');
}
const getSettings = async () => { const r = await fetch(base + '/api/settings'); return { status: r.status, text: await r.text() }; };
const send = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let parsed = null; try { parsed = JSON.parse(text); } catch { /* keep null */ }
  return { status: r.status, text, body: parsed };
};
const rawWithHost = (method, p, host, body, extraHeaders = {}) => new Promise((resolve, reject) => {
  const req = httpRequest({ host: '127.0.0.1', port: PORT, path: p, method, headers: { host, 'content-type': 'application/json', ...extraHeaders } }, (res) => {
    let t = ''; res.on('data', (d) => (t += d)); res.on('end', () => resolve({ status: res.statusCode, text: t }));
  });
  req.on('error', reject);
  req.end(body === undefined ? undefined : JSON.stringify(body));
});

try {
  await waitUp();
  const initial = await getSettings();
  const initialBody = JSON.parse(initial.text);
  assert(initial.status === 200 && initialBody.providers.meta.configured === false && initialBody.providers.baseten.configured === false && initialBody.providers.jev.configured === false, 'GET /api/settings: all three providers start unconfigured');

  const saved = await send('POST', '/api/settings/jev', { api_key: BAD });
  assert(saved.status === 200 && saved.body.configured === true && saved.body.last4 === BAD.slice(-4) && saved.body.source === 'store', 'POST save jev: masked entry returned');
  assert(!saved.text.includes(BAD), 'POST save response never carries the full key');

  const badTest = await send('POST', '/api/settings/jev/test', {});
  assert(badTest.body.ok === false && badTest.body.http_status === 401 && /rejected/.test(badTest.body.error), 'test endpoint: the saved bad key fails honestly (HTTP 401 from the provider)');

  const savedMeta = await send('POST', '/api/settings/meta', { api_key: GOOD });
  assert(savedMeta.status === 200 && savedMeta.body.last4 === GOOD.slice(-4), 'POST save meta: masked entry returned');
  const goodTest = await send('POST', '/api/settings/meta/test', {});
  assert(goodTest.body.ok === true && goodTest.body.http_status === 200, 'test endpoint: the saved good key passes the models read');

  const candidate = await send('POST', '/api/settings/baseten/test', { api_key: GOOD });
  assert(candidate.body.ok === true && candidate.body.source === 'candidate', 'test endpoint: an unsaved candidate key can be tested');
  const midView = JSON.parse((await getSettings()).text);
  assert(midView.providers.baseten.configured === false, 'testing a candidate does not save it');
  assert(midView.providers.meta.last4 === GOOD.slice(-4) && !JSON.stringify(midView).includes(GOOD), 'GET after saves: tails only, no full key anywhere in the view');
  assert((statSync(httpStore).mode & 0o777) === 0o600, 'store written by the server is 0600');

  const removed = await send('DELETE', '/api/settings/meta');
  assert(removed.status === 200 && removed.body.configured === false, 'DELETE remove meta: back to not configured');
  const noKeyTest = await send('POST', '/api/settings/meta/test', {});
  assert(noKeyTest.body.ok === false && /no key configured/.test(noKeyTest.body.error), 'test after remove: honest not-configured failure');

  const unknown = await send('POST', '/api/settings/nope', { api_key: GOOD });
  assert(unknown.status === 400, 'unknown provider save returns 400');

  const foreignHost = await rawWithHost('POST', '/api/settings/jev', 'memoryloom.example', { api_key: GOOD });
  assert(foreignHost.status === 403, 'non-local Host is rejected for a save (hosted deployment cannot mutate settings)');
  const foreignOrigin = await rawWithHost('POST', '/api/settings/jev', `localhost:${PORT}`, { api_key: GOOD }, { origin: 'https://evil.example' });
  assert(foreignOrigin.status === 403, 'non-local Origin is rejected for a save');
  const foreignTest = await rawWithHost('POST', '/api/settings/jev/test', 'memoryloom.example', {});
  assert(foreignTest.status === 403, 'non-local Host is rejected for the test endpoint');
  const afterForeign = JSON.parse((await getSettings()).text);
  assert(afterForeign.providers.jev.last4 === BAD.slice(-4), 'rejected foreign saves changed nothing');
} finally {
  server.kill('SIGTERM');
  stub.close();
}

assert(!serverOut.includes(GOOD) && !serverOut.includes(BAD) && !serverOut.includes(DUMMY_META), 'no key value appears in the server log output');

if (savedEnv === undefined) delete process.env.META_MODEL_API_KEY; else process.env.META_MODEL_API_KEY = savedEnv;

// The printed tally is the count every quoting document must use:
// it is computed from the assertions actually printed above, so the
// evidence and the quoted number can never drift apart again.
console.log(`\nsettings: ${passes}/${passes + failures} assertions passed`);
console.log(failures ? `\n${failures} FAILURES` : '\nALL GREEN');
process.exit(failures ? 1 : 0);
