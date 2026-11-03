/**
 * Memory graph layer — a derived, read-only view over Plane 1.
 *
 * Nodes and edges are computed from truth records (the `memories`,
 * `proposals` and `review_items` tables); nothing here writes to the
 * store. The console UI and the demo render from these shapes:
 *
 *   nodes: memory | proposal | agent | source | decision
 *   edges: authored_by, proposed_by, grounded_in, cites_source,
 *          links_to, supersedes, merged_into, derived_from,
 *          decided, promoted_to, contradicts
 *
 * Query helpers:
 *   buildGraph(pool, namespace)         the whole namespace graph
 *   provenanceTrail(pool, memoryId)     why this memory exists and
 *                                       what it rests on
 *   agentNeighbourhood(pool, ns, agent) one agent's activity
 *   supersessionChain(pool, memoryId)   oldest -> newest belief chain
 *   believedAt(pool, namespace, at)     bi-temporal "what did the team
 *                                       believe on date X": a record
 *                                       counts when it was recorded
 *                                       (created_at) on or before X,
 *                                       was valid from on or before X,
 *                                       and its validity had not ended
 *                                       by X (valid_to null or > X).
 */
const MEMORY_COLS = `id, namespace, type, scope, text, importance, strength,
  pinned, approval, index_status, superseded_by, merged_into,
  valid_from, valid_to, last_recalled_at, grounding_ids, links,
  provenance, created_at, updated_at`;

function memoryNode(row) {
  return {
    kind: 'memory',
    id: row.id,
    node_id: `memory:${row.id}`,
    type: row.type,
    approval: row.approval,
    pinned: row.pinned,
    text: row.text,
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    recorded_at: row.created_at,
  };
}

function agentNode(name) {
  return { kind: 'agent', id: name, node_id: `agent:${name}` };
}

function sourceNode(ref) {
  return { kind: 'source', id: ref, node_id: `source:${ref}` };
}

/** Extract every string in a JSON payload that matches a known memory id. */
function payloadMemoryIds(payload, knownIds) {
  const found = [];
  const walk = (v) => {
    if (typeof v === 'string') {
      if (knownIds.has(v) && !found.includes(v)) found.push(v);
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === 'object') {
      Object.values(v).forEach(walk);
    }
  };
  walk(payload);
  return found;
}

async function loadNamespace(pool, namespace) {
  const mem = await pool.query(
    `SELECT ${MEMORY_COLS} FROM memories WHERE namespace = $1 ORDER BY created_at`,
    [namespace]
  );
  const props = await pool.query(
    `SELECT id, namespace, type, scope, text, grounding_ids, provenance,
            route_reason, status, decided_by, decided_at, promoted_id, created_at
     FROM proposals WHERE namespace = $1 ORDER BY created_at`,
    [namespace]
  );
  const reviews = await pool.query(
    `SELECT id, kind, payload, status, created_at, decided_at, decided_by
     FROM review_items ORDER BY created_at`
  );
  return { memories: mem.rows, proposals: props.rows, reviewItems: reviews.rows };
}

