/**
 * Graph + daemon check, on the synthetic demo corpus (Project
 * Lantern) in a throwaway DB:
 *  - Graph derivation: agent nodes for grok + moose, authored_by /
 *    grounded_in / supersedes edges, decision nodes.
 *  - provenanceTrail, agentNeighbourhood, supersessionChain.
 *  - believedAt: bi-temporal belief on 10 Oct vs 25 Oct.
 *  - Daemon cycle: emits consolidation + contradiction + decay
 *    proposals ONLY (truth untouched), advances its watermark,
 *    writes a run log; second cycle emits nothing (idempotent);
 *    crash-resume: a stuck 'running' row is abandoned and
 *    reprocessing emits no duplicates.
 *  - applyDaemonItem: consolidation merges through the Jev gate,
 *    contradiction flags are human-only, decay resolves with a Jev
 *    verdict.
 *
 * Usage: DATABASE_URL=postgres://... node checks/graph-daemon.mjs
 * Owning file: checks/graph-daemon.mjs
 * Accountable layer: Graph surface and daemon layer
 * Provider need: Stub Jev for the consolidation and decay verdict cases, corrected at card S2
 * Declared mode: Stub
 */
process.env.MEMORYLOOM_ROUTER_MODE = 'live';
process.env.JEV_TIMEOUT_MS = process.env.JEV_TIMEOUT_MS || '15000';
import pg from 'pg';
import {
  agentNeighbourhood,
  believedAt,
  buildGraph,
  provenanceTrail,
  supersessionChain,
} from '../lib/graph.mjs';
import { applyDaemonItem, listDaemonRuns, runDaemonCycle } from '../lib/daemon.mjs';
import { seedDemo, DEMO_NAMESPACE as NS } from '../scripts/seed-demo.mjs';
import { preflightOrExit } from './db-preflight.mjs';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL missing'); process.exit(1); }
preflightOrExit();
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });
let failures = 0;
function assert(cond, label, extra = '') {
  if (cond) console.log(`  PASS ${label}`);
  else { failures++; console.log(`  FAIL ${label} ${extra}`); }
}
const NOW = new Date('2026-10-30T00:00:00Z');

// ---- seed -------------------------------------------------------------------
await seedDemo(pool);
const liveCount = async () =>
  (await pool.query(`SELECT count(*)::int n FROM memories WHERE namespace = $1 AND approval = 'live'`, [NS])).rows[0].n;
assert((await liveCount()) === 11, 'demo corpus seeded: 11 live memories');

// ---- graph derivation ---------------------------------------------------------
console.log('graph derivation:');
const graph = await buildGraph(pool, NS);
assert(graph.counts.memory === 11 && graph.counts.proposal === 2, 'graph node counts (11 memories, 2 proposals)', JSON.stringify(graph.counts));
const agentIds = graph.nodes.filter((n) => n.kind === 'agent').map((n) => n.id).sort();
assert(agentIds.join(',') === 'grok,moose', 'agent nodes are grok + moose', agentIds.join(','));
assert(graph.counts.source === 2, 'two source nodes from evidence_refs', JSON.stringify(graph.counts));
const hasEdge = (type, from, to) => graph.edges.some((e) => e.type === type && e.from === from && e.to === to);
assert(hasEdge('authored_by', 'memory:demo-g4', 'agent:grok'), 'edge authored_by g4 -> grok');
assert(hasEdge('grounded_in', 'memory:demo-g4', 'memory:demo-g2') && hasEdge('grounded_in', 'memory:demo-g4', 'memory:demo-g3'), 'edges grounded_in g4 -> g2,g3');
assert(hasEdge('supersedes', 'memory:demo-v2', 'memory:demo-v1'), 'edge supersedes v2 -> v1');
assert(hasEdge('proposed_by', 'proposal:demo-p2', 'agent:grok'), 'edge proposed_by p2 -> grok');
assert(graph.nodes.some((n) => n.kind === 'decision' && n.id === 'proposal:demo-p1'), 'decision node for the decided proposal');

// ---- provenance trail ------------------------------------------------------------
console.log('provenance trail:');
const trail = await provenanceTrail(pool, 'demo-g4');
assert(trail && trail.author === 'grok', 'trail names the author');
assert(trail.grounding.length === 2 && trail.grounding.every((g) => g.author === 'moose'), 'trail dereferences both grounding records (moose)');
assert(trail.decisions.some((d) => d.kind === 'promotion' && d.proposal_id === 'demo-p1'), 'trail carries the promotion decision');
assert((await provenanceTrail(pool, 'ghost')) === null, 'trail for a missing memory is null');

// ---- agent neighbourhoods -----------------------------------------------------------
console.log('agent neighbourhoods:');
const grokHood = await agentNeighbourhood(pool, NS, 'grok');
assert(grokHood.found && grokHood.counts.memories >= 6, 'grok neighbourhood holds his memories', JSON.stringify(grokHood.counts));
assert(grokHood.nodes.some((n) => n.node_id === 'memory:demo-g2'), 'grok neighbourhood reaches moose grounding in one hop');
const mooseHood = await agentNeighbourhood(pool, NS, 'moose');
assert(mooseHood.found && mooseHood.counts.memories >= 5, 'moose neighbourhood holds her memories', JSON.stringify(mooseHood.counts));
assert((await agentNeighbourhood(pool, NS, 'nobody')).found === false, 'unknown agent is not found');

