/**
 * Event-triggered daemon — the async side of the live loop.
 *
 * The daemon watches the store (sync_log mutations, new proposals,
 * decay pressure) and turns what it finds into PROPOSALS ONLY:
 * review_items that a human, or the Jev-gated apply path below, can
 * act on. A daemon cycle never writes a memory, never changes a
 * proposal, and never retires anything. Truth changes happen only in
 * applyDaemonItem, which routes through the same Jev-gated library
 * functions the live loop uses (consolidateNamespace, applyDecay) —
 * and contradiction flags are human-only by design.
 *
 * Idempotent and resumable:
 *  - The high-water mark lives in sync_state under
 *    'daemon:memoryloom:last_seq' and moves only at the END of a
 *    finished cycle, so a crashed cycle is simply reprocessed.
 *    A cycle restricted to one namespace keeps its own mark under
 *    a namespace scoped key and advances it only over that
 *    namespace's events, so it can never move past events that
 *    belong to another namespace (card S3b). The unrestricted
 *    cycle keeps the one global key.
 *  - Emitted review items carry a content signature and are deduped
 *    against every earlier item with the same signature, whatever
 *    its status: once a candidate has been emitted (and especially
 *    once a human has decided it), it is never emitted again.
 *  - Every cycle writes a daemon_runs row (migration 006). A row
 *    left 'running' is marked 'abandoned' by the next cycle.
 */
import { createHash, randomUUID } from 'node:crypto';
import { applyDecay, consolidateNamespace, normaliseText } from './planes.mjs';

export const DAEMON_NODE = 'memoryloom-daemon';
const WATERMARK_KEY = 'daemon:memoryloom:last_seq';
const DAY_MS = 86_400_000;

const NEGATIONS = new Set([
  'not', 'never', 'no', "n't", 'cannot', "can't", 'cant', "isn't", "aren't",
  "don't", "doesn't", "didn't", "won't", 'without',
]);

function signature(parts) {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}

/** The watermark key a cycle reads and writes. */
export function watermarkKeyFor(namespace) {
  return namespace ? `${WATERMARK_KEY}:ns:${namespace}` : WATERMARK_KEY;
}

async function getWatermark(pool, namespace) {
  const r = await pool.query(`SELECT last_seq FROM sync_state WHERE key = $1`, [watermarkKeyFor(namespace)]);
  return r.rows[0] ? Number(r.rows[0].last_seq) : 0;
}

async function setWatermark(pool, seq, namespace) {
  await pool.query(
    `INSERT INTO sync_state (key, last_seq, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET last_seq = EXCLUDED.last_seq, updated_at = now()`,
    [watermarkKeyFor(namespace), seq]
  );
}

async function alreadyEmitted(pool, sig) {
  const r = await pool.query(
    `SELECT 1 FROM review_items WHERE payload->>'signature' = $1 LIMIT 1`,
    [sig]
  );
  return r.rows.length > 0;
}

