# Baseten probe outcome and challenger standings for decisions, 2026-10-30

## The probe (ordered before any bulk Baseten spend)

The $100 grant mail tied the grant key to Muse Spark Open only, so before building the DeepSeek triage lane we ran one tiny capped probe (`checks/probe-baseten.mjs`). That probe was a single chat completion on `deepseek-ai/DeepSeek-V4.1-Flash-1017`, with a maximum of 16 output tokens, using the Baseten API key configured for the app.

**Result. HTTP 403. `{"error":"please check the api-key you provided"}`.**

Diagnosis, run once with a second, independent client to rule out our own client code.

- `GET /v1/models` on the same key and host returned **HTTP 200** and 21 models. The key authenticates and the catalogue read works.
- `POST /v1/chat/completions` on `deepseek-ai/DeepSeek-V4.1-Flash-1017` returned **403**, with the same error.
- The same call on `zai-org/GLM-5.2` returned **403**.
- The same call on `moonshotai/Kimi-K3` returned **403**.
- Billing attribution has no API surface for this key. The paths `/v1/billing`, `/v1/billing/credits`, `/v1/credits`, `/v1/usage`, `/v1/organizations`, and `/v1/workspaces` all return 404, and `/v1/api_keys` returns 403 PERMISSION_DENIED. The key is scoped by permission, exactly as a grant key restricted to one model would be.

**Verdict (inferred from the measured facts above). The probe FAILED.** Three chat completions returned 403 while the catalogue read on the same key returned 200, so the grant key appears scoped to Muse Spark Open only. That is an inference from those measured facts, not a statement Baseten made directly. Spark is not used in MemoryLoom, so on that inference the key has no usable inference for this project. This matches the grant mail's wording, and the catalogue listing DeepSeek never implied the key could call it. No charge was made. Refused calls return no usage and cost nothing, and Baseten spend for the whole project remains $0.

Consequences, per the staging rules.

- The DeepSeek triage lane is **not built**. Bulk triage stays on the Meta Wonder medium tier, its current owner. The router keeps Baseten as a closed provider whose reason string records the probe.
- No Baseten spend has occurred, and none is planned while the lane stays closed. No product path calls Baseten in this build.
- The lane would reopen with a Baseten key whose scope covers DeepSeek, or with a grant reissue. If either happens, run the probe again, record CLEARED in `router/config.json` (`baseten_probe.verdict`), and the lane and the challenger harness below unlock.

## Decision challengers, DEFERRED, Jev stands alone

Challenger candidates (Baseten catalogue, System One compatible, same `POST /v1/systemone` shape and answers map as Jev).

| model | price per 1M input tokens (output free) |
|---|---|
| decision-models/baseten-joey-2b-latest | $0.01 |
| decision-models/baseten-elephant-9b-latest | $0.035 |
| Jev jev-1.13.0 (incumbent, for scale) | $0.042 |
| decision-models/baseten-mammoth-27b-latest | $0.10 |

Prices are the published Model API rates (Baseten library / OpenRouter listings, 2026-10-30). On price per token, joey and elephant would be cheaper than Jev and mammoth dearer, but price per *decision* is what counts, and no challenger call was made, so no price per decision was measured.

Standings. **All three challengers are DEFERRED at leg 0.** The staging rule makes every challenger run conditional on the probe, and the probe failed. No leg was run. The legs that were not run are the gate golden set (Jev baseline 40/40, 0 unsafe, ~$0.0000164/decision), the 15 item decision sample regate (Jev 14/15), and the ContractNLI benchmark set (Jev 0.8207 accuracy, 36 false approvals). **No decision class has a challenger. Jev is the decision layer for gate, consolidation, decay and promotion, unchanged.**

What is built and waiting.

- `lib/decisions.mjs`. The decision backend is swappable per class via `router/config.json` `decision_backends` (all four classes set to `jev`). Each challenger has a ready adapter implementing the same evaluate contract, with the router's spend log, content hash cache and Baseten calibration stop loss, and no retries, so a failed spot check is a recorded failure and never a double spend.
- `checks/challenge-decisions.mjs`. This is the harness for direct comparison. It scores a challenger through the production decision rule (same questions, same calibration map, same decision logic, only the probability source changes), cheapest leg first, and closes any challenger that loses a leg. While the probe record stands, it refuses to spend and writes the deferral to `checks/out/challengers.json`.
- `checks/fixtures/gate-golden.mjs`. This is the 40 item golden set, now shared verbatim by the Jev calibration and the challenger harness.

## Update 2026-10-31, the Spark Open lane opens

The 2026-10-30 record above is not rewritten, and its facts stand. Completions for models other than Spark were refused, and the challengers are still deferred. No challenger leg was run in this iteration.

On 2026-10-31 Ashish reversed the Spark position for exactly one lane, Muse Spark Open on Baseten, as the Tier 0 operations provider. The capped probe and the calibration were then run for that lane. See `docs/spark-open-calibration.md` for the numbers.
