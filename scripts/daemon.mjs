/**
 * Run one daemon cycle against DATABASE_URL and print the run record.
 * The daemon emits proposals only; it never writes truth.
 *
 * Usage: DATABASE_URL=postgres://... node scripts/daemon.mjs [namespace]
 */
import pg from 'pg';
import { runDaemonCycle } from '../lib/daemon.mjs';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL missing');
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: url, max: 2 });
const run = await runDaemonCycle(pool, { namespace: process.argv[2] || null });
console.log(JSON.stringify(run, null, 2));
await pool.end();
