/**
 * MemoryLoom console + site API.
 *
 * One request handler shared by the local server (web/server.mjs) and
 * the Vercel function (api/index.mjs). Every read renders from the
 * real backend libraries (lib/graph.mjs, lib/planes.mjs,
 * lib/learning.mjs, lib/curator-decide.mjs) against ONE configured
 * namespace — the synthetic demo namespace by default. The console
 * never decides anything itself: new proposals go through the Jev
 * gate (lib/gate.mjs decideGate, fail closed), and human decisions
 * on escalations go through the curator helpers, exactly like the
 * MCP surface.
 */
import { randomUUID } from 'node:crypto';
import { buildGraph, provenanceTrail, agentNeighbourhood, supersessionChain, believedAt } from '../lib/graph.mjs';
import { recallWithReceipts, embedStaged } from '../lib/planes.mjs';
import { decideGate } from '../lib/gate.mjs';
import { reviewList, promoteProposal, rejectProposal } from '../lib/curator-decide.mjs';
import { recordEvent, listEvents } from '../lib/learning.mjs';
import { listDaemonRuns } from '../lib/daemon.mjs';
import { readSpendLog, routerConfig } from '../router/spend.mjs';
import { maskedSettings, providerDef, removeProviderKey, saveProviderKey, testProvider } from '../lib/config.mjs';

const HUMAN = 'human (console)';

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function hostOf(value) {
  return String(value || '').trim().toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
}

/**
 * Settings mutations and provider tests are LOCAL ONLY.
 *
 * Choice (Iteration 1.1): a mutating or test request is accepted
 * only when (a) the deployment marker VERCEL is absent — a hosted
 * deployment can never mutate settings, even if a header is forged —
 * and (b) the request's Host is a loopback host, and (c) when an
 * Origin header is present, its host is loopback too. The Host
 * check is what the browser the user actually runs sends for the
 * local app (http://localhost:<port>), so the Settings screen works
 * locally while the public deployment answers 403. The masked GET
 * view stays readable anywhere: it exposes only last-4 tails.
 */
function isLocalRequest(req) {
  if (process.env.VERCEL) return false;
  if (!LOCAL_HOSTS.has(hostOf(req.headers.host))) return false;
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (!LOCAL_HOSTS.has(new URL(origin).hostname.toLowerCase())) return false;
    } catch {
      return false;
    }
  }
  return true;
}

const LOCAL_ONLY = { status: 403, payload: { error: 'settings can only be changed from the local app' } };

