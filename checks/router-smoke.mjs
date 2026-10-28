/**
 * Router smoke: local fallback is live, hosted stubs fall through.
 * No network, no database. Run: node checks/router-smoke.mjs
 */
import { route, providerStatus } from '../router/router.mjs';

let failures = 0;
function assert(cond, label, extra = '') {
  if (cond) console.log(`  PASS ${label}`);
  else { failures++; console.log(`  FAIL ${label} ${extra}`); }
}

console.log('provider status:');
for (const p of providerStatus()) console.log(`  ${p.id}: live=${p.live} configured=${p.configured}`);

console.log('consolidate (meta stub -> local fallback):');
const c = await route('consolidate', {
  episodes: [
    { id: 'e1', text: 'The demo corpus is fictional.' },
    { id: 'e2', text: 'the demo corpus   is fictional.' },
    { id: 'e3', text: 'Recall receipts cite record ids.' },
  ],
});
assert(c.provider_used === 'local', 'fell back to local', JSON.stringify(c.attempts));
assert(c.result.atoms.length === 2 && c.result.merged === 1, 'duplicates merged', JSON.stringify(c.result));
assert(c.attempts.length === 2 && c.attempts[0].provider === 'meta' && c.attempts[0].ok === false, 'stub attempt logged');

console.log('gate_score (fireworks stub -> local):');
const g1 = await route('gate_score', { proposal: { text: 'A grounded fact.', type: 'semantic', grounding_ids: ['a', 'b'] } });
assert(g1.result.decision === 'approve' && g1.result.reason === 'grounding>=2', 'grounded semantic approves');
const g2 = await route('gate_score', { proposal: { text: 'A new procedure.', type: 'procedural' } });
assert(g2.result.decision === 'escalate' && g2.result.reason === 'procedural-human-always', 'procedural escalates');
const g3 = await route('gate_score', { proposal: { text: '   ', type: 'semantic' } });
assert(g3.result.decision === 'reject', 'empty text rejects');

console.log('narrate:');
const n = await route('narrate', { query: 'receipts', results: [{ id: 'm-1', text: 'Recall receipts cite record ids.' }] });
assert(n.provider_used === 'local' && n.result.receipts[0] === 'm-1', 'narration carries receipt');
const n0 = await route('narrate', { query: 'nothing', results: [] });
assert(n0.result.receipts.length === 0 && /No memories/.test(n0.result.narration), 'empty recall narrates honestly');

console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
