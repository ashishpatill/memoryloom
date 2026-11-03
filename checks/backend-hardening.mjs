/**
 * Backend hardening check — card S3b.
 *
 * Proves the schema, transaction and guard claims of the card on
 * a fresh database. Migration 008 applies cleanly on a fresh
 * database and over a database that stopped at migration 007.
 * Every named transaction boundary is driven once with a failure
 * injected at its named point, and the expected post state is
 * asserted. The promote claim, the conditional status guards on
 * the excluded decide tools and the concurrent pairs are proven
 * against the real decide functions. The stable error name
 * mapping is proven at the library level here, and at the MCP
 * and HTTP surfaces in the surface and web suites.
 *
 *   DATABASE_URL=postgres://… npm run check:hardening
 * Owning file: checks/backend-hardening.mjs
 * Accountable layer: Backend
 * Provider need: The local stubs for the gate and decision paths
 * Declared mode: Stub
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { preflightOrExit } from './db-preflight.mjs';
import { promoteProposal, rejectProposal, decideReviewItem } from '../lib/curator-decide.mjs';
import { consolidateNamespace, applyDecay } from '../lib/planes.mjs';
import { promoteEvent, recordEvent } from '../lib/learning.mjs';
import { coveredStoreOrPropose, coveredIngestFile } from '../lib/gatepath.mjs';
import { buildGraph, provenanceTrail } from '../lib/graph.mjs';
import { cacheKey, cachePut, routerConfig } from '../router/spend.mjs';
import { stableErrorName, failurePayload } from '../lib/errors.mjs';
import { JevError } from '../lib/jev.mjs';
import { DecisionError } from '../lib/decisions.mjs';

preflightOrExit();
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL missing'); process.exit(1); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 6 });

let failures = 0;
function assert(cond, label, extra = '') {
  if (cond) console.log(`  PASS ${label}`);
  else { failures++; console.log(`  FAIL ${label} ${extra}`); }
}
const q = (text, params) => pool.query(text, params);
// Learning events are append only, so no suite may delete them.
// Every case runs in a namespace stamped for this run, which
// keeps counts exact on a database a previous run already used.
const RUN = Date.now().toString(36);
const NS = (suffix) => `memoryloom-hardening-${suffix}-${RUN}`;
const DAY = 24 * 3600 * 1000;
const isoDaysAgo = (n, from = Date.now()) => new Date(from - n * DAY).toISOString();

async function wipeNs(ns) {
  await q(`DELETE FROM file_chunks WHERE proposal_id IN (SELECT id FROM proposals WHERE namespace = $1)`, [ns]);
  await q(`DELETE FROM request_records WHERE namespace = $1`, [ns]);
  await q(`DELETE FROM proposals WHERE namespace = $1`, [ns]);
  await q(`DELETE FROM memories WHERE namespace = $1`, [ns]);
}
async function insertMemory(ns, { id, text, type = 'semantic', strength = 1.0, pinned = false, createdAt = null, lastRecalledAt = null, decayAnchorAt = null, approval = 'live', provenance = {} }) {
  await q(
    `INSERT INTO memories (id, namespace, type, scope, text, importance, strength, pinned, provenance, approval, created_at, last_recalled_at, decay_anchor_at)
     VALUES ($1, $2, $3, 'global', $4, 5, $5, $6, $7::jsonb, $8, $9, $10, $11)`,
    [id, ns, type, text, strength, pinned, JSON.stringify(provenance), approval, createdAt, lastRecalledAt, decayAnchorAt]
  );
}
async function insertProposal(ns, { id, text = 'a hardening proposal', type = 'semantic', sourceFileName = null, chunkCount = null }) {
  await q(
    `INSERT INTO proposals (id, namespace, type, scope, text, importance, strength, pinned, grounding_ids, provenance, route_reason, source_file_name, chunk_count)
     VALUES ($1, $2, $3, 'global', $4, 5, 5.0, false, '{}', '{"author":"grok"}'::jsonb, 'hardening-seed', $5, $6)`,
    [id, ns, type, text, sourceFileName, chunkCount]
  );
}
const countMemories = async (ns) => Number((await q(`SELECT count(*)::int AS n FROM memories WHERE namespace = $1`, [ns])).rows[0].n);
const countEvents = async (ns, kind = null) => Number((await q(`SELECT count(*)::int AS n FROM learning_events WHERE namespace = $1 AND ($2::text IS NULL OR kind = $2)`, [ns, kind])).rows[0].n);

/* Fault injection. The wrapper delegates reads to the pool and
   hands out wrapped transaction clients whose query throws once
   when the statement matches the chosen pattern. The failure
   lands inside the boundary under test, on the real code path. */
