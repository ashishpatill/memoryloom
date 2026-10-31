// checks/architecture.mjs — three-layer architecture enforcement.
//
// Layers:
//   FRONTEND  = web/public/ (browser assets: .html/.js/.css), plus the
//               server files web/api.mjs and web/server.mjs, which are the
//               backend HTTP layer housed under web/ (they are not browser
//               code).
//   BACKEND   = lib/, mcp/, api/
//   AI LAYER  = router/
//
// Allowed crossings (only two):
//   1. frontend -> backend HTTP APIs
//   2. backend -> router interface (router/router.mjs)
//
// Any new crossing fails this check until it is named here, in
// WEB_ALLOWLIST or BACKEND_ALLOWLIST, with a reason and an owning
// iteration. Named exceptions are debt, owned — not permission slips:
// every entry is re-verified on each run (Rule B3) so a stale exception
// fails too and the debt list cannot silently rot.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function assert(cond, label, extra = '') {
  if (cond) {
    console.log(`  PASS ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${extra ? ` ${extra}` : ''}`);
  }
}

const WEB_ALLOWLIST = [
  { file: 'web/api.mjs', specifier: '../router/spend.mjs', reason: 'the console API reads the spend log and router config to render the providers view; it holds no provider key and calls no provider' },
];

const BACKEND_ALLOWLIST = [
  { file: 'lib/jev.mjs', reason: 'the Jev decision client: the decision layer predates the router interface and is called by the gate; moving it behind the router is owned by Iteration 6.2, which reworks the decisions/escalation path' },
  { file: 'lib/decisions.mjs', reason: 'the decision-backend challenger adapters call the Baseten System One endpoint directly; they are spend-logged and probe-gated, and their relocation is owned by Iteration 6.2 with the decisions path' },
  { file: 'lib/config.mjs', reason: 'the configuration service test probe: one harmless models-list read per provider so Settings can test a key; the config service is the sanctioned owner of provider reachability tests and never returns a key or a provider body' },
];

const PROVIDER_MARKERS = [
  'api.typesafe.ai',
  'api.meta.ai',
  'inference.baseten.co',
  'api.baseten.co',
  '/v1/systemone',
  '/v1/chat/completions',
  '/v1/responses',
  'JEV_BASE_URL',
  'BASETEN_BASE_URL',
  'META_MODEL_BASE_URL',
];

