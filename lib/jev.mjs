/**
 * Jev decision client (TypeSafe System One API).
 *
 * Jev is MemoryLoom's decision layer for every enumerable, fixed-answer
 * decision (credit-efficiency plan, corrected 2026-10-30). It is a
 * hosted decision model, not a chat model: one endpoint,
 * POST /v1/systemone, taking a `state` plus a map of typed questions.
 * A Noul question returns the probability that the statement in its
 * instructions is true given the state.
 *
 * The API key comes from the configuration service
 * (lib/config.mjs): the JEV_API_KEY environment variable first,
 * then the local Settings store. Keys are never logged.
 *
 * Discipline (binding):
 *  - Model pinned to jev-1.13.0 in router/config.json.
 *  - Every call is logged to the router spend log (provider 'jev')
 *    with an estimated input-token count, and served from the
 *    content-hash cache when identical — but ONLY when a key is
 *    configured. The cache is never consulted before the key check:
 *    a cached verdict served to an unconfigured caller would defeat
 *    fail-closed (Iteration 5.3 re-review, Finding D: a keyless seed
 *    on a warm-cache tree silently recorded gate approvals and a
 *    lesson promotion, with no notice, exactly as if Jev had been
 *    asked live). Unconfigured means fail closed, cache or no cache.
 *  - Transport discipline: retry 429 /
 *    503 / 529 and timeouts with backoff; anything else raises
 *    JevError, and callers MUST fail closed on JevError.
 *  - Budget (frozen master plan, Section 8, card S3b): the router
 *    config holds one Jev budget entry, a single shared pool of $5
 *    across the gate_calibration, product and drill spend classes,
 *    with a per iteration cap of $1. Jev holds its own cap rule at
 *    the full pool cap, not the 80 percent stop loss rule the
 *    other providers use. The client checks the budget before a
 *    paid call and fails closed at the cap. A spend class outside
 *    the entry is rejected by the entry check in this file before
 *    anything else happens. Every spend row this client writes
 *    carries the caller's spend class and iteration identity.
 *  - The base URL resolves the environment first and then the
 *    provider default recorded in lib/config.mjs. The router
 *    config carries no base URL fallback (card S3b).
 */
import { resolveProviderKey, PROVIDERS } from './config.mjs';
import { cacheGet, cacheKey, cachePut, estimateCostUsd, logSpend, readSpendLog, routerConfig } from '../router/spend.mjs';

export class JevError extends Error {}

const CONFIG = routerConfig();
const MODEL = CONFIG.jev?.model || 'jev-1.13.0';

function baseUrl() {
  return (process.env.JEV_BASE_URL || PROVIDERS.jev.defaultBaseUrl).replace(/\/$/, '');
}

// ---- the Jev budget --------------------------------------------------------

/** The Jev budget entry from the router config, or null. */
export function jevBudgetEntry() {
  return routerConfig().budgets_usd?.jev || null;
}

/** The spend classes inside the Jev budget entry. */
export function jevSpendClasses() {
  return Object.keys(jevBudgetEntry()?.classes || {});
}

/**
 * The Jev path's own entry check. A spend class outside the budget
 * entry is a programming error, and it is rejected here before the
 * key check, the cache and any paid call.
 */
export function assertJevSpendClass(spendClass) {
  if (!jevSpendClasses().includes(spendClass)) {
    throw new JevError(
      `jev: spend class '${spendClass}' is outside the Jev budget entry (classes: ${jevSpendClasses().join(', ')})`
    );
  }
}

/**
 * Uncached Jev spend totals from spend rows. Counts only rows
 * whose spend class stands inside the budget entry, so historical
 * rows written under a class the entry does not hold never count
 * toward the pool. Rows may be supplied by a test instead of read
 * from the log.
 */
export function jevSpendTotals(rows = null) {
  const classes = new Set(jevSpendClasses());
  const log = (rows || readSpendLog()).filter(
    (r) => r.provider === 'jev' && !r.cached && classes.has(r.spend_class)
  );
  const perIteration = new Map();
  let total = 0;
  for (const r of log) {
    const cost = r.est_cost_usd || 0;
    total += cost;
    if (r.iteration) perIteration.set(r.iteration, (perIteration.get(r.iteration) || 0) + cost);
  }
  return {
    total: Math.round(total * 1e6) / 1e6,
    perIteration: Object.fromEntries(
      [...perIteration.entries()].map(([k, v]) => [k, Math.round(v * 1e6) / 1e6])
    ),
  };
}

/**
 * The Jev budget check, run before a paid call. Returns a reason
 * string when the call must not happen, or null when it may
 * proceed. The pool is capped at the full entry total. An
 * iteration is capped at the per iteration figure from the entry.
 */
export function jevBudgetBlock({ iteration = null } = {}, rows = null) {
  const entry = jevBudgetEntry();
  if (!entry) return 'jev: no budget entry configured for provider jev';
  const totals = jevSpendTotals(rows);
  if (totals.total >= entry.total) {
    return `jev budget: shared pool spend $${totals.total} reached the $${entry.total} pool cap`;
  }
  if (iteration && entry.per_iteration_cap != null) {
    const mine = totals.perIteration[iteration] || 0;
    if (mine >= entry.per_iteration_cap) {
      return `jev budget: iteration ${iteration} spend $${mine} reached the $${entry.per_iteration_cap} per iteration cap`;
    }
  }
  return null;
}

