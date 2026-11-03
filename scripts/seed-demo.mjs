/**
 * Seed the synthetic demo corpus (Project Lantern) into a namespace,
 * wiring the two named demo agents — grok and moose — as graph
 * identities with proposals, grounding, supersession and decay
 * pressure for the daemon to find.
 *
 * The corpus is fictional. No real data is ever seeded.
 *
 * Library use:  import { seedDemo } from '../scripts/seed-demo.mjs'
 * CLI use:      DATABASE_URL=postgres://... node scripts/seed-demo.mjs [namespace]
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { embedStaged } from '../lib/planes.mjs';
import { resolveDatabaseUrl } from '../lib/load-env.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
export const DEMO_NAMESPACE = 'memoryloom-demo';

export async function seedDemo(pool, { namespace = DEMO_NAMESPACE } = {}) {
  const lines = readFileSync(join(__dir, '..', 'checks', 'fixtures', 'demo-corpus.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM proposals WHERE namespace = $1`, [namespace]);
    await client.query(`DELETE FROM memories WHERE namespace = $1`, [namespace]);
    for (const row of lines) {
      if (row.kind === 'memory') {
        const provenance = {
          source_session: `demo-seed-${row.id}`,
          author: row.author,
          origin: row.origin || 'seed',
          created_at: row.recorded_at,
          embedding_model: null,
        };
        if (row.evidence_refs) provenance.evidence_refs = row.evidence_refs;
        if (row.promoted_from) {
          provenance.promoted_from = row.promoted_from;
          provenance.decided_by = row.decided_by || 'human';
        }
        await client.query(
          `INSERT INTO memories (id, namespace, type, scope, text, importance, strength, pinned,
                                 index_status, approval, grounding_ids, provenance,
                                 valid_from, valid_to, created_at)
           VALUES ($1,$2,$3,'global',$4,5,$5,false,'staged','live',$6,$7::jsonb,$8,$9,$10)`,
          [
            row.id, namespace, row.type, row.text, row.strength ?? 5.0,
            row.grounding_ids || [], JSON.stringify(provenance),
            row.valid_from || row.recorded_at, row.valid_to || null, row.recorded_at,
          ]
        );
      } else if (row.kind === 'proposal') {
        const provenance = {
          source_session: `demo-seed-${row.id}`,
          author: row.author,
          origin: 'propose',
          created_at: row.recorded_at,
          embedding_model: null,
        };
        await client.query(
          `INSERT INTO proposals (id, namespace, type, scope, text, importance, strength, pinned,
                                  grounding_ids, provenance, route_reason, status,
                                  decided_by, decided_at, promoted_id, created_at)
           VALUES ($1,$2,$3,'global',$4,5,5.0,false,$5,$6::jsonb,$7,$8,$9,$10,$11,$12)`,
          [
            row.id, namespace, row.type, row.text, row.grounding_ids || [],
            JSON.stringify(provenance), row.route_reason, row.status,
            row.decided_by || null,
            row.status === 'pending' ? null : row.recorded_at,
            row.promoted_id || null, row.recorded_at,
          ]
        );
      }
    }
    // Second pass: supersession links, once every referenced row exists.
    for (const row of lines) {
      if (row.kind === 'memory' && row.superseded_by) {
        await client.query(`UPDATE memories SET superseded_by = $2 WHERE id = $1`, [row.id, row.superseded_by]);
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  const embedded = await embedStaged(pool, namespace);
  return { namespace, rows: lines.length, embedded };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // The deliberate seed entry point passes its operation identity
  // to the resolver in code (Section 10.4). Throwaway targets pass
  // on the allowlist. A hosted target also needs the operation
  // record and the named environment signal.
  const url = resolveDatabaseUrl({ operation: 'hosted-seed' });
  if (!url) {
    console.error('DATABASE_URL missing');
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const result = await seedDemo(pool, { namespace: process.argv[2] || DEMO_NAMESPACE });
  console.log(JSON.stringify(result));
  await pool.end();
}