export function createHandler({ pool, namespace }) {
  if (!pool) throw new Error('createHandler needs a pg pool');
  if (!namespace) throw new Error('createHandler needs a namespace');

  async function overview() {
    const [mem, prop, ev, lessons] = await Promise.all([
      pool.query(
        `SELECT type, approval, count(*)::int AS n FROM memories WHERE namespace = $1 GROUP BY type, approval`,
        [namespace]
      ),
      pool.query(
        `SELECT status, count(*)::int AS n FROM proposals WHERE namespace = $1 GROUP BY status`,
        [namespace]
      ),
      pool.query(`SELECT count(*)::int AS n FROM learning_events WHERE namespace = $1`, [namespace]),
      pool.query(
        `SELECT count(*)::int AS n FROM memories WHERE namespace = $1 AND provenance->>'origin' = 'learning-promotion'`,
        [namespace]
      ),
    ]);
    const range = await pool.query(
      `SELECT min(created_at) AS first, max(created_at) AS last FROM memories WHERE namespace = $1`,
      [namespace]
    );
    const agents = await pool.query(
      `SELECT DISTINCT provenance->>'author' AS author FROM memories
       WHERE namespace = $1 AND provenance->>'author' IS NOT NULL ORDER BY 1`,
      [namespace]
    );
    return {
      namespace,
      memories_by_type: mem.rows,
      proposals_by_status: prop.rows,
      learning_events: ev.rows[0].n,
      lessons: lessons.rows[0].n,
      agents: agents.rows.map((r) => r.author),
      first_recorded_at: range.rows[0].first,
      last_recorded_at: range.rows[0].last,
    };
  }

  async function proposals() {
    const r = await pool.query(
      `SELECT id, type, scope, text, grounding_ids, provenance, route_reason,
              status, decided_by, decided_at, promoted_id, created_at
       FROM proposals WHERE namespace = $1 ORDER BY (status = 'pending') DESC, created_at`,
      [namespace]
    );
    const review = await reviewList(pool, { status: 'pending' });
    const daemonItems = (review.review_items || []).filter(
      (i) => (i.payload?.namespace ?? namespace) === namespace || i.payload?.namespace === undefined
    );
    const runs = await listDaemonRuns(pool, 5).catch(() => []);
    return { proposals: r.rows, daemon_review_items: daemonItems, daemon_runs: runs };
  }

  async function memories() {
    const r = await pool.query(
      `SELECT id, type, scope, text, importance, strength, pinned, approval,
              index_status, superseded_by, merged_into, valid_from, valid_to,
              grounding_ids, provenance, created_at, last_recalled_at
       FROM memories WHERE namespace = $1 ORDER BY created_at`,
      [namespace]
    );
    return { memories: r.rows };
  }

  async function propose(body) {
    const text = String(body.text || '').trim();
    const author = String(body.author || 'grok').slice(0, 40);
    const type = ['episodic', 'semantic', 'procedural'].includes(body.type) ? body.type : 'semantic';
    const grounding_ids = Array.isArray(body.grounding_ids) ? body.grounding_ids.slice(0, 10) : [];
    if (!text) return { status: 400, payload: { error: 'text is required' } };
    let evidence = [];
    if (grounding_ids.length) {
      const er = await pool.query('SELECT id, text FROM memories WHERE id = ANY($1)', [grounding_ids]);
      evidence = er.rows;
    }
    // The Jev gate decides. Fail closed: a backend failure escalates.
    const d = await decideGate({ proposal: { text, type, scope: 'global', grounding_ids }, evidence });
    if (d.decision === 'approve') {
      const id = randomUUID();
      const provenance = {
        source_session: `console-${Date.now()}`,
        author, origin: 'propose-jev', created_at: new Date().toISOString(), embedding_model: null,
      };
      await pool.query(
        `INSERT INTO memories (id, namespace, type, scope, text, importance, strength, pinned,
                               index_status, approval, grounding_ids, provenance)
         VALUES ($1,$2,$3,'global',$4,5,5.0,false,'staged','live',$5,$6::jsonb)`,
        [id, namespace, type, text, grounding_ids, JSON.stringify(provenance)]
      );
      await embedStaged(pool, namespace);
      await recordEvent(pool, {
        namespace, kind: 'proposal', actor: author, subject_type: 'memory', subject_id: id,
        summary: `Proposal approved by the Jev gate: ${text.slice(0, 200)}`, evidence: { tool: 'console-propose' },
      });
      await recordEvent(pool, {
        namespace, kind: 'gate_verdict', actor: 'jev', subject_type: 'memory', subject_id: id,
        summary: `Gate verdict: approve (${d.reason}).`, evidence: { decision: d },
      });
      return { status: 200, payload: { decision: 'auto_approved', reason: d.reason, backend: d.backend, id } };
    }
    if (d.decision === 'reject') {
      await recordEvent(pool, {
        namespace, kind: 'gate_verdict', actor: 'jev', subject_type: 'proposal', subject_id: null,
        summary: `Gate verdict: reject (${d.reason}).`, evidence: { decision: d, text: text.slice(0, 200) },
      });
      return { status: 200, payload: { decision: 'rejected', reason: d.reason, backend: d.backend } };
    }
    const id = randomUUID();
    const route_reason = d.failed ? 'jev-unavailable-fail-closed' : 'jev-escalate';
    const provenance = {
      source_session: `console-${Date.now()}`,
      author, origin: 'propose', created_at: new Date().toISOString(), embedding_model: null, jev: d,
    };
    await pool.query(
      `INSERT INTO proposals (id, namespace, type, scope, text, importance, strength, pinned,
                              grounding_ids, provenance, route_reason)
       VALUES ($1,$2,$3,'global',$4,5,5.0,false,$5,$6::jsonb,$7)`,
      [id, namespace, type, text, grounding_ids, JSON.stringify(provenance), route_reason]
    );
    await recordEvent(pool, {
      namespace, kind: 'proposal', actor: author, subject_type: 'proposal', subject_id: id,
      summary: `Proposal queued for review (${route_reason}): ${text.slice(0, 200)}`,
      evidence: { tool: 'console-propose', route_reason },
    });
    await recordEvent(pool, {
      namespace, kind: 'gate_verdict', actor: 'jev', subject_type: 'proposal', subject_id: id,
      summary: `Gate verdict: escalate (${route_reason}).`, evidence: { decision: d },
    });
    return { status: 200, payload: { decision: 'queued_for_review', reason: route_reason, backend: d.backend, proposal_id: id } };
  }

  async function decide(id, body) {
    const decision = body.decision === 'approve' ? 'approve' : body.decision === 'reject' ? 'reject' : null;
    if (!decision) return { status: 400, payload: { error: 'decision must be approve or reject' } };
    const opts = { proposal_id: id, decided_by: HUMAN, note: body.note ? String(body.note).slice(0, 300) : undefined };
    const r = decision === 'approve' ? await promoteProposal(pool, opts) : await rejectProposal(pool, opts);
    if (r.status !== 'ok') return { status: 409, payload: r };
    await embedStaged(pool, namespace).catch(() => {});
    await recordEvent(pool, {
      namespace,
      kind: decision === 'approve' ? 'human_approval' : 'human_rejection',
      actor: HUMAN, subject_type: 'proposal', subject_id: id,
      summary: `Human ${decision === 'approve' ? 'approved' : 'rejected'} proposal ${id} in the console.`,
      evidence: { decision, promoted_id: r.memory_id || r.promoted_id || null },
    }).catch(() => {});
    return { status: 200, payload: r };
  }

  async function recall(url) {
    const q = url.searchParams.get('q') || '';
    const k = Math.min(20, Math.max(1, Number(url.searchParams.get('k') || 8)));
    if (!q.trim()) return { status: 400, payload: { error: 'q is required' } };
    const out = await recallWithReceipts(pool, { namespace, query: q, k });
    await recordEvent(pool, {
      namespace,
      kind: out.results.length ? 'recall_hit' : 'recall_miss',
      actor: 'console', subject_type: 'query', subject_id: null,
      summary: `Console recall "${q.slice(0, 120)}" returned ${out.results.length} receipts, ${out.dropped.length} dropped.`,
      evidence: { query: q, hits: out.results.map((r) => r.id), dropped: out.dropped },
    }).catch(() => {});
    return { status: 200, payload: out };
  }

  async function learning(url) {
    const kind = url.searchParams.get('kind');
    const events = await listEvents(pool, { namespace, kind: kind || null, limit: 300 });
    const lessonRows = await pool.query(
      `SELECT id, text, provenance, created_at FROM memories
       WHERE namespace = $1 AND provenance->>'origin' = 'learning-promotion' ORDER BY created_at`,
      [namespace]
    );
    // Read-only form of the lesson audit: a lesson-shaped record whose
    // provenance carries no Jev promote verdict is forged. (The
    // mutating audit that retires such records is lib/learning.mjs
    // auditLessons; the console only displays the finding.)
    const forged = lessonRows.rows
      .filter((r) => !r.provenance?.jev || r.provenance.jev.promote !== true)
      .map((r) => r.id);
    const audit = { forged_lesson_ids: forged, checked: lessonRows.rows.length };
    // Before/after evidence: the gate verdicts on the seeded task class.
    const verdicts = events
      .filter((e) => e.kind === 'gate_verdict' && e.subject_id === 'lodge-global-claim')
      .map((e) => ({ at: e.created_at, actor: e.actor, summary: e.summary, decision: e.evidence?.decision || null }));
    const taskEvents = events.filter((e) => e.subject_id === 'lodge-global-claim');
    return {
      events,
      lessons: lessonRows.rows.map((r) => ({
        id: r.id, text: r.text, created_at: r.created_at,
        learning_event_id: r.provenance?.learning_event_id || null,
        jev: r.provenance?.jev || null,
      })),
      audit,
      before_after: { task: 'lodge-global-claim', events: taskEvents, verdicts },
    };
  }

  async function spend() {
    const rows = readSpendLog();
    const byKey = new Map();
    for (const r of rows) {
      const key = `${r.provider} · ${r.model || '—'} · ${r.tier || '—'} · ${r.task || '—'} (${r.spend_class || '—'})`;
      const cur = byKey.get(key) || { key, provider: r.provider, model: r.model, tier: r.tier || null, task: r.task || null, spend_class: r.spend_class || null, calls: 0, cached: 0, input_tokens: 0, output_tokens: 0, est_cost_usd: 0 };
      if (r.cached) cur.cached += 1;
      else {
        cur.calls += 1;
        cur.input_tokens += r.input_tokens || 0;
        cur.output_tokens += r.output_tokens || 0;
        cur.est_cost_usd = Math.round((cur.est_cost_usd + (r.est_cost_usd || 0)) * 1e6) / 1e6;
      }
      byKey.set(key, cur);
    }
    const jev = await pool.query(
      `SELECT count(*)::int AS decisions FROM learning_events
       WHERE namespace = $1 AND kind = 'gate_verdict' AND actor = 'jev'`,
      [namespace]
    );
    // Per-memory provider work that actually happened: the Jev verdict
    // behind a memory (gate_verdict event) and any router narration
    // recorded in provenance. Only providers that did work appear.
    const work = await pool.query(
      `SELECT e.subject_id AS memory_id, e.evidence->'decision' AS decision, e.created_at
       FROM learning_events e
       WHERE e.namespace = $1 AND e.kind = 'gate_verdict' AND e.subject_type = 'memory'`,
      [namespace]
    );
    return {
      router: [...byKey.values()],
      budgets_usd: routerConfig().budgets_usd || {},
      jev_decisions_in_namespace: jev.rows[0].decisions,
      per_memory: work.rows.map((r) => ({
        memory_id: r.memory_id,
        provider: 'jev',
        work: 'write-gate verdict',
        decision: r.decision,
        at: r.created_at,
      })),
    };
  }

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      if (req.method === 'GET' && p === '/api/overview') return json(res, 200, await overview());
      if (req.method === 'GET' && p === '/api/graph') return json(res, 200, await buildGraph(pool, namespace));
      if (req.method === 'GET' && p === '/api/memories') return json(res, 200, await memories());
      if (req.method === 'GET' && p === '/api/proposals') return json(res, 200, await proposals());
      if (req.method === 'GET' && p === '/api/recall') { const r = await recall(url); return json(res, r.status, r.payload); }
      if (req.method === 'GET' && p === '/api/learning') return json(res, 200, await learning(url));
      if (req.method === 'GET' && p === '/api/spend') return json(res, 200, await spend());
      if (req.method === 'GET' && p === '/api/believed') {
        const at = url.searchParams.get('at');
        if (!at) return json(res, 400, { error: 'at is required (ISO date)' });
        return json(res, 200, await believedAt(pool, namespace, new Date(at)));
      }
      let m;
      if (req.method === 'GET' && (m = p.match(/^\/api\/trail\/(.+)$/))) return json(res, 200, await provenanceTrail(pool, decodeURIComponent(m[1])));
      if (req.method === 'GET' && (m = p.match(/^\/api\/chain\/(.+)$/))) return json(res, 200, await supersessionChain(pool, decodeURIComponent(m[1])));
      if (req.method === 'GET' && (m = p.match(/^\/api\/neighbourhood\/(.+)$/))) return json(res, 200, await agentNeighbourhood(pool, namespace, decodeURIComponent(m[1])));
      // Settings: masked view for everyone; save / remove / test are
      // local-only (see isLocalRequest). None of these touch the
      // database pool or the namespace — provider keys are app-level.
      if (req.method === 'GET' && p === '/api/settings') return json(res, 200, { providers: maskedSettings() });
      if ((m = p.match(/^\/api\/settings\/([a-z_]+)$/)) && (req.method === 'POST' || req.method === 'DELETE')) {
        if (!providerDef(m[1])) return json(res, 400, { error: 'unknown provider' });
        if (!isLocalRequest(req)) return json(res, LOCAL_ONLY.status, LOCAL_ONLY.payload);
        if (req.method === 'DELETE') { const r = removeProviderKey(m[1]); return json(res, r.status, r.payload); }
        const body = await readBody(req).catch(() => ({}));
        const r = saveProviderKey(m[1], body.api_key ?? body.key);
        return json(res, r.status, r.payload);
      }
      if (req.method === 'POST' && (m = p.match(/^\/api\/settings\/([a-z_]+)\/test$/))) {
        if (!providerDef(m[1])) return json(res, 400, { error: 'unknown provider' });
        if (!isLocalRequest(req)) return json(res, LOCAL_ONLY.status, LOCAL_ONLY.payload);
        const body = await readBody(req).catch(() => ({}));
        const r = await testProvider(m[1], { candidateKey: body.api_key ?? body.key ?? null });
        return json(res, 200, r);
      }
      if (req.method === 'POST' && p === '/api/propose') { const r = await propose(await readBody(req)); return json(res, r.status, r.payload); }
      if (req.method === 'POST' && (m = p.match(/^\/api\/proposals\/(.+)\/decide$/))) { const r = await decide(decodeURIComponent(m[1]), await readBody(req)); return json(res, r.status, r.payload); }
      return json(res, 404, { error: 'not found', path: p });
    } catch (e) {
      return json(res, 500, { error: String(e.message || e) });
    }
  };
}