/** The per iteration Jev report figure for one iteration identity. */
export function jevIterationReport(iteration, rows = null) {
  const entry = jevBudgetEntry();
  const totals = jevSpendTotals(rows);
  const total = totals.perIteration[iteration] || 0;
  return {
    iteration,
    total_usd: total,
    cap_usd: entry?.per_iteration_cap ?? null,
    within_cap: entry?.per_iteration_cap == null ? true : total < entry.per_iteration_cap,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postSystemOne(state, questions) {
  const timeoutMs = Number(process.env.JEV_TIMEOUT_MS || 30_000);
  const delays = [1000, 3000];
  let lastError = null;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    const { key: token } = resolveProviderKey('jev');
    if (!token) throw new JevError('jev: no API key configured (set JEV_API_KEY or add one in Settings)');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl()}/v1/systemone`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ state, model: MODEL, questions }),
        signal: ctrl.signal,
        redirect: 'error',
      });
      if ((res.status === 429 || res.status === 503 || res.status === 529) && attempt < delays.length) {
        const ra = Number(res.headers.get('Retry-After'));
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 20_000) : delays[attempt]);
        continue;
      }
      if (res.status !== 200) {
        throw new JevError(`jev HTTP ${res.status}`);
      }
      const body = await res.json();
      if (!body || typeof body.answers !== 'object' || body.answers === null) {
        throw new JevError('jev returned a malformed answers map');
      }
      return body.answers;
    } catch (e) {
      if (e instanceof JevError) throw e;
      lastError = e;
      if (attempt < delays.length) {
        await sleep(delays[attempt]);
        continue;
      }
      throw new JevError(`jev call failed: ${e.message || e}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new JevError(`jev call failed: ${lastError?.message || 'retries exhausted'}`);
}

/**
 * Evaluate a map of Noul questions against a state.
 * Returns { answers: {name: rawProbability}, fromCache }.
 * Throws JevError on any backend failure — callers fail closed.
 *
 * The caller threads its spend class and its iteration identity
 * through opts (spendClass, iteration). Both spend rows this call
 * can write, the cached row and the paid row, carry that same
 * class and that same iteration. opts.spendRows is a test seam
 * that feeds the budget check synthetic rows instead of the log.
 */
export async function jevEvaluate(taskLabel, state, questions, opts = {}) {
  const spendClass = opts.spendClass || 'product';
  const iteration = opts.iteration || null;
  // The entry check runs first. A class outside the budget entry
  // never reaches the key check, the cache or a paid call.
  assertJevSpendClass(spendClass);
  // Fail closed BEFORE the cache: with no key configured there is no
  // decision backend, and a cached answer must never impersonate one.
  if (!resolveProviderKey('jev').key) {
    throw new JevError('jev: no API key configured (set JEV_API_KEY or add one in Settings)');
  }
  const key = cacheKey('jev', MODEL, taskLabel, { state, questions });
  const hit = cacheGet(key);
  if (hit) {
    logSpend({
      at: new Date().toISOString(),
      provider: 'jev',
      model: MODEL,
      task: taskLabel,
      spend_class: spendClass,
      iteration,
      input_tokens: 0,
      output_tokens: 0,
      est_cost_usd: 0,
      cached: true,
      synthetic: true,
    });
    return { answers: hit.answers, fromCache: true };
  }
  // The budget check runs before the paid call and fails closed at
  // the pool cap and at the per iteration cap.
  const block = jevBudgetBlock({ spendClass, iteration }, opts.spendRows ?? null);
  if (block) throw new JevError(block);
  const answers = await postSystemOne(state, questions);
  const clean = {};
  for (const [name, q] of Object.entries(questions)) {
    const v = Number(answers?.[name]?.noul);
    if (!Number.isFinite(v) || v < 0 || v > 1) {
      throw new JevError(`jev answer for '${name}' is malformed or out of range`);
    }
    clean[name] = v;
  }
  const inputTokens = Math.ceil((String(state).length + JSON.stringify(questions).length) / 4);
  logSpend({
    at: new Date().toISOString(),
    provider: 'jev',
    model: MODEL,
    task: taskLabel,
    spend_class: spendClass,
    iteration,
    input_tokens: inputTokens,
    output_tokens: 0,
    est_cost_usd: estimateCostUsd('jev', MODEL, { input_tokens: inputTokens }),
    cached: false,
    synthetic: true,
  });
  cachePut(key, { answers: clean });
  return { answers: clean, fromCache: false };
}

/**
 * Piecewise calibration of a raw Jev probability — the calibration
 * used by the decision adapter, fitted on 2,091
 * ContractNLI judgements and passing the calibrated re-gate at 14/15.
 * Anchors: raw 0.05 -> 0.30 (cut line), raw 0.30 -> 0.80 (ship line).
 * Monotone: Jev's own ordering is preserved. A calibrated value >= 0.5
 * corresponds to raw >= 0.15.
 */
export function calibrateJevProbability(raw) {
  if (raw <= 0.05) return Math.round(Math.min(raw, 1) * 6 * 10000) / 10000;
  if (raw <= 0.3) return Math.round((0.3 + (raw - 0.05) * 2) * 10000) / 10000;
  return Math.round((0.8 + (raw - 0.3) * (0.2 / 0.7)) * 10000) / 10000;
}

export function jevModel() {
  return MODEL;
}

export function thresholdsLive() {
  return Boolean(routerConfig().jev?.thresholds_live);
}
