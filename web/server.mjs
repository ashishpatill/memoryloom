/**
 * Local web server for the MemoryLoom site + console.
 *
 * Serves web/public (the product site and the console) and the JSON
 * API from web/api.mjs, against DATABASE_URL. The console namespace
 * is WEB_NAMESPACE (default: the synthetic demo namespace). This
 * server is for local/demo use; on Vercel the same handler runs as
 * api/index.mjs behind vercel.json rewrites.
 *
 *   DATABASE_URL=postgres://… npm run web        # http://localhost:4173
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { resolveDatabaseUrl } from '../lib/load-env.mjs';
import { createHandler } from './api.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dir, 'public');
const url = resolveDatabaseUrl();
if (!url) {
  console.error('DATABASE_URL missing — the console reads the demo database. See README "Run the site + console".');
  process.exit(1);
}
const namespace = process.env.WEB_NAMESPACE || 'memoryloom-demo';
const port = Number(process.env.WEB_PORT || 4173);

const pool = new pg.Pool({ connectionString: url, max: 4 });
const api = createHandler({ pool, namespace });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname.startsWith('/api/')) return api(req, res);
  let path = u.pathname === '/' ? '/index.html' : u.pathname;
  if (path === '/console') path = '/console.html';
  const file = normalize(join(PUBLIC, path));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
});

server.listen(port, () => {
  console.log(`MemoryLoom web: http://localhost:${port}  (site)  http://localhost:${port}/console  (console, namespace ${namespace})`);
});
