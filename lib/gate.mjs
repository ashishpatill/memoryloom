/**
 * The Jev decision gate — every enumerable, fixed-answer decision in
 * MemoryLoom goes through here (credit-efficiency plan, 2026-10-30):
 *
 *  - decideGate:            write-gate approve | reject | escalate
 *  - decideConsolidation:   merge a duplicate group, or keep originals
 *  - decideDecayDrop:       retire a stale memory, or keep it
 *  - decidePromotion:       promote a learning event into a playbook
 *
 * Binding rules:
 *  - Fixed choice sets; ESCALATE always exists (for keep/drop style
 *    decisions the safe branch plays the escalate role).
 *  - Every score is returned as a provenance record (raw + calibrated
 *    Jev probabilities, model, timestamp) and callers persist it.
 *  - Thresholds go live only after the calibration eval passes
 *    (router/config.json jev.thresholds_live). Before that, decideGate
 *    runs in shadow mode: scores are computed and recorded, but the
 *    effective decision is always escalate.
 *  - FAIL CLOSED: on any Jev backend failure the decision is the safe
 *    branch (escalate / keep originals / keep memory / do not
 *    promote). Rules and fallbacks never approve.
 *  - No LLM renders these verdicts. Wonder may write the explanation
 *    around a decision made here; it never makes the decision.
 */
import { calibrateJevProbability, jevEvaluate, jevModel, thresholdsLive, JevError } from './jev.mjs';

const GATE_POLICY = [
  'Memory store write policy:',
  '- Automatic approval fits a proposal that is episodic or node-local,',
  '  or a factual claim whose text is fully supported by the grounding',
  '  evidence records quoted below.',
  '- A human must decide a proposal that is procedural, or pinned, or',
  '  a factual claim whose text is not fully supported by the grounding',
  '  evidence quoted below (including absence claims: a claim that',
  '  something is not mentioned or does not exist is supported only if',
  '  the evidence states that exclusivity explicitly).',
  '- Meaningless proposals (gibberish, random characters, content-free',
  '  filler) are rejected.',
].join('\n');

function noul(statement) {
  return {
    type: 'noul',
    instructions:
      'Considering only the information given in the state, is the following statement true?\n\nStatement: ' +
      statement,
  };
}

function failClosed(kind, error) {
  return {
    decision: kind === 'gate' ? 'escalate' : 'safe',
    accept: false,
    drop: false,
    promote: false,
    backend: 'jev',
    model: jevModel(),
    failed: true,
    fail_closed: true,
    reason: `jev unavailable (${error?.message || error}) — fail closed`,
    raw: null,
    calibrated: null,
    at: new Date().toISOString(),
  };
}

/**
 * Score one proposal with Jev and compute the would-be decision.
 * Throws JevError on backend failure. This is the exact scoring path
 * decideGate uses, exported so the calibration eval measures the
 * production logic, not a copy of it.
 */
export async function evaluateGate({ proposal = {}, evidence = [] } = {}) {
  const state = buildGateState(proposal, evidence);
  const questions = {
    policy_approve: noul(
      'The proposal meets the write policy for automatic approval.'
    ),
    policy_human: noul(
      'The proposal requires a human decision under the write policy.'
    ),
    meaningless: noul(
      'The proposal text is meaningless: gibberish, random characters, or content-free filler with no factual claim.'
    ),
  };
  const { answers } = await jevEvaluate('gate_decision', state, questions);
  const raw = {
    policy_approve: answers.policy_approve,
    policy_human: answers.policy_human,
    meaningless: answers.meaningless,
  };
  const calibrated = Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k, calibrateJevProbability(v)])
  );
  // Decision rule (calibrated 2026-10-30 on the 40-item golden set;
  // see docs/calibration-jev-gate.md):
  //  - The winning branch is the highest calibrated score; a branch
  //    must reach 0.5 to fire at all, and ties resolve toward the
  //    safer branch (escalate > reject > approve).
  //  - A structural layer can only ever escalate, never approve: the
  //    write policy's human-always classes (procedural, pinned) and
  //    the min-evidence rule (a global, non-episodic claim citing
  //    fewer than 2 grounding records) cap the outcome at escalate.
  //    Jev still scores every proposal, and approval exists only
  //    where Jev's policy_approve branch wins outside those classes.
  const grounding = Array.isArray(proposal.grounding_ids) ? proposal.grounding_ids.length : 0;
  const structuralBlock =
    Boolean(proposal.pinned) ||
    proposal.type === 'procedural' ||
    ((proposal.scope || 'global') === 'global' && proposal.type !== 'episodic' && grounding < 2);
  const branches = [
    ['escalate', calibrated.policy_human],
    ['reject', calibrated.meaningless],
    ['approve', calibrated.policy_approve],
  ];
  branches.sort((a, b) => b[1] - a[1]);
  const [topBranch, topScore] = branches[0];
  let decision;
  let reason;
  if (topScore < 0.5) {
    decision = 'escalate';
    reason = 'jev: no branch reached the threshold — escalate';
  } else if (topBranch === 'approve' && structuralBlock) {
    decision = 'escalate';
    reason = 'structural: human-always class or fewer than 2 grounding records — capped at escalate';
  } else if (topBranch === 'approve') {
    decision = 'approve';
    reason = 'jev: policy-approve wins';
  } else if (topBranch === 'reject') {
    decision = 'reject';
    reason = 'jev: meaningless wins';
  } else {
    decision = 'escalate';
    reason = 'jev: human-required wins';
  }
  return { decision, reason, raw, calibrated, structural_block: structuralBlock };
}

