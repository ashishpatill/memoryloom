/**
 * Demo utility: recall the firmware answer in the demo namespace and
 * narrate it through the provider router (Meta muse-wonder-1.0 in live
 * mode, deterministic local narrator otherwise — the same receipts
 * either way). Prints the narration, its receipts, which provider
 * answered, and whether the answer came from the router cache.
 *
 * This is the demo script's narration beat (docs/demo-script.md).
 * Synthetic/demo corpus only, like every paid call in this repo.
 *
 * Usage: DATABASE_URL=postgres://… [MEMORYLOOM_ROUTER_MODE=live] node scripts/narrate-demo.mjs
 */
import pg from 'pg';
import { recallWithReceipts } from '../lib/planes.mjs';
import { route } from '../router/router.mjs';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL missing'); process.exit(1); }
const namespace = process.env.WEB_NAMESPACE || 'memoryloom-demo';
const query = 'which firmware does the bench unit run';

const pool = new pg.Pool({ connectionString: url, max: 2 });
const recall = await recallWithReceipts(pool, { namespace, query, k: 5 });
await pool.end();

const top = recall.results.slice(0, 2).map((r) => ({ id: r.id, text: r.text }));
const r = await route('narrate', { query, results: top }, { synthetic: true });
if (!r.result) {
  console.error('narration failed on every provider:', JSON.stringify(r.attempts));
  process.exit(1);
}
console.log(JSON.stringify({
  query,
  provider_used: r.provider_used,
  cached: r.cached,
  narration: r.result.narration,
  receipts: r.result.receipts,
}, null, 2));
