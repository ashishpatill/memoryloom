/**
 * MemoryLoom provider router.
 *
 * One router picks the provider per task class. Every attempt is logged
 * (task, provider, ok, latency) for the UI provider-activity panel, and
 * every PAID call additionally goes to the spend log with tokens and
 * estimated cost (router/spend.mjs), behind a content-hash cache and
 * the credit plan's 80% stop-loss budgets.
 *
 * Owners per task class (credit-efficiency plan, corrected 2026-10-30):
 *  - meta / muse-wonder-1.0 "Wonder Full" (high effort): core reasoning
 *    — consolidation writing, contradiction explanation, recall
 *    narration, eval judging.
 *  - meta / muse-wonder-1.0 "Wonder" (medium effort): implementation
 *    passes and bulk triage drafting.
 *  - Jev (TypeSafe) is the decision layer for every enumerable,
 *    fixed-answer decision — see lib/gate.mjs. No LLM in this router
 *    renders a gate verdict, and the local fallback NEVER approves a
 *    gate decision (fail closed: escalate).
 *  - local: embeddings and all dev/debug traffic; final fallback for
 *    every task, so a dead credit never stops the loop.
 *  - baseten: CLOSED (probe 2026-10-30 proved the grant key refuses
 *    all non-Spark inference with HTTP 403 — DeepSeek, GLM and Kimi
 *    chat calls all rejected; only catalogue reads succeed). The
 *    DeepSeek triage lane was therefore not built, its budget stays
 *    untouched, and triage runs on the Meta Wonder medium tier.
 *    fireworks: no spend authorised in this build. modal: no role.
 *
 * Muse Spark is not used anywhere: no spark ids in config, and the
 * meta provider refuses any model id containing "spark" or
 * "contributor".
 *
 * Hosted providers are armed only when MEMORYLOOM_ROUTER_MODE=live, and
 * even then only for calls explicitly marked { synthetic: true } — the
 * privacy rule is that paid calls carry the synthetic/demo corpus and
 * non-sensitive text, never the real corpus.
 */
import { performance } from 'node:perf_hooks';
import { resolveProviderKey } from '../lib/config.mjs';
import {
  budgetBlock,
  cacheGet,
  cacheKey,
  cachePut,
  estimateCostUsd,
  logSpend,
  routerConfig,
} from './spend.mjs';

const CONFIG = routerConfig();

export function hostedEnabled() {
  return process.env.MEMORYLOOM_ROUTER_MODE === 'live';
}

// ---- local provider: deterministic offline implementations ---------------

