/**
 * Decision backends — the swappable layer under lib/gate.mjs.
 *
 * Every enumerable decision class (gate, consolidation, decay,
 * promotion) resolves its backend from router/config.json
 * `decision_backends`, defaulting to Jev for all classes. A backend
 * implements one contract:
 *
 *   evaluate(taskLabel, state, questions) -> { answers, fromCache }
 *
 * where questions is a map of System One typed questions and answers
 * maps each name to a raw probability in [0, 1]. Any backend failure
 * throws, and lib/gate.mjs fails closed — exactly as it does for Jev.
 *
 * Challenger rule (Ashish, 2026-10-30): a challenger replaces Jev for
 * a decision class ONLY if it beats Jev on ALL quality legs (the gate
 * golden set, a 15-item sample re-gate, the ContractNLI full test
 * split) AND on measured price per decision. Challengers run only as
 * capped spot-checks inside the Baseten calibration budget — see
 * checks/challenge-decisions.mjs. Until one clears every leg, the
 * config keeps every class on Jev and the challenger backends below
 * are never wired into production paths.
 *
 * The Baseten decision models (elephant / mammoth / joey) are
 * TypeSafe System One compatible: same POST /v1/systemone shape, same
 * answers map. The adapter mirrors lib/jev.mjs discipline — the API
 * key comes from the configuration service (lib/config.mjs:
 * BASETEN_API_KEY environment variable first, then the local
 * Settings store), content-hash cache, spend log (provider
 * 'baseten', spend class 'calibration'), Baseten budget stop-loss
 * guard — with one deliberate difference: NO retries. A challenger
 * spot-check that fails is a recorded failure, not a reason to
 * spend twice.
 *
 * STATUS 2026-10-30: the Baseten probe failed (the grant key refuses
 * all non-Spark inference with HTTP 403 — docs/baseten-probe-and-
 * challengers.md), so challenger runs are DEFERRED. This adapter is
 * built and ready; it has never been called live.
 */
import { resolveProviderKey } from './config.mjs';
import { budgetBlock, cacheGet, cacheKey, cachePut, estimateCostUsd, logSpend, routerConfig } from '../router/spend.mjs';
import { jevEvaluate, jevModel } from './jev.mjs';

export class DecisionError extends Error {}

function basetenSystemOneUrl() {
  const base = String(process.env.BASETEN_BASE_URL || 'https://inference.baseten.co').replace(/\/$/, '');
  return `${base}/v1/systemone`;
}

export const CHALLENGER_MODELS = [
  'decision-models/baseten-elephant-9b-latest',
  'decision-models/baseten-mammoth-27b-latest',
  'decision-models/baseten-joey-2b-latest',
];

const jevBackend = {
  id: 'jev',
  get model() {
    return jevModel();
  },
  // The caller threads its spend class and iteration identity
  // through opts, and the Jev client writes both into every spend
  // row the decision produces (card S3b). The challenger adapter
  // below keeps its own spend class and ignores opts.
  evaluate: (taskLabel, state, questions, opts = {}) => jevEvaluate(taskLabel, state, questions, opts),
};

/** A challenger backend bound to one Baseten decision-model id. */
export function basetenChallengerBackend(model) {
  if (!CHALLENGER_MODELS.includes(model)) {
    throw new DecisionError(`unknown challenger model: ${model}`);
  }
  return {
    id: 'baseten-challenger',
    model,
    async evaluate(taskLabel, state, questions) {
      // Key check before the cache, same rule as lib/jev.mjs: an
      // unconfigured backend fails closed and never serves cache.
      if (!resolveProviderKey('baseten').key) {
        throw new DecisionError('baseten challenger: no API key configured (set BASETEN_API_KEY or add one in Settings)');
      }
      const key = cacheKey('baseten', model, taskLabel, { state, questions });
      const hit = cacheGet(key);
      if (hit) {
        logSpend({
          at: new Date().toISOString(),
          provider: 'baseten',
          model,
          task: taskLabel,
          spend_class: 'calibration',
          input_tokens: 0,
          output_tokens: 0,
          est_cost_usd: 0,
          cached: true,
          synthetic: true,
        });
        return { answers: hit.answers, fromCache: true };
      }
      const block = budgetBlock('baseten', 'calibration');
      if (block) throw new DecisionError(block);
      const { key: token } = resolveProviderKey('baseten');
      if (!token) throw new DecisionError('baseten challenger: no API key configured (set BASETEN_API_KEY or add one in Settings)');
      let res;
      try {
        res = await fetch(basetenSystemOneUrl(), {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ state, model, questions }),
          redirect: 'error',
        });
      } catch (e) {
        throw new DecisionError(`baseten challenger call failed: ${e.message || e}`);
      }
      if (res.status !== 200) {
        throw new DecisionError(`baseten challenger HTTP ${res.status}`);
      }
      const body = await res.json().catch(() => null);
      if (!body || typeof body.answers !== 'object' || body.answers === null) {
        throw new DecisionError('baseten challenger returned a malformed answers map');
      }
      const clean = {};
      for (const name of Object.keys(questions)) {
        const v = Number(body.answers?.[name]?.noul);
        if (!Number.isFinite(v) || v < 0 || v > 1) {
          throw new DecisionError(`baseten challenger answer for '${name}' is malformed or out of range`);
        }
        clean[name] = v;
      }
      const inputTokens = Math.ceil((String(state).length + JSON.stringify(questions).length) / 4);
      logSpend({
        at: new Date().toISOString(),
        provider: 'baseten',
        model,
        task: taskLabel,
        spend_class: 'calibration',
        input_tokens: inputTokens,
        output_tokens: 0,
        est_cost_usd: estimateCostUsd('baseten', model, { input_tokens: inputTokens }),
        cached: false,
        synthetic: true,
      });
      cachePut(key, { answers: clean });
      return { answers: clean, fromCache: false };
    },
  };
}

/**
 * Resolve the configured backend for a decision class
 * ('gate' | 'consolidation' | 'decay' | 'promotion').
 * Config values: 'jev' (default) or 'baseten-challenger:<model id>'.
 */
export function getDecisionBackend(decisionClass) {
  const configured = routerConfig().decision_backends?.[decisionClass] || 'jev';
  if (configured === 'jev') return jevBackend;
  if (configured.startsWith('baseten-challenger:')) {
    return basetenChallengerBackend(configured.slice('baseten-challenger:'.length));
  }
  throw new DecisionError(`unknown decision backend '${configured}' for class '${decisionClass}'`);
}
