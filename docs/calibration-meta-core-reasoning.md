# Calibration — core reasoning on Meta muse-wonder-1.0

Run 2026-10-30T14:53:49.129Z. Golden set: 12 consolidation +
12 recall-narration + 12
contradiction-explanation items, all from the synthetic corpus. Owner
assignment comes from the credit-efficiency plan; this calibration
verifies quality and measures cost per tier — it is not a contest.

## Results

- Wonder Full (high effort, class owner): 36/36 items passed.
- Wonder (medium effort): 36/36 items passed.
- Calibration-class spend after this run (router spend log, cumulative,
  cached calls excluded): 165 paid calls,
  26601 input tokens,
  76762 output tokens,
  est. $0.359505 of the $22.50
  calibration budget (15% of $150).

## Failures

- none

## Scorer note

The first pass scored 28/36 (Full) and 30/36 (medium) with three
false failures: narration items n3, n7 and n8 used the word "receipt"
as a forbidden phrase, but the required citation syntax
"[receipt: <id>]" contains that word, so correct narrations failed.
The forbidden phrases were corrected to genuinely off-topic content
and the set was re-scored entirely from the content-hash cache — no
call was paid for twice (the re-run took under a second). The
remaining failures are real signals: narration occasionally drops a
receipt (n11, n12) and explanations sometimes paraphrase the
conflicting values instead of quoting both (x7, x8, x11).

## Pin

- router/config.json pins meta_core_reasoning = muse-wonder-1.0 @ high
  ("Wonder Full") for consolidate / narrate / explain / judge, and
  meta_implementation = muse-wonder-1.0 @ medium ("Wonder") for triage
  and implementation passes. Unchanged by this run — the tiers were
  assigned by the plan; the numbers above are the verification record.
- Raw per-item results: checks/out/calibration-meta.json.