// ---- supersession + bi-temporal belief -------------------------------------------------
console.log('supersession chain + believed-at:');
const chain = await supersessionChain(pool, 'demo-v1');
assert(chain && chain.length === 2 && chain[0].id === 'demo-v1' && chain[1].id === 'demo-v2', 'chain runs Hall A -> Hall B', JSON.stringify(chain?.map((c) => c.id)));
const chainFromTail = await supersessionChain(pool, 'demo-v2');
assert(chainFromTail && chainFromTail.map((c) => c.id).join(',') === 'demo-v1,demo-v2', 'chain is the same from the tail');
const oct10 = await believedAt(pool, NS, '2026-10-10T00:00:00Z');
assert(oct10.some((m) => m.id === 'demo-v1') && !oct10.some((m) => m.id === 'demo-v2'), 'on 10 Oct the team believed Hall A');
const oct25 = await believedAt(pool, NS, '2026-10-25T00:00:00Z');
assert(oct25.some((m) => m.id === 'demo-v2') && !oct25.some((m) => m.id === 'demo-v1'), 'on 25 Oct the team believed Hall B');

// ---- daemon cycle 1 -----------------------------------------------------------------------
console.log('daemon cycle 1 (proposals only):');
const runs0 = await listDaemonRuns(pool);
const run1 = await runDaemonCycle(pool, { namespace: NS, now: NOW });
assert(run1.status === 'finished' && run1.scanned > 0, 'cycle finished and scanned the sync log', JSON.stringify(run1));
assert(run1.emitted.consolidation_candidates === 1, 'one consolidation candidate (venue-hours duplicates)', JSON.stringify(run1.emitted));
assert(run1.emitted.contradiction_flags === 1, 'one contradiction flag (charged overnight pair)', JSON.stringify(run1.emitted));
assert(run1.emitted.decay_candidates === 1, 'one decay candidate (fairground rehearsal note)', JSON.stringify(run1.emitted));
assert(run1.watermark_after > run1.watermark_before, 'watermark advanced');
assert((await liveCount()) === 11, 'truth untouched: still 11 live memories');
const p2 = await pool.query(`SELECT status FROM proposals WHERE id = 'demo-p2'`);
assert(p2.rows[0].status === 'pending', 'truth untouched: pending proposal unchanged');
const daemonItems = await pool.query(
  `SELECT id, kind, payload FROM review_items WHERE payload->>'daemon' = 'true' ORDER BY created_at`
);
assert(daemonItems.rows.length === 3, 'three daemon review items queued', `got ${daemonItems.rows.length}`);
const runs1 = await listDaemonRuns(pool);
assert(runs1.length === runs0.length + 1 && runs1[0].status === 'finished', 'run log holds the finished cycle');
const graph2 = await buildGraph(pool, NS);
assert(graph2.edges.some((e) => e.type === 'contradicts' && [e.from, e.to].includes('memory:demo-c1') && [e.from, e.to].includes('memory:demo-c2')), 'graph shows the contradiction edge after the daemon flag');

// ---- daemon cycle 2: idempotent --------------------------------------------------------------
console.log('daemon cycle 2 (idempotent):');
const run2 = await runDaemonCycle(pool, { namespace: NS, now: NOW });
assert(run2.emitted.consolidation_candidates === 0 && run2.emitted.contradiction_flags === 0 && run2.emitted.decay_candidates === 0, 'second cycle emits nothing new', JSON.stringify(run2.emitted));
const daemonItems2 = await pool.query(`SELECT count(*)::int n FROM review_items WHERE payload->>'daemon' = 'true'`);
assert(daemonItems2.rows[0].n === 3, 'still three daemon items after cycle 2');

// ---- crash-resume ------------------------------------------------------------------------------
console.log('crash-resume:');
await pool.query(`UPDATE sync_state SET last_seq = $1 WHERE key = $2`, [run1.watermark_before, `daemon:memoryloom:last_seq:ns:${NS}`]);
await pool.query(
  `INSERT INTO daemon_runs (id, daemon, namespace, status, watermark_before)
   VALUES ('stuck-run', 'memoryloom-daemon', $1, 'running', $2)`,
  [NS, run1.watermark_before]
);
const run3 = await runDaemonCycle(pool, { namespace: NS, now: NOW });
const stuck = await pool.query(`SELECT status FROM daemon_runs WHERE id = 'stuck-run'`);
assert(stuck.rows[0].status === 'abandoned', 'stuck run marked abandoned by the next cycle');
assert(run3.emitted.consolidation_candidates === 0 && run3.emitted.decay_candidates === 0 && run3.emitted.contradiction_flags === 0, 'reprocessing after a crash emits no duplicates', JSON.stringify(run3.emitted));

