# Spark Open Calibration, 2026-10-31

On 2026-10-31 we measured Muse Spark Open on Baseten against the same synthetic test sets used for the recorded Wonder run. Those sets were a 40 item write gate prescreen set and a 36 item meta set covering consolidation, narration, and explanation drafting. This was calibration before contact and was measurement only. No product path uses this tier yet.

## Probe result

Before the calibration, one capped test call was made to check that the connection worked.

| Item | Result |
|---|---|
| Model | `meta-models/muse-spark-open-1026` |
| Response | HTTP 200 (success) |
| Prompt tokens used | 152, of which 128 were cached (reused from a stored copy, not read again from scratch) |
| Completion tokens used | 16 |
| Visible reply | Empty |

The empty visible reply is not a failure. The model spends completion tokens on reasoning first, before writing anything the reader sees. The tiny cap of 16 tokens was used up by that reasoning, so no visible text remained, even though the call itself succeeded. The response reported 13 of its 16 completion tokens as reasoning tokens, which is why the visible reply was empty at that cap.

## Method

How the calls were made and checked.

| Part | What was done |
|---|---|
| Transport | Calls went through the router (the part of the app that sends requests to model providers) in live mode. The API key came from the app's own configuration service, where its settings are stored. |
| Spend class | Every calibration call was recorded under the spend class `calibration`. A spend class is the label that ties spending to its approved budget. |
| Effort, prescreen | `low`. Effort is how much reasoning work the model is asked to do before answering. |
| Effort, consolidate / narrate / explain | `medium` |
| Model pinning | The model is pinned, meaning the exact model id above is fixed in code. Any other model id is refused. |
| Response checking | Baseten does not enforce JSON schema and it will not guarantee that a reply arrives in the exact data shape requested. So every response was validated (checked against the required shape) before any part of it was used. |
| Test data | Golden sets only, and synthetic only. A golden set is a list of test items with the correct outcome recorded in advance. No real user data was used. |

The key for these calls was resolved through the app configuration service from the environment of the calibration process. The order was environment first and then the Settings store. At that moment the Settings store on this machine held only test values. So the working key did not come from the store. The later store correction in this same iteration does not touch these results.

## Write gate set

The write gate decides whether a proposed item may be written into memory as truth. In this test, Spark Open gave a lean, an advisory first opinion, on each item. It did not decide anything.

| Comparison | Agreement |
|---|---|
| Spark Open lean vs. expected outcome | 33 / 40 (82.5%) |
| Spark Open lean vs. recorded Jev decision | 33 / 40 (82.5%) |

The two numbers are identical because Jev scored 40 / 40 against the expected outcomes. Jev stays the decider. The prescreen never approves anything into truth.

### Disagreements

Exactly 7 items disagreed. In every row, the expected outcome and the Jev decision are the same.

| Item | Expected / Jev | Spark Open lean | Spark Open's own reason |
|---|---|---|---|
| a03 | approve | escalate | Semantic factual claim about laptop location has no supporting evidence. |
| a04 | approve | escalate | No evidence provided to support semantic factual claim about lamp casings location. |
| e03 | escalate | approve | Evidence directly supports receipt with record id claim. |
| a12 | approve | escalate | Factual claim about whiteboard contents has no evidence; needs human verification. |
| e06 | escalate | approve | Exact evidence match supports factual claim verbatim. |
| e12 | escalate | approve | Well-formed team goal statement, no external factual claim requiring evidence. |
| e13 | escalate | approve | Claim directly supported by identical evidence text, well-formed reflective proposal. |

### What the pattern means

Agreement by expected class was 9 of 12 on items expected to be approved, 16 of 20 on items expected to be escalated, and 8 of 8 on items expected to be rejected as noise. The model caught every noise item. Items a03, a04 and a12 are the three cases where the model escalated too much. They are notes about the local workspace, a laptop cabinet, a bench and a whiteboard. The gate rules approve such notes without evidence, and the model asked for evidence that the rules do not require.

The four cases where the model escalated too little map out one by one. Item e03 is a pinned proposal, and the text alone does not show that status. Items e06 and e13 each rest on a single evidence record where the bar is two. Item e12 is a goal with no evidence at all. This pattern reading is an interpretation of seven items, not a law. Both directions are safe in the cascade because Jev decides every item, and any disagreement can escalate to Wonder at medium effort.

## Meta calibration set

These items test drafting work. That work is combining records (consolidate), telling back what was recalled (narrate), and explaining a contradiction (explain). The same prompts and the same deterministic scorers, fixed scoring rules and not another model's opinion, were used as in the recorded Wonder run.

| Path | Items | Spark Open passed |
|---|---|---|
| Consolidate | 12 | 12 / 12 |
| Narrate | 12 | 12 / 12 |
| Explain | 12 | 12 / 12 |
| **Total** | **36** | **36 / 36** |

Wonder Full's recorded result on the same set is also 36 / 36. No item has a Spark Open outcome that differs from the recorded outcome for Wonder for that item.

## Spend

| Measure | Amount |
|---|---|
| Paid calls | 76 |
| Input tokens | 26,706 |
| Output tokens | 33,986 |
| Estimated cost, calibration calls | $0.168111 |

These figures come from the router spend log. Every entry shows provider `baseten`, spend class `calibration`, and tier `tier0`. The probe call above was a separate single check made before calibration and is not part of the figure above. The probe call cost an estimated $0.000117 on the same prices, using 24 fresh input tokens, 128 cached input tokens and 16 output tokens. The Baseten total for the iteration is $0.168228 against the $15 calibration class budget.

## Recommendation for Iteration 6.2

Advice only, per path, based on the numbers above.

- **Prescreen (write gate lean), adopt as a Tier 0 drafting aid.** Jev must decide every item, and any lean/Jev disagreement escalates to Wonder medium (Tier 1). Spark Open was strong in the measurement on meaningless noise and on claims with good evidence. It was weak exactly where rules, not text, carry the decision, so it is advisory only and never a filter that can drop or approve an item on its own.
- **Narration drafting (narrate), suitable for first pass recall narration drafts.** Strong in the measurement with 12 / 12, with receipts (the record references backing the draft) complete on every item.
- **Explanation drafting (explain), suitable for first pass drafts that explain a contradiction,** with Tier 1 review on escalated items. Strong in the measurement with 12 / 12, with both records quoted and cited on every item.
- **Consolidation drafting (consolidate), suitable for first pass consolidation drafts.** Strong in the measurement with 12 / 12.
- **Rerank and interaction log digest, not recommended on this evidence.** No golden set exists for these paths, so nothing was measured. They must be calibrated before use, or stay unbuilt.

## Raw record

The full raw results are in `checks/out/calibration-spark-open.json`.
