/**
 * init-db.mjs — apply the MemoryLoom schema to DATABASE_URL in order:
 * schema/v1.sql, then schema/migrations/002..008. Every file is
 * written to be re-runnable, so the same command also upgrades a
 * database that already applied the schema through migration 007
 * (card S3b proves that upgrade path).
 *
 * Usage: node scripts/init-db.mjs — DATABASE_URL from the environment
 * or from .env.local (see lib/load-env.mjs).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { resolveDatabaseUrl } from '../lib/load-env.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, '..');
// A hosted schema application runs under an operation identity
// passed on the command line, with its operation record and the
// MEMORYLOOM_ALLOW_HOSTED_SCHEMA signal (Section 10.4). Local
// throwaway targets need no identity and pass on the allowlist.
const opIdx = process.argv.indexOf('--operation');
const operation = opIdx >= 0 ? process.argv[opIdx + 1] : null;
const url = resolveDatabaseUrl(operation ? { operation } : {});
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
  'schema/migrations/007-learning-events.sql',
  'schema/migrations/008-request-records-file-chunks.sql',
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
