/**
 * Vercel function entry for the MemoryLoom API.
 *
 * The same handler the local server uses (web/api.mjs), backed by a
 * pool from the DATABASE_URL environment variable, or from
 * NEON_CONNECTION_STRING when DATABASE_URL is not set. Deploy notes:
 *  - Set DATABASE_URL, or NEON_CONNECTION_STRING, in the Vercel
 *    project to the hosted Postgres 16 + pgvector database.
 *  - WEB_NAMESPACE may override the namespace; it defaults to the
 *    live namespace, memoryloom-live.
 */
import pg from 'pg';
import { createHandler } from '../web/api.mjs';

let handler = null;
function getHandler() {
  if (!handler) {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL || process.env.NEON_CONNECTION_STRING, max: 2 });
    handler = createHandler({ pool, namespace: String(process.env.WEB_NAMESPACE || 'memoryloom-live').replace(/_/g, '-') });
  }
  return handler;
}

export default async function vercelHandler(req, res) {
  if (!process.env.DATABASE_URL && !process.env.NEON_CONNECTION_STRING) {
    res.writeHead(500, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'DATABASE_URL is not configured on this deployment' }));
  }
  return getHandler()(req, res);
}
