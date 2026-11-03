/**
 * Local HTTP entry for the MemoryLoom MCP server.
 *
 * Serves the same shared server that the stdio entry uses over
 * Streamable HTTP in stateless mode at POST /mcp.
 *
 * Run with DATABASE_URL set in the process environment. The
 * database gate check runs at startup in the same way as the
 * stdio entry and the server refuses to start when the target is
 * not allowlisted. The listening port comes from MCP_HTTP_PORT
 * and defaults to 8891.
 */
import { createServer } from 'node:http';
import pg from 'pg';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { evaluateDbGate } from '../lib/db-gate.mjs';
import { buildMemoryServer } from './server.mjs';

const DATABASE_URL = process.env.DATABASE_URL;
const QUEUE = process.env.MEMORY_QUEUE || 'memory-embed';
const PORT = Number(process.env.MCP_HTTP_PORT || 8891);

if (!DATABASE_URL) {
  console.error('[mcp] DATABASE_URL missing');
  process.exit(1);
}
{
  const gate = evaluateDbGate({ url: DATABASE_URL });
  if (!gate.allowed) {
    console.error(`[mcp] db gate refusal: ${gate.reason}`);
    process.exit(1);
  }
}

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

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname !== '/mcp') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found', path: url.pathname }));
    return;
  }
  // A stateless transport cannot be reused across requests so a
  // fresh server and a fresh transport are built for each request.
  // The pool is shared across requests.
  const server = buildMemoryServer({ getPool, databaseUrl: DATABASE_URL, queue: QUEUE });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (e) {
    console.error('[mcp-http] request failed:', e);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null }));
    }
  }
});

httpServer.listen(PORT, '127.0.0.1', () => {
  console.error(`[memory-mcp] http ready at http://127.0.0.1:${PORT}/mcp (store, recall[receipts], list_namespaces, get, ingest_file, propose, review_list, promote, reject_proposal, review_decide)`);
});

process.on('SIGINT', async () => {
  httpServer.close();
  if (pool) await pool.end().catch(() => {});
  process.exit(0);
});
process.on('SIGTERM', async () => {
  httpServer.close();
  if (pool) await pool.end().catch(() => {});
  process.exit(0);
});
