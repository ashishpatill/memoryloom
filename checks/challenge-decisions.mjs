/**
 * challenge-decisions.mjs — head-to-head: Baseten decision models vs Jev.
 *
 * Challenger rule (Ashish, 2026-10-30): a challenger replaces Jev for
 * a decision class ONLY if it beats Jev on ALL quality legs AND on
 * measured price per decision. Legs, cheapest first:
 *   1. MemoryLoom gate golden set (40 items) — Jev baseline 40/40,
 *      0 unsafe approvals, ~$0.0000164 per decision (measured in the
 *      2026-10-30 gate calibration: 40 calls, $0.000657 total).
 *   2. A 15-item sample re-gate — Jev baseline 14/15, zero unsupported
 *      shipped. NOT automated here: run only for a challenger still
 *      unbeaten after leg 1, using an external sample pack.
 *   3. ContractNLI full test split (2,091 pairs) — Jev baseline
 *      accuracy 0.8207, 36 false approvals. Same gating as leg 2.
 * A challenger that loses any leg is closed and recorded; no re-runs.
 *
 * Challengers are scored through the PRODUCTION decision rule
 * (lib/gate.mjs evaluateGate with the challenger backend): same
 * questions, same piecewise calibration map, same argmax + structural
 * rule. Only the probability source differs.
 *
 * STAGING GATE: challenger calls draw on the Baseten balance. The
 * 2026-10-30 probe FAILED (grant key refuses all non-Spark inference,
 * HTTP 403), so this harness refuses to spend and reports the
 * deferral. It runs live only when router/config.json
 * baseten_probe.verdict records a cleared probe.
 * Owning file: checks/challenge-decisions.mjs
 * Accountable layer: Decision layer
 * Provider need: None while the probe record stands
 * Declared mode: Keyless refusal, runs only inside its owning card
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateGate } from '../lib/gate.mjs';
import { basetenChallengerBackend, CHALLENGER_MODELS } from '../lib/decisions.mjs';
import { routerConfig, spendSummary } from '../router/spend.mjs';
import { GATE_GOLDEN_ITEMS } from './fixtures/gate-golden.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const CONFIG = routerConfig();
const JEV_BASELINE = { agreement: 40, total: 40, unsafe_approvals: 0, cost_per_decision_usd: 0.0000164 };

const probe = CONFIG.baseten_probe || {};
const probeCleared = typeof probe.verdict === 'string' && probe.verdict.startsWith('CLEARED');
if (!probeCleared) {
  console.log('CHALLENGERS DEFERRED — the Baseten probe did not clear, so no challenger calls were made.');
  console.log(`probe: ${probe.model || '?'} -> ${probe.result || 'not recorded'}`);
  console.log('Jev stands alone as the decision layer for every decision class.');
  writeFileSync(
    join(__dir, 'out', 'challengers.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        status: 'deferred — probe failed',
        probe,
        jev_baseline: JEV_BASELINE,
        challengers: CHALLENGER_MODELS.map((model) => ({ model, status: 'deferred', legs: {} })),
      },
      null,
      2
    ) + '\n'
  );
  console.log('wrote checks/out/challengers.json');
  process.exit(0);
}

// ---- live path (only reached with a cleared probe) -------------------------
const standings = [];
for (const model of CHALLENGER_MODELS) {
  const backend = basetenChallengerBackend(model);
  const before = spendSummary('baseten', 'calibration');
  let agree = 0;
  let unsafe = 0;
  let errors = 0;
  for (const item of GATE_GOLDEN_ITEMS) {
    let decision = null;
    try {
      const scored = await evaluateGate({ proposal: item.proposal, evidence: item.evidence, backend });
      decision = scored.decision;
    } catch {
      errors += 1;
    }
    if (decision === item.expect) agree += 1;
    if (decision === 'approve' && item.expect !== 'approve') unsafe += 1;
  }
  const after = spendSummary('baseten', 'calibration');
  const spent = Math.round((after.est_cost_usd - before.est_cost_usd) * 1e6) / 1e6;
  const perDecision = GATE_GOLDEN_ITEMS.length ? spent / GATE_GOLDEN_ITEMS.length : null;
  const beatsQuality = agree > JEV_BASELINE.agreement && unsafe === 0 && errors === 0;
  const beatsPrice = perDecision !== null && perDecision < JEV_BASELINE.cost_per_decision_usd;
  standings.push({
    model,
    leg1_golden_set: { agreement: agree, total: GATE_GOLDEN_ITEMS.length, unsafe_approvals: unsafe, errors },
    cost_per_decision_usd: perDecision,
    beats_jev_leg1: beatsQuality && beatsPrice,
    status: beatsQuality && beatsPrice ? 'unbeaten after leg 1 — legs 2 and 3 required before any switch' : 'CLOSED — lost leg 1',
  });
  console.log(`${model}: leg1 ${agree}/${GATE_GOLDEN_ITEMS.length}, unsafe ${unsafe}, errors ${errors}, $/decision ${perDecision}`);
}
writeFileSync(
  join(__dir, 'out', 'challengers.json'),
  JSON.stringify({ at: new Date().toISOString(), status: 'leg 1 complete', jev_baseline: JEV_BASELINE, challengers: standings }, null, 2) + '\n'
);
console.log('wrote checks/out/challengers.json');