function failingDb(match, times = 1) {
  let seen = 0;
  const guard = async (run, text, params) => {
    const sql = typeof text === 'string' ? text : (text && text.text) || '';
    if (seen < times && match(sql)) { seen++; throw new Error('injected failure for the hardening suite'); }
    return run(text, params);
  };
  const wrap = (client) => ({
    query: (text, params) => guard((t, p) => client.query(t, p), text, params),
    release: (err) => client.release(err),
  });
  return {
    query: (text, params) => guard((t, p) => pool.query(t, p), text, params),
    connect: async () => wrap(await pool.connect()),
  };
}
const runNode = (args, env) => new Promise((resolve) => {
  const p = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  p.on('close', (code) => resolve({ code, out }));
});

try {
  // The fixture ids are fixed strings, so a rerun on a used
  // database starts by removing this suite's own fixture rows.
  // Learning events stay, because they are append only. Every
  // event count below is scoped by namespace or by a per run
  // event id, so the kept events cannot disturb a later run.
  const FIXTURE_IDS = ['hc-dup-prop', 'hc-ce-1', 'hc-ce-2', 'hc-cu-1', 'hc-cu-2', 'hc-dq-clean', 'hc-dc-1', 'hc-claim-1', 'hc-file-1', 'hc-ev-1', 'hc-g-1', 'hc-g-2', 'hc-g-3', 'hc-trail-1'];
  await q(`DELETE FROM file_chunks WHERE proposal_id = ANY($1)`, [FIXTURE_IDS]);
  await q(`DELETE FROM proposals WHERE id = ANY($1)`, [FIXTURE_IDS]);
  await q(`DELETE FROM memories WHERE id = ANY($1) OR provenance->>'promoted_from' = ANY($1)`, [FIXTURE_IDS]);
  await q(`DELETE FROM review_items WHERE id IN ('hc-ev-item', 'hc-g-item')`);
  for (const suffix of ['cons-embed', 'cons-update', 'decay', 'decay-eq', 'gate-live', 'gate-rr', 'gate-queue', 'ingest', 'trail']) await wipeNs(NS(suffix));

  /* ============ Migration proofs ============ */
  console.log('migration proofs:');
  const base = DATABASE_URL.replace(/\/[^/]+$/, '');
  const admin = new pg.Pool({ connectionString: `${base}/postgres`, max: 2 });
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
  const freshName = `ml_s3b_fresh_${stamp}`;
  const upgName = `ml_s3b_upg_${stamp}`;
  const shapeChecks = async (dbPool, label) => {
    const tables = await dbPool.query(`SELECT table_name FROM information_schema.tables WHERE table_name IN ('request_records', 'file_chunks')`);
    assert(tables.rows.length === 2, `${label}: migration 008 tables exist`);
    const cols = await dbPool.query(`SELECT column_name FROM information_schema.columns WHERE (table_name = 'proposals' AND column_name IN ('created_memory_ids', 'source_file_name', 'chunk_count')) OR (table_name = 'memories' AND column_name = 'decay_anchor_at')`);
    assert(cols.rows.length === 4, `${label}: migration 008 columns exist`);
    const fks = await dbPool.query(`SELECT constraint_name FROM information_schema.table_constraints WHERE table_name = 'file_chunks' AND constraint_type = 'FOREIGN KEY'`);
    assert(fks.rows.length === 1, `${label}: the file chunks foreign key to proposals exists`);
  };
  try {
    await admin.query(`CREATE DATABASE ${freshName}`);
    const freshUrl = `${base}/${freshName}`;
    const init = await runNode(['scripts/init-db.mjs'], { DATABASE_URL: freshUrl });
    assert(init.code === 0, 'the fresh database migration proof: a fresh database applies migrations through 008', init.out.slice(-300));
    const freshPool = new pg.Pool({ connectionString: freshUrl, max: 2 });
    await shapeChecks(freshPool, 'fresh database');
    const daemonRun = await runNode(['checks/graph-daemon.mjs'], { DATABASE_URL: freshUrl });
    assert(daemonRun.code === 0 && daemonRun.out.includes('ALL GREEN'), 'the fresh database then passes the daemon suite');
    const learningRun = await runNode(['checks/learning.mjs'], { DATABASE_URL: freshUrl });
    assert(learningRun.code === 0 && learningRun.out.includes('ALL GREEN'), 'the fresh database then passes the learning suite');
    await freshPool.end();

    await admin.query(`CREATE DATABASE ${upgName}`);
    const upgUrl = `${base}/${upgName}`;
    const upgPool = new pg.Pool({ connectionString: upgUrl, max: 2 });
    const through007 = ['schema/v1.sql', 'schema/migrations/002-proposals.sql', 'schema/migrations/003-import-review.sql', 'schema/migrations/004-blackboard-outbox.sql', 'schema/migrations/005-daemon-presence.sql', 'schema/migrations/006-daemon-runs.sql', 'schema/migrations/007-learning-events.sql'];
    for (const f of through007) await upgPool.query(readFileSync(join(root, f), 'utf8'));
    await upgPool.query(
      `INSERT INTO memories (id, namespace, type, scope, text, importance, strength, provenance)
       VALUES ('upg-m1', 'memoryloom-upgrade', 'semantic', 'global', 'a record written before migration 008', 5, 0.75, '{"author":"grok"}'::jsonb)`
    );
    await upgPool.query(
      `INSERT INTO proposals (id, namespace, type, scope, text, importance, strength, grounding_ids, provenance, route_reason)
       VALUES ('upg-p1', 'memoryloom-upgrade', 'semantic', 'global', 'a proposal written before migration 008', 5, 5.0, '{}', '{"author":"grok"}'::jsonb, 'seed')`
    );
    const upgInit = await runNode(['scripts/init-db.mjs'], { DATABASE_URL: upgUrl });
    assert(upgInit.code === 0, 'the upgrade path proof: the same init command runs over a database that stopped at migration 007', upgInit.out.slice(-300));
    await shapeChecks(upgPool, 'upgrade path');
    const kept = await upgPool.query(`SELECT text, strength FROM memories WHERE id = 'upg-m1'`);
    assert(kept.rows.length === 1 && kept.rows[0].text === 'a record written before migration 008' && Number(kept.rows[0].strength) === 0.75, 'the upgrade path leaves the records written before migration 008 undisturbed');
    const keptP = await upgPool.query(`SELECT created_memory_ids, source_file_name, chunk_count FROM proposals WHERE id = 'upg-p1'`);
    assert(keptP.rows.length === 1 && Array.isArray(keptP.rows[0].created_memory_ids) && keptP.rows[0].created_memory_ids.length === 0 && keptP.rows[0].source_file_name === null && keptP.rows[0].chunk_count === null, 'a pre 008 proposal gains an empty created memory ids array and null file columns');
    await upgPool.end();
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${freshName}`);
    await admin.query(`DROP DATABASE IF EXISTS ${upgName}`);
    await admin.end();
  }
  // The duplicate chunk pair refusal at the database level.
  {
    const ns = NS('dupchunk');
    await wipeNs(ns);
    await insertProposal(ns, { id: 'hc-dup-prop', sourceFileName: 'dup.md', chunkCount: 1 });
    await q(`INSERT INTO file_chunks (proposal_id, chunk_index, text) VALUES ('hc-dup-prop', 0, 'the only chunk')`);
    let refused = null;
    try { await q(`INSERT INTO file_chunks (proposal_id, chunk_index, text) VALUES ('hc-dup-prop', 0, 'a second write of the same pair')`); } catch (e) { refused = e; }
    assert(refused && refused.code === '23505', 'the duplicate refusal test: the same proposal id and chunk index pair is refused on the second write');
    await wipeNs(ns);
  }

  /* ============ Failure injection, one per named boundary ============ */
  console.log('failure injection:');
  const FACT = 'The release checklist for the demo build lives in the team handbook and is reviewed every Friday';
  // Consolidation, the embedding step failing.
  {
    const ns = NS('cons-embed');
    await insertMemory(ns, { id: 'hc-ce-1', text: FACT, createdAt: isoDaysAgo(2) });
    await insertMemory(ns, { id: 'hc-ce-2', text: FACT, createdAt: isoDaysAgo(2) });
    let threwEmbed = false;
    try { await consolidateNamespace(failingDb((sql) => /SET embedding/.test(sql)), { namespace: ns }); } catch { threwEmbed = true; }
    assert(threwEmbed, 'consolidation boundary, embedding failure: the failure surfaces and the group rolls back');
    const originals = await q(`SELECT approval, merged_into FROM memories WHERE namespace = $1 ORDER BY id`, [ns]);
    assert(originals.rows.every((x) => x.approval === 'live' && x.merged_into === null), 'consolidation boundary, embedding failure: all originals stay active and unmarked');
    const again = await consolidateNamespace(pool, { namespace: ns });
    assert(again.merged.length === 1, 'consolidation can run again after the rolled back attempt');
  }
  // Consolidation, a source update failing after the insert.
  {
    const ns = NS('cons-update');
    await insertMemory(ns, { id: 'hc-cu-1', text: FACT, createdAt: isoDaysAgo(2) });
    await insertMemory(ns, { id: 'hc-cu-2', text: FACT, createdAt: isoDaysAgo(2) });
    let threwUpdate = false;
    try { await consolidateNamespace(failingDb((sql) => /SET superseded_by/.test(sql)), { namespace: ns }); } catch { threwUpdate = true; }
    assert(threwUpdate, 'consolidation boundary, source update failure: the failure surfaces and the merged record rolls back with the group');
    const originals = await q(`SELECT approval FROM memories WHERE namespace = $1`, [ns]);
    assert(originals.rows.length === 2 && originals.rows.every((x) => x.approval === 'live'), 'consolidation boundary, source update failure: no original is marked and no merged record remains');
  }
  // Decay, and the decay repeat equality case. A retiring
  // verdict is arranged through the decision cache, the same
  // mechanism the web suite relies on for deterministic gate
  // answers. The exact decision state is primed through the
  // product call, then the cached stub verdict is set to retire.
  // In stub mode every verdict is synthetic by construction. This
  // proves the decay write path under a retiring verdict, never
  // live provider judgement.
  {
    const T = Date.now();
    const DECAY_TEXT = 'An old note about a retired staging server that nobody has recalled in months';
    const seedDecayRow = async (ns, id) => insertMemory(ns, {
      id, text: DECAY_TEXT, strength: 0.9, createdAt: isoDaysAgo(200, T), lastRecalledAt: isoDaysAgo(200, T),
    });
    // The retiring verdict is placed in the decision cache with
    // the cache functions the product itself uses, under the key
    // the decay decision call computes for this exact state. The
    // state text below mirrors the one the gate builds for a
    // decay drop decision on this record, field for field.
    const primeRetire = (id) => {
      const newStrength = Math.round(0.9 * Math.pow(0.5, 200 / 30) * 1e6) / 1e6;
      const state = [
        'Memory under decay review:',
        JSON.stringify({ id, text: DECAY_TEXT.slice(0, 500), type: 'semantic', pinned: false, strength: newStrength, age_days: 200, days_since_recall: 200, recall_count: null }),
        '',
        'A memory should be retired only if it is stale, weak, never or rarely recalled, not pinned, and keeping it adds noise rather than value.',
      ].join('\n');
      const questions = {
        retire: {
          type: 'noul',
          instructions: 'Considering only the information given in the state, is the following statement true?\n\nStatement: This memory should be retired (dropped) rather than kept.',
        },
      };
      cachePut(cacheKey('jev', routerConfig().jev.model, 'decay_drop', { state, questions }), { answers: { retire: 0.95 } });
    };
    const nsClean = NS('decay-eq');
    await seedDecayRow(nsClean, 'hc-dq-clean');
    await primeRetire('hc-dq-clean');
    const clean = await applyDecay(pool, { namespace: nsClean, now: new Date(T) });
    const cleanRow = (await q(`SELECT strength, approval FROM memories WHERE id = 'hc-dq-clean'`)).rows[0];
    assert(clean.retired.length === 1 && cleanRow.approval === 'retired', 'decay clean run retires the stale weak record');
    const ns = NS('decay');
    await seedDecayRow(ns, 'hc-dc-1');
    await primeRetire('hc-dc-1');
    let threw = false;
    try {
      await applyDecay(failingDb((sql) => /approval = 'retired'/.test(sql), 1), { namespace: ns, now: new Date(T) });
    } catch { threw = true; }
    const afterFail = (await q(`SELECT strength, approval, valid_to FROM memories WHERE id = 'hc-dc-1'`)).rows[0];
    assert(threw, 'decay boundary, retirement write failure: the run surfaces the failure');
    assert(afterFail.approval === 'live' && afterFail.valid_to === null && Number(afterFail.strength) < 0.9, 'decay boundary, retirement write failure: the row keeps its prior validity end and approval, and the committed strength update stands');
    const repeat = await applyDecay(pool, { namespace: ns, now: new Date(T) });
    const afterRepeat = (await q(`SELECT strength, approval FROM memories WHERE id = 'hc-dc-1'`)).rows[0];
    assert(repeat.retired.length === 1 && afterRepeat.approval === 'retired', 'the decay run can be repeated after the failure');
    assert(Number(afterRepeat.strength) === Number(cleanRow.strength), 'the decay repeat equality case: a retirement failure followed by a repeat at the same time leaves the row at exactly the strength and retirement outcome of one clean run');
  }
  // Promotion, the embedding step failing, then the event write failing.
  {
    const ns = NS('promo');
    await wipeNs(ns);
    const mkEvent = async (subject) => {
      const ev = await recordEvent(pool, {
        namespace: ns, kind: 'eval_outcome', actor: 'grok',
        subject_type: 'task', subject_id: subject,
        summary: 'Always pin the toolchain before a release build.',
        evidence: {
          lesson_text: 'Always pin the toolchain before a release build.',
          incident: 'A release build broke because the toolchain floated to a new major version overnight.',
          resolution: 'Pinning the toolchain in the build file is now the standing fix, applied on the next two release builds.',
          verified: true,
        },
      });
      for (const day of ['2026-10-19', '2026-10-26']) {
        await recordEvent(pool, {
          namespace: ns, kind: 'lesson_applied', actor: 'moose',
          subject_type: 'learning_event', subject_id: ev,
          summary: `The pinned toolchain rule was applied on the ${day} release build and the build stayed green.`,
          evidence: { run: day, outcome: 'the build stayed green with the toolchain pinned' },
        });
      }
      return ev;
    };
    const ev1 = await mkEvent('hc-promo-src-1');
    let threwPromoEmbed = false;
    try { await promoteEvent(pool, ev1, { embedFn: async () => { throw new Error('injected embedding failure'); } }); } catch { threwPromoEmbed = true; }
    assert(threwPromoEmbed, 'promotion boundary, embedding failure: the failure surfaces and the promotion rolls back');
    const lessons1 = await q(`SELECT count(*)::int AS n FROM memories WHERE namespace = $1 AND provenance->>'learning_event_id' = $2`, [ns, ev1]);
    const decisions1 = await q(`SELECT count(*)::int AS n FROM learning_events WHERE namespace = $1 AND kind = 'promotion_decision' AND subject_id = $2`, [ns, ev1]);
    assert(lessons1.rows[0].n === 0 && decisions1.rows[0].n === 0, 'promotion boundary, embedding failure: no lesson row and no promotion event remain');
    const r1b = await promoteEvent(pool, ev1);
    assert(r1b.promoted === true, 'promotion can run again after the rolled back attempt');
    const ev2 = await mkEvent('hc-promo-src-2');
    let threwPromoEvent = false;
    try { await promoteEvent(failingDb((sql) => /INSERT INTO learning_events/.test(sql)), ev2); } catch { threwPromoEvent = true; }
    assert(threwPromoEvent, 'promotion boundary, event write failure: the failure surfaces and the promotion rolls back');
    const lessons2 = await q(`SELECT count(*)::int AS n FROM memories WHERE namespace = $1 AND provenance->>'learning_event_id' = $2`, [ns, ev2]);
    assert(lessons2.rows[0].n === 0, 'promotion boundary, event write failure: no lesson row remains');
    await wipeNs(ns);
  }
  // The promote claim, and a failure after the claim.
  {
    const ns = NS('claim');
    await wipeNs(ns);
    await insertProposal(ns, { id: 'hc-claim-1', text: 'A claimed promotion writes exactly one memory' });
    const rClaim = await promoteProposal(failingDb((sql) => /SET status = 'approved'/.test(sql)), { proposal_id: 'hc-claim-1', decided_by: 'human' });
    assert(rClaim.status === 'error', 'the promote claim boundary: a claim write failure returns a failure');
    const stClaim = (await q(`SELECT status FROM proposals WHERE id = 'hc-claim-1'`)).rows[0].status;
    assert(stClaim === 'pending' && (await countMemories(ns)) === 0, 'the promote claim boundary: no claim is recorded and the proposal stays ready to claim again');
    const rInsert = await promoteProposal(failingDb((sql) => /INSERT INTO memories/.test(sql)), { proposal_id: 'hc-claim-1', decided_by: 'human' });
    const stInsert = (await q(`SELECT status FROM proposals WHERE id = 'hc-claim-1'`)).rows[0].status;
    assert(rInsert.status === 'error' && stInsert === 'pending' && (await countMemories(ns)) === 0, 'a failure after the claim rolls the whole promotion back');
    const rOk = await promoteProposal(pool, { proposal_id: 'hc-claim-1', decided_by: 'human' });
    assert(rOk.status === 'ok' && (await countMemories(ns)) === 1, 'the promotion completes on the retry');
    await wipeNs(ns);
  }
  // The gate path write sets.
  {
    const nsLive = NS('gate-live');
    const rLive = await coveredStoreOrPropose({
      db: failingDb((sql) => /INSERT INTO learning_events/.test(sql)),
      tool: 'store', namespace: nsLive, text: 'The hardening drill ran on schedule this morning',
      metadata: { author: 'grok', type: 'episodic', scope: 'global', grounding_ids: [] },
      requestId: 'hc-live-ev-fail',
      args: { text: 'The hardening drill ran on schedule this morning', type: 'episodic', scope: 'global', grounding_ids: [] },
    });
    assert(rLive.outcome === 'failed' && (await countMemories(nsLive)) === 0, 'the live insert boundary, event write failure: no live memory row remains, because every gate score is claimed as provenance');
    const nsRr = NS('gate-rr');
    const rRr = await coveredStoreOrPropose({
      db: failingDb((sql) => /INSERT INTO request_records/.test(sql)),
      tool: 'store', namespace: nsRr, text: 'The hardening drill ran on schedule this morning',
      metadata: { author: 'grok', type: 'episodic', scope: 'global', grounding_ids: [] },
      requestId: 'hc-rr-fail',
      args: { text: 'The hardening drill ran on schedule this morning', type: 'episodic', scope: 'global', grounding_ids: [] },
    });
    assert(rRr.outcome === 'failed' && (await countMemories(nsRr)) === 0 && (await countEvents(nsRr)) === 0, 'the live insert boundary, failure after the insert and before the request record: no memory, no event and no request record remain');
    const nsQ = NS('gate-queue');
    const rQ = await coveredStoreOrPropose({
      db: failingDb((sql) => /INSERT INTO proposals/.test(sql)),
      tool: 'propose', namespace: nsQ, text: 'How to run the hardening drill in five careful steps',
      metadata: { author: 'grok', type: 'procedural', scope: 'global', grounding_ids: [] },
      requestId: 'hc-queue-fail',
      args: { text: 'How to run the hardening drill in five careful steps', type: 'procedural', scope: 'global', grounding_ids: [] },
    });
    const qRows = await q(`SELECT count(*)::int AS n FROM proposals WHERE namespace = $1`, [nsQ]);
    assert(rQ.outcome === 'failed' && qRows.rows[0].n === 0 && (await countEvents(nsQ)) === 0, 'the queued branch boundary, queue write failure: no queued proposal and no verdict event remain');
    const nsIng = NS('ingest-fail');
    await wipeNs(nsIng);
    const rIng = await coveredIngestFile({
      db: failingDb((sql) => /INSERT INTO file_chunks/.test(sql)),
      namespace: nsIng, filename: 'hardening.md', chunks: ['the first hardening chunk', 'the second hardening chunk'],
      metadata: { author: 'grok' },
      requestId: 'hc-ingest-fail',
      args: { filename: 'hardening.md', chunks: ['the first hardening chunk', 'the second hardening chunk'] },
    });
    const ingRows = await q(`SELECT count(*)::int AS n FROM proposals WHERE namespace = $1`, [nsIng]);
    assert(rIng.outcome === 'failed' && ingRows.rows[0].n === 0, 'the ingest boundary: a chunk write failure leaves no proposal behind');
    await wipeNs(nsIng);
  }
  // File approval and file rejection write failures.
  {
    const ns = NS('filedecide');
    await wipeNs(ns);
    await insertProposal(ns, { id: 'hc-file-1', text: 'filedecide.md: two chunks', sourceFileName: 'filedecide.md', chunkCount: 2 });
    await q(`INSERT INTO file_chunks (proposal_id, chunk_index, text) VALUES ('hc-file-1', 0, 'file chunk zero'), ('hc-file-1', 1, 'file chunk one')`);
    const rApp = await promoteProposal(failingDb((sql) => /INSERT INTO memories/.test(sql)), { proposal_id: 'hc-file-1', decided_by: 'human' });
    const stApp = (await q(`SELECT status FROM proposals WHERE id = 'hc-file-1'`)).rows[0].status;
    assert(rApp.status === 'error' && stApp === 'pending' && (await countMemories(ns)) === 0, 'the file approval boundary: a failure at an approval write leaves the proposal pending and creates no memory');
    const rRej = await rejectProposal(failingDb((sql) => /SET status = 'rejected'/.test(sql)), { proposal_id: 'hc-file-1', decided_by: 'human' });
    const stRej = (await q(`SELECT status FROM proposals WHERE id = 'hc-file-1'`)).rows[0].status;
    assert(rRej.status === 'error' && stRej === 'pending', 'the file rejection boundary: a failure at a rejection write leaves the proposal pending');
    await wipeNs(ns);
  }
  // The decide event write inside the decide transaction.
  {
    const ns = NS('eventtx');
    await wipeNs(ns);
    await insertProposal(ns, { id: 'hc-ev-1', text: 'A proposal whose rejection event fails' });
    const rEv = await rejectProposal(failingDb((sql) => /INSERT INTO learning_events/.test(sql)), {
      proposal_id: 'hc-ev-1', decided_by: 'human',
      event: { kind: 'human_rejection', actor: 'human', summary: 'A person rejected the proposal in the console', evidence: { decision: 'reject' } },
    });
    const stEv = (await q(`SELECT status FROM proposals WHERE id = 'hc-ev-1'`)).rows[0].status;
    assert(rEv.status === 'error' && stEv === 'pending', 'the decide event failure test: a failing rejection event write rolls the state change back');
    assert((await q(`SELECT count(*)::int AS n FROM learning_events WHERE namespace = $1 AND subject_id = 'hc-ev-1'`, [ns])).rows[0].n === 0, 'the decide event failure test: no event row remains');
    await q(`DELETE FROM review_items WHERE id = 'hc-ev-item'`);
    await q(
      `INSERT INTO review_items (id, kind, payload, status)
       VALUES ('hc-ev-item', 'import_contradiction', $1::jsonb, 'queued')`,
      [JSON.stringify({ proposal_id: 'hc-ev-1', namespace: ns, summary: 'two records disagree' })]
    );
    const rItem = await decideReviewItem(failingDb((sql) => /INSERT INTO learning_events/.test(sql)), {
      id: 'hc-ev-item', decision: 'approve', decided_by: 'human',
      event: { kind: 'human_approval', subjectType: 'proposal', subjectId: 'hc-ev-1', actor: 'human', summary: 'A person approved the review item in the console', evidence: { decision: 'approve' } },
    });
    const stItem = (await q(`SELECT status FROM review_items WHERE id = 'hc-ev-item'`)).rows[0].status;
    assert(rItem.status === 'error' && stItem === 'queued', 'the decide event failure test: a failing review event write rolls the review decision back');
    await q(`DELETE FROM review_items WHERE id = 'hc-ev-item'`);
    await wipeNs(ns);
  }

  /* ============ Guards, concurrent pairs, trail agreement ============ */
  console.log('guards and concurrency:');
  {
    const ns = NS('guards');
    await wipeNs(ns);
    await insertProposal(ns, { id: 'hc-g-1', text: 'A proposal rejected exactly once' });
    const first = await rejectProposal(pool, { proposal_id: 'hc-g-1', decided_by: 'human' });
    const second = await rejectProposal(pool, { proposal_id: 'hc-g-1', decided_by: 'human' });
    assert(first.status === 'ok' && second.status === 'error' && second.error === 'CONFLICT', 'the guard test for reject_proposal: a second decision on a decided proposal is refused');
    await insertProposal(ns, { id: 'hc-g-2', text: 'A proposal two people reject at once' });
    const pair = await Promise.all([
      rejectProposal(pool, { proposal_id: 'hc-g-2', decided_by: 'human', event: { kind: 'human_rejection', actor: 'human', summary: 'rejected in the console', evidence: { decision: 'reject' } } }),
      rejectProposal(pool, { proposal_id: 'hc-g-2', decided_by: 'human', event: { kind: 'human_rejection', actor: 'human', summary: 'rejected in the console', evidence: { decision: 'reject' } } }),
    ]);
    const okCount = pair.filter((r) => r.status === 'ok').length;
    const evCount = (await q(`SELECT count(*)::int AS n FROM learning_events WHERE namespace = $1 AND subject_id = 'hc-g-2' AND kind = 'human_rejection'`, [ns])).rows[0].n;
    assert(okCount === 1 && evCount === 1, 'the guard test for reject_proposal, concurrent pair: exactly one decision lands and exactly one event is written');
    await q(`DELETE FROM review_items WHERE id = 'hc-g-item'`);
    await q(
      `INSERT INTO review_items (id, kind, payload, status)
       VALUES ('hc-g-item', 'import_contradiction', '{"proposal_id":"hc-g-1","summary":"two records disagree"}'::jsonb, 'queued')`
    );
    const itemPair = await Promise.all([
      decideReviewItem(pool, { id: 'hc-g-item', decision: 'approve', decided_by: 'human' }),
      decideReviewItem(pool, { id: 'hc-g-item', decision: 'approve', decided_by: 'human' }),
    ]);
    const itemOk = itemPair.filter((r) => r.status === 'ok').length;
    const itemAgain = await decideReviewItem(pool, { id: 'hc-g-item', decision: 'approve', decided_by: 'human' });
    assert(itemOk === 1 && itemAgain.status === 'error' && itemAgain.error === 'CONFLICT', 'the guard test for review_decide, concurrent pair: exactly one decision lands, and a later decision is refused');
    await insertProposal(ns, { id: 'hc-g-3', text: 'A proposal promoted by two callers at once' });
    const promoPair = await Promise.all([
      promoteProposal(pool, { proposal_id: 'hc-g-3', decided_by: 'human' }),
      promoteProposal(pool, { proposal_id: 'hc-g-3', decided_by: 'human' }),
    ]);
    const created = await q(`SELECT id FROM memories WHERE namespace = $1 AND provenance->>'promoted_from' = 'hc-g-3'`, [ns]);
    const propRow = (await q(`SELECT created_memory_ids FROM proposals WHERE id = 'hc-g-3'`)).rows[0];
    assert(created.rows.length === 1 && propRow.created_memory_ids.length === 1 && promoPair.every((r) => r.status === 'ok'), 'two promotes for the same proposal at the same time: exactly one memory is created and the loser replays the recorded result');
    await q(`DELETE FROM review_items WHERE id = 'hc-g-item'`);
    await wipeNs(ns);
  }
  {
    const ns = NS('trail');
    await insertProposal(ns, { id: 'hc-trail-1', text: 'trail.md: two chunks', sourceFileName: 'trail.md', chunkCount: 2 });
    await q(`INSERT INTO file_chunks (proposal_id, chunk_index, text) VALUES ('hc-trail-1', 0, 'trail chunk zero'), ('hc-trail-1', 1, 'trail chunk one')`);
    const promo = await promoteProposal(pool, { proposal_id: 'hc-trail-1', decided_by: 'human' });
    assert(promo.status === 'ok' && promo.created_memory_ids.length === 2, 'the trail fixture: the file approval creates two memories');
    const createdRows = await q(`SELECT id FROM memories WHERE namespace = $1 AND provenance->>'promoted_from' = 'hc-trail-1'`, [ns]);
    const createdSet = new Set(createdRows.rows.map((r) => r.id));
    const recordedSet = new Set(promo.created_memory_ids);
    assert(createdSet.size === recordedSet.size && [...createdSet].every((id) => recordedSet.has(id)), 'the graph trail agreement test: the created memory ids array holds every memory the approval created, no extra and no missing id');
    let trailsOk = true;
    for (const id of promo.created_memory_ids) {
      const trail = await provenanceTrail(pool, id);
      if (!trail || !trail.decisions.some((d) => d.kind === 'promotion' && d.proposal_id === 'hc-trail-1')) trailsOk = false;
    }
    assert(trailsOk, 'the graph trail agreement test: every created memory has a graph trail entry through its deciding proposal');
    const graph = await buildGraph(pool, ns);
    assert(promo.created_memory_ids.every((id) => graph.nodes.some((n) => n.id === id && n.kind === 'memory')), 'the graph trail agreement test: both created memories stand as graph nodes');
  }

  /* ============ Stable error names ============ */
  console.log('stable error names:');
  assert(stableErrorName(Object.assign(new Error('boom'), { code: '23505' })) === 'DATABASE_FAILURE', 'the stable error name test: a database failure maps to its stable name');
  assert(stableErrorName(new JevError('backend down', { code: 'JEV_UNAVAILABLE' })) === 'DECISION_BACKEND_FAILURE', 'the stable error name test: a decision backend failure maps to its stable name');
  assert(stableErrorName(new DecisionError('backend down', { code: 'DECISION_UNAVAILABLE' })) === 'DECISION_BACKEND_FAILURE', 'the stable error name test: a decision error maps to its stable name');
  assert(stableErrorName(new SyntaxError('unexpected token')) === 'VALIDATION', 'the stable error name test: a malformed payload maps to VALIDATION');
  assert(stableErrorName({ error: 'CONFLICT' }) === 'CONFLICT', 'the stable error name test: a shaped product error keeps its name');
  const payload = failurePayload(new Error('raw provider payload with SECRET inside'));
  assert(payload.error === 'INTERNAL' && !JSON.stringify(payload).includes('SECRET'), 'the stable error name test: a failed provider reports a plain failure and never the raw provider payload');
} catch (e) {
  failures++;
  console.error('HARDENING ERROR', e);
} finally {
  await pool.end();
}
console.log(failures === 0 ? 'ALL GREEN' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
