/**
 * Secret scanner (card S2, Section 10.7 of the frozen master
 * plan). Scans for provider key shapes and for the Neon
 * connection string across a scope wider than the tracked tree.
 * It never prints a matched value. A finding names the scope, the
 * pattern and the location only.
 *
 * Owning file: checks/secret-scan.mjs
 * Accountable layer: backend and security
 * Provider need: none
 * Declared mode: keyless. Runs against the working checkout by
 *   default, or against a named root with --root.
 *
 * Scopes: every commit reachable from any local or remote ref,
 * objects reachable only through a reflog, dangling objects, and
 * tracked, untracked and ignored working files, including the
 * store temporary file artifact. A value found under its named
 * expected variable inside the local settings store is recorded
 * as an expected holding. A store temporary file counts as an
 * expected holding only while its write is in progress, decided
 * by the leftover check from card S1a, which runs first here.
 *
 * Pattern set (also recorded in the runbook beside the probe
 * results):
 *   neon-connection-string: a Postgres URL carrying a password at
 *     a neon.tech host.
 *   provider-key-assignment: one of META_MODEL_API_KEY,
 *     BASETEN_API_KEY or TYPESAFE_API_KEY, anchored to a line
 *     start or a quote, assigned a value of 12 or more characters
 *     that is not a known placeholder shape.
 * With --values-from-store the scanner also searches every scope
 * for the exact values the local store holds for DATABASE_URL
 * and the three provider key variables, reporting locations only.
 * Those values are expected inside the store and nowhere else.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { findLeftoverStoreTemps } from '../lib/config.mjs';

const args = process.argv.slice(2);
const rootIdx = args.indexOf('--root');
const ROOT = rootIdx >= 0 ? resolve(args[rootIdx + 1]) : resolve(join(import.meta.dirname, '..'));
const WITH_VALUES = args.includes('--values-from-store');

export const PATTERNS = [
  {
    name: 'neon-connection-string',
    re: /postgres(?:ql)?:\/\/[A-Za-z0-9._~-]+:[^\s@'"<>]+@[A-Za-z0-9.-]*neon\.tech(?::\d+)?\/[^\s'"]*/g,
  },
  {
    name: 'provider-key-assignment',
    re: /(?:^|["'`])(META_MODEL_API_KEY|BASETEN_API_KEY|TYPESAFE_API_KEY)\s*[:=]\s*["']?([^\s"']{12,})/gm,
  },
];
const PLACEHOLDER = /dummy|stub|decoy|fake|synthetic|probe|placeholder|example|sample/i;

