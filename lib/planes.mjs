/**
 * Two-plane memory operations.
 *
 * Plane 1 — TRUTH: the `memories` table's records themselves: text,
 * provenance, bi-temporal validity, approval state. Append-only in
 * spirit: consolidation and decay never rewrite a record's text or
 * provenance; they add new records and change lifecycle fields
 * (superseded_by, merged_into, valid_to, approval) with the decision
 * provenance attached.
 *
 * Plane 2 — RECALL: everything derived from Plane 1 — embeddings and
 * index_status. Disposable and rebuildable from Plane 1 at any time;
 * rebuildRecallIndex proves it by wiping the derived state and
 * regenerating it from the records alone.
 *
 * Recall receipts: recall proposes, truth disposes. Every recall
 * result must dereference to a live Plane-1 record with provenance,
 * or it is dropped before the agent sees it (recallWithReceipts).
 *
 * Decisions inside these jobs (consolidation accept, decay keep/drop)
 * belong to the Jev layer (lib/gate.mjs) and fail closed. The writing
 * of merged atoms belongs to the router's core-reasoning owner.
 */
import { randomUUID } from 'node:crypto';
import { route } from '../router/router.mjs';
import { decideConsolidation, decideDecayDrop } from './gate.mjs';

// ---- embeddings (local MiniLM — credits are never spent on these) ---------

let embedder = null;
async function getEmbedder() {
  if (!embedder) {
    const { pipeline } = await import('@xenova/transformers');
    embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return embedder;
}

function halfvecLiteral(arr) {
  const parts = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) parts[i] = Number(arr[i]).toFixed(6);
  return '[' + parts.join(',') + ']';
}

export async function embedText(text) {
  const ex = await getEmbedder();
  const out = await ex(text, { pooling: 'mean', normalize: true });
  return halfvecLiteral(Array.from(out.data));
}

/** Embed every live row in a namespace whose embedding is NULL. */
export async function embedStaged(pool, namespace) {
  const { rows } = await pool.query(
    `SELECT id, text FROM memories WHERE namespace = $1 AND approval = 'live' AND embedding IS NULL`,
    [namespace]
  );
  for (const row of rows) {
    const emb = await embedText(row.text);
    await pool.query(
      `UPDATE memories SET embedding = $2::halfvec, index_status = 'indexed' WHERE id = $1`,
      [row.id, emb]
    );
  }
  return rows.length;
}

// ---- Plane 2 rebuild --------------------------------------------------------

/**
 * Wipe the derived index for a namespace (embeddings + index_status)
 * and rebuild it from Plane 1 alone. Returns before/after counts.
 */
export async function rebuildRecallIndex(pool, namespace) {
  const before = await pool.query(
    `SELECT count(*)::int AS live,
            count(*) FILTER (WHERE index_status = 'indexed' AND embedding IS NOT NULL)::int AS indexed
     FROM memories WHERE namespace = $1 AND approval = 'live'`,
    [namespace]
  );
  await pool.query(
    `UPDATE memories SET embedding = NULL, index_status = 'staged'
     WHERE namespace = $1 AND approval = 'live'`,
    [namespace]
  );
  const rebuilt = await embedStaged(pool, namespace);
  const after = await pool.query(
    `SELECT count(*)::int AS live,
            count(*) FILTER (WHERE index_status = 'indexed' AND embedding IS NOT NULL)::int AS indexed
     FROM memories WHERE namespace = $1 AND approval = 'live'`,
    [namespace]
  );
  return { before: before.rows[0], after: after.rows[0], rebuilt };
}

// ---- hybrid recall + receipts -------------------------------------------------

