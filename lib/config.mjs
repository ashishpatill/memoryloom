/**
 * MemoryLoom configuration service (Iteration 1.1).
 *
 * One place that answers "what is provider X's API key?" for the
 * three hosted providers the product knows about: Meta Model API,
 * Baseten, and Jev (TypeSafe). Resolution order per provider:
 *
 *   1. the provider's environment variable,
 *   2. the local settings store,
 *   3. not configured.
 *
 * The settings store is a server-side file named `.env.local` in
 * the repository root, in dotenv KEY=value form. It is created with
 * permissions 0600, written by atomic replace (temp file in the
 * same directory, then rename), and `.env.local` is added to
 * `.gitignore` before the first write if it is not already there.
 *
 * Secrecy rules (binding):
 *  - Keys are never logged and never included in an error message.
 *    Any provider-supplied text that could echo a key is scrubbed
 *    of the key value before it leaves this module.
 *  - The only read view is the masked view: per provider
 *    { configured, last4, source }. No function here returns the
 *    store contents; resolveProviderKey returns ONE provider's key
 *    to server-side callers that need to make the call.
 *  - Keys are written nowhere except the store file.
 *
 * Every provider call site resolves its key here: the router
 * (Meta), lib/jev.mjs (Jev) and lib/decisions.mjs (Baseten
 * challengers), plus the Settings API in web/api.mjs.
 */
import { chmodSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Provider registry. `probe` is the one harmless read used by the
 * test endpoint: a models list for every provider. For Jev the
 * models list is the probe its own API documentation uses to prove
 * a key is accepted, so the test makes no decision call at all and
 * costs nothing beyond the read.
 */
export const PROVIDERS = {
  meta: {
    id: 'meta',
    label: 'Meta Model API',
    envVar: 'META_API_KEY',
    envAliases: ['META_MODEL_API_KEY'],
    baseUrlEnv: 'META_MODEL_BASE_URL',
    defaultBaseUrl: 'https://api.meta.ai',
    probePath: '/v1/models',
    keyHint: 'a Meta Model API key from dev.meta.ai',
  },
  baseten: {
    id: 'baseten',
    label: 'Baseten',
    envVar: 'BASETEN_API_KEY',
    baseUrlEnv: 'BASETEN_BASE_URL',
    defaultBaseUrl: 'https://inference.baseten.co',
    probePath: '/v1/models',
    keyHint: 'a Baseten API key from the Baseten workspace settings',
  },
  jev: {
    id: 'jev',
    label: 'Jev (TypeSafe)',
    envVar: 'JEV_API_KEY',
    envAliases: ['TYPESAFE_API_KEY'],
    baseUrlEnv: 'JEV_BASE_URL',
    defaultBaseUrl: 'https://api.typesafe.ai',
    probePath: '/v1/models',
    keyHint: 'a TypeSafe API key for the Jev decision models',
  },
};

// Friendly aliases accepted anywhere a provider id is taken.
const ALIASES = { typesafe: 'jev', meta_model_api: 'meta' };

export function providerDef(id) {
  const key = ALIASES[String(id || '').toLowerCase()] || String(id || '').toLowerCase();
  return PROVIDERS[key] || null;
}

export function providerIds() {
  return Object.keys(PROVIDERS);
}

/** Absolute path of the settings store file. */
export function storePath(opts = {}) {
  if (opts.storePath) return opts.storePath;
  if (process.env.MEMORYLOOM_SETTINGS_FILE) return process.env.MEMORYLOOM_SETTINGS_FILE;
  return join(REPO_ROOT, '.env.local');
}

// ---- store parsing ---------------------------------------------------------

/**
 * Parse dotenv-style content into a Map. Lines without an `=`, with
 * an empty name, or with an unterminated quote are corrupt and are
 * SKIPPED, never fatal: one bad line must not lock the user out of
 * every other provider. Unknown names are preserved by the writer.
 */
function parseStore(content) {
  const map = new Map();
  for (const rawLine of String(content).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue; // corrupt line: no name or no '='
    const name = line.slice(0, eq).trim().replace(/^export\s+/, '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue; // corrupt name
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      if (value.length < 2 || !value.endsWith(quote)) continue; // unterminated quote: corrupt
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    map.set(name, value);
  }
  return map;
}

function readStoreMap(opts = {}) {
  const path = storePath(opts);
  if (!existsSync(path)) return new Map();
  try {
    return parseStore(readFileSync(path, 'utf8'));
  } catch {
    return new Map(); // an unreadable store reads as empty, never throws with content
  }
}

function formatValue(value) {
  // Keys are validated to carry no whitespace, so plain form is the
  // norm; quote only if a future value ever needs it.
  if (/[\s#"']/.test(value)) return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return value;
}

/**
 * Ensure `.env.local` is ignored by git in the store's directory
 * BEFORE any write. No-op when there is no .gitignore there (the
 * store then lives outside the repo, e.g. a test temp directory).
 */
export const STORE_TMP_PATTERN = '.env.local.tmp-*';

function ensureGitignore(dir) {
  const gi = join(dir, '.gitignore');
  if (!existsSync(gi)) return;
  const content = readFileSync(gi, 'utf8');
  const lines = content.split(/\r?\n/).map((l) => l.trim());
  const hasStore = lines.includes('.env.local') || lines.includes('/.env.local');
  const hasTmp = lines.includes(STORE_TMP_PATTERN) || lines.includes(`/${STORE_TMP_PATTERN}`);
  if (hasStore && hasTmp) return;
  let next = content.replace(/\n?$/, '\n');
  if (!hasStore) next += '.env.local\n';
  if (!hasTmp) next += `${STORE_TMP_PATTERN}\n`;
  writeFileSync(gi, next, 'utf8');
}

/**
 * Atomically replace the store with `map` merged over the current
 * file. Unrelated lines (comments and other variables) survive:
 * only the lines for names in `updates` change. A null update value
 * removes that name's line.
 */
function writeStore(updates, opts = {}) {
  const path = storePath(opts);
  const dir = dirname(path);
  ensureGitignore(dir);
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const kept = [];
  const seen = new Set();
  for (const rawLine of existing.split(/\r?\n/)) {
    const line = rawLine.trim();
    const eq = line.indexOf('=');
    const name = eq > 0 && !line.startsWith('#') ? line.slice(0, eq).trim().replace(/^export\s+/, '') : null;
    if (name && updates.has(name)) {
      seen.add(name);
      const v = updates.get(name);
      if (v !== null) kept.push(`${name}=${formatValue(v)}`);
      continue; // replaced above, or dropped when the update is null
    }
    if (rawLine.trim() !== '') kept.push(rawLine);
  }
  for (const [name, v] of updates) {
    if (!seen.has(name) && v !== null) kept.push(`${name}=${formatValue(v)}`);
  }
  const tmp = join(dir, `.env.local.tmp-${process.pid}-${Date.now()}`);
  writeFileSync(tmp, kept.length ? kept.join('\n') + '\n' : '', { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600); // also tightens a pre-existing loose file
}

// ---- resolution ------------------------------------------------------------

/**
 * Resolve one provider's key: environment first, then the store.
 * Returns { key, source } with source 'env' | 'store' | null.
 * Server-side only — never expose `key` through an API response.
 */
export function resolveProviderKey(id, opts = {}) {
  const def = providerDef(id);
  if (!def) return { key: null, source: null };
  for (const name of [def.envVar, ...(def.envAliases || [])]) {
    const envVal = String(process.env[name] || '').trim();
    if (envVal) return { key: envVal, source: 'env' };
  }
  const store = readStoreMap(opts);
  for (const name of [def.envVar, ...(def.envAliases || [])]) {
    const stored = store.get(name);
    if (stored && String(stored).trim()) return { key: String(stored).trim(), source: 'store' };
  }
  return { key: null, source: null };
}

function last4Of(key) {
  if (!key) return null;
  // A very short value is not a real key; showing its tail would
  // show most or all of it, so report no tail instead.
  if (key.length < 8) return null;
  return key.slice(-4);
}

/** The masked view for one provider — the only read shape allowed. */
export function maskedEntry(id, opts = {}) {
  const def = providerDef(id);
  if (!def) return null;
  const { key, source } = resolveProviderKey(def.id, opts);
  return { configured: Boolean(key), last4: last4Of(key), source };
}

/** The masked view for every provider: { meta: …, baseten: …, jev: … }. */
export function maskedSettings(opts = {}) {
  const out = {};
  for (const id of providerIds()) out[id] = maskedEntry(id, opts);
  return out;
}

// ---- writes ------------------------------------------------------------------

function validateKey(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!key) return { ok: false, error: 'api_key is required' };
  if (/\s/.test(key)) return { ok: false, error: 'api_key must not contain whitespace' };
  if (key.length > 512) return { ok: false, error: 'api_key is too long' };
  return { ok: true, key };
}

/** Save a provider key into the store. Returns the masked entry. */
export function saveProviderKey(id, value, opts = {}) {
  const def = providerDef(id);
  if (!def) return { status: 400, payload: { error: 'unknown provider' } };
  const v = validateKey(value);
  if (!v.ok) return { status: 400, payload: { error: v.error } };
  const updates = new Map([[def.envVar, v.key]]);
  for (const alias of def.envAliases || []) updates.set(alias, null);
  writeStore(updates, opts);
  return { status: 200, payload: { provider: def.id, ...maskedEntry(def.id, opts) } };
}

/** Remove a provider key from the store. Returns the masked entry. */
export function removeProviderKey(id, opts = {}) {
  const def = providerDef(id);
  if (!def) return { status: 400, payload: { error: 'unknown provider' } };
  const updates = new Map([[def.envVar, null]]);
  for (const alias of def.envAliases || []) updates.set(alias, null);
  writeStore(updates, opts);
  return { status: 200, payload: { provider: def.id, ...maskedEntry(def.id, opts) } };
}

// ---- test probe ---------------------------------------------------------------

function scrub(text, key) {
  const s = String(text ?? '');
  if (!key) return s;
  return s.split(key).join('[redacted]');
}

/**
 * One harmless read against the provider: GET its models list with
 * the key as the bearer token. An optional `candidateKey` tests a
 * key the user has typed but not saved yet. The result reports the
 * HTTP status and a plain outcome; it never carries the key or a
 * provider body verbatim (bodies are not read at all).
 *
 * Returns { ok, provider, http_status, latency_ms, source, error? }.
 * ok is true only on HTTP 200. A bad key fails honestly: ok false
 * with the real status (401/403) named in the error.
 */
export async function testProvider(id, { candidateKey = null, fetchImpl = fetch, timeoutMs = 10_000, ...opts } = {}) {
  const def = providerDef(id);
  if (!def) return { ok: false, provider: null, error: 'unknown provider' };
  let key;
  let source;
  if (candidateKey !== null && candidateKey !== undefined && String(candidateKey).trim() !== '') {
    const v = validateKey(candidateKey);
    if (!v.ok) return { ok: false, provider: def.id, error: v.error };
    key = v.key;
    source = 'candidate';
  } else {
    const r = resolveProviderKey(def.id, opts);
    key = r.key;
    source = r.source;
  }
  if (!key) {
    return { ok: false, provider: def.id, http_status: null, source: null, error: `no key configured — paste ${def.keyHint} and save first` };
  }
  const base = String(process.env[def.baseUrlEnv] || def.defaultBaseUrl).replace(/\/$/, '');
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${base}${def.probePath}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      signal: ctrl.signal,
      redirect: 'error',
    });
    // Drain and discard the body so the socket frees up; the body is
    // never read into a result, a log, or an error.
    try { await res.text(); } catch { /* ignore */ }
    const latency = Date.now() - started;
    if (res.status === 200) {
      return { ok: true, provider: def.id, http_status: 200, latency_ms: latency, source };
    }
    const hint =
      res.status === 401 || res.status === 403
        ? 'the provider rejected this key'
        : 'the provider did not answer the models read';
    return { ok: false, provider: def.id, http_status: res.status, latency_ms: latency, source, error: `${def.label} returned HTTP ${res.status} — ${hint}` };
  } catch (e) {
    const latency = Date.now() - started;
    const msg = e && e.name === 'AbortError' ? `timed out after ${timeoutMs} ms` : 'network error reaching the provider';
    return { ok: false, provider: def.id, http_status: null, latency_ms: latency, source, error: scrub(`${def.label}: ${msg}`, key) };
  } finally {
    clearTimeout(timer);
  }
}

// ---- leftover temporary store files ----------------------------------------
// Section 10.7 of the frozen master plan. A temporary store file is a
// permitted holding only while its write is in progress. The file age
// is taken from the timestamp in the file name, never from the file
// system clock. A file older than one hour is a leftover even when the
// process id it carries is still alive, because the store writer runs
// inside the long lived web server process. The process alive proof
// decides only files that are one hour old or younger.

export const STORE_TMP_MAX_AGE_MS = 3_600_000;
const STORE_TMP_NAME = /^\.env\.local\.tmp-(\d+)-(\d+)$/;

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Scan a directory for leftover store temporary files. Returns one
 * finding per leftover, with the file name, the process id and the
 * timestamp read from the name, the age in milliseconds and the rule
 * that classified it. Files whose write is proven still in progress
 * (one hour old or younger, process alive) are not findings.
 */
export function findLeftoverStoreTemps(dir, now = Date.now()) {
  const findings = [];
  if (!existsSync(dir)) return findings;
  for (const name of readdirSync(dir)) {
    const m = STORE_TMP_NAME.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    const stamp = Number(m[2]);
    const ageMs = now - stamp;
    if (ageMs > STORE_TMP_MAX_AGE_MS) {
      findings.push({ name, pid, stamp, ageMs, rule: 'older than one hour' });
    } else if (!pidAlive(pid)) {
      findings.push({ name, pid, stamp, ageMs, rule: 'writer process not alive' });
    }
  }
  return findings;
}
