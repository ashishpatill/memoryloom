# Spark Open Calibration — 2026-10-31

On 2026-10-31 we measured Muse Spark Open on Baseten against the same synthetic test sets used for the recorded Wonder run: a 40-item write-gate pre-screen set and a 36-item meta set covering consolidation, narration, and explanation drafting. This was calibration before contact — measurement only. No product path uses this tier yet.

## Probe result

Before the calibration, one capped test call was made to check that the connection worked.

| Item | Result |
|---|---|
| Model | `meta-models/muse-spark-open-1026` |
| Response | HTTP 200 (success) |
| Prompt tokens used | 152, of which 128 were cached (reused from a stored copy, not re-read from scratch) |
| Completion tokens used | 16 |
| Visible reply | Empty |

The empty visible reply is not a failure. The model spends completion tokens on reasoning first, before writing anything the reader sees. The tiny cap of 16 tokens was used up by that reasoning, so no visible text remained, even though the call itself succeeded.

## Method

How the calls were made and checked:

| Part | What was done |
|---|---|
| Transport | Calls went through the router (the part of the app that sends requests to model providers) in live mode. The API key came from the app's own configuration service, where its settings are stored. |
| Spend class | Every calibration call was recorded under the spend class `calibration`. A spend class is the label that ties spending to its approved budget. |
| Effort — prescreen | `low`. Effort is how much reasoning work the model is asked to do before answering. |
| Effort — consolidate / narrate / explain | `medium` |
| Model pinning | The model is pinned, meaning the exact model id above is fixed in code. Any other model id is refused. |
| Response checking | Baseten does not enforce JSON schema — it will not guarantee that a reply arrives in the exact data shape requested. So every response was validated (checked against the required shape) before any part of it was used. |
| Test data | Golden sets only, and synthetic only. A golden set is a list of test items with the correct outcome recorded in advance. No real user data was used. |

## Write-gate set

The write gate decides whether a proposed item may be written into memory as truth. In this test, Spark Open gave a lean — an advisory first opinion — on each item. It did not decide anything.

| Comparison | Agreement |
|---|---|
| Spark Open lean vs. expected outcome | 33 / 40 (82.5%) |
| Spark Open lean vs. recorded Jev decision | 33 / 40 (82.5%) |

The two numbers are identical because Jev scored 40 / 40 against the expected outcomes. Jev stays the decider. The pre-screen never approves anything into truth.

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

The three over-escalations (a03, a04, a12) are node-local notes — notes about things in the local workspace: a laptop cabinet, a bench, a whiteboard. The gate's own rules approve these without evidence. Spark Open asked for evidence the rules do not require.

The four under-escalations (e03, e06, e12, e13) are cases the decision layer catches through structure the text alone does not show: a pinned proposal (held in place so it cannot be passed this way), a single evidence record where the bar is two, and an unevidenced goal. The lean saw text that looked supported and stopped there.

Both directions are safe for a pre-screen whose disagreements escalate to Wonder medium in the cascade (the chain where a harder case is passed up to a stronger model). Over-escalation costs one extra review. Under-escalation is exactly why Jev still decides those same items.

## Meta calibration set

These items test drafting work: combining records (consolidate), telling back what was recalled (narrate), and explaining a contradiction (explain). The same prompts and the same deterministic scorers — fixed scoring rules, not another model's opinion — were used as in the recorded Wonder run.

| Path | Items | Spark Open passed |
|---|---|---|
| Consolidate | 12 | 12 / 12 |
| Narrate | 12 | 12 / 12 |
| Explain | 12 | 12 / 12 |
| **Total** | **36** | **36 / 36** |

Wonder Full's recorded result on the same set is also 36 / 36. Items where Spark Open's outcome differs from Wonder's recorded per-item outcome: none.

## Spend

| Measure | Amount |
|---|---|
| Paid calls | 76 |
| Input tokens | 26,706 |
| Output tokens | 33,986 |
| Estimated cost | $0.168111 of the $15 Baseten calibration class budget |

These figures come from the router spend log. Every entry shows provider `baseten`, spend class `calibration`, and tier `tier0`. The probe call above was a separate one-off check made before calibration and is not part of this total.

## Recommendation for Iteration 6.2

Advice only, per path, based on the numbers above:

- **Prescreen (write-gate lean): adopt as a Tier 0 drafting aid.** Jev must decide every item, and any lean/Jev disagreement escalates to Wonder medium (Tier 1). Spark Open was measured-strong on meaningless noise and on well-evidenced claims. It was weak exactly where rules, not text, carry the decision — so it is advisory-only, never a filter that can drop or approve an item on its own.
- **Narration drafting (narrate): suitable for first-pass recall narration drafts.** Measured-strong: 12 / 12, with receipts (the record references backing the draft) complete on every item.
- **Explanation drafting (explain): suitable for first-pass contradiction-explanation drafts,** with Tier 1 review on escalated items. Measured-strong: 12 / 12, with both records quoted and cited on every item.
- **Consolidation drafting (consolidate): suitable for first-pass consolidation drafts.** Measured-strong: 12 / 12.
- **Rerank and interaction-log digest: not recommended on this evidence.** No golden set exists for these paths, so nothing was measured. They must be calibrated before use, or stay unbuilt.

## Raw record

The full raw results are in `checks/out/calibration-spark-open.json`.
