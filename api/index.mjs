/**
 * Vercel function entry for the MemoryLoom API.
 *
 * The same handler the local server uses (web/api.mjs), backed by a
 * pool from the DATABASE_URL environment variable. Deploy notes:
 *  - Set DATABASE_URL in the Vercel project to a Postgres 16 +
 *    pgvector database seeded with the demo corpus
 *    (`npm run db:init` then `npm run seed:web` against that URL).
 *  - WEB_NAMESPACE may override the namespace; it defaults to the
 *    synthetic demo namespace. Never point this at a live store.
 */
import pg from 'pg';
import { createHandler } from '../web/api.mjs';

let handler = null;
function getHandler() {
  if (!handler) {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    handler = createHandler({ pool, namespace: process.env.WEB_NAMESPACE || 'memoryloom-demo' });
  }
  return handler;
}

export default async function vercelHandler(req, res) {
  if (!process.env.DATABASE_URL) {
    res.writeHead(500, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'DATABASE_URL is not configured on this deployment' }));
  }
  return getHandler()(req, res);
}
