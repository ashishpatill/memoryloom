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
// WEB_ALLOWLIST or BACKEND_ALLOWLIST, with a reason, an owner, an
// owning iteration and a review date (card S3b). An entry with a
// missing field fails, and an entry whose review date has passed
// fails, so an exception cannot quietly outlive its review.
// Named exceptions are debt, owned — not permission slips:
// every entry is re-verified on each run (Rule B3) so a stale exception
// fails too and the debt list cannot silently rot.
//
// Imports from router/spend.mjs are enumerated by function in
// SPEND_IMPORT_ALLOWLIST (card S3b). A backend or web server file
// may import only the functions named for it, so the spend ledger
// surface each layer touches is explicit, not blanket.
// Owning file: checks/architecture.mjs
// Accountable layer: All layers
// Provider need: None
// Declared mode: Keyless, runs as step 2 of the verify entry

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
  {
    file: 'web/api.mjs',
    specifier: '../router/spend.mjs',
    reason: 'the console API reads the spend log and router config to render the providers view; it holds no provider key and calls no provider',
    owner: 'project owner',
    owning_iteration: 'card S3b',
    review_date: '2026-12-15',
  },
];

const BACKEND_ALLOWLIST = [
  {
    file: 'lib/jev.mjs',
    reason: 'the Jev decision client: the decision layer predates the router interface and is called by the gate. Renewed by card S3b with a dated retirement task: move the Jev client behind the router interface, or renew this entry again with fresh evidence, by the review date',
    owner: 'project owner',
    owning_iteration: 'card S3b',
    review_date: '2026-12-15',
  },
  {
    file: 'lib/decisions.mjs',
    reason: 'the decision-backend challenger adapters call the Baseten System One endpoint directly; they are spend-logged and probe-gated. Renewed by card S3b with a dated retirement task: move the decision backends behind the router interface with the decisions path, or renew this entry again with fresh evidence, by the review date',
    owner: 'project owner',
    owning_iteration: 'card S3b',
    review_date: '2026-12-15',
  },
  {
    file: 'lib/config.mjs',
    reason: 'the configuration service test probe: one harmless models-list read per provider so Settings can test a key; the config service is the sanctioned owner of provider reachability tests and never returns a key or a provider body',
    owner: 'project owner',
    owning_iteration: 'card S3b',
    review_date: '2026-12-15',
  },
];

// The functions each file may import from router/spend.mjs, named
// one by one (card S3b). A file absent from this map may not
// import the spend ledger at all.
const SPEND_IMPORT_ALLOWLIST = {
  'lib/jev.mjs': ['cacheGet', 'cacheKey', 'cachePut', 'estimateCostUsd', 'logSpend', 'readSpendLog', 'routerConfig'],
  'lib/decisions.mjs': ['budgetBlock', 'cacheGet', 'cacheKey', 'cachePut', 'estimateCostUsd', 'logSpend', 'routerConfig'],
  'web/api.mjs': ['readSpendLog', 'routerConfig'],
};

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

/** The names one import statement binds from a specifier ending in suffix. */
function importedNames(content, suffix) {
  const names = [];
  const re = /import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    if (!m[2].endsWith(suffix)) continue;
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name) names.push(name);
    }
  }
  return names;
}

const ENTRY_FIELDS = ['file', 'reason', 'owner', 'owning_iteration', 'review_date'];

/**
 * The allowlist entry contract (card S3b). Returns a problem
 * string, or null when the entry stands: every field present and
 * the review date today or later.
 */
function entryProblem(entry) {
  if (!entry || typeof entry !== 'object') return 'entry is not an object';
  for (const field of ENTRY_FIELDS) {
    if (!entry[field] || typeof entry[field] !== 'string') return `missing field ${field}`;
  }
  const review = new Date(`${entry.review_date}T00:00:00Z`);
  if (Number.isNaN(review.getTime())) return `review_date ${entry.review_date} does not parse`;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  if (review.getTime() < today.getTime()) return `review date ${entry.review_date} has passed`;
  return null;
}

