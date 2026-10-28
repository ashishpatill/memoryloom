/**
 * MemoryLoom provider router (skeleton, offline build).
 *
 * One router picks the provider per task. Every attempt is logged
 * (task, provider, ok, latency) so the UI provider-activity panel can
 * show which provider consolidated, scored and narrated each memory.
 *
 * Live today: the `local` provider — deterministic, dependency-free
 * implementations that run fully offline. It is the final fallback for
 * every task, so a missing or dead hosted credit never stops the loop.
 *
 * Stubs: meta / baseten / modal / fireworks are configuration stubs
 * behind this same interface. A stub reports whether its credential is
 * configured (env var present) but performs NO network call in this
 * build; routing falls through to the next provider, ending at local.
 */
import { performance } from 'node:perf_hooks';

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
 * Fixed-choice gate scoring (approve | reject | escalate).
 * Mirrors the write-gate classes: procedural/pinned always escalate to
 * a human; grounded semantic approves; ungrounded escalates; empty or
 * invalid input rejects. Every score is returned as a provenance record.
 */
function localGateScore({ proposal = {} } = {}) {
  const text = String(proposal.text || '').trim();
  const grounding = Array.isArray(proposal.grounding_ids) ? proposal.grounding_ids.length : 0;
  let decision;
  let reason;
  if (!text) {
    decision = 'reject';
    reason = 'empty-text';
  } else if (proposal.type === 'procedural') {
    decision = 'escalate';
    reason = 'procedural-human-always';
  } else if (proposal.pinned) {
    decision = 'escalate';
    reason = 'pinned-human-always';
  } else if (proposal.type === 'episodic' || proposal.scope === 'node_local') {
    decision = 'approve';
    reason = 'episodic-or-node-local';
  } else if (grounding >= 2) {
    decision = 'approve';
    reason = 'grounding>=2';
  } else {
    decision = 'escalate';
    reason = 'low-evidence';
  }
  return {
    decision,
    reason,
    scored_by: 'local',
    grounding_count: grounding,
    at: new Date().toISOString(),
  };
}

/** Batch triage = gate-score each proposal (the high-throughput job). */
function localTriage({ proposals = [] } = {}) {
  return { scores: proposals.map((p) => ({ id: p.id || null, ...localGateScore({ proposal: p }) })) };
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

// ---- hosted provider stubs (no network in this build) --------------------

function stubProvider(id, envVar, role) {
  return {
    id,
    live: false,
    role,
    get configured() {
      return Boolean(process.env[envVar]);
    },
    async call() {
      return {
        ok: false,
        reason: this.configured
          ? `${id} stub: configured but hosted calls are not wired in this build`
          : `${id} stub: not configured (set ${envVar})`,
      };
    },
  };
}

export const PROVIDERS = {
  local: localProvider,
  meta: stubProvider('meta', 'META_MODEL_API_KEY', 'core reasoner: consolidation, contradiction explanation, recall narration'),
  baseten: stubProvider('baseten', 'BASETEN_API_KEY', 'high-throughput triage of proposed memories'),
  modal: stubProvider('modal', 'MODAL_TOKEN_ID', 'batch jobs: consolidation/decay sweeps, embedding backfill, eval runs'),
  fireworks: stubProvider('fireworks', 'FIREWORKS_API_KEY', 'low-latency gate scoring and recall reranking'),
};

/** Preferred provider per task; the chain always ends at local. */
export const TASK_ROUTES = {
  consolidate: ['meta', 'local'],
  gate_score: ['fireworks', 'local'],
  narrate: ['meta', 'local'],
  triage: ['baseten', 'local'],
  batch_sweep: ['modal', 'local'],
};

export function providerStatus() {
  return Object.values(PROVIDERS).map((p) => ({
    id: p.id,
    live: p.live,
    configured: p.configured,
    role: p.role || 'local offline provider',
  }));
}

/**
 * Route one task. Returns { provider_used, attempts, result } where
 * attempts is the provider-activity log for this call.
 */
export async function route(task, payload = {}, routes = TASK_ROUTES) {
  const chain = routes[task] || ['local'];
  const attempts = [];
  for (const id of chain) {
    const provider = PROVIDERS[id];
    if (!provider) continue;
    const t0 = performance.now();
    let out;
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
      latency_ms: Math.round((performance.now() - t0) * 10) / 10,
      at: new Date().toISOString(),
    });
    if (out.ok) {
      return { provider_used: id, attempts, result: out.result };
    }
  }
  return { provider_used: null, attempts, result: null };
}
