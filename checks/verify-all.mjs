// MemoryLoom -- one-command verification entry.
//
// This is the single gate the iterations run: `npm run verify`.
//
// Steps, in order:
//   1. Forbidden-string scan over the tracked tree (git grep), excluding
//      this script itself.
//   2. Architecture check (checks/architecture.mjs).
//   3. Lint/format, only if this repo actually configures it (a matching
//      dependency or script in package.json); otherwise reported as not
//      configured and skipped -- nothing is invented.
//   4. Test suites on fresh databases, grouped by layer: backend,
//      frontend, then the AI layer. Every suite gets its own throwaway
//      database named ml_verify_<suite> on the local dev Postgres
//      (127.0.0.1:5433), created fresh, initialised via
//      scripts/init-db.mjs, and dropped/recreated on the next run.
//      Databases are disposable; no suite touches a real database.
//   5. Final summary and exit code.
//
// Plain console output, no colours.
// Owning file: checks/verify-all.mjs, the verify entry itself
// Accountable layer: all layers, it is the green baseline gate
// Provider need: none of its own, it declares the mode of every suite it spawns

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runStartedAt = Date.now();

const ADMIN_URL = 'postgres://postgres@127.0.0.1:5433/postgres';
const DB_URL_BASE = 'postgres://postgres@127.0.0.1:5433';
const TIMEOUT_MS = 10 * 60 * 1000; // generous: suites run a real server + DB

const FORBIDDEN_PATTERN =
  'hsurr|authd|JARVIS|/run/hatch|/opt/muse|/opt/hatch|dynamic_credentials|custom\\.meta-model-api|custom\\.baseten|custom\\.typesafe';

function countResults(output) {
  const lines = String(output || '').split(/\r?\n/);
  return {
    pass: lines.filter((line) => line.includes('  PASS ')).length,
    fail: lines.filter((line) => line.includes('  FAIL ')).length,
  };
}

function lastLine(output) {
  const lines = String(output || '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
  return lines.length > 0 ? lines[lines.length - 1] : '';
}

function exitCodeOf(result) {
  return typeof result.status === 'number' ? result.status : 1;
}

let overallOk = true;

// ---------------------------------------------------------------- step 0
// Startup protections (Section 10.2, card S2). The verify entry
// rejects the run at startup, before any suite starts, when an
// inherited MEMORYLOOM_SETTINGS_FILE value resolves to the real
// repo store file. It then runs the runbook preflight: the Node
// version, Postgres 16 with pgvector at the declared address,
// database create and drop rights and the provider cache state.
console.log('== Step 0: startup protections and preflight ==');
const realStoreFile = join(repoRoot, '.env.local');
{
  const inherited = process.env.MEMORYLOOM_SETTINGS_FILE;
  if (inherited && resolve(inherited) === realStoreFile) {
    console.log('startup rejection: MEMORYLOOM_SETTINGS_FILE resolves to the real repo store file, so this verify run cannot start');
    console.log('VERIFY: FAIL');
    process.exit(1);
  }
  console.log('startup settings guard: PASS (no inherited settings file value names the real store)');
}
let preflightOk = true;
{
  const major = Number(process.versions.node.split('.')[0]);
  console.log(`preflight node: ${process.versions.node} (major ${major})`);
  if (!(major >= 20)) { preflightOk = false; console.log('preflight node: FAIL (Node 20 or newer is required)'); }
  const client = new Client({ connectionString: ADMIN_URL });
  try {
    await client.connect();
    const v = await client.query('SELECT version() AS v');
    const is16 = /PostgreSQL 16\./.test(v.rows[0].v);
    console.log(`preflight postgres: ${v.rows[0].v.split(' ').slice(0, 2).join(' ')} at 127.0.0.1:5433 (${is16 ? 'PostgreSQL 16 confirmed' : 'NOT PostgreSQL 16'})`);
    if (!is16) preflightOk = false;
    const ext = await client.query("SELECT 1 FROM pg_available_extensions WHERE name = 'vector'");
    console.log(`preflight pgvector: ${ext.rowCount ? 'available' : 'MISSING'}`);
    if (!ext.rowCount) preflightOk = false;
    await client.query('DROP DATABASE IF EXISTS ml_verify_preflight');
    await client.query('CREATE DATABASE ml_verify_preflight');
    await client.query('DROP DATABASE ml_verify_preflight');
    console.log('preflight database rights: create and drop confirmed on a scratch database');
  } catch (err) {
    preflightOk = false;
    console.log(`preflight postgres: FAIL (${err.message})`);
  } finally {
    await client.end().catch(() => {});
  }
  const cacheDir = join(repoRoot, 'router', 'cache');
  let cacheFiles = 0;
  let cacheBytes = 0;
  if (existsSync(cacheDir)) {
    for (const name of readdirSync(cacheDir)) {
      try { cacheBytes += statSync(join(cacheDir, name)).size; cacheFiles++; } catch { /* ignore */ }
    }
  }
  console.log(`preflight provider cache state: ${cacheFiles} files, ${cacheBytes} bytes in router/cache (recorded, not cleared)`);
  console.log(`preflight: ${preflightOk ? 'PASS' : 'FAIL'}`);
}
if (!preflightOk) overallOk = false;

// Real-store guard (Iteration 6.1 correction): a full verify run must
// leave the repo's real settings store byte-identical. Checks only
// ever use temporary store paths; this snapshot proves the whole run
// honoured that. The store is read for comparison only, never written.
import { existsSync as _existsSync, readFileSync as _readFileSync } from 'node:fs';
import { join as _join } from 'node:path';
const _realStorePath = _join(repoRoot, '.env.local');
const _realStoreBefore = _existsSync(_realStorePath) ? _readFileSync(_realStorePath) : null;

// ---------------------------------------------------------------- step 1
console.log('== Step 1: forbidden-string scan ==');
let forbiddenOk;
{
  const result = spawnSync(
    'git',
    [
      'grep',
      '-n',
      '-E',
      FORBIDDEN_PATTERN,
      '--',
      '.',
      ':(exclude)checks/verify-all.mjs',
      ':(exclude)checks/architecture.mjs',
    ],
    { cwd: repoRoot, encoding: 'utf8', timeout: TIMEOUT_MS },
  );
  if (result.status === 1) {
    // git grep exit 1 = no matches.
    forbiddenOk = true;
    console.log('forbidden strings: PASS (no matches)');
  } else if (result.status === 0) {
    forbiddenOk = false;
    console.log('forbidden strings: FAIL (matches found)');
    if (result.stdout) process.stdout.write(result.stdout);
  } else {
    forbiddenOk = false;
    console.log(`forbidden strings: FAIL (git grep exited ${exitCodeOf(result)})`);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) console.log(String(result.error));
  }
}
if (!forbiddenOk) overallOk = false;