function isDirectProviderCallSite(content) {
  return /fetch(Impl)?\s*\(/.test(content) && PROVIDER_MARKERS.some((marker) => content.includes(marker));
}

console.log('named exceptions (debt, owned):');
for (const entry of WEB_ALLOWLIST) {
  console.log(`  ${entry.file} -> ${entry.specifier}: ${entry.reason} [owner ${entry.owner}, ${entry.owning_iteration}, review by ${entry.review_date}]`);
}
for (const entry of BACKEND_ALLOWLIST) {
  console.log(`  ${entry.file}: ${entry.reason} [owner ${entry.owner}, ${entry.owning_iteration}, review by ${entry.review_date}]`);
}

// ENTRY CONTRACT (card S3b): every allowlist entry carries its
// owner, its owning iteration and a review date that has not
// passed. The two fixture entries prove the check fails on an
// expired entry and on a field missing entry, on the same code
// path the real entries take.
{
  const expiredFixture = {
    file: 'lib/fixture-expired.mjs',
    reason: 'fixture entry whose review date has passed',
    owner: 'project owner',
    owning_iteration: 'card S3b',
    review_date: '2020-01-01',
  };
  assert(entryProblem(expiredFixture) !== null, 'the check fails on an expired fixture exception entry (card S3b)');
  const missingFixture = { file: 'lib/fixture-missing.mjs', reason: 'fixture entry with fields missing' };
  assert(entryProblem(missingFixture) !== null, 'the check fails on a fixture entry with a missing field (card S3b)');
  for (const entry of [...WEB_ALLOWLIST, ...BACKEND_ALLOWLIST]) {
    const problem = entryProblem(entry);
    assert(problem === null, `allowlist entry carries owner, owning iteration and a live review date: ${entry.file}`, problem || '');
  }
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
        // The spend ledger enumeration binds the web server too
        // (card S3b): only the functions named for the file.
        if (specifier.endsWith('router/spend.mjs')) {
          const allowed = SPEND_IMPORT_ALLOWLIST[file.rel] || [];
          for (const name of importedNames(file.content, 'router/spend.mjs')) {
            if (!allowed.includes(name)) {
              violations++;
              assert(false, `web server file imports a spend ledger function outside its enumerated list: ${file.rel}`, `imports ${name}`);
            }
          }
        }
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
// router/router.mjs (the router interface) or router/spend.mjs
// (the shared spend ledger — a data file; it calls no provider
// and holds no key). Spend ledger imports are enumerated by
// function in SPEND_IMPORT_ALLOWLIST (card S3b): a file may
// import only the functions named for it.
{
  let violations = 0;
  for (const file of backendFiles) {
    for (const specifier of importSpecifiers(file.content)) {
      if (!specifier.includes('router/')) continue;
      if (specifier.endsWith('router/router.mjs')) continue;
      if (specifier.endsWith('router/spend.mjs')) {
        const allowed = SPEND_IMPORT_ALLOWLIST[file.rel];
        if (!allowed) {
          violations++;
          assert(false, `backend file imports the spend ledger without an enumerated entry: ${file.rel}`, `imports ${specifier}`);
          continue;
        }
        for (const name of importedNames(file.content, 'router/spend.mjs')) {
          if (!allowed.includes(name)) {
            violations++;
            assert(false, `backend file imports a spend ledger function outside its enumerated list: ${file.rel}`, `imports ${name}`);
          }
        }
        continue;
      }
      violations++;
      assert(false, `backend file imports the AI layer outside the router interface: ${file.rel}`, `imports ${specifier}`);
    }
  }
  if (violations === 0) {
    assert(true, 'backend (lib/, mcp/, api/) imports the AI layer only through router/router.mjs or its enumerated spend ledger functions');
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

// B4 spend enumeration honesty: each enumerated list names exactly
// the functions its file imports from the spend ledger today, so
// the enumeration cannot drift in either direction.
for (const [file, allowed] of Object.entries(SPEND_IMPORT_ALLOWLIST)) {
  const f = byRel.get(file);
  const imported = f ? importedNames(f.content, 'router/spend.mjs') : [];
  const exact =
    imported.length === allowed.length && allowed.every((name) => imported.includes(name));
  assert(exact, `spend enumeration matches the real imports: ${file}`, `imports ${imported.join(', ')}`);
}

console.log(failures === 0 ? 'ALL GREEN' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

