/**
 * probe-baseten.mjs — ONE tiny capped probe call on Baseten DeepSeek.
 *
 * Ordered by Ashish 2026-10-30 19:22 IST before any bulk Baseten spend:
 * the $100 grant mail tied the grant key to Muse Spark Open only, so
 * this probe establishes (a) the saved key serves
 * deepseek-ai/DeepSeek-V4.1-Flash-1017, and (b) what the call does —
 * succeed against the key's balance, or fail. Balance attribution
 * (grant vs standard workspace credit) has no API surface: every
 * billing/usage endpoint on api.baseten.co returns 404 for this key
 * (checked 2026-10-30), and /v1/api_keys returns 403 — the key is the
 * permission-scoped one-time GRANT key, not a workspace Settings key,
 * so a charge carried by this key is a charge on the grant it carries.
 *
 * The call is spend-logged like every paid call (provider 'baseten',
 * spend class 'calibration'). Published Baseten prices for this model:
 * $0.30 / 1M input, $1.20 / 1M output.
 * Owning file: checks/probe-baseten.mjs
 * Accountable layer: Router layer
 * Provider need: Live Baseten
 * Declared mode: Runs only inside its owning card
 */
import { resolveProviderKey } from '../lib/config.mjs';
import { logSpend } from '../router/spend.mjs';

const MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-1017';
const PRICE = { in: 0.3, out: 1.2 };

const { key: token } = resolveProviderKey('baseten');
if (!token) {
  console.error('PROBE ABORTED: no Baseten API key configured (set BASETEN_API_KEY or add one in Settings).');
  process.exit(1);
}
const base = String(process.env.BASETEN_BASE_URL || 'https://inference.baseten.co').replace(/\/$/, '');
const res = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: MODEL,
    messages: [
      { role: 'system', content: 'You are a probe endpoint. Reply with exactly: PROBE-OK' },
      { role: 'user', content: 'ping' },
    ],
    max_tokens: 16,
    temperature: 0,
  }),
  redirect: 'error',
});
const interestingHeaders = {};
for (const [k, v] of res.headers.entries()) {
  if (/credit|balance|billing|usage|limit|remain/i.test(k)) interestingHeaders[k] = v;
}
const text = await res.text();
let json = null;
try { json = JSON.parse(text); } catch { /* non-JSON */ }

console.log('HTTP status:', res.status);
console.log('credit/billing headers:', JSON.stringify(interestingHeaders));
if (json?.usage) {
  const u = json.usage;
  const est = Math.round(((u.prompt_tokens / 1e6) * PRICE.in + (u.completion_tokens / 1e6) * PRICE.out) * 1e6) / 1e6;
  logSpend({
    at: new Date().toISOString(),
    provider: 'baseten',
    model: MODEL,
    task: 'probe',
    spend_class: 'calibration',
    input_tokens: u.prompt_tokens || 0,
    output_tokens: u.completion_tokens || 0,
    est_cost_usd: est,
    cached: false,
    synthetic: true,
  });
  console.log('usage:', JSON.stringify(u), 'est cost $' + est, '(spend-logged)');
}
console.log('reply:', json?.choices?.[0]?.message?.content ?? text.slice(0, 300));
console.log(
  res.status === 200
    ? 'PROBE VERDICT: key serves DeepSeek-V4.1-Flash-1017 (HTTP 200).'
    : `PROBE VERDICT: call failed with HTTP ${res.status} — lane does not clear.`
);
