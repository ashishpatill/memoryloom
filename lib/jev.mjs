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
 * (lib/config.mjs): the TYPESAFE_API_KEY environment variable first,
 * then the local Settings store. Keys are never logged.
 *
 * Discipline (binding):
 *  - Model pinned to jev-1.13.0 in router/config.json.
 *  - Every call is logged to the router spend log (provider 'jev')
 *    with an estimated input-token count, and served from the
 *    content-hash cache when identical.
 *  - Transport discipline: retry 429 /
 *    503 / 529 and timeouts with backoff; anything else raises
 *    JevError, and callers MUST fail closed on JevError.
 */
import { resolveProviderKey } from './config.mjs';
import { cacheGet, cacheKey, cachePut, estimateCostUsd, logSpend, routerConfig } from '../router/spend.mjs';

export class JevError extends Error {}

const CONFIG = routerConfig();
const MODEL = CONFIG.jev?.model || 'jev-1.13.0';

function baseUrl() {
  return (process.env.JEV_BASE_URL || CONFIG.jev?.base_url || 'https://api.typesafe.ai').replace(/\/$/, '');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postSystemOne(state, questions) {
  const timeoutMs = Number(process.env.JEV_TIMEOUT_MS || 30_000);
  const delays = [1000, 3000];
  let lastError = null;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    const { key: token } = resolveProviderKey('jev');
    if (!token) throw new JevError('jev: no API key configured (set TYPESAFE_API_KEY or add one in Settings)');
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
 */
export async function jevEvaluate(taskLabel, state, questions) {
  const key = cacheKey('jev', MODEL, taskLabel, { state, questions });
  const hit = cacheGet(key);
  if (hit) {
    logSpend({
      at: new Date().toISOString(),
      provider: 'jev',
      model: MODEL,
      task: taskLabel,
      spend_class: 'decisions',
      input_tokens: 0,
      output_tokens: 0,
      est_cost_usd: 0,
      cached: true,
      synthetic: true,
    });
    return { answers: hit.answers, fromCache: true };
  }
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
    spend_class: 'decisions',
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