async function emit(pool, { kind, payload }) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO review_items (id, kind, payload, status) VALUES ($1, $2, $3::jsonb, 'queued')`,
    [id, kind, JSON.stringify(payload)]
  );
  return id;
}

/** Core text of a memory with negation tokens removed — the contradiction detector's comparison key. */
function negationCore(text) {
  const tokens = normaliseText(text).replace(/[.,;:!?"]/g, '').split(' ').filter(Boolean);
  return {
    core: tokens.filter((t) => !NEGATIONS.has(t)).join(' '),
    negated: tokens.some((t) => NEGATIONS.has(t)),
  };
}

/**
 * One daemon cycle. Options:
 *   namespace    restrict work to one namespace (default: all)
 *   now          clock for decay projection (tests pin it)
 *   batchLimit   max sync_log entries examined per cycle
 *   halfLifeDays / dropFloor — the decay parameters from planes.mjs
 * Returns the finished run record.
 */
export async function runDaemonCycle(pool, {
  namespace = null,
  now = new Date(),
  batchLimit = 500,
  halfLifeDays = 30,
  dropFloor = 1.0,
} = {}) {
  const nowMs = new Date(now).getTime();
  await pool.query(
    `UPDATE daemon_runs SET status = 'abandoned' WHERE daemon = $1 AND status = 'running'`,
    [DAEMON_NODE]
  );
  const watermarkBefore = await getWatermark(pool, namespace);
  const runId = randomUUID();
  await pool.query(
    `INSERT INTO daemon_runs (id, daemon, namespace, status, watermark_before)
     VALUES ($1, $2, $3, 'running', $4)`,
    [runId, DAEMON_NODE, namespace, watermarkBefore]
  );
  await pool.query(
    `INSERT INTO daemon_presence (node, last_beat, version, meta)
     VALUES ($1, now(), 'block4', $2::jsonb)
     ON CONFLICT (node) DO UPDATE SET last_beat = now(), meta = EXCLUDED.meta`,
    [DAEMON_NODE, JSON.stringify({ last_run: runId })]
  );

  const emitted = {
    consolidation_candidates: 0,
    decay_candidates: 0,
    contradiction_flags: 0,
    observed_proposals: 0,
    observed_gate_verdicts: 0,
  };

  // ---- watch: new store events since the watermark -------------------------
  const batch = await pool.query(
    `SELECT s.seq, s.memory_id, s.op, m.namespace
     FROM sync_log s JOIN memories m ON m.id = s.memory_id
     WHERE s.seq > $1 ORDER BY s.seq LIMIT $2`,
    [watermarkBefore, batchLimit]
  );
  const inScope = (ns) => namespace === null || ns === namespace;
  const affected = new Map(); // memory_id -> namespace
  for (const row of batch.rows) {
    if (inScope(row.namespace)) affected.set(row.memory_id, row.namespace);
  }

  // Observed (not acted on): proposals and gate verdicts are the live
  // loop's business; the daemon only counts what it saw go by.
  const since = new Date(nowMs - DAY_MS).toISOString();
  const propCount = await pool.query(
    `SELECT count(*)::int AS n,
            count(*) FILTER (WHERE status <> 'pending')::int AS decided
     FROM proposals WHERE created_at >= $1 ${namespace ? 'AND namespace = $2' : ''}`,
    namespace ? [since, namespace] : [since]
  );
  emitted.observed_proposals = propCount.rows[0].n;
  emitted.observed_gate_verdicts = propCount.rows[0].decided;

  // ---- detect: consolidation candidates among affected memories ------------
  const namespacesTouched = [...new Set(affected.values())];
  for (const ns of namespacesTouched) {
    const live = await pool.query(
      `SELECT id, text FROM memories WHERE namespace = $1 AND approval = 'live' ORDER BY created_at`,
      [ns]
    );
    const groups = new Map();
    for (const row of live.rows) {
      const key = normaliseText(row.text);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row.id);
    }
    for (const ids of groups.values()) {
      if (ids.length < 2) continue;
      if (!ids.some((id) => affected.has(id))) continue;
      const sig = signature(['consolidation', ns, ...[...ids].sort()]);
      if (await alreadyEmitted(pool, sig)) continue;
      await emit(pool, {
        kind: 'resolution',
        payload: {
          daemon: true,
          daemon_kind: 'consolidation_candidate',
          namespace: ns,
          memory_ids: ids,
          signature: sig,
          detected_at: new Date(nowMs).toISOString(),
          run_id: runId,
        },
      });
      emitted.consolidation_candidates += 1;
    }

    // ---- detect: contradiction flags (negation pairs) ----------------------
    const byCore = new Map();
    for (const row of live.rows) {
      const { core, negated } = negationCore(row.text);
      if (!core) continue;
      if (!byCore.has(core)) byCore.set(core, { plain: [], negated: [] });
      byCore.get(core)[negated ? 'negated' : 'plain'].push(row.id);
    }
    for (const { plain, negated } of byCore.values()) {
      if (!plain.length || !negated.length) continue;
      const pair = [plain[0], negated[0]].sort();
      if (!pair.some((id) => affected.has(id))) continue;
      const sig = signature(['contradiction', ns, ...pair]);
      if (await alreadyEmitted(pool, sig)) continue;
      await emit(pool, {
        kind: 'import_contradiction',
        payload: {
          daemon: true,
          daemon_kind: 'contradiction_flag',
          detector: 'negation-pair',
          namespace: ns,
          memory_ids: pair,
          signature: sig,
          detected_at: new Date(nowMs).toISOString(),
          run_id: runId,
        },
      });
      emitted.contradiction_flags += 1;
    }
  }

  // ---- detect: decay candidates across the scope ---------------------------
  const stale = await pool.query(
    `SELECT id, namespace, strength, pinned, created_at, last_recalled_at, decay_anchor_at
     FROM memories
     WHERE approval = 'live' AND pinned = false
       ${namespace ? 'AND namespace = $1' : ''}
     ORDER BY created_at`,
    namespace ? [namespace] : []
  );
  for (const row of stale.rows) {
    // The projection reads the same decay anchor in the same
    // fallback order as applyDecay (card S3b), so the daemon flags
    // exactly the rows a decay run would decay.
    const anchor = new Date(row.decay_anchor_at || row.last_recalled_at || row.created_at).getTime();
    const ageDays = Math.max(0, (nowMs - anchor) / DAY_MS);
    const projected = Math.round(row.strength * Math.pow(0.5, ageDays / halfLifeDays) * 1e6) / 1e6;
    if (projected >= dropFloor) continue;
    const sig = signature(['decay', row.namespace, row.id]);
    if (await alreadyEmitted(pool, sig)) continue;
    await emit(pool, {
      kind: 'resolution',
      payload: {
        daemon: true,
        daemon_kind: 'decay_candidate',
        namespace: row.namespace,
        memory_id: row.id,
        projected_strength: projected,
        signature: sig,
        detected_at: new Date(nowMs).toISOString(),
        run_id: runId,
      },
    });
    emitted.decay_candidates += 1;
  }

  // ---- finish: advance the watermark, close the run ------------------------
  // A restricted cycle advances its own mark only over its own
  // namespace's rows in the batch. An unrestricted cycle advances
  // the global mark over the whole batch, as before.
  const inScopeRows = namespace ? batch.rows.filter((row) => row.namespace === namespace) : batch.rows;
  const watermarkAfter = inScopeRows.length
    ? Number(inScopeRows[inScopeRows.length - 1].seq)
    : watermarkBefore;
  await setWatermark(pool, watermarkAfter, namespace);
  await pool.query(
    `UPDATE daemon_runs
     SET status = 'finished', watermark_after = $2, scanned = $3,
         emitted = $4::jsonb, finished_at = now()
     WHERE id = $1`,
    [runId, watermarkAfter, batch.rows.length, JSON.stringify(emitted)]
  );
  return {
    run_id: runId,
    status: 'finished',
    scanned: batch.rows.length,
    watermark_before: watermarkBefore,
    watermark_after: watermarkAfter,
    emitted,
  };
}

/**
 * Act on one daemon-emitted review item. Truth changes route through
 * the Jev-gated library paths only:
 *  - consolidation_candidate -> consolidateNamespace (Jev accept +
 *    router-written atom); resolved only if the group actually merged.
 *  - decay_candidate -> applyDecay (Jev keep/drop); resolved with the
 *    verdict as the outcome, whichever way it went.
 *  - contradiction_flag -> human-only; this function refuses.
 */
export async function applyDaemonItem(pool, itemId, { decidedBy = 'daemon-apply' } = {}) {
  const r = await pool.query(`SELECT * FROM review_items WHERE id = $1`, [itemId]);
  const item = r.rows[0];
  if (!item) return { applied: false, reason: 'review item not found' };
  const payload = item.payload || {};
  if (!payload.daemon) return { applied: false, reason: 'not a daemon item' };
  if (item.status !== 'queued') return { applied: false, reason: `item status=${item.status}` };

  if (payload.daemon_kind === 'contradiction_flag') {
    return { applied: false, reason: 'human-only: contradiction flags are resolved by a human via review_decide', human_only: true };
  }

  if (payload.daemon_kind === 'consolidation_candidate') {
    const result = await consolidateNamespace(pool, { namespace: payload.namespace });
    const wanted = new Set(payload.memory_ids || []);
    const merged = result.merged.find((m) => m.from.every((id) => wanted.has(id)));
    if (!merged) {
      const skipped = result.skipped.find((s) => s.ids.every((id) => wanted.has(id)));
      return { applied: false, reason: skipped?.reason || 'group not merged', decision: skipped?.decision || null };
    }
    await pool.query(
      `UPDATE review_items SET status = 'resolved', decided_by = $2, decided_at = now() WHERE id = $1`,
      [itemId, decidedBy]
    );
    return { applied: true, outcome: 'merged', new_id: merged.new_id, decision: merged.decision };
  }

  if (payload.daemon_kind === 'decay_candidate') {
    const result = await applyDecay(pool, { namespace: payload.namespace, useJev: true });
    const entry = result.decisions.find((d) => d.id === payload.memory_id);
    if (!entry) {
      return { applied: false, reason: 'memory no longer a decay candidate', decision: null };
    }
    await pool.query(
      `UPDATE review_items SET status = 'resolved', decided_by = $2, decided_at = now() WHERE id = $1`,
      [itemId, decidedBy]
    );
    return {
      applied: true,
      outcome: entry.decision.drop ? 'retired' : 'kept-by-verdict',
      decision: entry.decision,
    };
  }

  return { applied: false, reason: `unknown daemon_kind ${payload.daemon_kind}` };
}

/** Recent daemon runs, newest first. */
export async function listDaemonRuns(pool, limit = 20) {
  const r = await pool.query(
    `SELECT * FROM daemon_runs ORDER BY started_at DESC LIMIT $1`,
    [limit]
  );
  return r.rows;
}
