# Eval — LongMemEval-style recall evaluation

Run 2026-10-30T14:57:10.858Z. Harness: checks/eval-longmem.mjs. Dataset:
checks/fixtures/longmem-haystack.jsonl (generated deterministically by
the harness; the committed fixture is exactly what was measured).

## Shape

- Haystack: 120 memories about a fictional project
  (Project Kestrel), written as six dated sessions from
  2026-08-03 to 2026-10-19, seeded into a throwaway
  database and nothing else. Needles are buried among hand-written and
  templated distractor work notes.
- Questions: 42 — 8 single-session,
  8 multi-session,
  8 temporal,
  10 knowledge-update (two of them asked as-of an
  earlier date), 8 abstention.
- Scoring is deterministic: needle rank in the receipts recall
  actually returned, answer terms present in the recalled text,
  believed-at set membership for as-of questions, and near-miss
  absence for abstention. No model judge was used.

## Results

- Recall@1: 17/29 (59%) of answerable ranked questions.
- Recall@5: 27/29 (93%).
- Recall@10: 29/29 (100%).
- Accuracy by type (full per-type criterion):
  - single-session: 8/8 (100%)
  - multi-session: 8/8 (100%)
  - temporal: 8/8 (100%)
  - knowledge-update: 6/10 (60%)
  - abstention: 3/8 (38%)

## Caveats, stated plainly

- Small n: 42 questions against a 120-memory
  haystack. The real LongMemEval uses roughly 500 sessions of
  haystack per question; this is a smoke signal for the mechanics,
  not a benchmark score, and the percentages swing on single items.
- The haystack is dense: distractors share vocabulary with needles by
  design, which makes ranking harder per item than a sparse corpus
  would, but the corpus is still small enough that the vector leg
  sees every record.
- Recall ranking has no recency preference: for knowledge-update
  questions the newer record must outrank a near-identical older one
  on relevance alone. The bi-temporal believed-at path is the
  product's mechanism for "what was true then", and it is scored
  separately above.
- Abstention here is measured at the recall layer (a near-miss record
  in the top-10 is a false hit). The hybrid vector leg returns nearest
  neighbours even for unanswerable questions, so the top-10 is rarely
  empty; the product's abstention behaviour lives in the receipt and
  narration layer above recall, which this eval does not score.

Raw per-question results: checks/out/eval-longmem.json.