function git(gitArgs, opts = {}) {
  return execFileSync('git', gitArgs, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
}

function scanText(text, location, scope, sink) {
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (name === 'provider-key-assignment') {
        const value = m[2].replace(/["';,]+$/, '');
        // Not findings: a fragment carrying an escape sequence or
        // a template bracket, a single repeated character, or a
        // value carrying a known placeholder word. The pattern
        // itself anchors the variable name to a line start or a
        // quote, so a code expression such as an env property
        // assignment to another variable never matches.
        if (/[\\<>]/.test(value)) continue;
        if (PLACEHOLDER.test(value) || /^(.)\1+$/.test(value)) continue;
        sink.push({ scope, pattern: name, location, variable: m[1] });
      } else {
        sink.push({ scope, pattern: name, location });
      }
    }
  }
  if (WITH_VALUES) {
    for (const v of storeValues) {
      if (v.value && text.includes(v.value)) {
        sink.push({ scope, pattern: 'store-value', location, variable: v.name });
      }
    }
  }
}

// The leftover check runs before any scan result is claimed.
const leftovers = findLeftoverStoreTemps(ROOT);
const leftoverNames = new Set(leftovers.map((f) => f.name));

// Expected holdings: the store file itself, and a store temporary
// file whose write is still in progress.
function isExpectedHolding(scope, location) {
  if (scope !== 'ignored-file' && scope !== 'tracked-file' && scope !== 'untracked-file') return false;
  const base = basename(location);
  if (base === '.env.local') return true;
  if (/^\.env\.local\.tmp-\d+-\d+$/.test(base) && !leftoverNames.has(base)) return true;
  return false;
}

let storeValues = [];
if (WITH_VALUES) {
  const storeFile = join(ROOT, '.env.local');
  if (existsSync(storeFile)) {
    for (const raw of readFileSync(storeFile, 'utf8').split(/\r?\n/)) {
      const m = /^(DATABASE_URL|META_MODEL_API_KEY|BASETEN_API_KEY|TYPESAFE_API_KEY)=(.*)$/.exec(raw.trim());
      if (m && m[2].trim()) storeValues.push({ name: m[1], value: m[2].trim() });
    }
    console.log(`values mode: searching for the store values of ${storeValues.map((v) => v.name).join(', ') || 'no variables'} by location only`);
  } else {
    console.log('values mode: no local store at the scan root, value search skipped');
  }
}

const findings = [];
const holdings = [];
function collect(scope, location, text) {
  const sink = [];
  scanText(text, location, scope, sink);
  for (const f of sink) {
    if (f.pattern === 'store-value' && location === '.env.local') { holdings.push(f); continue; }
    if (isExpectedHolding(scope, location)) holdings.push(f);
    else findings.push(f);
  }
}

// ---- git object scopes ------------------------------------------------------
function blobIds(revListArgs) {
  let out = '';
  try { out = git(['rev-list', '--objects', ...revListArgs]); } catch { out = ''; }
  const ids = new Set();
  for (const line of out.split('\n')) {
    const sha = line.split(' ')[0];
    if (/^[0-9a-f]{40}$/.test(sha)) ids.add(sha);
  }
  return ids;
}
function scanBlobs(scope, ids) {
  for (const sha of ids) {
    let type = '';
    try { type = git(['cat-file', '-t', sha]).trim(); } catch { continue; }
    if (type !== 'blob') continue;
    let content = '';
    try { content = git(['cat-file', 'blob', sha]); } catch { continue; }
    collect(scope, `object ${sha}`, content);
  }
}
const reachable = blobIds(['--all']);
scanBlobs('reachable-object', reachable);
const reflogOnly = new Set([...blobIds(['--reflog'])].filter((id) => !reachable.has(id)));
scanBlobs('reflog-object', reflogOnly);
let dangling = new Set();
try {
  const fsck = git(['fsck', '--no-reflogs', '--dangling'], { stdio: ['ignore', 'pipe', 'pipe'] });
  for (const line of fsck.split('\n')) {
    const m = /^dangling blob ([0-9a-f]{40})$/.exec(line.trim());
    if (m) dangling.add(m[1]);
  }
} catch (e) {
  const out = `${e.stdout || ''}`;
  for (const line of out.split('\n')) {
    const m = /^dangling blob ([0-9a-f]{40})$/.exec(line.trim());
    if (m) dangling.add(m[1]);
  }
}
dangling = new Set([...dangling].filter((id) => !reachable.has(id) && !reflogOnly.has(id)));
scanBlobs('dangling-object', dangling);

// ---- working file scopes ------------------------------------------------------
function scanFiles(scope, gitArgs) {
  let out = '';
  try { out = git(gitArgs); } catch { out = ''; }
  for (const rel of out.split('\n').filter(Boolean)) {
    const p = join(ROOT, rel);
    try {
      const st = statSync(p);
      if (!st.isFile() || st.size > 5 * 1024 * 1024) continue;
      collect(scope, rel, readFileSync(p, 'utf8'));
    } catch { /* unreadable files are skipped, never fatal */ }
  }
}
scanFiles('tracked-file', ['ls-files']);
scanFiles('untracked-file', ['ls-files', '--others', '--exclude-standard']);
scanFiles('ignored-file', ['ls-files', '--others', '--ignored', '--exclude-standard']);

for (const f of holdings) {
  console.log(`expected-holding scope=${f.scope} pattern=${f.pattern}${f.variable ? ` variable=${f.variable}` : ''} location=${f.location}`);
}
for (const f of findings) {
  console.log(`finding scope=${f.scope} pattern=${f.pattern}${f.variable ? ` variable=${f.variable}` : ''} location=${f.location}`);
}
if (leftovers.length) {
  console.log(`leftover store temporary files at the scan root: ${leftovers.map((f) => f.name).join(', ')}`);
}
console.log(`secret-scan: ${findings.length} findings, ${holdings.length} expected holdings, scopes reachable ${reachable.size} objects, reflog only ${reflogOnly.size}, dangling ${dangling.size}`);
process.exit(findings.length ? 1 : 0);