function buildGateState(proposal, evidence) {
  const text = String(proposal.text || '').trim();
  return [
    GATE_POLICY,
    '',
    'Proposal:',
    JSON.stringify({
      text,
      type: proposal.type || 'semantic',
      scope: proposal.scope || 'global',
      pinned: Boolean(proposal.pinned),
      grounding_ids: Array.isArray(proposal.grounding_ids) ? proposal.grounding_ids : [],
    }),
    '',
    'Grounding evidence records:',
    evidence.length
      ? evidence.map((e) => `[${e.id}] ${String(e.text || '').slice(0, 500)}`).join('\n')
      : '(none cited)',
  ].join('\n');
}

/**
 * Write-gate decision for one proposal.
 * proposal: { text, type, scope, pinned, grounding_ids }
 * evidence: [{ id, text }] — the grounding records' current texts.
 */
export async function decideGate({ proposal = {}, evidence = [] } = {}) {
  const text = String(proposal.text || '').trim();
  if (!text) {
    return {
      decision: 'reject',
      backend: 'validation',
      model: null,
      failed: false,
      reason: 'empty-text (validation)',
      raw: null,
      calibrated: null,
      at: new Date().toISOString(),
    };
  }
  let scored;
  try {
    scored = await evaluateGate({ proposal, evidence });
  } catch (e) {
    return failClosed('gate', e);
  }
  const { decision, reason, raw, calibrated } = scored;
  const live = thresholdsLive();
  return {
    decision: live ? decision : 'escalate',
    shadow_decision: live ? null : decision,
    backend: 'jev',
    model: jevModel(),
    failed: false,
    fail_closed: false,
    reason: live ? reason : `shadow mode (thresholds not live) — would be: ${reason}`,
    raw,
    calibrated,
    at: new Date().toISOString(),
  };
}

/**
 * Consolidation accept: may these records be merged into one memory?
 * records: [{ id, text }]. Fail closed = keep originals.
 */
export async function decideConsolidation({ records = [] } = {}) {
  const state = [
    'Records proposed for consolidation into a single memory:',
    ...records.map((r) => `[${r.id}] ${String(r.text || '').slice(0, 500)}`),
  ].join('\n');
  const questions = {
    same_fact: noul(
      'All of the records in the state state the same fact, so merging them into a single memory loses no information.'
    ),
  };
  let answers;
  try {
    ({ answers } = await jevEvaluate('consolidation_accept', state, questions));
  } catch (e) {
    return { ...failClosed('consolidation', e), accept: false };
  }
  const raw = answers.same_fact;
  const calibrated = calibrateJevProbability(raw);
  return {
    accept: calibrated >= 0.5,
    decision: calibrated >= 0.5 ? 'merge' : 'keep-originals',
    backend: 'jev',
    model: jevModel(),
    failed: false,
    reason: calibrated >= 0.5 ? 'jev: same fact' : 'jev: not the same fact — keep originals',
    raw: { same_fact: raw },
    calibrated: { same_fact: calibrated },
    at: new Date().toISOString(),
  };
}

/**
 * Decay keep/drop: should this stale memory be retired?
 * Fail closed = keep.
 */
export async function decideDecayDrop({ memory = {}, stats = {} } = {}) {
  const state = [
    'Memory under decay review:',
    JSON.stringify({
      id: memory.id || null,
      text: String(memory.text || '').slice(0, 500),
      type: memory.type || null,
      pinned: Boolean(memory.pinned),
      strength: memory.strength ?? null,
      age_days: stats.age_days ?? null,
      days_since_recall: stats.days_since_recall ?? null,
      recall_count: stats.recall_count ?? null,
    }),
    '',
    'A memory should be retired only if it is stale, weak, never or rarely recalled, not pinned, and keeping it adds noise rather than value.',
  ].join('\n');
  const questions = {
    retire: noul('This memory should be retired (dropped) rather than kept.'),
  };
  let answers;
  try {
    ({ answers } = await jevEvaluate('decay_drop', state, questions));
  } catch (e) {
    return { ...failClosed('decay', e), drop: false };
  }
  const raw = answers.retire;
  const calibrated = calibrateJevProbability(raw);
  return {
    drop: calibrated >= 0.5,
    decision: calibrated >= 0.5 ? 'drop' : 'keep',
    backend: 'jev',
    model: jevModel(),
    failed: false,
    reason: calibrated >= 0.5 ? 'jev: retire' : 'jev: keep',
    raw: { retire: raw },
    calibrated: { retire: calibrated },
    at: new Date().toISOString(),
  };
}

/**
 * Learning-event promotion hook: may this learning event become a
 * standing playbook entry? Fail closed = do not promote.
 */
export async function decidePromotion({ event = {} } = {}) {
  const state = [
    'Learning event proposed for promotion into a standing playbook:',
    JSON.stringify({
      summary: String(event.summary || '').slice(0, 800),
      evidence: String(event.evidence || '').slice(0, 800),
      times_applied: event.times_applied ?? null,
      verified: Boolean(event.verified),
    }),
    '',
    'Promotion fits only a lesson that is reusable beyond its original incident, backed by the evidence quoted, and already applied successfully at least once.',
  ].join('\n');
  const questions = {
    promote: noul('This learning event should be promoted into a standing playbook entry.'),
  };
  let answers;
  try {
    ({ answers } = await jevEvaluate('learning_promotion', state, questions));
  } catch (e) {
    return { ...failClosed('promotion', e), promote: false };
  }
  const raw = answers.promote;
  const calibrated = calibrateJevProbability(raw);
  return {
    promote: calibrated >= 0.5,
    decision: calibrated >= 0.5 ? 'promote' : 'do-not-promote',
    backend: 'jev',
    model: jevModel(),
    failed: false,
    reason: calibrated >= 0.5 ? 'jev: promote' : 'jev: do not promote',
    raw: { promote: raw },
    calibrated: { promote: calibrated },
    at: new Date().toISOString(),
  };
}

export { JevError };
