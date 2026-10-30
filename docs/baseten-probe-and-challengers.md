# Baseten probe outcome and decision-challenger standings — 2026-10-30

## The probe (ordered before any bulk Baseten spend)

The $100 grant mail tied the grant key to Muse Spark Open only, so
before building the DeepSeek triage lane we ran one tiny capped probe
(`checks/probe-baseten.mjs`): a single chat completion on
`deepseek-ai/DeepSeek-V4.1-Flash-1017`, max 16 output tokens, using
the Baseten API key configured for the app.

**Result: HTTP 403 — `{"error":"please check the api-key you provided"}`.**

Diagnosis, run once with a second, independent client to rule out
our own client code:

- `GET /v1/models` on the same key and host: **HTTP 200**, 21 models —
  the key authenticates and the catalogue read works.
- `POST /v1/chat/completions` on `deepseek-ai/DeepSeek-V4.1-Flash-1017`:
  **403**, same error.
- Same call on `zai-org/GLM-5.2`: **403**.
- Same call on `moonshotai/Kimi-K3`: **403**.
- Billing attribution has no API surface for this key: `/v1/billing`,
  `/v1/billing/credits`, `/v1/credits`, `/v1/usage`, `/v1/organizations`,
  `/v1/workspaces` all return 404, and `/v1/api_keys` returns 403
  PERMISSION_DENIED — the key is permission-scoped, exactly as a
  model-restricted grant key would be.

**Verdict: the probe FAILED.** The grant key serves Muse Spark Open
and nothing else we can use — Spark is banned in MemoryLoom, so the
key has no usable inference for this project. This matches the grant
mail's wording; the catalogue listing DeepSeek never implied the key
could call it. No charge was made: refused calls return no usage and
cost nothing (Baseten spend for the whole project remains $0).

Consequences, per the staging rules:

- The DeepSeek triage lane is **not built**. Bulk triage stays on the
  Meta Wonder medium tier, its current owner. The router keeps
  Baseten as a closed provider whose reason string records the probe.
- The Baseten budget ($100: 15 calibration / 60 triage / 25 reserve)
  is **untouched**.
- What would reopen the lane: a Baseten key whose scope covers
  DeepSeek (a workspace Settings key would spend the workspace's own
  credit, not the grant — that trade-off is the owner's call), or a
  grant reissue. If either happens, re-run the probe, record CLEARED
  in `router/config.json` (`baseten_probe.verdict`), and the lane +
  challenger harness below unlock.

## Decision challengers — DEFERRED, Jev stands alone

Challenger candidates (Baseten catalogue, System One compatible —
same `POST /v1/systemone` shape and answers map as Jev):

| model | price per 1M input tokens (output free) |
|---|---|
| decision-models/baseten-joey-2b-latest | $0.01 |
| decision-models/baseten-elephant-9b-latest | $0.035 |
| Jev jev-1.13.0 (incumbent, for scale) | $0.042 |
| decision-models/baseten-mammoth-27b-latest | $0.10 |

Prices are the published Model API rates (Baseten library /
OpenRouter listings, 2026-10-30). On price per token, joey and
elephant would be cheaper than Jev and mammoth dearer — but price
per *decision* is what counts, and no challenger call was made, so
no per-decision price was measured.

Standings: **all three challengers DEFERRED at leg 0** — the staging
rule makes every challenger run conditional on the probe, and the
probe failed. No leg was run: not the gate golden set (Jev baseline
40/40, 0 unsafe, ~$0.0000164/decision), not the ProofDesk sample
re-gate (Jev 14/15), not ContractNLI (Jev 0.8207 accuracy, 36 false
approvals). **No decision class has a challenger. Jev is the decision
layer for gate, consolidation, decay and promotion, unchanged.**

What is built and waiting:

- `lib/decisions.mjs` — the decision backend is swappable per class
  via `router/config.json` `decision_backends` (all four classes set
  to `jev`). Each challenger has a ready adapter implementing the
  same evaluate contract, with the router's spend log, content-hash
  cache and Baseten calibration stop-loss — and no retries, so a
  failed spot-check is a recorded failure, never a double spend.
- `checks/challenge-decisions.mjs` — the head-to-head harness. It
  scores a challenger through the production decision rule
  (same questions, same calibration map, same decision logic; only
  the probability source changes), cheapest leg first, and closes
  any challenger that loses a leg. While the probe record stands,
  it refuses to spend and writes the deferral to
  `checks/out/challengers.json`.
- `checks/fixtures/gate-golden.mjs` — the 40-item golden set, now
  shared verbatim by the Jev calibration and the challenger harness.
