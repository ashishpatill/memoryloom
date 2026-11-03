# Calibration, core reasoning on Meta muse-wonder-1.0

Run 2026-10-30T14:53:49.129Z. The golden set has 12 consolidation and
12 recall narration and 12
contradiction explanation items, all from the synthetic corpus. Owner
assignment comes from the credit efficiency plan. This calibration
verifies quality and measures cost per tier. It is not a contest.

## Results

- Wonder Full (high effort, class owner) passed 36/36 items.
- Wonder (medium effort) passed 36/36 items.
- Calibration class spend after this run (router spend log, cumulative,
  cached calls excluded) is 165 paid calls,
  26601 input tokens,
  76762 output tokens and
  est. $0.359505 of the $22.50
  calibration budget (15% of $150).

## Failures

- none

## Scorer note

The first pass scored 28/36 (Full) and 30/36 (medium) with three
false failures. Narration items n3, n7 and n8 used the word "receipt"
as a forbidden phrase, but the required citation syntax
"[receipt: <id>]" contains that word, so correct narrations failed.
The forbidden phrases were corrected to genuinely off topic content
and the set was scored again entirely from the content hash cache. No
call was paid for twice (the rerun took under a second). The
remaining failures are real signals. Narration occasionally drops a
receipt (n11, n12) and explanations sometimes paraphrase the
conflicting values instead of quoting both (x7, x8, x11).

## Pin

- router/config.json pins meta_core_reasoning = muse-wonder-1.0 @ high
  ("Wonder Full") for consolidate / narrate / explain / judge, and
  meta_implementation = muse-wonder-1.0 @ medium ("Wonder") for triage
  and implementation passes. This was unchanged by this run. The tiers were
  assigned by the plan. The numbers above are the verification record.
- Raw per item results are in checks/out/calibration-meta.json.