function normalise(text) {
  return String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Merge raw episodes into deduplicated atoms with provenance counts. */
function localConsolidate({ episodes = [] } = {}) {
  const atoms = new Map();
  for (const ep of episodes) {
    const key = normalise(ep.text);
    if (!key) continue;
    if (!atoms.has(key)) {
      atoms.set(key, {
        text: String(ep.text).trim(),
        sources: 0,
        ids: [],
        first_seen: ep.created_at || null,
      });
    }
    const atom = atoms.get(key);
    atom.sources += 1;
    if (ep.id) atom.ids.push(ep.id);
  }
  return { atoms: [...atoms.values()], merged: episodes.length - atoms.size };
}

/**
 * Local gate placeholder — FAIL CLOSED by design. Decisions belong to
 * the Jev layer (lib/gate.mjs); when Jev is unavailable the only safe
 * local answer is escalate (empty input is a validation reject, never
 * an approval). This function exists so offline callers get a
 * well-shaped, never-approving score record.
 */
function localGateScore({ proposal = {} } = {}) {
  const text = String(proposal.text || '').trim();
  const grounding = Array.isArray(proposal.grounding_ids) ? proposal.grounding_ids.length : 0;
  if (!text) {
    return {
      decision: 'reject',
      reason: 'empty-text (validation)',
      scored_by: 'local-fail-closed',
      grounding_count: grounding,
      at: new Date().toISOString(),
    };
  }
  return {
    decision: 'escalate',
    reason: 'fail-closed: decision layer (Jev) unavailable locally',
    scored_by: 'local-fail-closed',
    grounding_count: grounding,
    at: new Date().toISOString(),
  };
}

const TRIAGE_KINDS = new Set(['working', 'episodic', 'semantic', 'procedural', 'goals', 'reflective']);

/**
 * Local triage fallback: provisional queue labels only (kind taken from
 * the proposal, sensitivity unjudged). Triage labels are drafting for
 * the review queue, never gate decisions.
 */
function localTriage({ proposals = [] } = {}) {
  return {
    labels: proposals.map((p) => ({
      id: p.id || null,
      kind: TRIAGE_KINDS.has(p.type) ? p.type : 'semantic',
      sensitivity: 'unjudged',
      duplicate_of: null,
      note: 'local fallback label — provisional',
      provisional: true,
    })),
  };
}

/** Recall narration with receipts: every line dereferences to a record id. */
function localNarrate({ results = [], query = '' } = {}) {
  if (!results.length) {
    return { narration: `No memories matched "${query}". Nothing was invented to fill the gap.`, receipts: [] };
  }
  const lines = results.map(
    (r, i) => `${i + 1}. ${r.text} [receipt: ${r.id}]`
  );
  return {
    narration: `Recalled ${results.length} memor${results.length === 1 ? 'y' : 'ies'} for "${query}":\n${lines.join('\n')}`,
    receipts: results.map((r) => r.id),
  };
}

const localProvider = {
  id: 'local',
  live: true,
  configured: true,
  paid: false,
  async call(task, payload) {
    switch (task) {
      case 'consolidate':
        return { ok: true, result: localConsolidate(payload) };
      case 'gate_score':
        return { ok: true, result: localGateScore(payload) };
      case 'triage':
        return { ok: true, result: localTriage(payload) };
      case 'narrate':
        return { ok: true, result: localNarrate(payload) };
      default:
        return { ok: false, reason: `local provider has no task '${task}'` };
    }
  },
};

// ---- shared hosted-call plumbing ------------------------------------------

/**
 * One authenticated POST for a hosted provider. The API key comes
 * from the configuration service (lib/config.mjs): the provider's
 * environment variable first, then the local Settings store. Real
 * keys need no refresh, so there is no retry-on-401 here — a 401 is
 * returned to the caller as the provider's answer.
 */
async function authedFetch(providerId, url, body, { timeoutMs = 120_000 } = {}) {
  const { key: token } = resolveProviderKey(providerId);
  if (!token) {
    throw new Error(`${providerId}: no API key configured (set the provider's key environment variable or add one in Settings)`);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
      redirect: 'error',
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
    return { status: res.status, json, raw: text.slice(0, 400) };
  } finally {
    clearTimeout(timer);
  }
}

function metaBaseUrl() {
  return String(process.env.META_MODEL_BASE_URL || 'https://api.meta.ai').replace(/\/$/, '');
}

function extractJson(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

// ---- Meta provider: muse-wonder-1.0 in two effort tiers -------------------

const FULL_TASKS = new Set(['consolidate', 'narrate', 'explain', 'judge']);

function metaPrompt(task, payload) {
  switch (task) {
    case 'consolidate': {
      const episodes = (payload.episodes || []).map((e) => ({ id: e.id || null, text: e.text }));
      return {
        json: true,
        maxOut: 1200,
        system:
          'You consolidate raw memory episodes into deduplicated atomic facts for a shared agent memory store. ' +
          'Merge episodes that state the same fact (including casing or whitespace variants) into one atom whose text is the clearest version. ' +
          'Never invent facts. Reply with JSON only: {"atoms": [{"text": "...", "ids": ["episode ids merged into this atom"]}]}.',
        user: JSON.stringify({ episodes }),
      };
    }
    case 'narrate': {
      const results = (payload.results || []).map((r) => ({ id: r.id, text: r.text }));
      return {
        json: true,
        maxOut: 900,
        system:
          'You narrate a memory recall for an agent. Use ONLY the supplied records; never invent facts. ' +
          'Cite every record you use as [receipt: <id>]. If there are no records, say plainly that nothing matched and nothing was invented. ' +
          'Reply with JSON only: {"narration": "...", "receipts": ["ids cited"]}.',
        user: JSON.stringify({ query: payload.query || '', results }),
      };
    }
    case 'explain': {
      return {
        json: true,
        maxOut: 900,
        system:
          'You explain a contradiction between two memory records for a human reviewer. Say what each record claims, ' +
          'where they conflict, and what evidence would settle it. Cite both record ids. Reply with JSON only: ' +
          '{"explanation": "...", "cites": ["id-a", "id-b"]}.',
        user: JSON.stringify({ a: payload.a || null, b: payload.b || null }),
      };
    }
    case 'judge': {
      return {
        json: true,
        maxOut: 700,
        system:
          'You are an eval judge. Score the candidate against the criteria from 0 to 10 and explain briefly. ' +
          'Judge only what is in front of you. Reply with JSON only: {"score": <0-10>, "verdict": "<one line>", "notes": "<brief>"}.',
        user: JSON.stringify({
          criteria: payload.criteria || '',
          reference: payload.reference || null,
          candidate: payload.candidate || '',
        }),
      };
    }
    case 'triage': {
      const proposals = (payload.proposals || []).map((p) => ({
        id: p.id || null,
        text: p.text || '',
        type: p.type || null,
      }));
      return {
        json: true,
        maxOut: 1500,
        system:
          'You label proposed memories for a human review queue. These labels are drafting aids only — you are NOT deciding approval. ' +
          'For each proposal give: kind (working|episodic|semantic|procedural|goals|reflective), sensitivity (normal|sensitive — sensitive means credentials, personal data, or anything that should not be shared widely), ' +
          'duplicate_of (the id of another proposal in this same batch that states the same fact, else null), and a short note. ' +
          'Reply with JSON only: {"labels": [{"id": ..., "kind": "...", "sensitivity": "...", "duplicate_of": null, "note": "..."}]}.',
        user: JSON.stringify({ proposals }),
      };
    }
    default:
      return null;
  }
}

function metaShapeResult(task, payload, parsed, rawText) {
  if (task === 'consolidate') {
    if (!parsed || !Array.isArray(parsed.atoms)) return null;
    const episodes = payload.episodes || [];
    const atoms = parsed.atoms.map((a) => ({
      text: String(a.text || '').trim(),
      sources: Array.isArray(a.ids) ? a.ids.length : 0,
      ids: Array.isArray(a.ids) ? a.ids : [],
      first_seen: null,
    })).filter((a) => a.text);
    return { atoms, merged: episodes.length - atoms.length };
  }
  if (task === 'narrate') {
    if (parsed && typeof parsed.narration === 'string') {
      return { narration: parsed.narration, receipts: Array.isArray(parsed.receipts) ? parsed.receipts : [] };
    }
    if (rawText) {
      const ids = (payload.results || []).map((r) => r.id).filter((id) => rawText.includes(id));
      return { narration: rawText, receipts: ids };
    }
    return null;
  }
  if (task === 'explain') {
    if (parsed && typeof parsed.explanation === 'string') {
      return { explanation: parsed.explanation, cites: Array.isArray(parsed.cites) ? parsed.cites : [] };
    }
    return rawText ? { explanation: rawText, cites: [] } : null;
  }
  if (task === 'judge') {
    if (parsed && typeof parsed.score === 'number') {
      return { score: parsed.score, verdict: parsed.verdict || '', notes: parsed.notes || '' };
    }
    return null;
  }
  if (task === 'triage') {
    if (!parsed || !Array.isArray(parsed.labels)) return null;
    return {
      labels: parsed.labels.map((l) => ({
        id: l.id ?? null,
        kind: TRIAGE_KINDS.has(l.kind) ? l.kind : 'semantic',
        sensitivity: l.sensitivity === 'sensitive' ? 'sensitive' : 'normal',
        duplicate_of: l.duplicate_of ?? null,
        note: l.note || '',
        provisional: false,
      })),
    };
  }
  return null;
}

let metaResponsesOk = null; // tri-state: unknown until first live call

const metaProvider = {
  id: 'meta',
  live: true,
  paid: true,
  role: 'muse-wonder-1.0: Wonder Full (core reasoning) + Wonder (implementation, triage)',
  get configured() {
    return hostedEnabled() && Boolean(resolveProviderKey('meta').key);
  },
  /** Model spec for a task: { id, reasoning_effort, tier }. */
  defaultModel(task) {
    return FULL_TASKS.has(task) ? CONFIG.models.meta_core_reasoning : CONFIG.models.meta_implementation;
  },
  async call(task, payload, ctx = {}) {
    const prompt = metaPrompt(task, payload);
    if (!prompt) return { ok: false, reason: `meta provider has no task '${task}'` };
    const spec = ctx.spec || this.defaultModel(task);
    if (/spark|contributor/i.test(spec.id)) {
      return { ok: false, reason: `model ${spec.id} is banned in MemoryLoom (no Spark, no contributor)`, model: spec.id };
    }
    // Preferred endpoint: /v1/responses (the only one that carries
    // reasoning across turns). If it errors once with a shape-style
    // status, this process falls back to /v1/chat/completions.
    if (metaResponsesOk !== false) {
      const r = await authedFetch(this.id, `${metaBaseUrl()}/v1/responses`, {
        model: spec.id,
        input: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        reasoning_effort: spec.reasoning_effort,
        max_output_tokens: prompt.maxOut,
      });
      if (r.status === 200 && r.json) {
        metaResponsesOk = true;
        const text =
          typeof r.json.output_text === 'string'
            ? r.json.output_text
            : (r.json.output || [])
                .flatMap((o) => o.content || [])
                .filter((c) => c.type === 'output_text' || typeof c.text === 'string')
                .map((c) => c.text)
                .join('');
        const result = metaShapeResult(task, payload, extractJson(text), text);
        if (!result) return { ok: false, reason: 'meta responses: unparsable output', usage: r.json.usage || null, model: spec.id };
        return { ok: true, result, usage: r.json.usage || null, model: spec.id, endpoint: 'responses' };
      }
      metaResponsesOk = false;
      if (r.status !== 400 && r.status !== 404 && r.status !== 422) {
        return { ok: false, reason: `meta responses HTTP ${r.status}: ${r.raw}`, model: spec.id };
      }
      // fall through to chat completions for 400/404/422 (endpoint shape mismatch)
    }
    const body = {
      model: spec.id,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      max_tokens: prompt.maxOut,
      reasoning_effort: spec.reasoning_effort,
    };
    if (prompt.json) body.response_format = { type: 'json_object' };
    let r = await authedFetch(this.id, `${metaBaseUrl()}/v1/chat/completions`, body);
    if (r.status === 400) {
      delete body.response_format;
      delete body.reasoning_effort;
      r = await authedFetch(this.id, `${metaBaseUrl()}/v1/chat/completions`, body);
    }
    if (r.status !== 200 || !r.json) {
      return { ok: false, reason: `meta chat HTTP ${r.status}: ${r.raw}`, model: spec.id };
    }
    const text = r.json.choices?.[0]?.message?.content || '';
    const result = metaShapeResult(task, payload, extractJson(text), text);
    if (!result) return { ok: false, reason: 'meta chat: unparsable output', usage: r.json.usage || null, model: spec.id };
    return { ok: true, result, usage: r.json.usage || null, model: spec.id, endpoint: 'chat' };
  },
};

// ---- parked / disabled providers -------------------------------------------

function disabledProvider(id, envVar, role, reason) {
  return {
    id,
    live: false,
    role,
    paid: false,
    get configured() {
      return Boolean(process.env[envVar]);
    },
    async call() {
      return { ok: false, reason };
    },
  };
}

export const PROVIDERS = {
  local: localProvider,
  meta: metaProvider,
  baseten: disabledProvider(
    'baseten',
    'BASETEN_API_KEY',
    'bulk triage (CLOSED — probe failed 2026-10-30)',
    'baseten: closed — probe 2026-10-30 proved the grant key refuses all non-Spark inference (HTTP 403); DeepSeek lane not built, budget untouched, triage on Meta Wonder medium'
  ),
  modal: disabledProvider('modal', 'MODAL_TOKEN_ID', 'batch compute', 'modal: no role in the credit plan ($0 confirmed)'),
  fireworks: disabledProvider('fireworks', 'FIREWORKS_API_KEY', 'live-loop scoring', 'fireworks: spend not authorised in this build'),
};

/** Preferred provider per task; the chain always ends at local. */
export const TASK_ROUTES = {
  consolidate: ['meta', 'local'],
  explain: ['meta', 'local'],
  narrate: ['meta', 'local'],
  judge: ['meta'],
  triage: ['meta', 'local'],
  gate_score: ['local'], // placeholder only — real decisions live in lib/gate.mjs (Jev), fail closed
  batch_sweep: ['local'],
};

export function providerStatus() {
  return Object.values(PROVIDERS).map((p) => ({
    id: p.id,
    live: p.live,
    configured: p.configured,
    role: p.role || 'local offline provider',
  }));
}

function spendClassFor(providerId, task, opts) {
  return (
    opts.spendClass ||
    CONFIG.default_spend_class?.[providerId]?.[task] ||
    'demo_final'
  );
}

/**
 * Route one task. Returns { provider_used, attempts, result, cached }.
 *
 * opts:
 *  - synthetic: must be true before any paid provider is attempted
 *    (privacy rule: paid calls carry synthetic/demo content only).
 *  - spendClass: budget class for the spend log (calibration, evals,
 *    demo_final, reserve). Defaults come from config.json.
 *  - provider / model / effort: force one provider and an exact model
 *    spec (calibration runs). The same budget, cache and privacy
 *    guards apply.
 *  - routes: override the provider chain.
 */
export async function route(task, payload = {}, opts = {}) {
  const chain = opts.provider ? [opts.provider] : opts.routes?.[task] || TASK_ROUTES[task] || ['local'];
  const attempts = [];
  for (const id of chain) {
    const provider = PROVIDERS[id];
    if (!provider) continue;
    const t0 = performance.now();
    const latency = () => Math.round((performance.now() - t0) * 10) / 10;
    let out;
    if (provider.paid) {
      out = await paidCall(provider, task, payload, opts);
      attempts.push({
        task,
        provider: id,
        model: out.model || null,
        tier: out.tier || null,
        ok: Boolean(out.ok),
        reason: out.ok ? null : out.reason || null,
        cached: Boolean(out.cached),
        est_cost_usd: out.est_cost_usd ?? null,
        latency_ms: latency(),
        at: new Date().toISOString(),
      });
    } else {
      try {
        out = await provider.call(task, payload);
      } catch (e) {
        out = { ok: false, reason: String(e.message || e) };
      }
      attempts.push({
        task,
        provider: id,
        ok: Boolean(out.ok),
        reason: out.ok ? null : out.reason || null,
        latency_ms: latency(),
        at: new Date().toISOString(),
      });
    }
    if (out.ok) {
      return { provider_used: id, attempts, result: out.result, cached: Boolean(out.cached) };
    }
  }
  return { provider_used: null, attempts, result: null, cached: false };
}

/** One paid provider call behind cache, budget and spend-log guards. */
async function paidCall(provider, task, payload, opts) {
  const baseSpec = provider.defaultModel(task);
  const spec = {
    id: opts.model || baseSpec.id,
    reasoning_effort: opts.effort || baseSpec.reasoning_effort,
    tier: opts.effort
      ? opts.effort === 'medium'
        ? 'wonder'
        : 'wonder-full'
      : baseSpec.tier,
  };
  if (!hostedEnabled()) {
    return { ok: false, reason: `${provider.id}: hosted calls disabled (set MEMORYLOOM_ROUTER_MODE=live)`, model: spec.id, tier: spec.tier };
  }
  if (opts.synthetic !== true) {
    return { ok: false, reason: `${provider.id}: paid calls require synthetic:true (privacy rule)`, model: spec.id, tier: spec.tier };
  }
  const spendClass = spendClassFor(provider.id, task, opts);
  const key = cacheKey(provider.id, spec, task, payload);
  const hit = cacheGet(key);
  if (hit) {
    logSpend({
      at: new Date().toISOString(),
      provider: provider.id,
      model: spec.id,
      tier: spec.tier,
      reasoning_effort: spec.reasoning_effort,
      task,
      spend_class: spendClass,
      input_tokens: 0,
      output_tokens: 0,
      est_cost_usd: 0,
      cached: true,
      synthetic: true,
    });
    return { ok: true, result: hit.result, cached: true, est_cost_usd: 0, model: spec.id, tier: spec.tier };
  }
  const block = budgetBlock(provider.id, spendClass);
  if (block) return { ok: false, reason: block, model: spec.id, tier: spec.tier };
  let out;
  try {
    out = await provider.call(task, payload, { spec });
  } catch (e) {
    return { ok: false, reason: String(e.message || e), model: spec.id, tier: spec.tier };
  }
  if (!out.ok) return { ...out, model: out.model || spec.id, tier: spec.tier };
  const usage = out.usage || {};
  const est = estimateCostUsd(provider.id, out.model || spec.id, usage);
  // The spend record is written before the result is handed back:
  // a call the router cannot log does not count as done.
  logSpend({
    at: new Date().toISOString(),
    provider: provider.id,
    model: out.model || spec.id,
    tier: spec.tier,
    reasoning_effort: spec.reasoning_effort,
    task,
    spend_class: spendClass,
    input_tokens: usage.input_tokens || usage.prompt_tokens || 0,
    output_tokens: usage.output_tokens || usage.completion_tokens || 0,
    est_cost_usd: est,
    cached: false,
    synthetic: true,
  });
  cachePut(key, { result: out.result });
  return { ok: true, result: out.result, est_cost_usd: est, model: out.model || spec.id, tier: spec.tier };
}
