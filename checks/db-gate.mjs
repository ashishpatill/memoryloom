/**
 * Database gate check (card S1a, Section 10.4 of the frozen master
 * plan). Proves the pre run database gate in both directions, per
 * entry point, with the named exception tests and the leftover
 * temporary file check from Section 10.7.
 *
 * Entry points covered by invocation: the suites that read the
 * database setting, both seed scripts, the init command, the
 * rehearsal harness, the demo path scripts, the web server (the
 * serving path the capture driver drives, the driver itself reads
 * no database setting) and the MCP entry with its two harnesses.
 * The direct command test starts a database command that never
 * calls the shared preflight and shows the resolver stopping it.
 *
 * DATABASE_URL for the pass direction tests is built inside this
 * file against a fresh throwaway database that this file creates
 * and drops. No test here connects to a hosted target. The hosted
 * shaped target names a probe host that does not resolve, and the
 * exception pass tests use a closed local port so the gate pass is
 * proven by the connection refusal that follows it.
 * Owning file: checks/db-gate.mjs
 * Accountable layer: Backend and security, card S1a
 * Provider need: None
 * Declared mode: Keyless
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { evaluateDbGate } from '../lib/db-gate.mjs';
import { findLeftoverStoreTemps } from '../lib/config.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN = 'postgres://postgres@127.0.0.1:5433/postgres';
const HOSTILE = 'postgres://gateprobe:gateprobe@ep-gate-probe.gate-probe.invalid/memoryloom_demo?sslmode=require';
const BOT_MEMORY_LOCAL = 'postgres://postgres@127.0.0.1:5433/bot_memory';
const CLOSED = 'postgres://gateprobe:gateprobe@127.0.0.1:5999/memoryloom_demo';
const THROWAWAY = 'ml_s1a_gate';
const THROWAWAY_URL = `postgres://postgres@127.0.0.1:5433/${THROWAWAY}`;

let passes = 0;
let failures = 0;
function assert(cond, label, extra = '') {
  if (cond) { passes++; console.log(`  PASS ${label}`); }
  else { failures++; console.log(`  FAIL ${label} ${extra}`); }
}

function childEnv(extra = {}) {
  const env = { ...process.env };
  delete env.MEMORYLOOM_SETTINGS_FILE;
  delete env.MEMORYLOOM_DB_OPERATION;
  delete env.MEMORYLOOM_ALLOW_HOSTED_SCHEMA;
  return { ...env, ...extra };
}

function runNode(args, env, { cwd = root, timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { p.kill('SIGKILL'); }, timeoutMs);
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: String(e) }); });
  });
}

async function expectRefusal(label, args, env, opts = {}) {
  const t0 = Date.now();
  const r = await runNode(args, env, opts);
  const fast = Date.now() - t0 < (opts.timeoutMs || 60000);
  assert(r.code !== 0 && r.out.includes('db gate refusal') && fast, label,
    `exit ${r.code} refusal ${r.out.includes('db gate refusal')} out ${r.out.slice(-200)}`);
}

const recordPath = (op) => join(root, 'checks', 'out', `db-operation-${op}.json`);
function writeRecord(op, target, expiresInMs = 3600e3) {
  writeFileSync(recordPath(op), JSON.stringify({
    operation: op, card: 'S1a', target, expires_at: new Date(Date.now() + expiresInMs).toISOString(),
  }));
}
function removeRecord(op) {
  if (existsSync(recordPath(op))) unlinkSync(recordPath(op));
}

// ---- unit direction tests ---------------------------------------------------
console.log('unit: gate decisions in process');
{
  const a = evaluateDbGate({ url: 'postgres://postgres@127.0.0.1:5433/ml_verify_web' });
  assert(a.allowed && a.via === 'allowlist', 'unit throwaway target passes on the allowlist');
  const b = evaluateDbGate({ url: HOSTILE });
  assert(!b.allowed, 'unit hosted target refused with no operation identity');
  const c = evaluateDbGate({ url: BOT_MEMORY_LOCAL });
  assert(!c.allowed && c.reason.includes('bot_memory'), 'unit real memory database refused on the local host');
  const d = evaluateDbGate({ url: 'postgres://u:p@ep-other.gate-probe.invalid/bot_memory' });
  assert(!d.allowed, 'unit real memory database refused on a hosted host');
  const e = evaluateDbGate({ url: 'postgres://postgres@127.0.0.1:5432/ml_x' });
  assert(!e.allowed, 'unit wrong port refused');
  const f = evaluateDbGate({ url: 'postgres://postgres@127.0.0.1:5433/production' });
  assert(!f.allowed, 'unit unknown database name refused');
  const g = evaluateDbGate({ url: 'not a url' });
  assert(!g.allowed && g.target === null, 'unit unparsable target refused');
}

// ---- invocation refusals ----------------------------------------------------
console.log('invocation: every entry point stopped at a hosted target');
const hostileEnv = () => childEnv({ DATABASE_URL: HOSTILE });
await expectRefusal('suite test-surface stopped', ['checks/test-surface.mjs'], hostileEnv());
await expectRefusal('suite two-plane stopped', ['checks/two-plane.mjs'], hostileEnv());
await expectRefusal('suite graph-daemon stopped', ['checks/graph-daemon.mjs'], hostileEnv());
await expectRefusal('suite learning stopped', ['checks/learning.mjs'], hostileEnv());
await expectRefusal('suite learning-demo stopped', ['checks/learning-demo.mjs'], hostileEnv());
await expectRefusal('suite web stopped', ['checks/web.mjs'], hostileEnv());
await expectRefusal('suite settings stopped', ['checks/settings.mjs'], hostileEnv());
await expectRefusal('suite eval-longmem stopped', ['checks/eval-longmem.mjs'], hostileEnv());
await expectRefusal('jev gate part 3 stopped', ['checks/jev-gate.mjs'], hostileEnv(), { timeoutMs: 240000 });
await expectRefusal('seed script seed-demo stopped', ['scripts/seed-demo.mjs'], hostileEnv());
await expectRefusal('seed script seed-web-demo stopped', ['scripts/seed-web-demo.mjs'], hostileEnv());
await expectRefusal('rehearsal harness stopped', ['checks/rehearse.mjs', '99'], hostileEnv());
await expectRefusal('demo path daemon stopped', ['scripts/daemon.mjs'], hostileEnv());
await expectRefusal('demo path narrate-demo stopped', ['scripts/narrate-demo.mjs'], hostileEnv());
await expectRefusal('web server (capture driver serving path) stopped', ['web/server.mjs'], hostileEnv());
await expectRefusal('MCP entry stopped', ['mcp/index.mjs'], hostileEnv());
await expectRefusal('MCP harness recall smoke stopped', ['checks/recall_smoke.mjs', 'memoryloom-demo', 'firmware'], hostileEnv());
await expectRefusal('MCP harness roundtrip stopped', ['checks/roundtrip.mjs'], hostileEnv(), { timeoutMs: 90000 });
await expectRefusal('real memory database target stopped at a suite', ['checks/two-plane.mjs'], childEnv({ DATABASE_URL: BOT_MEMORY_LOCAL }));

// ---- direct command test ------------------------------------------------------
console.log('direct command: no shared preflight call, still stopped');
{
  const r = await runNode([join(root, 'scripts', 'daemon.mjs')], hostileEnv(), { cwd: tmpdir() });
  assert(r.code !== 0 && r.out.includes('db gate refusal'),
    'direct command daemon from a foreign folder stopped before any write', `exit ${r.code} out ${r.out.slice(-200)}`);
}

// ---- exception tests ----------------------------------------------------------
console.log('exceptions: the named operation mechanism');
{
  // One, a suite command at the hosted target with the signal set
  // but no operation record and no identity in code is stopped.
  removeRecord('hosted-seed');
  const r1 = await runNode(['checks/two-plane.mjs'], childEnv({ DATABASE_URL: HOSTILE, MEMORYLOOM_DB_OPERATION: 'hosted-seed' }));
  assert(r1.code !== 0 && r1.out.includes('db gate refusal'), 'exception one, suite stopped without record and identity', `exit ${r1.code}`);
  const r1b = await runNode(['checks/rehearse.mjs', '99'], childEnv({ DATABASE_URL: HOSTILE, MEMORYLOOM_DB_OPERATION: 'hosted-seed' }));
  assert(r1b.code !== 0 && r1b.out.includes('db gate refusal'), 'exception one, rehearsal stopped without record and identity', `exit ${r1b.code}`);

  // Two, the deliberate seed operation passes with its identity,
  // record and signal present. The target is a closed local port,
  // so the gate pass shows as the connection refusal that follows.
  writeRecord('hosted-seed', { host: '127.0.0.1', port: 5999, database: 'memoryloom_demo' });
  const r2 = await runNode(['scripts/seed-web-demo.mjs'], childEnv({ DATABASE_URL: CLOSED, MEMORYLOOM_DB_OPERATION: 'hosted-seed' }), { timeoutMs: 90000 });
  assert(!r2.out.includes('db gate refusal') && r2.out.includes('ECONNREFUSED'),
    'exception two, deliberate seed operation passes the gate with identity, record and signal', `exit ${r2.code} out ${r2.out.slice(-200)}`);
  const r2b = await runNode(['scripts/seed-web-demo.mjs'], childEnv({ DATABASE_URL: CLOSED }), { timeoutMs: 30000 });
  assert(r2b.out.includes('db gate refusal'), 'exception two control, seed stopped when the signal is removed', `exit ${r2b.code}`);
  removeRecord('hosted-seed');

  // Four, the hosted schema invocation. Stopped without identity,
  // record and signal. Passing with all three present.
  const r4a = await runNode(['scripts/init-db.mjs'], hostileEnv());
  assert(r4a.code !== 0 && r4a.out.includes('db gate refusal'), 'exception four, init stopped at the hosted target without identity, record and signal', `exit ${r4a.code}`);
  writeRecord('hosted-schema', { host: '127.0.0.1', port: 5999, database: 'memoryloom_demo' });
  const r4b = await runNode(['scripts/init-db.mjs', '--operation', 'hosted-schema'],
    childEnv({ DATABASE_URL: CLOSED, MEMORYLOOM_ALLOW_HOSTED_SCHEMA: 'hosted-schema' }), { timeoutMs: 30000 });
  assert(!r4b.out.includes('db gate refusal') && r4b.out.includes('ECONNREFUSED'),
    'exception four, init passes the gate with identity, record and MEMORYLOOM_ALLOW_HOSTED_SCHEMA present', `exit ${r4b.code} out ${r4b.out.slice(-200)}`);
  const r4c = await runNode(['scripts/init-db.mjs', '--operation', 'hosted-schema'],
    childEnv({ DATABASE_URL: CLOSED }), { timeoutMs: 30000 });
  assert(r4c.out.includes('db gate refusal'), 'exception four control, init stopped when the signal is removed', `exit ${r4c.code}`);
  removeRecord('hosted-schema');

  // Record discipline in process. An expired record and a record
  // for a different target both refuse.
  writeRecord('hosted-seed', { host: '127.0.0.1', port: 5999, database: 'memoryloom_demo' }, -1000);
  const x1 = evaluateDbGate({ url: CLOSED, operation: 'hosted-seed', env: { MEMORYLOOM_DB_OPERATION: 'hosted-seed' } });
  assert(!x1.allowed && x1.reason.includes('expired'), 'expired operation record refused');
  removeRecord('hosted-seed');
  writeRecord('hosted-seed', { host: '127.0.0.1', port: 5999, database: 'other_db' });
  const x2 = evaluateDbGate({ url: CLOSED, operation: 'hosted-seed', env: { MEMORYLOOM_DB_OPERATION: 'hosted-seed' } });
  assert(!x2.allowed && x2.reason.includes('does not match'), 'operation record for a different target refused');
  removeRecord('hosted-seed');
}

// ---- pass direction on a fresh throwaway database -----------------------------
console.log('pass direction: init, seed and the smoke entry point on a throwaway target');
{
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${THROWAWAY}`);
  await admin.query(`CREATE DATABASE ${THROWAWAY}`);
  await admin.end();
  try {
    const init = await runNode(['scripts/init-db.mjs'], childEnv({ DATABASE_URL: THROWAWAY_URL }), { timeoutMs: 120000 });
    assert(init.code === 0 && init.out.includes('applied schema/v1.sql'), 'init passes on a throwaway target', `exit ${init.code} out ${init.out.slice(-200)}`);
    const seed = await runNode(['scripts/seed-demo.mjs'], childEnv({ DATABASE_URL: THROWAWAY_URL }), { timeoutMs: 300000 });
    assert(seed.code === 0, 'seed passes on a throwaway target', `exit ${seed.code} out ${seed.out.slice(-200)}`);
    // Three, the smoke entry point passes under the same mechanism
    // on the local path.
    const smoke = await runNode(['checks/recall_smoke.mjs', 'memoryloom-demo', 'which firmware does the bench unit run'],
      childEnv({ DATABASE_URL: THROWAWAY_URL }), { timeoutMs: 300000 });
    assert(smoke.code === 0 && smoke.out.length > 0, 'exception three, smoke entry point passes on the local path', `exit ${smoke.code} out ${smoke.out.slice(-200)}`);
  } finally {
    const admin2 = new pg.Client({ connectionString: ADMIN });
    await admin2.connect();
    await admin2.query(`DROP DATABASE IF EXISTS ${THROWAWAY}`);
    await admin2.end();
  }
}

// ---- settings file guard -------------------------------------------------------
console.log('store guard: an external command naming the real store is refused');
{
  const before = readFileSync(join(root, '.env.local'));
  const r = await runNode(['checks/two-plane.mjs'], childEnv({
    DATABASE_URL: 'postgres://postgres@127.0.0.1:5433/ml_verify_web',
    MEMORYLOOM_SETTINGS_FILE: join(root, '.env.local'),
  }));
  const after = readFileSync(join(root, '.env.local'));
  assert(r.code !== 0 && r.out.includes('settings guard refusal') && before.equals(after),
    'suite refused when MEMORYLOOM_SETTINGS_FILE resolves to the real store, and the store is unchanged', `exit ${r.code}`);
}

// ---- leftover temporary file check ---------------------------------------------
console.log('leftover check: Section 10.7 age rule');
{
  const dir = mkdtempSync(join(tmpdir(), 'ml-tmp-check-'));
  const now = Date.now();
  writeFileSync(join(dir, `.env.local.tmp-${process.pid}-${now - 2 * 3600e3}`), 'x');
  writeFileSync(join(dir, `.env.local.tmp-${process.pid}-${now}`), 'x');
  writeFileSync(join(dir, '.env.local.tmp-999999-' + now), 'x');
  const findings = findLeftoverStoreTemps(dir, now);
  const old = findings.find((f) => f.ageMs > 3600e3);
  assert(old && old.rule === 'older than one hour' && old.pid === process.pid,
    'leftover named test, a file older than one hour is a leftover even when its process id is still alive');
  assert(!findings.some((f) => f.stamp === now && f.pid === process.pid),
    'a fresh temporary file with a live writer is not a finding');
  assert(findings.some((f) => f.pid === 999999 && f.rule === 'writer process not alive'),
    'a fresh temporary file with no live writer is a finding');
  const realDir = findLeftoverStoreTemps(root);
  assert(Array.isArray(realDir), `real store folder scan ran, ${realDir.length} leftover findings on the build machine`);
}

// ---- git check-ignore ------------------------------------------------------------
console.log('ignore rules: store file and temporary pattern');
{
  const run = (args) => new Promise((resolve) => {
    const p = spawn('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
  const t = await run(['check-ignore', '-v', '.env.local.tmp-123-456']);
  assert(t.code === 0 && t.out.includes('.env.local.tmp-*'), 'git check-ignore covers a temporary store name', t.out);
  const s = await run(['check-ignore', '-v', '.env.local']);
  assert(s.code === 0, 'git check-ignore covers the store file', s.out);
}

console.log(`db-gate: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