/** Build nodes + edges for one namespace from Plane-1 records. */
export function deriveGraph({ memories = [], proposals = [], reviewItems = [] } = {}) {
  const nodes = new Map();
  const edges = [];
  const addNode = (n) => {
    if (!nodes.has(n.node_id)) nodes.set(n.node_id, n);
    return n.node_id;
  };
  const addEdge = (type, from, to, meta = {}) => {
    edges.push({ type, from, to, ...meta });
  };

  const knownIds = new Set(memories.map((m) => m.id));
  for (const row of memories) addNode(memoryNode(row));

  for (const row of memories) {
    const prov = row.provenance || {};
    const me = `memory:${row.id}`;
    if (prov.author) {
      addEdge('authored_by', me, addNode(agentNode(prov.author)));
    }
    for (const gid of row.grounding_ids || []) {
      if (knownIds.has(gid)) addEdge('grounded_in', me, `memory:${gid}`);
    }
    for (const lid of row.links || []) {
      if (knownIds.has(lid)) addEdge('links_to', me, `memory:${lid}`);
    }
    for (const ref of prov.evidence_refs || []) {
      addEdge('cites_source', me, addNode(sourceNode(String(ref))));
    }
    if (row.superseded_by && knownIds.has(row.superseded_by)) {
      // The successor supersedes this record.
      addEdge('supersedes', `memory:${row.superseded_by}`, me);
    }
    if (row.merged_into && knownIds.has(row.merged_into)) {
      addEdge('merged_into', me, `memory:${row.merged_into}`);
    }
    if (Array.isArray(prov.merged_from)) {
      for (const src of prov.merged_from) {
        if (knownIds.has(src)) addEdge('derived_from', me, `memory:${src}`);
      }
    }
    if (prov.origin === 'consolidation' && prov.jev) {
      const d = {
        kind: 'decision',
        id: `jev-consolidation:${row.id}`,
        node_id: `decision:jev-consolidation:${row.id}`,
        backend: prov.jev.backend || 'jev',
        decision: prov.jev.decision || null,
        at: prov.jev.at || null,
      };
      addEdge('decided', addNode(d), me, { decision: d.decision });
    }
  }

  for (const p of proposals) {
    const pn = {
      kind: 'proposal',
      id: p.id,
      node_id: `proposal:${p.id}`,
      type: p.type,
      status: p.status,
      route_reason: p.route_reason,
      text: p.text,
      recorded_at: p.created_at,
    };
    addNode(pn);
    const prov = p.provenance || {};
    if (prov.author) {
      addEdge('proposed_by', pn.node_id, addNode(agentNode(prov.author)));
    }
    for (const gid of p.grounding_ids || []) {
      if (knownIds.has(gid)) addEdge('grounded_in', pn.node_id, `memory:${gid}`);
    }
    if (p.status !== 'pending' || p.decided_by || prov.jev) {
      const d = {
        kind: 'decision',
        id: `proposal:${p.id}`,
        node_id: `decision:proposal:${p.id}`,
        backend: prov.jev ? 'jev' : 'review',
        decision: p.status,
        route_reason: p.route_reason,
        decided_by: p.decided_by || null,
        at: p.decided_at || (prov.jev && prov.jev.at) || null,
      };
      addEdge('decided', addNode(d), pn.node_id, { decision: d.decision });
    }
    if (p.promoted_id && knownIds.has(p.promoted_id)) {
      addEdge('promoted_to', pn.node_id, `memory:${p.promoted_id}`);
    }
  }

  for (const item of reviewItems) {
    if (item.kind !== 'import_contradiction') continue;
    const ids = payloadMemoryIds(item.payload || {}, knownIds);
    for (let i = 0; i + 1 < ids.length; i++) {
      addEdge('contradicts', `memory:${ids[i]}`, `memory:${ids[i + 1]}`, {
        review_item: item.id,
        status: item.status,
      });
    }
  }

  return { nodes: [...nodes.values()], edges };
}

/** The full graph for a namespace. */
export async function buildGraph(pool, namespace) {
  const data = await loadNamespace(pool, namespace);
  const graph = deriveGraph(data);
  const counts = {};
  for (const n of graph.nodes) counts[n.kind] = (counts[n.kind] || 0) + 1;
  return { namespace, counts, ...graph };
}

/**
 * Provenance trail for one memory: the record itself, who authored
 * it, the sources it cites, its grounding chain (dereferenced one
 * level, receipt style), what it was derived from, what superseded
 * it, and every decision that touched it.
 */
export async function provenanceTrail(pool, memoryId) {
  const r = await pool.query(`SELECT ${MEMORY_COLS} FROM memories WHERE id = $1`, [memoryId]);
  const row = r.rows[0];
  if (!row) return null;
  const prov = row.provenance || {};
  const grounding = [];
  for (const gid of row.grounding_ids || []) {
    const g = await pool.query(
      `SELECT id, text, approval, provenance, valid_from, valid_to FROM memories WHERE id = $1`,
      [gid]
    );
    if (g.rows[0]) {
      grounding.push({
        id: g.rows[0].id,
        text: g.rows[0].text,
        approval: g.rows[0].approval,
        author: g.rows[0].provenance?.author || null,
        valid_from: g.rows[0].valid_from,
        valid_to: g.rows[0].valid_to,
      });
    }
  }
  const derivedFrom = [];
  for (const src of prov.merged_from || []) {
    const s = await pool.query(`SELECT id, text, approval FROM memories WHERE id = $1`, [src]);
    if (s.rows[0]) derivedFrom.push(s.rows[0]);
  }
  let successor = null;
  if (row.superseded_by) {
    const s = await pool.query(`SELECT id, text, approval FROM memories WHERE id = $1`, [row.superseded_by]);
    successor = s.rows[0] || null;
  }
  const decisions = [];
  if (prov.jev) {
    decisions.push({ kind: 'consolidation', ...prov.jev });
  }
  if (prov.promoted_from) {
    decisions.push({
      kind: 'promotion',
      proposal_id: prov.promoted_from,
      decided_by: prov.decided_by || null,
      note: prov.decision_note || null,
    });
  }
  const prop = await pool.query(
    `SELECT id, status, route_reason, decided_by, decided_at FROM proposals WHERE promoted_id = $1`,
    [memoryId]
  );
  for (const p of prop.rows) {
    decisions.push({ kind: 'gate', proposal_id: p.id, status: p.status, route_reason: p.route_reason, decided_by: p.decided_by, at: p.decided_at });
  }
  return {
    memory: memoryNode(row),
    provenance: prov,
    author: prov.author || null,
    origin: prov.origin || null,
    sources: prov.evidence_refs || [],
    grounding,
    derived_from: derivedFrom,
    superseded_by: successor,
    decisions,
  };
}

