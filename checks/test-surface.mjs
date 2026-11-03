/**
 * MemoryLoom surface test: seeds a small SYNTHETIC fictional corpus
 * (24 rows, MiniLM embeddings, index_status='indexed') into a
 * throwaway test database, then drives the MCP server over stdio
 * through all ten tools and asserts shapes plus the gate contract
 * from the frozen master plan, Section 5, as built by card S3a.
 *
 * The gate contract is exercised in both backend states, and the
 * suite controls both states itself so the result does not depend
 * on the host machine.
 *
 * The unset state runs on a keyless instance, spawned with an
 * empty temporary settings store and no provider key in its
 * environment. In that state the gate fails closed on every call.
 * Store and propose queue every proposal, ingest_file queues its
 * one proposal, and nothing becomes live without a human decision.
 * A case fails if any call in the unset state becomes live without
 * a verdict record or a queue record behind it.
 *
 * The set state runs on a second instance whose Jev backend is the
 * committed stub server, started by this suite on spare ports when
 * the baseline stub is not already reachable. In that state the
 * verdict governs, subject to the grounding rules. Approve stores
 * live truth, reject stores nothing, escalate queues. Approval by
 * local rules does not exist in either state.
 *
 * Recall is asserted on the receipt path. Every result carries a
 * receipt that dereferences to its record, dropped results carry a
 * reason, and the payload states whether the best fusion score
 * clears the answer threshold.
 *
 * Never run this against a database that holds real memories: it
 * deletes and re-seeds rows in the test namespaces.
 *
 * Usage: DATABASE_URL=postgres://... node checks/test-surface.mjs
 * Owning file: checks/test-surface.mjs
 * Accountable layer: Browser layer
 * Provider need: None
 * Declared mode: Keyless
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { pipeline } from '@xenova/transformers';
import { assertContractShape } from '../lib/cold-start-contract.mjs';
import { embedStaged } from '../lib/planes.mjs';
import { preflightOrExit } from './db-preflight.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL missing'); process.exit(1); }
preflightOrExit();
const NS = 'memoryloom-test';
const NS2 = 'memoryloom-test-gated';

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
let failures = 0;
function assert(cond, label, extra = '') {
  if (cond) console.log(`  PASS ${label}`);
  else { failures++; console.log(`  FAIL ${label} ${extra}`); }
}
function halfvecLiteral(arr) {
  const p = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) p[i] = Number(arr[i]).toFixed(6);
  return '[' + p.join(',') + ']';
}
async function liveCount(textLike, namespace = NS) {
  const r = await pool.query(
    `SELECT count(*)::int n FROM memories WHERE namespace = $1 AND approval = 'live' AND text LIKE $2`,
    [namespace, textLike]
  );
  return r.rows[0].n;
}

// An empty temporary settings store, so the keyless instance below
// is keyless by construction and not by accident of the host.
const emptyStorePath = join(mkdtempSync(join(tmpdir(), 'ml-surface-')), 'empty.env');
writeFileSync(emptyStorePath, '', { mode: 0o600 });

// ---- 1. seed synthetic corpus with embeddings -----------------------------
console.log('seeding synthetic corpus…');
{
  const c = await pool.connect();
  try {
    // File chunks and request records reference proposals and
    // namespaces, so they go first. Proposals next: promoted_id is
    // a foreign key into memories.
    await c.query(`DELETE FROM file_chunks WHERE proposal_id IN (SELECT id FROM proposals WHERE namespace = ANY($1))`, [[NS, NS2]]);
    await c.query(`DELETE FROM request_records WHERE namespace = ANY($1)`, [[NS, NS2]]);
    await c.query(`DELETE FROM proposals WHERE namespace = ANY($1)`, [[NS, NS2]]);
    await c.query(`DELETE FROM memories WHERE namespace = ANY($1)`, [[NS, NS2]]);
  } finally { c.release(); }
}
const rows = readFileSync(join(__dir, 'fixtures', 'synthetic-corpus.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const ex = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
const client = await pool.connect();
try {
  await client.query('BEGIN');
  for (const r of rows) {
    const out = await ex(r.text, { pooling: 'mean', normalize: true });
    const emb = halfvecLiteral(Array.from(out.data));
    await client.query(
      `INSERT INTO memories (id, namespace, type, scope, text, importance, strength,
                             index_status, approval, grounding_ids, provenance, embedding)
       VALUES ($1,$2,$3,'global',$4,5,5.0,'indexed','live',$5::text[],$6::jsonb,$7::halfvec)
       ON CONFLICT (id) DO UPDATE SET embedding = EXCLUDED.embedding, index_status = 'indexed'`,
      [`seed-${r.id}`, r.namespace, r.type, r.text, r.grounding_ids || [],
       JSON.stringify({ ...(r.provenance || {}), embedding_model: 'minilm-l6-v2@1' }), emb]
    );
  }
  await client.query('COMMIT');
  console.log(`  seeded ${rows.length} indexed rows`);
  // One indexed row in the test namespace for the vector-leg paraphrase check
  const probeText = 'The demo daemon wakes on a webhook signal and drains its queued jobs.';
  const probeOut = await ex(probeText, { pooling: 'mean', normalize: true });
  await client.query(
    `INSERT INTO memories (id, namespace, type, scope, text, importance, strength,
                           index_status, approval, grounding_ids, provenance, embedding)
     VALUES ('seed-probe-1',$1,'semantic','global',$2,5,5.0,'indexed','live','{}',
             '{"author":"ml-test","origin":"seed"}'::jsonb,$3::halfvec)
     ON CONFLICT (id) DO NOTHING`,
    [NS, probeText, halfvecLiteral(Array.from(probeOut.data))]
  );
} finally { client.release(); }

// ---- 2. MCP harness ---------------------------------------------------------
function startMcp(env) {
  // Every instance starts from a provider free base environment.
  // The caller then adds back exactly the backend state it means
  // to exercise, so no case depends on the host shell.
  const base = { ...process.env };
  delete base.TYPESAFE_API_KEY;
  delete base.JEV_BASE_URL;
  delete base.META_MODEL_API_KEY;
  delete base.BASETEN_API_KEY;
  delete base.META_MODEL_BASE_URL;
  delete base.MEMORYLOOM_GATE_BACKEND;
  const srv = spawn('node', [join(__dir, '..', 'mcp', 'index.mjs')], {
    env: { ...base, ...env },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let reqId = 0;
  const pending = new Map();
  let buf = '';
  srv.stdout.on('data', (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id); pending.delete(msg.id); resolve(msg);
      }
    }
  });
  function rpc(method, params) {
    const id = ++reqId;
    return new Promise((resolve) => {
      pending.set(id, { resolve });
      srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async function callTool(name, args) {
    const res = await rpc('tools/call', { name, arguments: args });
    if (res.error) throw new Error(`tools/call ${name}: ${JSON.stringify(res.error)}`);
    const text = res.result.content?.[0]?.text ?? '';
    return { raw: res.result, json: JSON.parse(text), isError: res.result.isError === true };
  }
  return {
    srv,
    async init() {
      await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ml-test', version: '1' } });
      srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
    },
    async listTools() {
      const tools = await rpc('tools/list', {});
      return tools.result.tools.map((t) => t.name).sort();
    },
    callTool,
    kill() { srv.kill(); },
  };
}

// The keyless instance. Its environment names the empty store and
// carries no provider key and no provider base URL, whatever the
// host shell holds.
const keylessEnv = { MEMORYLOOM_SETTINGS_FILE: emptyStorePath };
const mcp = startMcp(keylessEnv);
await mcp.init();
const callTool = mcp.callTool;

console.log('tools:');
const names = await mcp.listTools();
console.log('  ' + names.join(', '));
assert(names.join(',') === 'get,ingest_file,list_namespaces,promote,propose,recall,reject_proposal,review_decide,review_list,store', 'all 10 tools listed');

// ---- 3. store in the unset state -------------------------------------------
// The store text carries words that appear in no other record, so
// the recall cases below can isolate its fusion score.
console.log('store, unset state:');
const STORE_TEXT = 'MemoryLoom test memory. A quokka lantern festival in Zanzibar.';
const st = await callTool('store', {
  namespace: NS, text: STORE_TEXT, request_id: 'surface-store-1',
  metadata: { type: 'episodic', author: 'ml-test' },
});
assert(st.json.decision === 'queued_for_review' && st.json.proposal_id, 'store with no gate backend configured queues, it does not store', JSON.stringify(st.json).slice(0, 160));
assert(st.json.reason === 'jev-unavailable-fail-closed' && st.json.backend === 'jev', 'store queue reason names the fail closed gate', JSON.stringify(st.json).slice(0, 160));
assert((await liveCount('MemoryLoom test memory%')) === 0, 'unset store call left no live memory');
const stProp = await pool.query(`SELECT status, route_reason FROM proposals WHERE id = $1`, [st.json.proposal_id]);
assert(stProp.rows.length === 1 && stProp.rows[0].status === 'pending', 'unset store call left a pending queue record');
const stVerdict = await pool.query(
  `SELECT count(*)::int n FROM learning_events WHERE namespace = $1 AND kind = 'gate_verdict' AND subject_id = $2`,
  [NS, st.json.proposal_id]
);
assert(stVerdict.rows[0].n >= 1, 'unset store call left a gate verdict record');
// A human decision is the only way this record becomes live.
const stProm = await callTool('promote', { proposal_id: st.json.proposal_id });
assert(stProm.json.status === 'ok' && stProm.json.promoted_id, 'human promotion stores the queued store proposal');
const storedId = stProm.json.promoted_id;
assert((await liveCount('MemoryLoom test memory%')) === 1, 'promoted store record is live exactly once');

// ---- 4. recall on the receipt path ------------------------------------------
console.log('recall:');
const rc = await callTool('recall', { namespace: NS, query: 'quokka lantern festival Zanzibar', k: 5 });
assert(rc.json.status === 'ok', 'recall ok');
assert(rc.json.count >= 1 && rc.json.results.some((r) => r.id === storedId), 'recall finds the promoted store record', `got ${rc.json.results.map((r) => r.id).join(',')}`);
assert(rc.json.results.every((r) => r.receipt && r.receipt.memory_id === r.id && r.receipt.author), 'every recall result carries a receipt that dereferences to its record');
assert(Array.isArray(rc.json.dropped), 'recall reports dropped results with reasons');
// The promoted record is staged, so only the keyword leg finds it
// and its fusion score sits below the answer threshold. The
// payload must say so instead of dressing a near miss as an
// answer. After the record is indexed, both legs find it and the
// same query answers.
assert(rc.json.no_answer === true && rc.json.answerable === false, 'single leg staged hit is labelled not an answer', JSON.stringify({ no_answer: rc.json.no_answer, rrf: rc.json.results[0]?.rrf }));
await embedStaged(pool, NS);
const rcIdx = await callTool('recall', { namespace: NS, query: 'quokka lantern festival Zanzibar', k: 5 });
assert(rcIdx.json.answerable === true && rcIdx.json.no_answer === false && rcIdx.json.results.some((r) => r.id === storedId), 'indexed record answers the same query above the threshold', JSON.stringify({ answerable: rcIdx.json.answerable, top: rcIdx.json.results[0]?.id }));
const rc2 = await callTool('recall', { namespace: NS, query: 'background process activation signal', k: 5 });
assert(rc2.json.status === 'ok' && rc2.json.results.some((r) => r.id === 'seed-probe-1'),
  'paraphrase recall hits via the vector leg, with a receipt', `got ${rc2.json.results.map((r) => r.id).join(',')}`);
const rcAns = await callTool('recall', { namespace: NS, query: 'weekly planning session Monday morning', k: 5 });
assert(rcAns.json.answerable === true && rcAns.json.results.some((r) => r.id === 'seed-s01'), 'grounded corpus query answers above the threshold');
const rcCold = await callTool('recall', { namespace: 'no-such-ns', query: 'anything', k: 5 });
assert(rcCold.json.status === 'cold_start', 'cold_start on empty namespace');
assert(assertContractShape(rc.json.contract) === null, 'recall contract shape', assertContractShape(rc.json.contract));
assert(rc.json.contract.source === 'neon', 'contract source neon');
assert(['warm', 'cold'].includes(rc.json.contract.index), 'contract index warm|cold');
assert(['warm', 'cold', 'unknown'].includes(rc.json.contract.daemon), 'contract daemon');
assert(rcCold.json.contract.index === 'cold', 'empty ns index=cold');
assert(rcCold.json.contract.replica_lag === null, 'primary replica_lag null');
assert(typeof rc.json.contract.last_seq === 'number', 'last_seq present');

// ---- 5. get -------------------------------------------------------------------
console.log('get:');
const g = await callTool('get', { id: storedId });
assert(g.json.status === 'ok' && g.json.memory.text.includes('quokka'), 'get returns the promoted store record');
assert(g.json.memory.provenance.jev !== undefined || g.json.memory.provenance.origin === 'promote', 'promoted record provenance names its path in');
const gMiss = await callTool('get', { id: 'does-not-exist' });
assert(gMiss.isError && gMiss.json.error === 'NOT_FOUND', 'get 404 on missing id');

// ---- 6. ingest_file in the unset state -----------------------------------------
console.log('ingest_file, unset state:');
const para = (tag) => `${tag} ` + 'lorem ipsum dolor sit amet '.repeat(60); // ~1560 chars
const fileText = [para('AAA'), para('BBB'), para('CCC')].join('\n\n');
const ing = await callTool('ingest_file', {
  namespace: NS, filename: 'agent-note.md', request_id: 'surface-ingest-1',
  content_base64: Buffer.from(fileText, 'utf8').toString('base64'),
  metadata: { author: 'ml-test' },
});
assert(ing.json.decision === 'queued_for_review' && ing.json.state === 'queued' && ing.json.proposal_id,
  'ingest_file queues one proposal for the file', JSON.stringify(ing.json).slice(0, 160));
assert(ing.json.chunks === 3 && ing.json.chunk_count === 3 && ing.json.stored === 0 && ing.json.ids.length === 0,
  'ingest_file reports the chunk count and stores nothing live', JSON.stringify(ing.json).slice(0, 160));
const ingLive = await pool.query(
  `SELECT count(*)::int n FROM memories WHERE namespace = $1 AND provenance->>'filename' = 'agent-note.md'`, [NS]
);
assert(ingLive.rows[0].n === 0, 'no chunk from the file is live after ingest');
const ingProp = await pool.query(`SELECT text, provenance, source_file_name, chunk_count FROM proposals WHERE id = $1`, [ing.json.proposal_id]);
assert(ingProp.rows.length === 1 && ingProp.rows[0].text.startsWith('agent-note.md'), 'the file proposal names the file and a summary');
assert(ingProp.rows[0].source_file_name === 'agent-note.md' && ingProp.rows[0].chunk_count === 3,
  'the file proposal row carries the source file name and the chunk count (card S3b)');
assert(!('chunk_texts' in (ingProp.rows[0].provenance || {})), 'chunk text no longer travels through the proposal provenance (card S3b)');
const ingChunks = await pool.query(
  `SELECT chunk_index, text FROM file_chunks WHERE proposal_id = $1 ORDER BY chunk_index`, [ing.json.proposal_id]
);
assert(ingChunks.rows.length === 3 && ingChunks.rows[0].text.includes('AAA') && ingChunks.rows[2].text.includes('CCC'),
  'the chunk texts are held in the file chunks table in chunk index order (card S3b)');
// A retry of the ingest call returns the first result and writes
// no second proposal and no second set of chunk rows.
const ingRetry = await callTool('ingest_file', {
  namespace: NS, filename: 'agent-note.md', request_id: 'surface-ingest-1',
  content_base64: Buffer.from(fileText, 'utf8').toString('base64'),
  metadata: { author: 'ml-test' },
});
assert(ingRetry.json.proposal_id === ing.json.proposal_id, 'ingest retry returns the stored first result (card S3b)');
const ingChunksAfter = await pool.query(`SELECT count(*)::int n FROM file_chunks WHERE proposal_id = $1`, [ing.json.proposal_id]);
assert(ingChunksAfter.rows[0].n === 3, 'ingest retry wrote no second set of chunk rows (card S3b)');

// ---- 7. propose in the unset state ----------------------------------------------
// Every class queues when no gate backend is configured. Local
// rules no longer exist, so the episodic and grounded cases queue
// exactly like the human always classes.
console.log('propose, unset state:');
const unsetCases = [
  ['episodic unset test', { type: 'episodic' }],
  ['semantic with evidence unset test', { type: 'semantic', grounding_ids: ['seed-s01', 'seed-s02'] }],
  ['procedural unset test', { type: 'procedural' }],
  ['low evidence unset test', { type: 'semantic' }],
  ['pinned unset test', { type: 'semantic', pinned: true, grounding_ids: ['seed-s01', 'seed-s02'] }],
];
let firstUnsetProposalId = null;
for (const [i, [text, metadata]] of unsetCases.entries()) {
  const p = await callTool('propose', { namespace: NS, text, metadata, request_id: `surface-unset-${i}` });
  assert(p.json.decision === 'queued_for_review' && p.json.reason === 'jev-unavailable-fail-closed' && p.json.proposal_id,
    `propose queues in the unset state (${text.split(' ')[0]})`, JSON.stringify(p.json).slice(0, 140));
  assert((await liveCount(text)) === 0, `unset propose left no live memory (${text.split(' ')[0]})`);
  if (i === 0) firstUnsetProposalId = p.json.proposal_id;
}
// A retry of a queued propose returns the stored first result and
// queues nothing a second time.
const unsetRetry = await callTool('propose', {
  namespace: NS, text: unsetCases[0][0], metadata: unsetCases[0][1], request_id: 'surface-unset-0',
});
assert(unsetRetry.json.proposal_id === firstUnsetProposalId, 'queued propose retry returns the stored first result (card S3b)');
const pq = await pool.query(`SELECT count(*)::int n FROM proposals WHERE status='pending' AND namespace=$1`, [NS]);
assert(pq.rows[0].n === 6, 'pending queue holds the ingest proposal and the five unset proposals', `got ${pq.rows[0].n}`);

// ---- 8. review flow ----------------------------------------------------------------
console.log('review flow:');
const rl = await callTool('review_list', {});
assert(rl.json.status === 'ok' && rl.json.counts.proposals === 6, 'review_list shows 6 pending proposals', JSON.stringify(rl.json.counts));
const pendingIds = rl.json.proposals.map((p) => p.id);
const prom = await callTool('promote', { proposal_id: pendingIds[0] });
assert(prom.json.status === 'ok' && prom.json.decision === 'approved' && prom.json.promoted_id, 'promote approves and creates a memory');
const gp = await callTool('get', { id: prom.json.promoted_id });
assert(gp.json.status === 'ok' && gp.json.memory.approval === 'live', 'promoted memory is live');
const rej = await callTool('reject_proposal', { proposal_id: pendingIds[1] });
assert(rej.json.status === 'ok' && rej.json.decision === 'rejected', 'reject_proposal rejects');
const dec = await callTool('review_decide', { target: 'proposal', id: pendingIds[2], decision: 'approve' });
assert(dec.json.status === 'ok' && dec.json.decision === 'approved', 'review_decide approves third proposal');
const rl2 = await callTool('review_list', {});
assert(rl2.json.counts.proposals === 3, 'review queue drains by exactly the three decisions', `got ${rl2.json.counts.proposals}`);

// ---- 8b. fabricated citations in the unset state --------------------------------------
// Two invented grounding ids behave exactly like no evidence. The
// proposal queues, and a later human promotion stores a record
// whose grounding is empty, so no receipt can ever claim the
// record rests on records that do not exist.
console.log('fabricated citations, unset state:');
const pFake = await callTool('propose', {
  namespace: NS, text: 'fabricated citations unset test', request_id: 'surface-fake-1',
  metadata: { type: 'semantic', grounding_ids: ['demo-does-not-exist', 'demo-also-fake-99'] },
});
assert(pFake.json.decision === 'queued_for_review', 'propose with fabricated ids queues in the unset state', JSON.stringify(pFake.json).slice(0, 160));
const promFake = await callTool('promote', { proposal_id: pFake.json.proposal_id });
assert(promFake.json.status === 'ok' && promFake.json.promoted_id, 'human promotion of the fabricated-citation proposal succeeds');
const gFake = await callTool('get', { id: promFake.json.promoted_id });
assert(Array.isArray(gFake.json.memory.grounding_ids) && gFake.json.memory.grounding_ids.length === 0, 'promoted record stores no unresolved grounding ids', JSON.stringify(gFake.json.memory.grounding_ids));
mcp.kill();

// ---- 9. the set state, against the committed stub --------------------------------------
// The stub server is the verify baseline stub on port 4711 when it
// is already running. Otherwise this suite starts its own copy on
// spare ports, so a standalone run proves the same cases.
console.log('set state, stub gate backend:');
let stubChild = null;
let jevBase = 'http://127.0.0.1:4711';
async function stubUp(base) {
  try { const r = await fetch(`${base}/v1/models`); return r.ok; } catch { return false; }
}
if (!(await stubUp(jevBase))) {
  jevBase = 'http://127.0.0.1:4721';
  stubChild = spawn('node', [join(__dir, 'stub-server-v1.mjs')], {
    env: { ...process.env, JEV_STUB_PORT: '4721', META_STUB_PORT: '4722' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !(await stubUp(jevBase))) {
    await new Promise((r) => setTimeout(r, 200));
  }
}
assert(await stubUp(jevBase), 'stub gate backend is reachable for the set state cases', jevBase);
const gated = startMcp({
  MEMORYLOOM_SETTINGS_FILE: emptyStorePath,
  TYPESAFE_API_KEY: 'stub-dummy-typesafe-key',
  JEV_BASE_URL: jevBase,
});
await gated.init();
const callGated = gated.callTool;

// Approve verdicts.
const gAuto1 = await callGated('propose', { namespace: NS2, text: 'episodic gated test', request_id: 'surface-g-auto1', metadata: { type: 'episodic', author: 'ml-test' } });
assert(gAuto1.json.decision === 'auto_approved' && gAuto1.json.backend === 'jev' && gAuto1.json.id, 'set state propose episodic approves through the gate', JSON.stringify(gAuto1.json).slice(0, 160));
assert((await liveCount('episodic gated test', NS2)) === 1, 'approved episodic proposal is live');
const SUPPORTED_TEXT = 'The demo team runs a weekly planning session every Monday morning and recall returns a receipt that cites the record id.';
const gAuto2 = await callGated('propose', {
  namespace: NS2, text: SUPPORTED_TEXT, request_id: 'surface-g-auto2',
  metadata: { type: 'semantic', author: 'ml-test', grounding_ids: ['seed-s01', 'seed-s02'] },
});
assert(gAuto2.json.decision === 'auto_approved' && gAuto2.json.id, 'set state propose with supported grounding approves', JSON.stringify(gAuto2.json).slice(0, 160));
const gAuto2Row = await pool.query(`SELECT provenance FROM memories WHERE id = $1`, [gAuto2.json.id]);
assert(gAuto2Row.rows[0].provenance.jev && gAuto2Row.rows[0].provenance.jev.decision === 'approve', 'approved record carries the gate verdict as provenance');
const gStore = await callGated('store', { namespace: NS2, text: 'store episodic gated test', request_id: 'surface-g-store', metadata: { type: 'episodic', author: 'ml-test' } });
assert(gStore.json.decision === 'auto_approved' && gStore.json.id && (await liveCount('store episodic gated test', NS2)) === 1, 'set state store follows the same contract and approves episodic', JSON.stringify(gStore.json).slice(0, 160));
// A retry of the live store returns the stored first result. It
// writes no second truth row, no duplicate learning event and no
// second request record.
const gStoreRetry = await callGated('store', { namespace: NS2, text: 'store episodic gated test', request_id: 'surface-g-store', metadata: { type: 'episodic', author: 'ml-test' } });
assert(gStoreRetry.json.decision === 'auto_approved' && gStoreRetry.json.id === gStore.json.id, 'live store retry returns the stored first result (card S3b)');
assert((await liveCount('store episodic gated test', NS2)) === 1, 'live store retry wrote no second truth row (card S3b)');
const gStoreEvents = await pool.query(
  `SELECT kind, count(*)::int n FROM learning_events WHERE namespace = $1 AND subject_id = $2 GROUP BY kind`,
  [NS2, gStore.json.id]
);
assert(gStoreEvents.rows.length === 2 && gStoreEvents.rows.every((r) => r.n === 1), 'live store retry wrote no duplicate learning event (card S3b)', JSON.stringify(gStoreEvents.rows));
const gStoreReq = await pool.query(
  `SELECT count(*)::int n FROM request_records WHERE tool = 'store' AND namespace = $1 AND request_id = 'surface-g-store'`, [NS2]
);
assert(gStoreReq.rows[0].n === 1, 'the live store wrote exactly one request record (card S3b)');
// The same request id with a different payload is refused.
const gStoreReuse = await callGated('store', { namespace: NS2, text: 'a different text under the same request id', request_id: 'surface-g-store', metadata: { type: 'episodic', author: 'ml-test' } });
assert(gStoreReuse.isError && gStoreReuse.json.error === 'REQUEST_ID_REUSED', 'request id reuse with a different payload is refused (card S3b)', JSON.stringify(gStoreReuse.json).slice(0, 160));
assert((await liveCount('a different text under the same request id', NS2)) === 0, 'the refused reuse wrote nothing');

// Escalate verdicts, one per routing class.
const gQueue1 = await callGated('propose', { namespace: NS2, text: 'The moon base opens to visitors in 2027.', request_id: 'surface-g-q1', metadata: { type: 'semantic', author: 'ml-test' } });
assert(gQueue1.json.decision === 'queued_for_review' && gQueue1.json.reason === 'jev-escalate', 'set state unsupported claim escalates', JSON.stringify(gQueue1.json).slice(0, 160));
assert((await liveCount('The moon base%', NS2)) === 0, 'escalated claim is not live');
const gQueue2 = await callGated('propose', { namespace: NS2, text: 'procedural gated test', request_id: 'surface-g-q2', metadata: { type: 'procedural', author: 'ml-test' } });
assert(gQueue2.json.decision === 'queued_for_review', 'set state procedural queues for a human', JSON.stringify(gQueue2.json).slice(0, 160));
const PINNED_TEXT = 'Recall returns a receipt that cites the record id for every result and the demo team runs a weekly planning session.';
const gQueue3 = await callGated('propose', {
  namespace: NS2, text: PINNED_TEXT, request_id: 'surface-g-q3',
  metadata: { type: 'semantic', pinned: true, author: 'ml-test', grounding_ids: ['seed-s01', 'seed-s02'] },
});
assert(gQueue3.json.decision === 'queued_for_review', 'set state pinned queues even with grounding', JSON.stringify(gQueue3.json).slice(0, 160));
assert((await liveCount(PINNED_TEXT, NS2)) === 0, 'pinned proposal is not live');
const gFake2 = await callGated('propose', {
  namespace: NS2, text: 'The Lantern demo rig runs firmware 2.4.1 on the bench unit.', request_id: 'surface-g-fake2',
  metadata: { type: 'semantic', author: 'ml-test', grounding_ids: ['demo-does-not-exist', 'demo-also-fake-99'] },
});
assert(gFake2.json.decision === 'queued_for_review', 'set state fabricated citations escalate, they never approve', JSON.stringify(gFake2.json).slice(0, 160));
assert((await liveCount('The Lantern demo rig runs firmware%', NS2)) === 0, 'fabricated citation proposal is not in the truth store');

// Reject verdict.
const gReject = await callGated('propose', { namespace: NS2, text: 'zxqw vbnm kjhg asdf qwer', request_id: 'surface-g-reject', metadata: { type: 'semantic', author: 'ml-test' } });
assert(gReject.json.decision === 'rejected' && gReject.json.backend === 'jev', 'set state meaningless proposal is rejected by the gate', JSON.stringify(gReject.json).slice(0, 160));
const gRejectRows = await pool.query(
  `SELECT (SELECT count(*)::int FROM memories WHERE namespace = $1 AND text LIKE 'zxqw%') AS live,
          (SELECT count(*)::int FROM proposals WHERE namespace = $1 AND text LIKE 'zxqw%') AS queued`,
  [NS2]
);
assert(gRejectRows.rows[0].live === 0 && gRejectRows.rows[0].queued === 0, 'rejected proposal leaves neither a live record nor a queue record');

// Store queues in the set state too, and a human completes it.
const gStoreQ = await callGated('store', { namespace: NS2, text: 'store global claim gated test', request_id: 'surface-g-storeq', metadata: { type: 'semantic', author: 'ml-test' } });
assert(gStoreQ.json.decision === 'queued_for_review' && gStoreQ.json.proposal_id && (await liveCount('store global claim gated test', NS2)) === 0, 'set state store queues a global claim without grounding', JSON.stringify(gStoreQ.json).slice(0, 160));
const gStoreProm = await callGated('promote', { proposal_id: gStoreQ.json.proposal_id });
assert(gStoreProm.json.status === 'ok' && (await liveCount('store global claim gated test', NS2)) === 1, 'human promotion completes the queued store call');

// Ingest in the set state still queues one proposal and stores nothing.
const gIng = await callGated('ingest_file', {
  namespace: NS2, filename: 'gated-note.md', request_id: 'surface-g-ingest',
  content_base64: Buffer.from(fileText, 'utf8').toString('base64'),
  metadata: { author: 'ml-test' },
});
assert(gIng.json.decision === 'queued_for_review' && gIng.json.chunks === 3 && gIng.json.stored === 0, 'set state ingest queues one proposal and stores nothing', JSON.stringify(gIng.json).slice(0, 160));
const gIngLive = await pool.query(
  `SELECT count(*)::int n FROM memories WHERE namespace = $1 AND provenance->>'filename' = 'gated-note.md'`, [NS2]
);
assert(gIngLive.rows[0].n === 0, 'set state ingest left no live chunk');
gated.kill();

// ---- 10. backend failure in the set state ------------------------------------------------
// A configured backend that cannot be reached fails closed. The
// proposal queues with the fail closed reason and stores nothing.
console.log('set state, dead gate backend:');
const dead = startMcp({
  MEMORYLOOM_SETTINGS_FILE: emptyStorePath,
  TYPESAFE_API_KEY: 'stub-dummy-typesafe-key',
  JEV_BASE_URL: 'https://api.typesafe.ai.invalid',
  JEV_TIMEOUT_MS: '8000',
});
await dead.init();
const dOut = await dead.callTool('propose', { namespace: NS2, text: 'episodic dead backend test', request_id: 'surface-dead-1', metadata: { type: 'episodic', author: 'ml-test' } });
assert(dOut.json.decision === 'queued_for_review' && dOut.json.reason === 'jev-unavailable-fail-closed', 'dead gate backend queues, it never stores', JSON.stringify(dOut.json).slice(0, 160));
assert((await liveCount('episodic dead backend test', NS2)) === 0, 'dead backend proposal is not in the truth store');
dead.kill();
if (stubChild) stubChild.kill('SIGTERM');

// ---- 11. list_namespaces -------------------------------------------------------------------
console.log('list_namespaces:');
const lnMcp = startMcp(keylessEnv);
await lnMcp.init();
const ln = await lnMcp.callTool('list_namespaces', {});
assert(ln.json.status === 'ok' && ln.json.namespaces.some((n) => n.namespace === NS), 'list_namespaces includes test ns');
lnMcp.kill();

// ---- 12. validation ---------------------------------------------------------------------------
console.log('validation:');
const valMcp = startMcp(keylessEnv);
await valMcp.init();
const bad = await valMcp.callTool('store', { namespace: 'x', text: 'y', request_id: 'surface-bad-1', metadata: { type: 'bogus' } });
assert(bad.isError && bad.json.error === 'VALIDATION', 'store rejects bad type before the gate');
const badP = await valMcp.callTool('propose', { namespace: 'x', text: 'y', request_id: 'surface-bad-2', metadata: { type: 'bogus' } });
assert(badP.isError && badP.json.error === 'VALIDATION', 'propose rejects bad type before the gate');
// A covered call without a request id is refused (card S3b). The
// refusal is a protocol level validation error, so the call
// itself throws here rather than returning a payload.
let noIdRefused = false;
try {
  await valMcp.callTool('store', { namespace: 'x', text: 'y', metadata: { type: 'episodic' } });
} catch {
  noIdRefused = true;
}
assert(noIdRefused, 'store without a request id is refused (card S3b)');
valMcp.kill();

// ---- 13. file chunks end to end (card S3b) ----------------------------------------------
// A fresh namespace, so the counts in the sections above stay
// untouched. The keyless instance queues everything, and a human
// decision is what turns a file into truth.
console.log('file chunks, ingest to approval:');
const NS3 = 'memoryloom-test-files';
const s3 = startMcp(keylessEnv);
await s3.init();
const twoChunkText = [para('DDD'), para('EEE')].join('\n\n');
const fIng = await s3.callTool('ingest_file', {
  namespace: NS3, filename: 'field-notes.md', request_id: 'surface-file-1',
  content_base64: Buffer.from(twoChunkText, 'utf8').toString('base64'),
  metadata: { author: 'ml-test' },
});
assert(fIng.json.decision === 'queued_for_review' && fIng.json.chunk_count === 2 && fIng.json.proposal_id,
  'two chunk file queues as one proposal', JSON.stringify(fIng.json).slice(0, 160));
// The null rule. A proposal that is not a file proposal carries
// neither the source file name nor the chunk count.
const plainProp = await s3.callTool('propose', {
  namespace: NS3, text: 'a plain proposal in the file namespace', request_id: 'surface-file-plain',
  metadata: { type: 'episodic', author: 'ml-test' },
});
const plainRow = await pool.query(
  `SELECT source_file_name, chunk_count, created_memory_ids FROM proposals WHERE id = $1`, [plainProp.json.proposal_id]
);
assert(plainRow.rows[0].source_file_name === null && plainRow.rows[0].chunk_count === null
  && Array.isArray(plainRow.rows[0].created_memory_ids) && plainRow.rows[0].created_memory_ids.length === 0,
  'a non file proposal keeps the file columns null (card S3b)');
// The review list at the MCP surface returns the chunk texts.
const fList = await s3.callTool('review_list', {});
const fEntry = (fList.json.proposals || []).find((p) => p.id === fIng.json.proposal_id);
assert(fEntry && fEntry.source_file_name === 'field-notes.md' && fEntry.chunk_count === 2,
  'review list returns the source file name and the chunk count (card S3b)');
assert(fEntry && Array.isArray(fEntry.chunks) && fEntry.chunks.length === 2
  && fEntry.chunks[0].chunk_index === 0 && fEntry.chunks[0].text.includes('DDD')
  && fEntry.chunks[1].chunk_index === 1 && fEntry.chunks[1].text.includes('EEE'),
  'review list returns the chunk texts in chunk index order (card S3b)');
// Approval creates one live memory per chunk, in chunk order,
// each carrying the source file and its chunk index.
const fProm = await s3.callTool('promote', { proposal_id: fIng.json.proposal_id });
assert(fProm.json.status === 'ok' && Array.isArray(fProm.json.created_memory_ids) && fProm.json.created_memory_ids.length === 2
  && fProm.json.promoted_id === fProm.json.created_memory_ids[0],
  'file approval creates one memory per chunk and records every created id (card S3b)', JSON.stringify(fProm.json).slice(0, 200));
const fMems = await pool.query(
  `SELECT id, text, provenance->>'source_file_name' AS sf, provenance->>'chunk_index' AS ci
   FROM memories WHERE id = ANY($1)`, [fProm.json.created_memory_ids]
);
assert(fMems.rows.length === 2 && fMems.rows.every((r) => r.sf === 'field-notes.md'),
  'every created memory names the source file in its provenance (card S3b)');
const fOrder = [...fMems.rows].sort((a, b) => Number(a.ci) - Number(b.ci));
assert(fOrder[0].id === fProm.json.created_memory_ids[0] && fOrder[0].text.includes('DDD') && fOrder[1].text.includes('EEE'),
  'the created memories stand in chunk index order (card S3b)');
// The chunk rows stay after approval.
const fChunksAfter = await pool.query(`SELECT count(*)::int n FROM file_chunks WHERE proposal_id = $1`, [fIng.json.proposal_id]);
assert(fChunksAfter.rows[0].n === 2, 'chunk rows are retained after approval (card S3b)');
// A repeated promote returns both created records and writes nothing new.
const fProm2 = await s3.callTool('promote', { proposal_id: fIng.json.proposal_id });
assert(fProm2.json.status === 'ok' && JSON.stringify(fProm2.json.created_memory_ids) === JSON.stringify(fProm.json.created_memory_ids),
  'a repeated promote of a two chunk approval returns both created records (card S3b)');
const fMemCount = await pool.query(
  `SELECT count(*)::int n FROM memories WHERE namespace = $1 AND provenance->>'promoted_from' = $2`, [NS3, fIng.json.proposal_id]
);
assert(fMemCount.rows[0].n === 2, 'the repeated promote wrote no new memory (card S3b)');
// Rejection also keeps the chunk rows.
const fIng2 = await s3.callTool('ingest_file', {
  namespace: NS3, filename: 'reject-me.md', request_id: 'surface-file-2',
  content_base64: Buffer.from(twoChunkText, 'utf8').toString('base64'),
  metadata: { author: 'ml-test' },
});
const fRej = await s3.callTool('reject_proposal', { proposal_id: fIng2.json.proposal_id });
assert(fRej.json.status === 'ok' && fRej.json.decision === 'rejected', 'file proposal rejects');
const fChunksRej = await pool.query(`SELECT count(*)::int n FROM file_chunks WHERE proposal_id = $1`, [fIng2.json.proposal_id]);
assert(fChunksRej.rows[0].n === 2, 'chunk rows are retained after rejection (card S3b)');
// A file proposal whose chunk count disagrees with its chunk rows
// is refused at promotion.
const corruptId = 'surface-corrupt-file';
await pool.query(`DELETE FROM file_chunks WHERE proposal_id = $1`, [corruptId]);
await pool.query(`DELETE FROM proposals WHERE id = $1`, [corruptId]);
await pool.query(
  `INSERT INTO proposals (id, namespace, type, scope, text, importance, strength, pinned, grounding_ids, provenance, route_reason, source_file_name, chunk_count)
   VALUES ($1, $2, 'semantic', 'global', 'corrupt file proposal', 5, 5.0, false, '{}', '{"author":"ml-test"}'::jsonb, 'ingest-file-queued', 'corrupt.md', 5)`,
  [corruptId, NS3]
);
await pool.query(`INSERT INTO file_chunks (proposal_id, chunk_index, text) VALUES ($1, 0, 'only one chunk row')`, [corruptId]);
const fCorrupt = await s3.callTool('promote', { proposal_id: corruptId });
assert(fCorrupt.isError === true && fCorrupt.json.status === 'error', 'a chunk count mismatch refuses the promotion (card S3b)', JSON.stringify(fCorrupt.json).slice(0, 160));
const corruptRow = await pool.query(`SELECT status FROM proposals WHERE id = $1`, [corruptId]);
assert(corruptRow.rows[0].status === 'pending', 'the refused file proposal stays pending');
s3.kill();

await pool.end();
console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
