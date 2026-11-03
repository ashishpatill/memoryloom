/**
 * memory-mcp — stdio MCP exposing the ten tool surface against
 * Postgres + pgvector (schema v1.sql + migrations).
 *
 * Run:  DATABASE_URL=... node mcp/index.mjs
 *
 * The gate contract (frozen master plan, Section 5, card S3a). No
 * MCP path writes truth directly. The store, propose and
 * ingest_file tools all route through the decision gate in
 * lib/gate.mjs, and approval by local rules is forbidden in every
 * backend state.
 *
 * store and propose follow one contract exactly. The gate scores
 * the proposal with the resolved grounding records. An approve
 * verdict stores the record as live truth. A reject verdict stores
 * nothing. An escalate verdict, and every backend failure, queues
 * the proposal for a human. The grounding rules sit inside the
 * gate. Episodic and node local proposals can approve. Procedural
 * and pinned proposals always queue. A global claim needs at
 * least two cited grounding records that resolve in the store to
 * approve, and otherwise queues.
 *
 * In the state where no Jev backend is configured, the gate fails
 * closed on every call, so store and propose queue every proposal
 * and nothing becomes live without a human decision. In the state
 * where the Jev backend is configured, the Jev verdict governs,
 * subject to the grounding rules above.
 *
 * ingest_file creates one queued proposal per file. The chunk
 * texts are held in the file chunks table, the proposal row
 * carries the source file name and the chunk count, and nothing
 * from a file becomes live at ingest in either state.
 *
 * The request id rule (card S3b). store, propose and ingest_file
 * each require a request id argument. The first call writes its
 * whole outcome as one transaction in lib/gatepath.mjs and stores
 * its first result in the request records table. A retry returns
 * the stored first result and writes nothing twice. A reuse of
 * the request id with a different payload is refused. Every
 * failure returns a plain detail with a stable error name from
 * lib/errors.mjs, never a raw error message.
 *
 * recall routes through the library receipt path in
 * lib/planes.mjs. Every result dereferences to a truth record and
 * carries its receipt, results that cannot dereference are
 * dropped with a reason, and the payload states whether the best
 * fusion score clears the answer threshold.
 *
 * get: fetch one memory by id.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { evaluateDbGate } from '../lib/db-gate.mjs';
import { buildMemoryServer } from './server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

const DATABASE_URL = process.env.DATABASE_URL;
const QUEUE = process.env.MEMORY_QUEUE || 'memory-embed';

if (!DATABASE_URL) {
  console.error('[mcp] DATABASE_URL missing');
  process.exit(1);
}
{
  // The MCP entry reads the database setting directly, so the pre
  // run database gate from Section 10.4 is enforced here, before
  // any pool exists. The hosted entry never reaches this file.
  const gate = evaluateDbGate({ url: DATABASE_URL });
  if (!gate.allowed) {
    console.error(`[mcp] db gate refusal: ${gate.reason}`);
    process.exit(1);
  }
}

/** Lazy pooled client — one connection reused for the stdio session. */
let pool = null;
function getPool() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: DATABASE_URL,
      max: 2,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 15_000,
    });
  }
  return pool;
}

const server = buildMemoryServer({ getPool, databaseUrl: DATABASE_URL, queue: QUEUE });

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is MCP JSON-RPC
  console.error('[memory-mcp] stdio ready (store, recall[receipts], list_namespaces, get, ingest_file, propose, review_list, promote, reject_proposal, review_decide)');
}

main().catch((e) => {
  console.error('[memory-mcp] fatal', e);
  process.exit(1);
});

process.on('SIGINT', async () => {
  if (pool) await pool.end().catch(() => {});
  process.exit(0);
});