/** One agent's neighbourhood: its memories, proposals, and the edges among them. */
export async function agentNeighbourhood(pool, namespace, agentId) {
  const data = await loadNamespace(pool, namespace);
  const graph = deriveGraph(data);
  const me = `agent:${agentId}`;
  if (!graph.nodes.some((n) => n.node_id === me)) {
    return { agent: agentId, found: false, nodes: [], edges: [], counts: { memories: 0, proposals: 0 } };
  }
  const keep = new Set([me]);
  for (const e of graph.edges) {
    if (e.from === me) keep.add(e.to);
    if (e.to === me) keep.add(e.from);
  }
  // One more hop: grounding / supersession neighbours of the agent's memories.
  for (const e of graph.edges) {
    if (keep.has(e.from) && e.from.startsWith('memory:')) keep.add(e.to);
    if (keep.has(e.to) && e.to.startsWith('memory:')) keep.add(e.from);
  }
  const nodes = graph.nodes.filter((n) => keep.has(n.node_id));
  const edges = graph.edges.filter((e) => keep.has(e.from) && keep.has(e.to));
  return {
    agent: agentId,
    found: true,
    nodes,
    edges,
    counts: {
      memories: nodes.filter((n) => n.kind === 'memory').length,
      proposals: nodes.filter((n) => n.kind === 'proposal').length,
    },
  };
}

/**
 * Supersession chain containing a memory, ordered oldest -> newest.
 * Walks superseded_by forward and the reverse links backward, and
 * follows merged_into at the tail (a consolidation atom continues
 * the chain).
 */
export async function supersessionChain(pool, memoryId) {
  const get = async (id) => {
    const r = await pool.query(
      `SELECT id, text, approval, valid_from, valid_to, superseded_by, merged_into, created_at
       FROM memories WHERE id = $1`,
      [id]
    );
    return r.rows[0] || null;
  };
  const start = await get(memoryId);
  if (!start) return null;
  // Backward: a record's superseded_by points at its successor, so
  // predecessors are the rows whose superseded_by points at this one.
  const chain = [start];
  let cursor = start;
  const seen = new Set([start.id]);
  for (;;) {
    const r = await pool.query(
      `SELECT id, text, approval, valid_from, valid_to, superseded_by, merged_into, created_at
       FROM memories WHERE superseded_by = $1 ORDER BY created_at LIMIT 1`,
      [cursor.id]
    );
    const prev = r.rows[0];
    if (!prev || seen.has(prev.id)) break;
    chain.unshift(prev);
    seen.add(prev.id);
    cursor = prev;
  }
  // Forward: follow superseded_by, then merged_into.
  cursor = start;
  for (;;) {
    const nextId = cursor.superseded_by || cursor.merged_into;
    if (!nextId || seen.has(nextId)) break;
    const nxt = await get(nextId);
    if (!nxt) break;
    chain.push(nxt);
    seen.add(nxt.id);
    cursor = nxt;
  }
  return chain.map((row) => ({
    id: row.id,
    text: row.text,
    approval: row.approval,
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    recorded_at: row.created_at,
  }));
}

/**
 * Bi-temporal belief query: which records did the team hold at
 * instant `at`? A record counts when it was already recorded
 * (created_at <= at), its validity had begun (valid_from <= at) and
 * had not ended (valid_to is null or > at). Approval state is
 * reported as it stands now; validity is what answers the question.
 */
export async function believedAt(pool, namespace, at) {
  const when = new Date(at).toISOString();
  const r = await pool.query(
    `SELECT ${MEMORY_COLS} FROM memories
     WHERE namespace = $1 AND created_at <= $2::timestamptz
       AND valid_from <= $2::timestamptz
       AND (valid_to IS NULL OR valid_to > $2::timestamptz)
     ORDER BY created_at`,
    [namespace, when]
  );
  // Receipt grounding (card S5): the believed at rows feed the
  // receipt on the landing panel and in time travel, and a receipt
  // names only records that resolve in the store. The cited ids are
  // dereferenced in one batch lookup, the same discipline the
  // recall receipt path applies in lib/planes.mjs, so an unresolved
  // citation id never reaches a receipt line as grounding.
  const citedIds = [...new Set(r.rows.flatMap((row) => (Array.isArray(row.grounding_ids) ? row.grounding_ids : [])))];
  const resolvable = new Set();
  if (citedIds.length) {
    const gr = await pool.query(`SELECT id FROM memories WHERE id = ANY($1)`, [citedIds]);
    for (const g of gr.rows) resolvable.add(g.id);
  }
  return r.rows.map((row) => ({
    ...memoryNode(row),
    author: row.provenance?.author || null,
    origin: row.provenance?.origin || null,
    grounding_ids: (Array.isArray(row.grounding_ids) ? row.grounding_ids : []).filter((id) => resolvable.has(id)),
  }));
}