// ---- apply path: Jev-gated, human-only where designed --------------------------------------------
console.log('apply path:');
const byKind = Object.fromEntries(daemonItems.rows.map((r) => [r.payload.daemon_kind, r]));
const contraApply = await applyDaemonItem(pool, byKind.contradiction_flag.id);
assert(contraApply.applied === false && contraApply.human_only === true, 'contradiction flag refuses automated apply (human-only)');
const contraRow = await pool.query(`SELECT status FROM review_items WHERE id = $1`, [byKind.contradiction_flag.id]);
assert(contraRow.rows[0].status === 'queued', 'contradiction item stays queued for a human');

const consApply = await applyDaemonItem(pool, byKind.consolidation_candidate.id);
assert(consApply.applied === true && consApply.decision?.backend === 'jev', 'consolidation applied through the Jev gate', JSON.stringify(consApply).slice(0, 240));
if (consApply.applied) {
  const atom = await pool.query(`SELECT provenance FROM memories WHERE id = $1`, [consApply.new_id]);
  assert(Array.isArray(atom.rows[0].provenance.merged_from) && atom.rows[0].provenance.jev, 'merged atom carries merged_from + Jev provenance');
  const orig = await pool.query(`SELECT count(*)::int n FROM memories WHERE id = ANY($1) AND approval = 'retired'`, [['demo-d1', 'demo-d2']]);
  assert(orig.rows[0].n === 2, 'duplicate originals retired by the gated merge');
  const item = await pool.query(`SELECT status FROM review_items WHERE id = $1`, [byKind.consolidation_candidate.id]);
  assert(item.rows[0].status === 'resolved', 'consolidation item resolved');
}

const decayApply = await applyDaemonItem(pool, byKind.decay_candidate.id);
assert(decayApply.applied === true && decayApply.decision?.backend === 'jev' && decayApply.decision?.failed === false, 'decay candidate resolved with a Jev verdict', JSON.stringify(decayApply).slice(0, 240));
assert(decayApply.outcome === (decayApply.decision.drop ? 'retired' : 'kept-by-verdict'), 'decay outcome matches the verdict');
console.log(`  decay verdict for demo-s1: ${decayApply.decision?.decision} (raw ${JSON.stringify(decayApply.decision?.raw)})`);
const doubleApply = await applyDaemonItem(pool, byKind.decay_candidate.id);
assert(doubleApply.applied === false, 're-applying a resolved item is refused');

// ---- interleaved namespace watermark (card S3b) ----------------------------------------------
// Two namespaces hold duplicate pairs, written interleaved so the
// sync log alternates between them. A cycle restricted to the
// first namespace must leave the second namespace's events to be
// processed by its own cycle. On a single global watermark the
// first cycle advances the mark past the second namespace's rows
// and the second cycle finds nothing, so this case fails there.
console.log('interleaved namespace watermark:');
const WNS_A = 'memoryloom-daemon-wm-a';
const WNS_B = 'memoryloom-daemon-wm-b';
await pool.query(`DELETE FROM memories WHERE namespace = ANY($1)`, [[WNS_A, WNS_B]]);
await pool.query(`DELETE FROM review_items WHERE payload->>'namespace' = ANY($1)`, [[WNS_A, WNS_B]]);
await pool.query(`DELETE FROM sync_state WHERE key = ANY($1)`, [[`daemon:memoryloom:last_seq:ns:${WNS_A}`, `daemon:memoryloom:last_seq:ns:${WNS_B}`]]);
const wmText = 'The watermark interleaved pair states one shared fact.';
for (const [id, ns] of [['wm-a-1', WNS_A], ['wm-b-1', WNS_B], ['wm-a-2', WNS_A], ['wm-b-2', WNS_B]]) {
  await pool.query(
    `INSERT INTO memories (id, namespace, type, scope, text, importance, strength, pinned,
                           index_status, approval, grounding_ids, provenance)
     VALUES ($1, $2, 'semantic', 'global', $3, 5, 5.0, false, 'indexed', 'live', '{}', '{"author":"wm-check"}'::jsonb)`,
    [id, ns, wmText]
  );
}
const wmRunA = await runDaemonCycle(pool, { namespace: WNS_A, now: NOW });
assert(wmRunA.emitted.consolidation_candidates === 1, 'cycle for the first namespace emits its own candidate', JSON.stringify(wmRunA.emitted));
const bItemsBefore = await pool.query(
  `SELECT count(*)::int n FROM review_items WHERE payload->>'namespace' = $1 AND payload->>'daemon' = 'true'`, [WNS_B]
);
assert(bItemsBefore.rows[0].n === 0, 'the first namespace cycle emitted nothing for the second namespace');
const wmRunB = await runDaemonCycle(pool, { namespace: WNS_B, now: NOW });
assert(wmRunB.emitted.consolidation_candidates === 1, 'cycle for the second namespace still processes its own events (card S3b)', JSON.stringify(wmRunB.emitted));

await pool.end();
console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