export async function hybridRecallIds(pool, { namespace, query, k = 8 }) {
  let qEmb = null;
  try {
    qEmb = await embedText(query);
  } catch {
    qEmb = null;
  }
  if (qEmb) {
    const r = await pool.query(
      `WITH kw AS (
         SELECT id, row_number() OVER (ORDER BY ts_rank_cd(text_tsv, plainto_tsquery('english', $2)) DESC) AS rnk
         FROM memories
         WHERE namespace = $1 AND approval = 'live'
           AND index_status IN ('indexed','staged')
           AND text_tsv @@ plainto_tsquery('english', $2)
         LIMIT 50
       ),
       vec AS (
         SELECT id, row_number() OVER (ORDER BY embedding <=> $3::halfvec) AS rnk
         FROM memories
         WHERE namespace = $1 AND approval = 'live' AND index_status = 'indexed'
           AND embedding IS NOT NULL
         ORDER BY embedding <=> $3::halfvec
         LIMIT 50
       ),
       fused AS (
         SELECT COALESCE(kw.id, vec.id) AS id,
                COALESCE(1.0/(60+kw.rnk),0) + COALESCE(1.0/(60+vec.rnk),0) AS rrf
         FROM kw FULL OUTER JOIN vec ON kw.id = vec.id
       )
       SELECT id, rrf FROM fused ORDER BY rrf DESC LIMIT $4`,
      [namespace, query, qEmb, k]
    );
    return r.rows.map((x) => ({ id: x.id, rrf: Number(x.rrf) }));
  }
  const r = await pool.query(
    `SELECT id, ts_rank_cd(text_tsv, plainto_tsquery('english', $2)) AS rrf
     FROM memories
     WHERE namespace = $1 AND approval = 'live'
       AND index_status IN ('indexed','staged')
       AND text_tsv @@ plainto_tsquery('english', $2)
     ORDER BY rrf DESC, created_at DESC
     LIMIT $3`,
    [namespace, query, k]
  );
  return r.rows.map((x) => ({ id: x.id, rrf: Number(x.rrf) }));
}

/**
 * The answer threshold for recall (Iteration 5.3, Finding B).
 *
 * Hybrid fusion is RRF with k=60 over two legs, so a record found by
 * ONE leg alone can score at most 1/(60+1) ≈ 0.0164, however well it
 * ranks there. A record both legs agree on scores above that by
 * construction: the demo corpus's real questions top out at
 * 0.0323–0.0328 (both legs at rank 1–2), while the canonical
 * unanswerable question ("what is the wifi password?") tops at
 * 0.0164 — a single-leg nearest neighbour, not an answer
 * (docs/eval-longmem.md records the same behaviour at eval scale:
 * "the vector leg returns nearest neighbours even for unanswerable
 * questions"). The threshold sits between the two: 0.025. A recall
 * whose best fusion score is below it has no answer, and the
 * surfaces must say so instead of dressing near-misses as answers.
 * Candidates with no fusion score (explicit candidate lists) are
 * not judged by this rule.
 */
export const RECALL_ANSWER_MIN_FUSION = 0.025;

/** True when a receipt-bearing result set actually answers: at
 *  least one result carries a fusion score at or above the answer
 *  threshold, or carries no score to judge by. */
export function recallAnswers(results) {
  if (!results.length) return false;
  const scored = results.map((r) => r.rrf).filter((v) => v != null);
  if (!scored.length) return true;
  return Math.max(...scored) >= RECALL_ANSWER_MIN_FUSION;
}

/**
 * Recall with receipts. Candidates come from hybrid recall (or an
 * explicit candidate list, for tests and rerankers). Each candidate is
 * dereferenced against Plane 1: it survives only if the record exists,
 * is live, and carries provenance. Survivors get a receipt; the rest
 * are reported as dropped with the reason.
 */
