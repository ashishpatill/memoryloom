/**
 * MemoryLoom surface test (adapted from the P1.M4 end-to-end test):
 * seeds a small SYNTHETIC fictional corpus (24 rows, MiniLM embeddings,
 * index_status='indexed') into a throwaway test database, then drives
 * the MCP server over stdio through all ten tools and asserts shapes
 * plus write-gate routing decisions.
 *
 * Never run this against a database that holds real memories: it
 * deletes and re-seeds rows in the 'memoryloom-test' namespace.
 *
 * Usage: DATABASE_URL=postgres://... node checks/test-surface.mjs
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { pipeline } from '@xenova/transformers';
import { assertContractShape } from '../lib/cold-start-contract.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL missing'); process.exit(1); }
const NS = 'memoryloom-test';

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

// ---- 1. seed synthetic corpus with embeddings -----------------------------
console.log('seeding synthetic corpus…');
{
  const c = await pool.connect();
  try {
    // Proposals first: promoted_id is a foreign key into memories.
    await c.query(`DELETE FROM proposals WHERE namespace = $1`, [NS]);
    await c.query(`DELETE FROM memories WHERE namespace = $1`, [NS]);
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

// ---- 2. spawn MCP server over stdio --------------------------------------
console.log('spawning memoryloom-mcp…');
const srv = spawn('node', [join(__dir, '..', 'mcp', 'index.mjs')], {
  env: { ...process.env },
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
function notify(method, params) {
  srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}
async function callTool(name, args) {
  const res = await rpc('tools/call', { name, arguments: args });
  if (res.error) throw new Error(`tools/call ${name}: ${JSON.stringify(res.error)}`);
  const text = res.result.content?.[0]?.text ?? '';
  return { raw: res.result, json: JSON.parse(text), isError: res.result.isError === true };
}

await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ml-test', version: '1' } });
notify('notifications/initialized', {});
const tools = await rpc('tools/list', {});
const names = tools.result.tools.map((t) => t.name).sort();
console.log('tools:', names.join(', '));
assert(names.join(',') === 'get,ingest_file,list_namespaces,promote,propose,recall,reject_proposal,review_decide,review_list,store', 'all 10 tools listed');

// ---- 3. store -------------------------------------------------------------
console.log('store:');
const st = await callTool('store', {
  namespace: NS, text: 'MemoryLoom test memory: hybrid recall uses RRF k=60 fusion.',
  metadata: { type: 'semantic', author: 'ml-test' },
});
assert(st.json.status === 'ok' && st.json.id, 'store ok + id', JSON.stringify(st.json).slice(0, 120));
const storedId = st.json.id;

// ---- 4. recall (hybrid) ----------------------------------------------------
console.log('recall:');
const rc = await callTool('recall', { namespace: NS, query: 'hybrid recall RRF fusion', k: 5 });
assert(rc.json.status === 'ok', 'recall ok');
assert(rc.json.hybrid === true, 'recall ran hybrid (embedder loaded)');
assert(rc.json.count >= 1 && rc.json.results[0].id === storedId, 'recall finds stored row first', `got ${rc.json.results[0]?.id}`);
assert(rc.json.legs.keyword >= 1, 'keyword leg contributed');
const rc2 = await callTool('recall', { namespace: NS, query: 'background process activation signal', k: 5 });
assert(rc2.json.status === 'ok' && rc2.json.results.some((r) => r.id === 'seed-probe-1'),
  'paraphrase recall hits via vector leg (no keyword overlap)', `got ${rc2.json.results.map((r) => r.id).join(',')}`);
assert(rc2.json.legs.vector >= 1, 'vector leg contributed');
const rcCold = await callTool('recall', { namespace: 'no-such-ns', query: 'anything', k: 5 });
assert(rcCold.json.status === 'cold_start', 'cold_start on empty namespace');
assert(assertContractShape(rc.json.contract) === null, 'recall contract shape', assertContractShape(rc.json.contract));
assert(rc.json.contract.source === 'neon', 'contract source neon');
assert(['warm','cold'].includes(rc.json.contract.index), 'contract index warm|cold');
assert(['warm','cold','unknown'].includes(rc.json.contract.daemon), 'contract daemon');
assert(rcCold.json.contract.index === 'cold', 'empty ns index=cold');
assert(rcCold.json.contract.replica_lag === null, 'primary replica_lag null');
assert(typeof rc.json.contract.last_seq === 'number', 'last_seq present');

// ---- 5. get -----------------------------------------------------------------
console.log('get:');
const g = await callTool('get', { id: storedId });
assert(g.json.status === 'ok' && g.json.memory.text.includes('RRF k=60'), 'get returns stored row');
const gMiss = await callTool('get', { id: 'does-not-exist' });
assert(gMiss.isError && gMiss.json.error === 'NOT_FOUND', 'get 404 on missing id');

// ---- 6. ingest_file ------------------------------------------------------------
console.log('ingest_file:');
const para = (tag) => `${tag} ` + 'lorem ipsum dolor sit amet '.repeat(60); // ~1560 chars
const fileText = [para('AAA'), para('BBB'), para('CCC')].join('\n\n');
const ing = await callTool('ingest_file', {
  namespace: NS, filename: 'agent-note.md',
  content_base64: Buffer.from(fileText, 'utf8').toString('base64'),
  metadata: { author: 'ml-test' },
});
assert(ing.json.status === 'ok' && ing.json.stored === 3 && ing.json.chunks === 3,
  'ingest_file stored 3 chunks', JSON.stringify(ing.json).slice(0, 160));
const g2 = await callTool('get', { id: ing.json.ids[0] });
assert(g2.json.memory.provenance.filename === 'agent-note.md', 'chunk provenance has filename');

// ---- 7. propose routing (the write gate) ---------------------------------------
console.log('propose:');
const pAuto1 = await callTool('propose', { namespace: NS, text: 'episodic auto test', metadata: { type: 'episodic' } });
assert(pAuto1.json.decision === 'auto_approved' && pAuto1.json.id, 'propose episodic → auto_approved');
const pAuto2 = await callTool('propose', {
  namespace: NS, text: 'semantic with evidence auto test',
  metadata: { type: 'semantic', grounding_ids: ['seed-x1', 'seed-x2'] },
});
assert(pAuto2.json.decision === 'auto_approved', 'propose semantic+2 grounding → auto_approved');
const pQ1 = await callTool('propose', { namespace: NS, text: 'procedural queued test', metadata: { type: 'procedural' } });
assert(pQ1.json.decision === 'queued_for_review' && pQ1.json.reason === 'procedural-human-always', 'propose procedural → queued');
const pQ2 = await callTool('propose', { namespace: NS, text: 'low evidence queued test', metadata: { type: 'semantic' } });
assert(pQ2.json.decision === 'queued_for_review' && pQ2.json.reason === 'low-evidence', 'propose semantic w/o grounding → queued');
const pQ3 = await callTool('propose', { namespace: NS, text: 'pinned queued test', metadata: { type: 'semantic', pinned: true, grounding_ids: ['a', 'b', 'c'] } });
assert(pQ3.json.decision === 'queued_for_review' && pQ3.json.reason === 'pinned-human-always', 'propose pinned → queued even with grounding');
const pq = await pool.query(`SELECT count(*)::int n FROM proposals WHERE status='pending' AND namespace=$1`, [NS]);
assert(pq.rows[0].n === 3, '3 proposals persisted in queue');

// ---- 8. review flow: review_list -> promote / reject_proposal / review_decide --
console.log('review flow:');
const rl = await callTool('review_list', {});
assert(rl.json.status === 'ok' && rl.json.counts.proposals === 3, 'review_list shows 3 pending proposals', JSON.stringify(rl.json.counts));
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
assert(rl2.json.counts.proposals === 0, 'review queue drained after decisions');

// ---- 8b. fabricated citations (Iteration 5.3, Finding A regression) -----------
// Two invented grounding ids must behave exactly like no evidence on
// the rules path too: the proposal queues as low-evidence, and a
// later human promotion stores a record whose grounding is empty —
// the receipt can never claim it rests on records that do not exist.
console.log('fabricated citations:');
const pFake = await callTool('propose', {
  namespace: NS, text: 'fabricated citations test',
  metadata: { type: 'semantic', grounding_ids: ['demo-does-not-exist', 'demo-also-fake-99'] },
});
assert(pFake.json.decision === 'queued_for_review' && pFake.json.reason === 'low-evidence', 'propose semantic+2 fabricated ids → queued as low-evidence', JSON.stringify(pFake.json).slice(0, 160));
const promFake = await callTool('promote', { proposal_id: pFake.json.proposal_id });
assert(promFake.json.status === 'ok' && promFake.json.promoted_id, 'human promotion of the fabricated-citation proposal succeeds');
const gFake = await callTool('get', { id: promFake.json.promoted_id });
assert(Array.isArray(gFake.json.memory.grounding_ids) && gFake.json.memory.grounding_ids.length === 0, 'promoted record stores no unresolved grounding ids', JSON.stringify(gFake.json.memory.grounding_ids));

// ---- 9. list_namespaces ---------------------------------------------------------------
console.log('list_namespaces:');
const ln = await callTool('list_namespaces', {});
assert(ln.json.status === 'ok' && ln.json.namespaces.some((n) => n.namespace === NS), 'list_namespaces includes test ns');

// ---- 10. validation ----------------------------------------------------------------------
console.log('validation:');
const bad = await callTool('store', { namespace: 'x', text: 'y', metadata: { type: 'bogus' } });
assert(bad.isError && bad.json.error === 'VALIDATION', 'store rejects bad type');

srv.kill();
await pool.end();
console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
