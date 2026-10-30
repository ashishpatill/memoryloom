/**
 * Router smoke: local fallback is live, hosted providers fall through
 * when not armed (default mode), gate fallback fails closed, Baseten
 * is parked. No network, no database.
 * Run: node checks/router-smoke.mjs
 */
import { route, providerStatus } from '../router/router.mjs';

let failures = 0;
function assert(cond, label, extra = '') {
  if (cond) console.log(`  PASS ${label}`);
  else { failures++; console.log(`  FAIL ${label} ${extra}`); }
}

console.log('provider status:');
for (const p of providerStatus()) console.log(`  ${p.id}: live=${p.live} configured=${p.configured}`);

assert(providerStatus().find((p) => p.id === 'baseten').live === false, 'baseten parked (not live)');
assert(providerStatus().find((p) => p.id === 'meta').live === true, 'meta provider wired live');

console.log('consolidate (meta not armed -> local fallback):');
const c = await route('consolidate', {
  episodes: [
    { id: 'e1', text: 'The demo corpus is fictional.' },
    { id: 'e2', text: 'the demo corpus   is fictional.' },
    { id: 'e3', text: 'Recall receipts cite record ids.' },
  ],
});
assert(c.provider_used === 'local', 'fell back to local', JSON.stringify(c.attempts));
assert(c.result.atoms.length === 2 && c.result.merged === 1, 'duplicates merged', JSON.stringify(c.result));
assert(c.attempts.length === 2 && c.attempts[0].provider === 'meta' && c.attempts[0].ok === false, 'meta attempt logged before fallback');

console.log('gate_score (local placeholder fails closed — real decisions are Jev, lib/gate.mjs):');
const g1 = await route('gate_score', { proposal: { text: 'A grounded fact.', type: 'semantic', grounding_ids: ['a', 'b'] } });
assert(g1.result.decision === 'escalate', 'local fallback never approves (fail closed)');
const g2 = await route('gate_score', { proposal: { text: 'A new procedure.', type: 'procedural' } });
assert(g2.result.decision === 'escalate', 'procedural escalates');
const g3 = await route('gate_score', { proposal: { text: '   ', type: 'semantic' } });
assert(g3.result.decision === 'reject', 'empty text rejects (validation)');

console.log('triage (meta not armed -> local provisional labels):');
const t = await route('triage', { proposals: [{ id: 'p1', text: 'A fact.', type: 'semantic' }, { id: 'p2', text: 'A step.', type: 'procedural' }] });
assert(t.provider_used === 'local' && t.result.labels.length === 2 && t.result.labels.every((l) => l.provisional), 'local triage labels are provisional');

console.log('narrate:');
const n = await route('narrate', { query: 'receipts', results: [{ id: 'm-1', text: 'Recall receipts cite record ids.' }] });
assert(n.provider_used === 'local' && n.result.receipts[0] === 'm-1', 'narration carries receipt');
const n0 = await route('narrate', { query: 'nothing', results: [] });
assert(n0.result.receipts.length === 0 && /No memories/.test(n0.result.narration), 'empty recall narrates honestly');

console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
