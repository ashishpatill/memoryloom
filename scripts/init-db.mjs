/**
 * init-db.mjs — apply the MemoryLoom schema to DATABASE_URL in order:
 * schema/v1.sql, then schema/migrations/002..005. Idempotent enough for
 * a fresh database; run once per database.
 *
 * Usage: DATABASE_URL=postgres://... node scripts/init-db.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, '..');
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL missing');
  process.exit(1);
}
const files = [
  'schema/v1.sql',
  'schema/migrations/002-proposals.sql',
  'schema/migrations/003-import-review.sql',
  'schema/migrations/004-blackboard-outbox.sql',
  'schema/migrations/005-daemon-presence.sql',
  'schema/migrations/006-daemon-runs.sql',
];
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  for (const f of files) {
    const sql = readFileSync(join(root, f), 'utf8');
    await client.query(sql);
    console.log(`applied ${f}`);
  }
  const t = await client.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' ORDER BY table_name`
  );
  console.log('tables:', t.rows.map((r) => r.table_name).join(', '));
} finally {
  await client.end();
}
