/**
 * Weave D1 browser check — the knot layout rule on the running app.
 *
 * Card S4 of the frozen master plan. Drives the real landing page
 * and the real console graph through the committed capture driver
 * (checks/capture-driver-v1.mjs, the Playwright headless shell over
 * CDP route) and measures the FINAL RENDERED geometry after fonts
 * load and after the figure settles, at 1280px and at 360px, in two
 * data states: the seeded corpus, and the same corpus after eight
 * fixture records gather at the latest date (the same day
 * accumulation case, timed knots growing from the seeded count by
 * eight). It never measures a proxy structure: every number below
 * comes from rendered text boxes and knot centres in the page.
 *
 * The assertions, per surface per width per state:
 *   - every figure label (knot, source, agent, date tick, break and
 *     playhead labels) sits inside the figure frame;
 *   - no two labels overlap or touch (a one pixel moat at render);
 *   - neighbouring knots on one thread keep the recorded minimum
 *     separation of 19 figure units;
 *   - date ticks render one per distinct date with a readable
 *     separation between neighbouring tick centres;
 *   - the page itself does not overflow sideways.
 *
 * Owning file: checks/weave-d1.mjs
 * Accountable layer: Browser layer
 * Provider need: None. The suite seeds keyless, so the corpus and
 *   the graph are fully seeded and the learning story stands in its
 *   keyless state, exactly as the seed records it.
 * Declared mode: Keyless
 *
 * Standalone run conditions: DATABASE_URL at a fresh throwaway
 * database already initialised by scripts/init-db.mjs, and
 * MEMORYLOOM_SETTINGS_FILE at a temporary empty settings store.
 * The verify entry provides both.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { preflightOrExit } from './db-preflight.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL missing'); process.exit(1); }
preflightOrExit();

let failures = 0;
function assert(cond, label, extra = '') {
  if (cond) console.log(`  PASS ${label}`);
  else { failures++; console.log(`  FAIL ${label} ${extra}`); }
}
function info(label) { console.log(`  info ${label}`); }
const run = (cmd, args, env = {}) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${out.slice(-400)}`))));
});

// Seed through the documented path. Keyless: the corpus, the graph,
// recall and time travel seed in full; the learning story records
// its keyless state with its notice, which is the declared mode
// working as designed, not a failure of this suite.
await run(process.execPath, ['scripts/seed-web-demo.mjs'], { DATABASE_URL });

const PORT = 4300 + Math.floor(Math.random() * 400);
const server = spawn(process.execPath, ['web/server.mjs'], {
  cwd: root,
  env: { ...process.env, DATABASE_URL, WEB_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const base = `http://127.0.0.1:${PORT}`;
async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(base + '/api/overview'); if (r.ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server did not come up');
}
await waitUp();

// The measurement probe. It waits for the figure, settles the weave,
// waits for fonts, then returns the rendered geometry of every text
// and every knot centre in the figure, in page pixels, together with
// the figure box and its viewBox so the suite can speak in figure
// units. It reads the artefact a person sees, nothing else.
const PROBE = `(async () => {
  const svgSel = '#heroGraph, #graphSvg';
  let svg = null;
  for (let i = 0; i < 60 && !svg; i++) {
    svg = document.querySelector(svgSel);
    if (svg && svg.querySelectorAll('text').length < 10) svg = null;
    if (!svg) await new Promise(r => setTimeout(r, 200));
  }
  if (!svg) return { error: 'graph svg never rendered' };
  if (window.__weaveCtl && window.__weaveCtl.settle) window.__weaveCtl.settle();
  await document.fonts.ready;
  await new Promise(r => setTimeout(r, 120));
  const sr = svg.getBoundingClientRect();
  const vb = (svg.getAttribute('viewBox') || '0 0 720 372').split(/\\s+/).map(Number);
  const T = (t) => { const r = t.getBoundingClientRect(); return { text: t.textContent, cls: t.getAttribute('class') || '', x: r.x, y: r.y, w: r.width, h: r.height }; };
  const grouped = new Set(svg.querySelectorAll('g[data-kind] text'));
  const groups = [...svg.querySelectorAll('g[data-kind]')].map(g => {
    const shape = g.querySelector('circle, rect');
    let cx = null, cy = null;
    if (shape) { const r = shape.getBoundingClientRect(); cx = r.x + r.width / 2; cy = r.y + r.height / 2; }
    return { kind: g.getAttribute('data-kind'), cx, cy, texts: [...g.querySelectorAll('text')].map(T) };
  });
  const loose = [...svg.querySelectorAll('text')].filter(t => !grouped.has(t)).map(T);
  // The settled sweep window, in user units, read straight from
  // the DOM: the axis lives inside the clipped weave group, so
  // this width decides whether the last date tick paints whole.
  // Layout geometry cannot see a clip path, which is how the
  // sliced final tick passed every measurement until a reader
  // caught it in the captures (card S4).
  let clipW = null;
  const weave = svg.querySelector('g[clip-path]');
  if (weave) {
    const m = /url\\(#(.+)\\)/.exec(weave.getAttribute('clip-path') || '');
    const rect = m && document.getElementById(m[1])?.querySelector('rect');
    if (rect) clipW = parseFloat(rect.getAttribute('width'));
  }
  return {
    svg: { x: sr.x, y: sr.y, w: sr.width, h: sr.height }, viewBox: { w: vb[2], h: vb[3] }, clipW,
    groups, loose,
    docScrollW: document.documentElement.scrollWidth, docClientW: document.documentElement.clientWidth
  };
})()`;

const work = mkdtempSync(join(tmpdir(), 'ml-weave-d1-'));
const DRIVER_PORT = 9350 + Math.floor(Math.random() * 90);

async function measureState(stateName) {
  const steps = {
    port: DRIVER_PORT,
    steps: [
      { goto: `${base}/`, waitMs: 900 },
      { shot: `${stateName}-landing-1280`, width: 1280, height: 1000 },
      { eval: PROBE, as: `${stateName}Hero1280` },
      { shot: `${stateName}-landing-360`, width: 360, height: 900 },
      { eval: PROBE, as: `${stateName}Hero360` },
      { goto: `${base}/console#/graph`, waitMs: 900 },
      { shot: `${stateName}-console-1280`, width: 1280, height: 1000 },
      { eval: PROBE, as: `${stateName}Graph1280` },
      { shot: `${stateName}-console-360`, width: 360, height: 900 },
      { eval: PROBE, as: `${stateName}Graph360` },
    ],
  };
  const stepsPath = join(work, `steps-${stateName}.json`);
  writeFileSync(stepsPath, JSON.stringify(steps));
  const outdir = join(work, `out-${stateName}`);
  await run(process.execPath, ['checks/capture-driver-v1.mjs', stepsPath, outdir]);
  return JSON.parse(readFileSync(join(outdir, 'walk-report.json'), 'utf8')).probes;
}

const DATE_RE = /^\d{1,2} \w{3}$/;
function analyse(probeName, p, expected) {
  const tag = `${probeName}`;
  if (!p || p.error || !p.svg) { assert(false, `${tag}: figure rendered for measurement`, p ? String(p.error || 'no svg') : 'probe missing'); return; }
  const scale = p.svg.w / p.viewBox.w; // rendered px per figure unit
  const U = (px) => px / scale;
  const S = p.svg;
  const rel = (t) => ({ text: t.text, cls: t.cls, x: U(t.x - S.x), y: U(t.y - S.y), w: U(t.w), h: U(t.h) });
  const knotLabels = [], sourceLabels = [], agentLabels = [], knots = [];
  for (const g of p.groups) {
    if (g.kind === 'memory' || g.kind === 'proposal') {
      knots.push({ kind: g.kind, cx: U(g.cx - S.x), cy: U(g.cy - S.y) });
      for (const t of g.texts) knotLabels.push(rel(t));
    } else if (g.kind === 'source') {
      for (const t of g.texts) sourceLabels.push(rel(t));
    } else if (g.kind === 'agent') {
      for (const t of g.texts) agentLabels.push(rel(t));
    }
  }
  const loose = p.loose.map(rel);
  const ticks = loose.filter((t) => DATE_RE.test(t.text) && t.cls.includes('node-sub'));
  const restRaw = loose.filter((t) => !(DATE_RE.test(t.text) && t.cls.includes('node-sub')));
  // The break disclosure is one label printed on two stacked lines
  // ("176 days" over "no records"). Lines of one label are a single
  // unit for the touching rule: what must never touch is one label
  // against another label, not a label against its own second line.
  const rest = [];
  for (const t of restRaw) {
    const cx = t.x + t.w / 2;
    const host = rest.find((u) => Math.abs((u.x + u.w / 2) - cx) < 2 && t.y - (u.y + u.h) >= -0.5 && t.y - (u.y + u.h) < 3);
    if (host) {
      const x2 = Math.max(host.x + host.w, t.x + t.w), y2 = Math.max(host.y + host.h, t.y + t.h);
      host.x = Math.min(host.x, t.x); host.y = Math.min(host.y, t.y);
      host.w = x2 - host.x; host.h = y2 - host.y; host.text += ' / ' + t.text;
    } else rest.push({ ...t });
  }
  const allLabels = [
    ...knotLabels.map((t) => ({ ...t, set: 'knot' })),
    ...sourceLabels.map((t) => ({ ...t, set: 'source' })),
    ...agentLabels.map((t) => ({ ...t, set: 'agent' })),
    ...ticks.map((t) => ({ ...t, set: 'tick' })),
    ...rest.map((t) => ({ ...t, set: 'figure' })),
  ];

  assert(knots.length >= expected.minKnots, `${tag}: timed knots rendered (${knots.length})`, `expected at least ${expected.minKnots}`);

  // Bounds: every label inside the frame (0.35 unit tolerance for
  // subpixel rounding in the rendered text boxes).
  let worstOut = 0, worstText = '';
  for (const t of allLabels) {
    const out = Math.max(0, -t.x, -t.y, t.x + t.w - p.viewBox.w, t.y + t.h - p.viewBox.h);
    if (out > worstOut) { worstOut = out; worstText = `${t.text} (${t.set})`; }
  }
  info(`${tag}: worst out of frame distance ${worstOut.toFixed(2)} units (${worstText || 'none'})`);
  assert(worstOut <= 0.35, `${tag}: every label inside the frame`, `worst ${worstOut.toFixed(2)} units out (${worstText})`);

  // Overlap: no two label boxes may intersect once each box grows
  // by 0.6 units, a moat of about one rendered pixel at 360px.
  const GROW = 0.6;
  let worstPair = null, worstArea = 0;
  for (let i = 0; i < allLabels.length; i++) for (let j = i + 1; j < allLabels.length; j++) {
    const a = allLabels[i], b = allLabels[j];
    const ox = Math.min(a.x + a.w + GROW, b.x + b.w + GROW) - Math.max(a.x - GROW, b.x - GROW);
    const oy = Math.min(a.y + a.h + GROW, b.y + b.h + GROW) - Math.max(a.y - GROW, b.y - GROW);
    if (ox > 0 && oy > 0 && ox * oy > worstArea) { worstArea = ox * oy; worstPair = `${a.text} (${a.set}) x ${b.text} (${b.set})`; }
  }
  info(`${tag}: worst label pair overlap area after the moat ${worstArea.toFixed(2)} square units (${worstPair || 'none'})`);
  assert(worstArea <= 0, `${tag}: no two labels overlap or touch`, worstPair || '');

  // Minimum knot separation on one thread. Threads are told apart
  // by their row: knot centres cluster within 20 units of a row
  // centre, and rows sit far apart, so clustering by centre height
  // names the thread a knot sits on.
  const rows = [];
  for (const k of knots) {
    let row = rows.find((r) => Math.abs(r.cy - k.cy) < 20);
    if (!row) { row = { cy: k.cy, pts: [] }; rows.push(row); }
    row.pts.push(k);
  }
  let minSep = Infinity;
  for (const r of rows) {
    const pts = r.pts.sort((a, b) => a.cx - b.cx);
    for (let i = 1; i < pts.length; i++) minSep = Math.min(minSep, Math.hypot(pts[i].cx - pts[i - 1].cx, pts[i].cy - pts[i - 1].cy));
  }
  info(`${tag}: minimum knot separation on one thread ${minSep === Infinity ? 'n/a' : minSep.toFixed(2)} units`);
  assert(minSep >= 18.5, `${tag}: neighbouring knots on one thread keep the recorded minimum separation of 19 units`, `measured ${minSep === Infinity ? 'n/a' : minSep.toFixed(2)}`);

  // Date ticks: one per distinct date, centres readable apart.
  const tickC = ticks.map((t) => t.x + t.w / 2).sort((a, b) => a - b);
  let minTick = Infinity;
  for (let i = 1; i < tickC.length; i++) minTick = Math.min(minTick, tickC[i] - tickC[i - 1]);
  info(`${tag}: date ticks ${ticks.length}, minimum tick centre separation ${minTick === Infinity ? 'n/a' : minTick.toFixed(2)} units`);
  assert(ticks.length === expected.slots, `${tag}: one date tick per distinct date (${ticks.length})`, `expected ${expected.slots}`);
  assert(minTick >= 30, `${tag}: date tick centres stay readable apart`, `measured ${minTick === Infinity ? 'n/a' : minTick.toFixed(2)}`);

  assert(p.clipW !== null && p.clipW >= p.viewBox.w - 0.5, `${tag}: the settled sweep window covers the whole frame`, `clip ${p.clipW === null ? 'unread' : p.clipW.toFixed(1)} of ${p.viewBox.w} units`);
  assert(p.docScrollW - p.docClientW <= 0, `${tag}: page does not overflow sideways`, `overflow ${p.docScrollW - p.docClientW}px`);
}

// Expected shape of the seeded state, read from the API the pages
// themselves render from.
const graph = await (await fetch(base + '/api/graph')).json();
const timed = graph.nodes.filter((n) => n.kind === 'memory' || n.kind === 'proposal');
const distinctDays = new Set(timed.map((n) => (n.recorded_at || '').slice(0, 10)));
info(`seeded state from the API: ${timed.length} timed knots over ${distinctDays.size} distinct dates`);

const seeded = await measureState('seeded');
for (const name of Object.keys(seeded)) analyse(name, seeded[name], { minKnots: timed.length, slots: distinctDays.size });

// The accumulation fixture: eight records gather at the latest
// date in the corpus, four per agent thread present in the seeded
// state. The rows clone the shape of a corpus record on this
// suite's own throwaway database and are marked as fixture records
// in their provenance. Timed knots grow by eight.
{
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const latest = await pool.query(
    `SELECT max((created_at AT TIME ZONE 'UTC')::date) AS d FROM memories WHERE namespace = $1`, [graph.namespace]);
  const day = latest.rows[0].d.toISOString().slice(0, 10);
  const fixtures = [
    ['demo-a1', 'grok', 'The Lantern rehearsal added a second bench unit for the October run.'],
    ['demo-a2', 'grok', 'The Lantern crew logged the hall generator test on the last day of October.'],
    ['demo-a3', 'grok', 'The Lantern rig spare lamp set was counted and shelved.'],
    ['demo-a4', 'grok', 'The Lantern demo schedule for November was pinned to the board.'],
    ['demo-a5', 'moose', 'The Lantern site visit notes were filed with the October records.'],
    ['demo-a6', 'moose', 'The Lantern bench unit firmware stick was labelled and stored.'],
    ['demo-a7', 'moose', 'The Lantern hall booking receipt was added to the folder.'],
    ['demo-a8', 'moose', 'The Lantern crew confirmed the winter rehearsal dates.'],
  ];
  for (let i = 0; i < fixtures.length; i++) {
    const [id, author, text] = fixtures[i];
    const ts = `${day}T${String(10 + i).padStart(2, '0')}:15:00Z`;
    await pool.query(
      `INSERT INTO memories (id, namespace, type, scope, text, embedding, index_status, importance, strength, version, pinned, approval, valid_from, grounding_ids, links, provenance, created_at, updated_at)
       SELECT $1, namespace, type, scope, $3, embedding, index_status, importance, strength, version, pinned, approval, $4::timestamptz, '{}', '{}',
              jsonb_build_object('author', $2::text, 'origin', 'weave-d1-accumulation-fixture'), $4::timestamptz, $4::timestamptz
       FROM memories WHERE id = 'demo-g4'`,
      [id, author, text, ts]);
  }
  await pool.end();
  info(`accumulation fixture: 8 records at ${day}, timed knots grow from ${timed.length} to ${timed.length + 8}`);
}

const accumulated = await measureState('accumulated');
for (const name of Object.keys(accumulated)) analyse(name, accumulated[name], { minKnots: timed.length + 8, slots: distinctDays.size });

server.kill('SIGTERM');
console.log(failures ? `weave-d1: ${failures} FAILURES` : 'weave-d1: all assertions passed');
process.exit(failures ? 1 : 0);