// ---------------------------------------------------------------- step 2
console.log('== Step 2: architecture check ==');
let architectureOk;
let architectureCounts = { pass: 0, fail: 0 };
let architectureExit = 1;
{
  const result = spawnSync('node', ['checks/architecture.mjs'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
  });
  architectureExit = exitCodeOf(result);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  architectureCounts = countResults(`${result.stdout || ''}\n${result.stderr || ''}`);
  architectureOk = architectureExit === 0;
  console.log(`architecture: ${architectureOk ? 'PASS' : 'FAIL'} (exit=${architectureExit})`);
}
if (!architectureOk) overallOk = false;

// ---------------------------------------------------------------- step 3
console.log('== Step 3: lint/format ==');
let lintOk = true;
let lintSummary = 'PASS';
{
  let pkg = {};
  try {
    pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  } catch (err) {
    lintOk = false;
    lintSummary = 'FAIL';
    console.log(`lint/format: FAIL (could not read package.json: ${err.message})`);
  }
  if (lintOk) {
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const depNames = Object.keys(deps);
    const foundDep = depNames.find((name) =>
      ['eslint', 'prettier', 'biome', '@biomejs/biome'].includes(name) ||
      name.includes('eslint') ||
      name.includes('prettier') ||
      name.includes('biome'),
    );
    const scripts = pkg.scripts || {};
    const scriptName = ['lint', 'format', 'check-format'].find((name) =>
      Object.prototype.hasOwnProperty.call(scripts, name),
    );
    if (!foundDep && !scriptName) {
      console.log(
        'lint/format: none configured in this repo (no eslint/prettier/biome dependency or script) — skipped, not invented',
      );
      lintSummary = 'PASS (skipped, none configured)';
    } else if (scriptName) {
      const result = spawnSync('npm', ['run', scriptName], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: TIMEOUT_MS,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      lintOk = exitCodeOf(result) === 0;
      lintSummary = lintOk ? 'PASS' : 'FAIL';
      console.log(`lint/format: ${lintSummary} (npm run ${scriptName}, exit=${exitCodeOf(result)})`);
    } else {
      const binary = foundDep.includes('eslint')
        ? 'eslint'
        : foundDep.includes('prettier')
          ? 'prettier'
          : 'biome';
      const args =
        binary === 'eslint'
          ? ['--no-install', 'eslint', '.']
          : binary === 'prettier'
            ? ['--no-install', 'prettier', '--check', '.']
            : ['--no-install', 'biome', 'check', '.'];
      const result = spawnSync('npx', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: TIMEOUT_MS,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      lintOk = exitCodeOf(result) === 0;
      lintSummary = lintOk ? 'PASS' : 'FAIL';
      console.log(`lint/format: ${lintSummary} (${binary} via npx, exit=${exitCodeOf(result)})`);
    }
  }
}
if (!lintOk) overallOk = false;

// ---------------------------------------------------------------- step 4
console.log('== Step 4: suites on fresh databases ==');

// Declared modes (card S2, runbook inventory). Keyless suites get a
// temporary empty settings store. Stub suites get a temporary store
// holding dummy keys and the stub base URLs, and their verdicts are
// stub decisions that prove the path and never live judgement. The
// verify entry sets a temporary settings file value in the
// environment of every suite it spawns, so no suite in this run can
// read or write the real store by default.
const SUITE_MODES = {
  'settings.mjs': 'stub-internal',
  'test-surface.mjs': 'keyless',
  'two-plane.mjs': 'stub',
  'graph-daemon.mjs': 'stub',
  'learning.mjs': 'stub',
  'learning-demo.mjs': 'stub',
  'jev-gate.mjs': 'stub',
  'backend-hardening.mjs': 'stub',
  'db-gate.mjs': 'keyless',
  'web.mjs': 'keyless',
  'weave-d1.mjs': 'keyless',
  'receipt-d2.mjs': 'keyless',
  'time-travel-d3.mjs': 'keyless',
  'states-a11y-s8.mjs': 'stub',
  'router-smoke.mjs': 'keyless',
};
const STUB_ENV = {
  JEV_BASE_URL: 'http://127.0.0.1:4711',
  META_MODEL_BASE_URL: 'http://127.0.0.1:4712',
};
const settingsTempDir = mkdtempSync(join(tmpdir(), 'ml-verify-settings-'));
function suiteStorePath(suite, mode) {
  const file = join(settingsTempDir, `${suite.replace(/\.mjs$/, '')}.env`);
  const body = mode === 'stub'
    ? 'TYPESAFE_API_KEY=stub-dummy-typesafe-key\nMETA_MODEL_API_KEY=stub-dummy-meta-key\n'
    : '';
  writeFileSync(file, body, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

// Stub lifecycle. The verify entry starts the committed stub
// server itself before the suites and stops it after them, and
// records both ends of the lifecycle in the run output.
let stubChild = null;
async function startStubs() {
  stubChild = spawn('node', ['checks/stub-server-v1.mjs'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  let exited = false;
  stubChild.on('exit', () => { exited = true; });
  const deadline = Date.now() + 15000;
  let jevUp = false;
  let metaUp = false;
  while (Date.now() < deadline && !(jevUp && metaUp)) {
    try { const r = await fetch('http://127.0.0.1:4711/v1/models'); if (r.ok) jevUp = true; } catch { /* not up yet */ }
    try { const r = await fetch('http://127.0.0.1:4712/v1/models'); if (r.ok) metaUp = true; } catch { /* not up yet */ }
    if (!(jevUp && metaUp)) await new Promise((r) => setTimeout(r, 200));
  }
  if (exited || !(jevUp && metaUp)) {
    console.log('stub lifecycle: FAIL (the stub server did not come up on ports 4711 and 4712, or the ports are held by another process)');
    return false;
  }
  console.log('stub lifecycle: started checks/stub-server-v1.mjs (jev stub on 4711, meta stub on 4712)');
  return true;
}
function stopStubs() {
  if (stubChild) {
    stubChild.kill('SIGTERM');
    stubChild = null;
    console.log('stub lifecycle: stopped');
  }
}
const stubsOk = await startStubs();
if (!stubsOk) overallOk = false;

const GROUPS = [
  {
    name: 'backend',
    suites: [
      'settings.mjs',
      'test-surface.mjs',
      'two-plane.mjs',
      'graph-daemon.mjs',
      'learning.mjs',
      'learning-demo.mjs',
      'jev-gate.mjs',
      'backend-hardening.mjs',
      'db-gate.mjs',
    ],
  },
  { name: 'frontend', suites: ['web.mjs', 'weave-d1.mjs', 'receipt-d2.mjs', 'time-travel-d3.mjs', 'states-a11y-s8.mjs'] },
  { name: 'AI layer', suites: ['router-smoke.mjs'] },
];

async function runSuite(groupName, suite) {
  const dbName = `ml_verify_${suite.replace(/\.mjs$/, '').replace(/-/g, '')}`;
  const databaseUrl = `${DB_URL_BASE}/${dbName}`;
  const mode = SUITE_MODES[suite] || 'keyless';
  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    MEMORYLOOM_SETTINGS_FILE: suiteStorePath(suite, mode),
    ...(mode === 'stub' ? STUB_ENV : {}),
  };
  if (mode !== 'stub') {
    delete env.JEV_BASE_URL;
    delete env.META_MODEL_BASE_URL;
    delete env.BASETEN_BASE_URL;
    delete env.TYPESAFE_API_KEY;
    delete env.META_MODEL_API_KEY;
    delete env.BASETEN_API_KEY;
  }

  // Fresh throwaway database for this suite.
  const client = new Client({ connectionString: ADMIN_URL });
  try {
    await client.connect();
    await client.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await client.query(`CREATE DATABASE "${dbName}"`);
  } catch (err) {
    console.log(`${groupName} / ${suite}: PASS=0 FAIL=1 exit=1`);
    console.log(`  could not create fresh database ${dbName}: ${err.message}`);
    return { ok: false, pass: 0, fail: 1 };
  } finally {
    await client.end().catch(() => {});
  }

  const init = spawnSync('node', ['scripts/init-db.mjs'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
  });
  if (exitCodeOf(init) !== 0) {
    const initOutput = `${init.stdout || ''}\n${init.stderr || ''}`;
    console.log(`${groupName} / ${suite}: PASS=0 FAIL=1 exit=${exitCodeOf(init)}`);
    const context = lastLine(initOutput);
    if (context) console.log(`  ${context}`);
    return { ok: false, pass: 0, fail: 1 };
  }

  const result = spawnSync('node', [join('checks', suite)], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const counts = countResults(output);
  const code = exitCodeOf(result);
  console.log(`${groupName} / ${suite}: PASS=${counts.pass} FAIL=${counts.fail} exit=${code} mode=${mode} store=${env.MEMORYLOOM_SETTINGS_FILE}`);
  const context = lastLine(output);
  if (context) console.log(`  ${context}`);
  return { ok: code === 0 && counts.fail === 0, pass: counts.pass, fail: counts.fail };
}

const groupResults = [];
for (const group of GROUPS) {
  console.log(`-- ${group.name} --`);
  let groupOk = true;
  let totalPass = 0;
  let totalFail = 0;
  for (const suite of group.suites) {
    const outcome = await runSuite(group.name, suite);
    totalPass += outcome.pass;
    totalFail += outcome.fail;
    if (!outcome.ok) groupOk = false;
  }
  if (group.name === 'AI layer') {
    // architecture.mjs already ran in step 2; do not run it twice.
    console.log(
      `AI layer / architecture.mjs: PASS=${architectureCounts.pass} FAIL=${architectureCounts.fail} exit=${architectureExit} - see step 2 (${architectureOk ? 'PASS' : 'FAIL'})`,
    );
    totalPass += architectureCounts.pass;
    totalFail += architectureCounts.fail;
    if (!architectureOk) groupOk = false;
  }
  groupResults.push({ name: group.name, ok: groupOk, pass: totalPass, fail: totalFail });
  if (!groupOk) overallOk = false;
}
stopStubs();
rmSync(settingsTempDir, { recursive: true, force: true });

// ---------------------------------------------------------------- step 5
const _realStoreAfter = _existsSync(_realStorePath) ? _readFileSync(_realStorePath) : null;
const realStoreOk =
  (_realStoreBefore === null && _realStoreAfter === null) ||
  (_realStoreBefore !== null && _realStoreAfter !== null && _realStoreBefore.equals(_realStoreAfter));
console.log(`real settings store byte-identical across the run: ${realStoreOk ? 'PASS' : 'FAIL'}`);
if (!realStoreOk) overallOk = false;
console.log('VERIFY SUMMARY');
console.log(`real settings store untouched: ${realStoreOk ? 'PASS' : 'FAIL'}`);
console.log(`forbidden strings: ${forbiddenOk ? 'PASS' : 'FAIL'}`);
console.log(
  `architecture: ${architectureOk ? 'PASS' : 'FAIL'} (PASS=${architectureCounts.pass} FAIL=${architectureCounts.fail} exit=${architectureExit})`,
);
console.log(`lint/format: ${lintSummary}`);
for (const group of groupResults) {
  console.log(`${group.name} suites: ${group.ok ? 'PASS' : 'FAIL'} (PASS=${group.pass} FAIL=${group.fail})`);
}
console.log(`run duration: ${Math.round((Date.now() - runStartedAt) / 1000)} seconds`);
console.log(`VERIFY: ${overallOk ? 'PASS' : 'FAIL'}`);
process.exit(overallOk ? 0 : 1);