export async function recallWithReceipts(pool, { namespace, query, k = 8, candidates = null, onRecall = null }) {
  const cands = candidates
    ? candidates.map((id) => ({ id, rrf: null }))
    : await hybridRecallIds(pool, { namespace, query, k });
  const results = [];
  const dropped = [];
  // Receipt honesty (Iteration 5.3, Finding A): a receipt's
  // grounding list is dereferenced too — ids that do not resolve to
  // a stored record are never listed as what a record "rests on",
  // even on records written before the gate learned to count only
  // resolved citations. The candidate rows are fetched first so one
  // batch lookup can resolve every cited id at once.
  const fetched = [];
  for (const cand of cands) {
    const r = await pool.query(
      `SELECT id, namespace, text, type, importance, strength, approval,
              valid_from, valid_to, grounding_ids, provenance, created_at
       FROM memories WHERE id = $1`,
      [cand.id]
    );
    fetched.push({ cand, row: r.rows[0] || null });
  }
  const citedIds = [...new Set(fetched.flatMap(({ row }) => (row && Array.isArray(row.grounding_ids) ? row.grounding_ids : [])))];
  const resolvable = new Set();
  if (citedIds.length) {
    const gr = await pool.query(`SELECT id FROM memories WHERE id = ANY($1)`, [citedIds]);
    for (const g of gr.rows) resolvable.add(g.id);
  }
  for (const { cand, row } of fetched) {
    if (!row) {
      dropped.push({ id: cand.id, why: 'no Plane-1 record' });
      continue;
    }
    if (row.namespace !== namespace) {
      dropped.push({ id: cand.id, why: 'namespace mismatch' });
      continue;
    }
    if (row.approval !== 'live') {
      dropped.push({ id: cand.id, why: `approval=${row.approval}` });
      continue;
    }
    const prov = row.provenance || {};
    if (!prov.author || !prov.origin) {
      dropped.push({ id: cand.id, why: 'provenance missing author/origin' });
      continue;
    }
    results.push({
      id: row.id,
      text: row.text,
      type: row.type,
      importance: row.importance,
      rrf: cand.rrf,
      receipt: {
        memory_id: row.id,
        author: prov.author,
        origin: prov.origin,
        source_session: prov.source_session || null,
        evidence_refs: prov.evidence_refs || [],
        merged_from: prov.merged_from || [],
        grounding_ids: (row.grounding_ids || []).filter((id) => resolvable.has(id)),
        valid_from: row.valid_from,
        valid_to: row.valid_to,
        record_created_at: row.created_at,
      },
    });
    await pool.query(`UPDATE memories SET last_recalled_at = now() WHERE id = $1`, [row.id]);
  }
  // Learning capture (Block 5): the caller may observe the outcome —
  // a hit or a miss — to record it as a learning event. A failing
  // observer never breaks recall.
  if (onRecall) {
    try {
      await onRecall({ namespace, query, results, dropped });
    } catch {
      /* learning capture is best-effort */
    }
  }
  return { results, dropped };
}

// ---- deterministic decay + Jev keep/drop --------------------------------------

const DAY_MS = 86_400_000;

/**
 * Deterministic strength decay: strength *= 0.5^(age/halfLifeDays),
 * where age is measured from last_recalled_at (falling back to
 * created_at) to the supplied `now`. Same state + same `now` = same
 * output, always. Pinned memories never decay.
 *
 * Rows whose decayed strength falls below dropFloor are put to the
 * Jev keep/drop decision (when useJev): drop only on a Jev retire
 * verdict; any Jev failure keeps the memory (fail closed).
 */
export async function applyDecay(pool, { namespace, now = new Date(), halfLifeDays = 30, dropFloor = 1.0, useJev = true } = {}) {
  const nowMs = new Date(now).getTime();
  const { rows } = await pool.query(
    `SELECT id, text, type, pinned, strength, created_at, last_recalled_at
     FROM memories WHERE namespace = $1 AND approval = 'live' AND pinned = false`,
    [namespace]
  );
  let decayed = 0;
  const retired = [];
  const kept = [];
  const decisions = [];
  for (const row of rows) {
    const anchor = new Date(row.last_recalled_at || row.created_at).getTime();
    const ageDays = Math.max(0, (nowMs - anchor) / DAY_MS);
    const newStrength = Math.round(row.strength * Math.pow(0.5, ageDays / halfLifeDays) * 1e6) / 1e6;
    if (Math.abs(newStrength - row.strength) > 1e-9) {
      await pool.query(`UPDATE memories SET strength = $2 WHERE id = $1`, [row.id, newStrength]);
      decayed += 1;
    }
    if (newStrength < dropFloor) {
      if (!useJev) {
        kept.push(row.id);
        continue;
      }
      const d = await decideDecayDrop({
        memory: { ...row, strength: newStrength },
        stats: {
          age_days: Math.round((nowMs - new Date(row.created_at).getTime()) / DAY_MS),
          days_since_recall: row.last_recalled_at
            ? Math.round((nowMs - new Date(row.last_recalled_at).getTime()) / DAY_MS)
            : null,
          recall_count: null,
        },
      });
      decisions.push({ id: row.id, decision: d });
      if (d.drop) {
        await pool.query(
          `UPDATE memories SET approval = 'retired', valid_to = $2 WHERE id = $1`,
          [row.id, new Date(nowMs).toISOString()]
        );
        retired.push(row.id);
      } else {
        kept.push(row.id);
      }
    }
  }
  return { decayed, retired, kept, decisions };
}

