/**
 * Spend log, budgets and the content-hash cache for paid router calls.
 *
 * Rules enforced here (credit-efficiency plan, binding):
 *  - Every paid call is logged to router/spend-log.jsonl with provider,
 *    model, task class, tokens and estimated cost. A call the router
 *    cannot log does not happen (append happens before the result is
 *    returned to the caller).
 *  - Content-hash cache: an identical (provider, model, task, payload)
 *    call is served from router/cache/ and never paid for twice.
 *  - Stop-loss: at 80% of a provider's total budget or of the spend
 *    class budget, paid calls for that provider/class are refused and
 *    routing falls back to free/local.
 */
import { createHash } from 'node:crypto';
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
// The spend log and the cache live beside this module in the local
// build. A hosted bundle can be read only, so when this directory is
// not writable the state moves to the operating system's temp area
// instead. The rule above is unchanged: a call the router cannot
// log does not happen, on either path.
function stateDir() {
  try {
    accessSync(__dir, constants.W_OK);
    return __dir;
  } catch {
    const alt = join(tmpdir(), 'memoryloom-router');
    mkdirSync(alt, { recursive: true });
    return alt;
  }
}
const STATE_DIR = stateDir();
export const SPEND_LOG = join(STATE_DIR, 'spend-log.jsonl');
const CACHE_DIR = join(STATE_DIR, 'cache');
const CONFIG = JSON.parse(readFileSync(join(__dir, 'config.json'), 'utf8'));

export function routerConfig() {
  return CONFIG;
}

export function estimateCostUsd(provider, model, usage) {
  const entry = CONFIG.pricing_usd_per_1m[provider];
  if (!entry || !usage) return 0;
  // A provider entry may carry per-model prices under `models`;
  // the flat {in, out} on the entry is the default for its models.
  const p = (model && entry.models && entry.models[model]) || entry;
  const inp = usage.input_tokens || usage.prompt_tokens || 0;
  const cached = usage.cached_input_tokens || 0;
  const out = usage.output_tokens || usage.completion_tokens || 0;
  const freshIn = Math.max(0, inp - cached);
  const cost =
    (freshIn / 1e6) * p.in +
    (cached / 1e6) * (p.cached_in ?? p.in) +
    (out / 1e6) * p.out;
  return Math.round(cost * 1e6) / 1e6;
}

/** Append one spend record. Throws if the log cannot be written. */
export function logSpend(record) {
  mkdirSync(dirname(SPEND_LOG), { recursive: true });
  appendFileSync(SPEND_LOG, JSON.stringify(record) + '\n');
}

export function readSpendLog() {
  if (!existsSync(SPEND_LOG)) return [];
  return readFileSync(SPEND_LOG, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
}

/** Summarise spend for one provider, optionally one spend class. */
export function spendSummary(provider, spendClass = null) {
  const rows = readSpendLog().filter(
    (r) => r.provider === provider && !r.cached && (spendClass ? r.spend_class === spendClass : true)
  );
  return {
    calls: rows.length,
    input_tokens: rows.reduce((a, r) => a + (r.input_tokens || 0), 0),
    output_tokens: rows.reduce((a, r) => a + (r.output_tokens || 0), 0),
    est_cost_usd: Math.round(rows.reduce((a, r) => a + (r.est_cost_usd || 0), 0) * 1e6) / 1e6,
  };
}

/**
 * Stop-loss check. Returns null when the paid call may proceed, or a
 * reason string when the budget guard refuses it.
 */
export function budgetBlock(provider, spendClass) {
  const budget = CONFIG.budgets_usd[provider];
  if (!budget) return `no budget configured for ${provider}`;
  const limit = CONFIG.stop_loss_fraction;
  const total = spendSummary(provider);
  if (total.est_cost_usd >= budget.total * limit) {
    return `stop-loss: ${provider} total spend $${total.est_cost_usd} >= ${limit * 100}% of $${budget.total}`;
  }
  const classBudget = budget.classes[spendClass];
  if (classBudget != null) {
    const cls = spendSummary(provider, spendClass);
    if (cls.est_cost_usd >= classBudget * limit) {
      return `stop-loss: ${provider}/${spendClass} spend $${cls.est_cost_usd} >= ${limit * 100}% of $${classBudget}`;
    }
  }
  return null;
}

// ---- content-hash cache ---------------------------------------------------
// Key = (provider, model spec, task, payload). A provider whose output
// also depends on a rendered prompt (router.mjs prompt builders) exposes
// promptFingerprint(task, payload); paidCall then folds the fingerprint
// into the payload slot so a prompt edit can never serve a stale result.

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  return (
    '{' +
    Object.keys(value)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + stableStringify(value[k]))
      .join(',') +
    '}'
  );
}

export function cacheKey(provider, model, task, payload) {
  return createHash('sha256')
    .update(stableStringify({ provider, model, task, payload }))
    .digest('hex');
}

export function cacheGet(key) {
  const file = join(CACHE_DIR, key + '.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function cachePut(key, value) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(join(CACHE_DIR, key + '.json'), JSON.stringify(value));
}
