/**
 * Pre run database gate (card S1a, Section 10.4 of the frozen master
 * plan). Before any suite, seed, capture, rehearsal or demo command
 * connects for writes, the resolved DATABASE_URL is checked here.
 * Only the host, the port and the database name are ever read from
 * the URL. The full URL is never printed, returned or logged.
 *
 * A target passes when host, port and database name together match
 * the throwaway allowlist in checks/db-allowlist.json. The real
 * memory database is forbidden for check and demo writes in every
 * case. A hosted target outside the allowlist passes only under the
 * named exception mechanism. The calling entry point passes its
 * operation identity in code, a named operation record created
 * before the run sits in checks/out, and a named environment signal
 * carries the operation name. The record and the signal are
 * confirming signals only. All three must be present, must agree
 * with the invocation and must still be current, checked before any
 * connection or write.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FORBIDDEN_DATABASE = 'bot_memory';
export const SEED_OPERATION = 'hosted-seed';
export const SCHEMA_OPERATION = 'hosted-schema';
export const SCHEMA_SIGNAL = 'MEMORYLOOM_ALLOW_HOSTED_SCHEMA';
export const OPERATION_SIGNAL = 'MEMORYLOOM_DB_OPERATION';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWLIST_PATH = path.join(REPO_ROOT, 'checks', 'db-allowlist.json');
const OUT_DIR = path.join(REPO_ROOT, 'checks', 'out');

let cachedAllowlist = null;

export function parseDbTarget(url) {
  if (typeof url !== 'string' || url.trim() === '') return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!parsed.hostname) return null;
  let database = parsed.pathname.replace(/^\//, '');
  try {
    database = decodeURIComponent(database);
  } catch {
    // Keep the raw path value when decoding fails.
  }
  if (!database) return null;
  const port = parsed.port ? Number(parsed.port) : 5432;
  if (!Number.isFinite(port)) return null;
  return { host: parsed.hostname, port, database };
}

export function loadAllowlist() {
  if (cachedAllowlist !== null) return cachedAllowlist;
  try {
    const parsed = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
    cachedAllowlist = parsed && Array.isArray(parsed.entries) ? parsed : { entries: [] };
  } catch {
    cachedAllowlist = { entries: [] };
  }
  return cachedAllowlist;
}

export function matchesAllowlist(target, allowlist) {
  if (!target || !allowlist || !Array.isArray(allowlist.entries)) return false;
  return allowlist.entries.some((entry) => {
    if (!entry || entry.host !== target.host) return false;
    if (Number(entry.port) !== Number(target.port)) return false;
    const databases = Array.isArray(entry.databases) ? entry.databases : [];
    if (databases.includes(target.database)) return true;
    const prefixes = Array.isArray(entry.databasePrefixes) ? entry.databasePrefixes : [];
    return prefixes.some((p) => typeof p === 'string' && p !== '' && target.database.startsWith(p));
  });
}

export function readOperationRecord(operation, outDir = OUT_DIR) {
  if (typeof operation !== 'string' || operation === '') return null;
  try {
    return JSON.parse(readFileSync(path.join(outDir, `db-operation-${operation}.json`), 'utf8'));
  } catch {
    return null;
  }
}

export function signalNameFor(operation) {
  return operation === SCHEMA_OPERATION ? SCHEMA_SIGNAL : OPERATION_SIGNAL;
}

export function evaluateDbGate({ url, operation = null, env = process.env, now = Date.now(), allowlist = null, outDir = null } = {}) {
  const target = parseDbTarget(url);
  if (target === null) {
    return { allowed: false, via: 'none', target: null, reason: 'the database target could not be parsed or has no database name' };
  }
  const label = `${target.host}:${target.port}/${target.database}`;
  if (target.database === FORBIDDEN_DATABASE) {
    return {
      allowed: false, via: 'none', target,
      reason: `the real memory database ${FORBIDDEN_DATABASE} is forbidden for check and demo writes (target ${label})`,
    };
  }
  const effective = allowlist !== null && allowlist !== undefined ? allowlist : loadAllowlist();
  if (matchesAllowlist(target, effective)) {
    return { allowed: true, via: 'allowlist', target, reason: `target ${label} matches the throwaway allowlist` };
  }
  if (typeof operation !== 'string' || operation === '') {
    return {
      allowed: false, via: 'none', target,
      reason: `target ${label} is outside the allowlist and the calling entry point passed no operation identity`,
    };
  }
  const signalName = signalNameFor(operation);
  const signalValue = env ? env[signalName] : undefined;
  if (signalValue === undefined || signalValue === null || signalValue === '') {
    return {
      allowed: false, via: 'none', target,
      reason: `target ${label} is outside the allowlist and the environment signal ${signalName} for operation ${operation} is missing`,
    };
  }
  if (signalValue !== operation) {
    return {
      allowed: false, via: 'none', target,
      reason: `target ${label} is outside the allowlist and the environment signal ${signalName} does not carry the operation name ${operation}`,
    };
  }
  const record = readOperationRecord(operation, outDir || OUT_DIR);
  if (record === null) {
    return {
      allowed: false, via: 'none', target,
      reason: `target ${label} is outside the allowlist and no operation record for operation ${operation} exists in the checks output folder`,
    };
  }
  if (record.operation !== operation) {
    return {
      allowed: false, via: 'none', target,
      reason: `the operation record names operation ${record.operation || 'none'} and not ${operation}, for target ${label}`,
    };
  }
  const rt = record.target;
  if (!rt || rt.host !== target.host || Number(rt.port) !== Number(target.port) || rt.database !== target.database) {
    return {
      allowed: false, via: 'none', target,
      reason: `the operation record target does not match the resolved target ${label} for operation ${operation}`,
    };
  }
  const expires = Date.parse(record.expires_at);
  if (!Number.isFinite(expires)) {
    return {
      allowed: false, via: 'none', target,
      reason: `the operation record for operation ${operation} has no readable expiry, for target ${label}`,
    };
  }
  if (expires <= now) {
    return {
      allowed: false, via: 'none', target,
      reason: `the operation record for operation ${operation} expired at ${record.expires_at}, for target ${label}`,
    };
  }
  return {
    allowed: true, via: 'operation', target,
    reason: `target ${label} allowed under the operation record for ${operation} from card ${record.card || 'unnamed'}`,
  };
}

export function assertDbAllowed(url, opts = {}) {
  const result = evaluateDbGate({ ...(opts || {}), url });
  if (result.allowed) return result;
  throw new Error(`db gate refusal: ${result.reason}`);
}
