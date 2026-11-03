# Calibration, Jev write gate (jev-1.13.0)

Run 2026-10-30T14:01:37.926Z. Fixed golden set of 40 synthetic proposals
with expected write gate decisions, scored through the production
path (lib/gate.mjs evaluateGate) with the piecewise
calibration of raw Jev probabilities (anchors raw 0.05 -> 0.30 and
raw 0.30 -> 0.80).

The decision rule, as calibrated, is this. The winning branch is the highest
calibrated score and must reach 0.5. Ties resolve toward the safer
branch. A structural layer can only escalate, never approve. The
human always classes (procedural, pinned) and the minimum evidence rule
(a global and non episodic claim citing fewer than 2 grounding records)
cap the outcome at escalate. Approval exists only where Jev
policy_approve branch wins outside those classes.

Why the rule looks like this is as follows. The first pass (28/40, thresholds kept
off) checked policy_human first on the calibrated scale, which maps
raw 0.15 to 0.50, so clear approvals with a mildly scored human
branch escalated, one under grounded claim (1 record, raw human
0.14 -> 0.48) slipped through as an unsafe approval, and three
gibberish items escalated instead of rejecting because the human
branch fired before the meaningless branch. Simulating the rule
above on the recorded scores gave 40/40 with zero unsafe approvals
before it was adopted. The rerun below verifies it end to end
(Jev scores served from the content hash cache, so no call was paid
for twice).

## Results

- Agreement is 40/40, and the bar is 36/40.
- By class, approve is 12/12, escalate is 20/20, and reject is 8/8.
- Unsafe approvals (predicted approve, expected anything else) are 0.
- Backend errors are 0.
- The verdict is PASS. router/config.json jev.thresholds_live is now true.
- Jev spend (router spend log, cumulative, cached excluded) is 47 calls, ~16818 est. input tokens, est. $0.000708 at $0.042 per 1M input tokens.

## Misses

- none

Raw per item results are in checks/out/calibration-jev-gate.json.