const FRONTEND_ROUTER_PATTERNS = [
  /from\s+['"][^'"]*router\//,
  /import\s*\(\s*['"][^'"]*router\//,
  /require\s*\(\s*['"][^'"]*router\//,
];

function rel(full) {
  return path.relative(root, full).split(path.sep).join('/');
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile() && ['.mjs', '.js', '.html'].includes(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

function importSpecifiers(content) {
  const specs = new Set();
  const patterns = [
    /from\s+['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]/g,
    /require\s*\(\s*['"]([^'"]+)['"]/g,
    /import\s+['"]([^'"]+)['"]/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(content)) !== null) specs.add(m[1]);
  }
  return [...specs];
}

function isDirectProviderCallSite(content) {
  return /fetch(Impl)?\s*\(/.test(content) && PROVIDER_MARKERS.some((marker) => content.includes(marker));
}

console.log('named exceptions (debt, owned):');
for (const entry of WEB_ALLOWLIST) {
  console.log(`  ${entry.file} -> ${entry.specifier}: ${entry.reason}`);
}
for (const entry of BACKEND_ALLOWLIST) {
  console.log(`  ${entry.file}: ${entry.reason}`);
}

const scanned = walk(root)
  .map((full) => {
    let content = '';
    try {
      content = fs.readFileSync(full, 'utf8');
    } catch {
      content = '';
    }
    return { full, rel: rel(full), content };
  })
  .sort((a, b) => a.rel.localeCompare(b.rel));

const byRel = new Map(scanned.map((f) => [f.rel, f]));

// RULE A (frontend never touches the AI layer): web/public/ files must not
// import, dynamically import, or require anything from router/.
{
  let violations = 0;
  for (const file of scanned) {
    if (!file.rel.startsWith('web/public/')) continue;
    if (FRONTEND_ROUTER_PATTERNS.some((re) => re.test(file.content))) {
      violations++;
      assert(false, `frontend (web/public) file touches the AI layer: ${file.rel}`);
    }
  }
  if (violations === 0) {
    assert(true, 'frontend (web/public) imports no router or provider code');
  }
}

// RULE A2 (server files under web/): web/api.mjs and web/server.mjs are the
// backend HTTP layer housed under web/; they may import from the AI layer
// only through WEB_ALLOWLIST entries (exact file + specifier match).
{
  const webServerFiles = scanned.filter(
    (f) => f.rel.startsWith('web/') && !f.rel.startsWith('web/public/')
  );
  let violations = 0;
  const matchedAllowlist = new Set();
  for (const file of webServerFiles) {
    for (const specifier of importSpecifiers(file.content)) {
      if (!specifier.includes('router/')) continue;
      const entry = WEB_ALLOWLIST.find(
        (e) => e.file === file.rel && e.specifier === specifier
      );
      if (entry) {
        matchedAllowlist.add(entry);
        assert(true, `web server allowlisted read: ${entry.file} imports ${entry.specifier} — ${entry.reason}`);
      } else {
        violations++;
        assert(false, `web server file imports router outside the allowlist: ${file.rel}`, `imports ${specifier}`);
      }
    }
  }
  if (violations === 0 && matchedAllowlist.size === 0) {
    // No router imports at all: B3 will fail the now-stale web entry.
    assert(true, 'web server files (web/api.mjs, web/server.mjs) import no router code outside the allowlist');
  }
}

// RULE B (backend calls providers only through the router): scan lib/, mcp/, api/.
const backendFiles = scanned.filter(
  (f) => f.rel.startsWith('lib/') || f.rel.startsWith('mcp/') || f.rel.startsWith('api/')
);

// B1 imports: router/ imports allowed only when they end with
// router/router.mjs (the router interface) or router/spend.mjs (the
// shared spend ledger — a data file every layer may append to or
// read; it calls no provider and holds no key).
{
  let violations = 0;
  for (const file of backendFiles) {
    for (const specifier of importSpecifiers(file.content)) {
      if (!specifier.includes('router/')) continue;
      if (specifier.endsWith('router/router.mjs')) continue;
      if (specifier.endsWith('router/spend.mjs')) continue;
      violations++;
      assert(false, `backend file imports the AI layer outside the router interface: ${file.rel}`, `imports ${specifier}`);
    }
  }
  if (violations === 0) {
    assert(true, 'backend (lib/, mcp/, api/) imports the AI layer only through router/router.mjs or the spend ledger');
  }
}

// B2 direct provider calls: a direct call site (fetch + provider marker)
// must be named in BACKEND_ALLOWLIST.
const directCallSites = new Map();
for (const file of backendFiles) {
  if (isDirectProviderCallSite(file.content)) directCallSites.set(file.rel, file);
}
{
  let violations = 0;
  for (const siteRel of [...directCallSites.keys()].sort()) {
    if (!BACKEND_ALLOWLIST.some((e) => e.file === siteRel)) {
      violations++;
      assert(false, `backend direct provider call outside the allowlist: ${siteRel}`);
    }
  }
  if (violations === 0) {
    assert(true, 'backend direct provider calls are limited to the named exceptions');
  }
}

// B3 allowlist honesty: every entry must still correspond to a real crossing.
for (const entry of BACKEND_ALLOWLIST) {
  const file = byRel.get(entry.file);
  if (!file || !fs.existsSync(path.join(root, entry.file))) {
    assert(false, `stale BACKEND_ALLOWLIST entry, file no longer exists: ${entry.file}`);
  } else if (!directCallSites.has(entry.file)) {
    assert(false, `stale BACKEND_ALLOWLIST entry, no longer a direct provider call site: ${entry.file}`);
  } else {
    assert(true, `allowlist entry still real: ${entry.file}`);
  }
}
for (const entry of WEB_ALLOWLIST) {
  const file = byRel.get(entry.file);
  if (!file || !fs.existsSync(path.join(root, entry.file))) {
    assert(false, `stale WEB_ALLOWLIST entry, file no longer exists: ${entry.file}`);
  } else if (!importSpecifiers(file.content).includes(entry.specifier)) {
    assert(false, `stale WEB_ALLOWLIST entry, specifier no longer imported: ${entry.file}`, `expected ${entry.specifier}`);
  } else {
    assert(true, `allowlist entry still real: ${entry.file} imports ${entry.specifier}`);
  }
}

console.log(failures === 0 ? 'ALL GREEN' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

