/**
 * Vercel function entry for the MemoryLoom MCP server over HTTP.
 *
 * Serves the same shared server that the stdio entry uses over
 * Streamable HTTP in stateless mode. The pool comes from the
 * DATABASE_URL environment variable only. There is no database
 * gate check on this hosted path and that matches the hosted API
 * entry in api/index.mjs.
 *
 * The route is wired in vercel.json with a rewrite from /mcp to
 * this function so the existing site and console routes and the
 * existing /api routes stay untouched.
 *
 * When MEMORYLOOM_MCP_TOKEN is set in the environment a request
 * must carry that value as a bearer credential in its
 * Authorization header and any request without it or with a
 * different value is refused with a 401 response. When
 * MEMORYLOOM_MCP_TOKEN is not set there is no credential check.
 * This check lives on this hosted entry only. The local stdio
 * and local HTTP entries carry no such check.
 */
import pg from 'pg';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildMemoryServer } from '../mcp/server.mjs';

let pool = null;
function getPool() {
  if (!pool) {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  }
  return pool;
}

export default async function vercelHandler(req, res) {
  const expectedToken = process.env.MEMORYLOOM_MCP_TOKEN;
  if (expectedToken) {
    const header = req?.headers?.authorization || req?.headers?.Authorization || '';
    if (header !== `Bearer ${expectedToken}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unauthorized' }));
    }
  }
  if (!process.env.DATABASE_URL) {
    res.writeHead(500, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'DATABASE_URL is not configured on this deployment' }));
  }
  const server = buildMemoryServer({
    getPool,
    databaseUrl: process.env.DATABASE_URL,
    queue: process.env.MEMORY_QUEUE || 'memory-embed',
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  if (res && typeof res.on === 'function') {
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
  }
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (e) {
    console.error('[mcp-hosted] request failed:', e);
    if (res && !res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null }));
    }
  }
}