// ---- consolidation --------------------------------------------------------------

export function normaliseText(text) {
  return String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Consolidate duplicate groups in a namespace:
 *  1. Group live records by normalised text (duplicates).
 *  2. Jev decides whether each group states one fact (fail closed:
 *     no merge on rejection or backend failure).
 *  3. The router's core-reasoning owner writes the merged atom.
 *  4. The atom is stored as a new Plane-1 record whose provenance
 *     carries merged_from + the Jev score; the originals are marked
 *     superseded_by / merged_into, closed with valid_to, and retired
 *     from current recall (they stay readable via get).
 */
export async function consolidateNamespace(pool, { namespace, now = new Date() } = {}) {
  const { rows } = await pool.query(
    `SELECT id, text, type, scope, importance, grounding_ids, provenance, created_at
     FROM memories WHERE namespace = $1 AND approval = 'live'
     ORDER BY created_at`,
    [namespace]
  );
  const groups = new Map();
  for (const row of rows) {
    const key = normaliseText(row.text);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const merged = [];
  const skipped = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const decision = await decideConsolidation({ records: group });
    if (!decision.accept) {
      skipped.push({ ids: group.map((g) => g.id), reason: decision.reason, decision });
      continue;
    }
    const routed = await route(
      'consolidate',
      { episodes: group.map((g) => ({ id: g.id, text: g.text, created_at: g.created_at })) },
      { synthetic: true, spendClass: 'demo_final' }
    );
    const atom = routed.result?.atoms?.[0];
    if (!atom) {
      skipped.push({ ids: group.map((g) => g.id), reason: 'consolidation writing produced no atom', decision });
      continue;
    }
    const newId = randomUUID();
    const grounding = [...new Set(group.flatMap((g) => g.grounding_ids || []))];
    const provenance = {
      source_session: `consolidation-${Date.now()}`,
      author: 'memoryloom-consolidation',
      origin: 'consolidation',
      created_at: new Date().toISOString(),
      embedding_model: null,
      merged_from: group.map((g) => g.id),
      jev: decision,
      consolidated_by: routed.provider_used,
    };
    await pool.query(
      `INSERT INTO memories (id, namespace, type, scope, text, importance, strength, pinned,
                             index_status, approval, grounding_ids, provenance)
       VALUES ($1,$2,$3,$4,$5,$6,$7,false,'staged','live',$8,$9::jsonb)`,
      [newId, namespace, group[0].type, group[0].scope, atom.text,
       Math.max(...group.map((g) => g.importance)), Math.max(...group.map((g) => g.strength ?? 5)),
       grounding, JSON.stringify(provenance)]
    );
    await pool.query(
      `UPDATE memories SET superseded_by = $2, merged_into = $2, valid_to = $3, approval = 'retired'
       WHERE id = ANY($1)`,
      [group.map((g) => g.id), newId, new Date(now).toISOString()]
    );
    merged.push({ new_id: newId, from: group.map((g) => g.id), written_by: routed.provider_used, decision });
  }
  if (merged.length) await embedStaged(pool, namespace);
  return { groups_found: [...groups.values()].filter((g) => g.length >= 2).length, merged, skipped };
}
