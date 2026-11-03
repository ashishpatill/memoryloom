#!/usr/bin/env node
/* Stub providers for the MemoryLoom green baseline (card S2).
 *
 * Owning file: checks/stub-server-v1.mjs
 * Accountable layer: AI layer test support
 * Provider need: none, this file is the stub the stub mode suites
 *   run against.
 *
 * Two local servers with deterministic policies, so a suite that
 * needs a gate decision or a model shaped answer without live
 * judgement can run in stub mode. A verdict from this server is a
 * stub decision. It proves the path, the state and the rendering.
 * It never proves live provider judgement.
 *
 *   Jev stub on port 4711. POST /v1/systemone answers each noul
 *     question from the state the product builds, under this
 *     policy. Approve grounded or episodic records, send
 *     procedural, pinned and unsupported records to a human,
 *     reject gibberish. Retire for decay only when a record is
 *     stale, weak, rarely recalled and unpinned. Promote only
 *     when a lesson is verified and applied. Consolidate only
 *     when the records state the same fact. GET /v1/models serves
 *     the Settings probe.
 *   Meta stub on port 4712. POST /v1/responses and
 *     /v1/chat/completions return one JSON text carrying every
 *     task shape the router parses, with ids harvested from the
 *     prompt. GET /v1/models serves the Settings probe.
 *
 * All spend against these stubs is synthetic by construction.
 * Run with node checks/stub-server-v1.mjs. JEV_STUB_PORT and
 * META_STUB_PORT override the ports. The verify entry starts and
 * stops this server itself for stub mode suites.
 */
import { createServer } from 'node:http';

const words = (s) => new Set(String(s || '').toLowerCase().match(/[a-z0-9]+/g) || []);
const overlapRatio = (a, b) => {
  const A = words(a), B = words(b);
  if (!A.size) return 0;
  let hit = 0;
  for (const w of A) if (w.length > 3 && B.has(w)) hit++;
  const sig = [...A].filter((w) => w.length > 3).length;
  return sig ? hit / sig : 0;
};
function stateJson(state) {
  const line = String(state).split('\n').find((l) => l.trim().startsWith('{'));
  try { return line ? JSON.parse(line) : null; } catch { return null; }
}
function gibberish(text) {
  const t = String(text || '').trim();
  if (t.length < 3) return true;
  const letters = t.replace(/[^a-z]/gi, '');
  if (!letters.length) return true;
  const vowels = (letters.match(/[aeiou]/gi) || []).length;
  return vowels / letters.length < 0.14;
}

function jevAnswers(state, questions) {
  const j = stateJson(state) || {};
  const out = {};
  for (const name of Object.keys(questions || {})) {
    if (name === 'policy_approve') {
      const evText = String(state).split('Grounding evidence records:')[1] || '';
      const resolved = Array.isArray(j.grounding_ids) ? j.grounding_ids.length : 0;
      const supported = overlapRatio(j.text, evText) >= 0.45;
      out[name] = j.type === 'episodic' ? 0.97 : (resolved >= 1 && supported ? 0.97 : 0.03);
    } else if (name === 'policy_human') {
      const evText = String(state).split('Grounding evidence records:')[1] || '';
      const resolved = Array.isArray(j.grounding_ids) ? j.grounding_ids.length : 0;
      const supported = overlapRatio(j.text, evText) >= 0.45;
      out[name] = (j.type === 'procedural' || j.pinned) ? 0.97 : (resolved >= 1 && supported ? 0.05 : 0.9);
    } else if (name === 'meaningless') {
      out[name] = gibberish(j.text) ? 0.97 : 0.02;
    } else if (name === 'retire') {
      const stale = (j.age_days ?? 0) >= 30 && (j.days_since_recall ?? 0) >= 30;
      const weak = (j.strength ?? 1) <= 0.3 && (j.recall_count ?? 99) <= 1;
      out[name] = stale && weak && !j.pinned ? 0.95 : 0.02;
    } else if (name === 'promote') {
      out[name] = j.verified && (j.times_applied ?? 0) >= 1 ? 0.95 : 0.03;
    } else if (name === 'same_fact') {
      const recs = String(state).split('\n').filter((l) => /^\[[^\]]+\]/.test(l)).map((l) => l.replace(/^\[[^\]]+\]\s*/, ''));
      let same = recs.length >= 2;
      for (let i = 0; i < recs.length && same; i++)
        for (let k = i + 1; k < recs.length; k++)
          if (overlapRatio(recs[i], recs[k]) < 0.6 && overlapRatio(recs[k], recs[i]) < 0.6) same = false;
      out[name] = same ? 0.95 : 0.03;
    } else {
      out[name] = 0.02;
    }
  }
  // The real provider returns each answer as an object carrying
  // its noul score, and the Jev client in lib/jev.mjs validates
  // that shape. The stub answers in the same shape. A plain number
  // here is malformed to the client and fails closed, which the
  // card S2 investigation recorded as a harness fault in the stub.
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { noul: v }]));
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}
function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

const jev = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/v1/models')) return json(res, 200, { data: [{ id: 'jev-1.13.0' }] });
  if (req.method === 'POST' && req.url.startsWith('/v1/systemone')) {
    const body = await readBody(req);
    return json(res, 200, { answers: jevAnswers(body.state || '', body.questions || {}) });
  }
  return json(res, 404, { error: 'not found' });
});

function metaText(body) {
  const raw = JSON.stringify(body || {});
  const ids = [...new Set(raw.match(/demo-[a-z0-9-]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || [])];
  return JSON.stringify({
    narration: 'The records provided answer the question directly.' + (ids.length ? ' The answer rests on ' + ids.slice(0, 3).join(', ') + '.' : ''),
    receipts: ids,
    explanation: 'The two records disagree, and the later record supersedes the earlier one.' + (ids.length ? ' Records involved: ' + ids.slice(0, 3).join(', ') + '.' : ''),
    cites: ids.slice(0, 3),
    score: 1,
    verdict: 'supported',
    notes: 'stub verdict',
    labels: [],
    atoms: [],
  });
}
const meta = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/v1/models')) return json(res, 200, { data: [{ id: 'muse-wonder-1.0' }] });
  if (req.method === 'POST' && req.url.startsWith('/v1/responses')) {
    const body = await readBody(req);
    const text = metaText(body);
    return json(res, 200, {
      id: 'stub-resp', model: 'muse-wonder-1.0', output_text: text,
      output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
      usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
    });
  }
  if (req.method === 'POST' && req.url.startsWith('/v1/chat/completions')) {
    const body = await readBody(req);
    return json(res, 200, {
      id: 'stub-chat', model: 'muse-wonder-1.0',
      choices: [{ message: { role: 'assistant', content: metaText(body) } }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    });
  }
  return json(res, 404, { error: 'not found' });
});

const jp = Number(process.env.JEV_STUB_PORT || 4711);
const mp = Number(process.env.META_STUB_PORT || 4712);
jev.listen(jp, '127.0.0.1', () => console.log('jev stub on', jp));
meta.listen(mp, '127.0.0.1', () => console.log('meta stub on', mp));
