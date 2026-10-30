# Prompt hardening — Block 7 (2026-10-30)

The core-reasoning calibration (docs/calibration-meta-core-reasoning.md)
left five real failures, all in two classes. This note records what was
changed and the before/after on exactly those items.

## The failures (calibration of 2026-10-30, before hardening)

- Narration dropped receipt citations: n11 on both tiers (missing
  receipt m-s02) and n12 on Wonder Full (missing m-s09). The narrator
  used the records but did not cite every one.
- Explanations paraphrased the conflict instead of quoting it: x7 on
  both tiers ("staged first" / "indexed first"), x8 on Wonder Full
  ("human always"), x11 on both tiers ("superseded stays readable" /
  "superseded is deleted"). The conflicting values never appeared
  verbatim, so a reviewer could not see the actual clash.

## Changes (router/router.mjs, metaPrompt)

- narrate: the prompt now requires one sentence per supplied record,
  each fact-bearing sentence ending with that record's [receipt: <id>]
  marker, no merging of two records into one sentence, and the
  receipts array listing every supplied id exactly once, in order.
- explain: the prompt now requires quoting each record's conflicting
  claim verbatim, word for word, in double quotes, before any
  discussion — for both records, even when one is obviously wrong —
  and (second pass) naming both record ids in the explanation text
  and in the cites array.

## Bug found while verifying: the cache ignored the prompt

The first re-run after the prompt edit returned every item from cache,
including the edited tasks. The content-hash cache key covered
(provider, model, task, payload) but not the rendered prompt, so a
prompt edit silently served pre-edit results — the credit plan's rule
"an identical prompt and input is never paid for twice" was only half
implemented. Fix: prompt-built providers expose a prompt fingerprint
(a hash of the rendered system + user text) and paidCall folds it
into the cache key. Providers without a fingerprint keep the
historical key shape, so no other cache entries were disturbed.
Regression evidence: the router smoke check still passes 11/11, and
the calibration below re-ran live exactly where prompts had changed.

## Before / after on the affected items

| Item | Tier | Before | After |
| --- | --- | --- | --- |
| n11 (narrate) | Wonder Full | FAIL — missing receipts: m-s02 | PASS |
| n11 (narrate) | Wonder | FAIL — missing receipts: m-s02 | PASS |
| n12 (narrate) | Wonder Full | FAIL — missing receipts: m-s09 | PASS |
| x7 (explain) | Wonder Full | FAIL — missing phrases: staged first; indexed first | PASS |
| x7 (explain) | Wonder | FAIL — missing phrases: staged first; indexed first | PASS |
| x8 (explain) | Wonder Full | FAIL — missing phrases: human always | PASS |
| x11 (explain) | Wonder Full | FAIL — missing phrases: superseded stays readable; superseded is deleted | PASS |
| x11 (explain) | Wonder | FAIL — missing phrases: superseded stays readable; superseded is deleted | PASS |

Full golden set after hardening: **Wonder Full 36/36, Wonder 36/36**
(before: 31/36 and 33/36).

## Honest notes on the final run

- One intermediate run showed Wonder Full at 30/36 with four
  provider-level failures (x3, x7, x10, x11 returned no provider) and
  two citation slips (x2, x6). A direct probe of x7 at high effort
  immediately afterwards succeeded with a fully compliant answer, so
  the four are recorded as transient call failures, not prompt
  failures; the two citation slips motivated the second prompt pass.
- The final 36/36 is assembled the way the cache is designed to work:
  per tier, 12 consolidation items came from the original cache
  (their prompt never changed), 12 narration items from the first
  hardened run's cache (identical prompt and input), and 12
  explanation items ran live against the final prompt. No item was
  paid for twice with an identical prompt and input.
- Calibration-class spend: $0.1182 before this block, $0.3595 after
  (cumulative, router spend log) — $0.2413 of hardening and
  verification against the $22.50 calibration budget.
