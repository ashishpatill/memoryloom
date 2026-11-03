/**
 * Receipt D2 browser check — the seven part receipt record on the
 * running app.
 *
 * Card S5 of the frozen master plan. Drives the real landing page
 * and the real console through the committed capture driver
 * (checks/capture-driver-v1.mjs, the Playwright headless shell over
 * CDP route) and reads the rendered receipt wherever it renders:
 * the recall answer, the recall near misses, the landing believed
 * at panel and the live loop decided rows. It never reads a proxy
 * structure: every fact below comes from rendered parts, rendered
 * text and computed styles in the page, after fonts load.
 *
 * The assertions, per surface:
 *   - the receipt carries exactly the seven parts named in Section
 *     6.5 of the master plan, in order: Record, Written by, How it
 *     arrived, Recorded, Valid from, Valid to, Rests on;
 *   - part labels are set in the text face at 11px with a 14px line
 *     height, and part values in the text face at 14px with a 20px
 *     line height;
 *   - the firmware answer receipt names the record, the author and
 *     the grounding records, and its Record part is a link a reader
 *     can follow to open that record (the walk clicks it and reads
 *     the provenance trail it lands on);
 *   - a record that rests on nothing shows the words No grounding
 *     record, with no link in that part;
 *   - every id shown in a Rests on part resolves to a record in the
 *     store, checked against the graph the store itself returns;
 *   - the wifi question shows the refusal, and every near miss is
 *     labelled as not an answer, carries the same seven parts, and
 *     never takes the receipt card border;
 *   - the live loop decided row names the memory a proposal became
 *     as a link that opens that record.
 *
 * Owning file: checks/receipt-d2.mjs
 * Accountable layer: Browser layer
 * Provider need: None. The suite seeds keyless, so recall answers
 *   from the seeded corpus and the gate paths stand in their fail
 *   closed states, exactly as the seed records them.
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

// Seed through the documented path. Keyless: the corpus, recall and
// the believed at answers seed in full.
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

// ---- facts from the APIs the pages render from -------------------
const graph = await (await fetch(base + '/api/graph')).json();
const storeIds = new Set(graph.nodes.filter((n) => n.kind === 'memory' || n.kind === 'source').map((n) => n.id));
info(`store records from the graph: ${storeIds.size}`);

const fwApi = await (await fetch(base + '/api/recall?q=' + encodeURIComponent('what firmware does the rig run?') + '&k=8')).json();
const fwTop = fwApi.results && fwApi.results[0];
assert(!!fwTop && fwTop.id === 'demo-g4', 'API: the firmware question is answered by demo-g4', fwTop ? `top was ${fwTop.id}` : 'no results');
assert(!!fwTop && JSON.stringify(fwTop.receipt.grounding_ids) === JSON.stringify(['demo-g2', 'demo-g3']),
  'API: the firmware receipt rests on demo-g2 and demo-g3',
  fwTop ? `grounding was ${JSON.stringify(fwTop.receipt.grounding_ids)}` : 'no receipt');
for (const [name, api] of [['firmware', fwApi]]) {
  for (const r of api.results || []) {
    for (const g of r.receipt.grounding_ids || []) {
      assert(storeIds.has(g), `API: ${name} receipt for ${r.id} rests only on records that resolve (${g})`);
    }
  }
}
const believedApi = await (await fetch(base + '/api/believed?at=' + encodeURIComponent('2026-10-12T00:00:00Z'))).json();
const v1 = (believedApi || []).find((r) => r.id === 'demo-v1');
assert(!!v1, 'API: the believed at answer for 12 Oct 2026 is demo-v1');
assert(!!v1 && Array.isArray(v1.grounding_ids), 'API: believed at rows carry their grounding ids',
  v1 ? `grounding_ids was ${JSON.stringify(v1.grounding_ids)}` : 'no row');
if (v1 && Array.isArray(v1.grounding_ids)) {
  for (const g of v1.grounding_ids) assert(storeIds.has(g), `API: believed at grounding id resolves (${g})`);
}

// ---- probes ------------------------------------------------------
// One extractor, shared by every surface probe: it reads the
// rendered parts of every receipt inside a root element, with the
// computed style of each label and value, the links inside each
// value, and whether the receipt sits inside the card aside.
const EXTRACTOR = `
  const partsOf = (block) => [...block.querySelectorAll('.record-fact')].map((f) => {
    const dt = f.querySelector('dt'); const dd = f.querySelector('dd');
    const ls = dt ? getComputedStyle(dt) : null; const vs = dd ? getComputedStyle(dd) : null;
    return {
      label: dt ? dt.textContent.trim() : '',
      value: dd ? dd.textContent.trim() : '',
      links: dd ? [...dd.querySelectorAll('a')].map((a) => ({ text: a.textContent.trim(), href: a.getAttribute('href') || '' })) : [],
      labelStyle: ls ? { family: ls.fontFamily, size: ls.fontSize, leading: ls.lineHeight } : null,
      valueStyle: vs ? { family: vs.fontFamily, size: vs.fontSize, leading: vs.lineHeight } : null,
    };
  });
  const receiptsIn = (rootEl) => {
    const blocks = [];
    const seen = new Set();
    for (const aside of rootEl.querySelectorAll('aside.record')) { blocks.push({ card: true, el: aside }); seen.add(aside); }
    for (const f of rootEl.querySelectorAll('.record-fact')) {
      let host = f.closest('aside.record');
      if (!host) {
        host = f.closest('.receipt-plain') || f.closest('.row-item') || f.parentElement;
        if (!seen.has(host)) { blocks.push({ card: false, el: host }); seen.add(host); }
      }
    }
    return blocks.map((b) => ({ card: b.card, parts: partsOf(b.el) }));
  };
`;

const LANDING_PROBE = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  ${EXTRACTOR}
  const panel = async (id) => {
    const host = document.getElementById(id);
    if (!host) return { error: 'panel missing: ' + id };
    const card = host.closest('.card') || host.parentElement;
    for (let i = 0; i < 75; i++) {
      if (card.querySelector('.record-fact')) break;
      await sleep(200);
    }
    await document.fonts.ready;
    return { text: card.textContent, receipts: receiptsIn(card) };
  };
  return { believed12: await panel('believed12'), believed25: await panel('believed25') };
})()`;

const ANSWER_PROBE = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  ${EXTRACTOR}
  let out = document.getElementById('recallOut');
  for (let i = 0; i < 90; i++) {
    if (out && out.querySelector('aside.record .record-fact')) break;
    await sleep(200);
  }
  await document.fonts.ready;
  const row = out ? out.querySelector('.row-item') : null;
  return {
    receipts: out ? receiptsIn(out) : [],
    rowText: row ? row.textContent : '',
    rowBadges: row ? [...row.querySelectorAll('.badge')].map((b) => b.textContent.trim()) : [],
  };
})()`;

const TRAIL_PROBE = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let out = document.getElementById('trailOut');
  for (let i = 0; i < 75; i++) {
    if (out && out.textContent.includes('Provenance trail')) break;
    await sleep(200);
  }
  return { text: out ? out.textContent : '' };
})()`;

const NOANSWER_PROBE = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  ${EXTRACTOR}
  let out = document.getElementById('recallOut');
  for (let i = 0; i < 90; i++) {
    if (out && out.textContent.includes('No receipts, no answer')) break;
    await sleep(200);
  }
  await document.fonts.ready;
  const rows = out ? [...out.querySelectorAll('.row-item')].map((row) => ({
    badges: [...row.querySelectorAll('.badge')].map((b) => b.textContent.trim()),
    hasCardAside: !!row.querySelector('aside.record'),
    receipts: receiptsIn(row),
  })) : [];
  return { refusal: out ? out.textContent.includes('No receipts, no answer') : false, rows };
})()`;

const LOOP_PROBE = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let rows = [];
  for (let i = 0; i < 75; i++) {
    rows = [...document.querySelectorAll('#decidedList .row-item')];
    if (rows.some((r) => r.textContent.includes('became memory'))) break;
    await sleep(200);
  }
  const row = rows.find((r) => r.textContent.includes('became memory'));
  if (!row) return { found: false };
  const link = [...row.querySelectorAll('a')].find((a) => a.textContent.trim() === 'demo-g4');
  return { found: true, becameLink: !!link, linkText: link ? link.textContent.trim() : '' };
})()`;

const work = mkdtempSync(join(tmpdir(), 'ml-receipt-d2-'));
const DRIVER_PORT = 9350 + Math.floor(Math.random() * 90);
async function drive(name, steps) {
  const stepsPath = join(work, `steps-${name}.json`);
  writeFileSync(stepsPath, JSON.stringify({ port: DRIVER_PORT, steps }));
  const outdir = join(work, `out-${name}`);
  // A step can fail on the defective tree (the follow walk clicks a
  // link that does not exist yet). The walk report still records
  // every probe, so the driver exit code is not fatal here: the
  // assertions below judge what the probes found.
  await new Promise((resolve) => {
    const p = spawn(process.execPath, ['checks/capture-driver-v1.mjs', stepsPath, outdir], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    p.on('close', () => resolve());
    p.on('error', () => resolve());
  });
  return JSON.parse(readFileSync(join(outdir, 'walk-report.json'), 'utf8')).probes;
}

const SEVEN = ['Record', 'Written by', 'How it arrived', 'Recorded', 'Valid from', 'Valid to', 'Rests on'];
function assertSevenParts(tag, receipt) {
  assert(!!receipt, `${tag}: a receipt renders`);
  if (!receipt) return;
  const labels = receipt.parts.map((p) => p.label);
  assert(JSON.stringify(labels) === JSON.stringify(SEVEN), `${tag}: exactly the seven parts in order`, `got ${JSON.stringify(labels)}`);
}
function assertReceiptType(tag, receipt) {
  if (!receipt) return;
  for (const p of receipt.parts) {
    assert(!!p.labelStyle && p.labelStyle.family.includes('Source Sans 3') && !p.labelStyle.family.includes('IBM Plex Mono'),
      `${tag}: the ${p.label} label is set in the text face`, p.labelStyle ? p.labelStyle.family : 'no style');
    assert(!!p.labelStyle && p.labelStyle.size === '11px' && p.labelStyle.leading === '14px',
      `${tag}: the ${p.label} label is 11px on a 14px line`, p.labelStyle ? `${p.labelStyle.size}/${p.labelStyle.leading}` : 'no style');
    assert(!!p.valueStyle && p.valueStyle.size === '14px' && p.valueStyle.leading === '20px',
      `${tag}: the ${p.label} value is 14px on a 20px line`, p.valueStyle ? `${p.valueStyle.size}/${p.valueStyle.leading}` : 'no style');
  }
}
const part = (receipt, name) => receipt && receipt.parts.find((p) => p.label === name);

// ---- landing believed at panel ------------------------------------
{
  const probes = await drive('landing', [
    { goto: `${base}/`, waitMs: 900 },
    { eval: LANDING_PROBE, as: 'landing' },
    { shot: 'landing-believed-1280', width: 1280, height: 1000, fullPage: true },
  ]);
  const L = probes.landing || {};
  for (const [key, id, hall] of [['believed12', 'demo-v1', 'Hall A'], ['believed25', 'demo-v2', 'Hall B']]) {
    const panel = L[key] || {};
    const tag = `landing ${id}`;
    assert(typeof panel.text === 'string' && panel.text.includes(hall), `${tag}: the belief text renders (${hall})`, (panel.text || '').slice(0, 80));
    const receipt = panel.receipts && panel.receipts[0];
    assertSevenParts(tag, receipt);
    assertReceiptType(tag, receipt);
    const rec = part(receipt, 'Record');
    assert(!!rec && rec.value === id, `${tag}: the Record part names ${id}`, rec ? rec.value : 'missing');
    const rests = part(receipt, 'Rests on');
    assert(!!rests && rests.value === 'No grounding record' && rests.links.length === 0,
      `${tag}: Rests on shows the words No grounding record with no link`, rests ? `${rests.value} (${rests.links.length} links)` : 'missing');
  }
}

// ---- console: recall answer, the follow walk, the no answer state -
{
  const probes = await drive('console', [
    { goto: `${base}/console#/recall`, waitMs: 900 },
    { type: ['#q', 'what firmware does the rig run?'] },
    { click: '#ask' },
    { eval: ANSWER_PROBE, as: 'answer' },
    { shot: 'recall-firmware-1280', width: 1280, height: 1000, fullPage: true },
    { shot: 'recall-firmware-360', width: 360, height: 900, fullPage: true },
    { click: '#recallOut aside.record a[data-record-link]' },
    { eval: TRAIL_PROBE, as: 'trail' },
    { shot: 'graph-trail-1280', width: 1280, height: 1000, fullPage: true },
    { goto: `${base}/console#/recall`, waitMs: 900 },
    { type: ['#q', 'what is the wifi password?'] },
    { click: '#ask' },
    { eval: NOANSWER_PROBE, as: 'noanswer' },
    { shot: 'recall-wifi-1280', width: 1280, height: 1000, fullPage: true },
    { shot: 'recall-wifi-360', width: 360, height: 900, fullPage: true },
    { goto: `${base}/console#/loop`, waitMs: 900 },
    { eval: LOOP_PROBE, as: 'loop' },
    { shot: 'loop-decided-1280', width: 1280, height: 1000, fullPage: true },
  ]);
  const A = probes.answer || {};
  const tag = 'recall firmware answer';
  const receipt = A.receipts && A.receipts[0];
  assertSevenParts(tag, receipt);
  assertReceiptType(tag, receipt);
  assert(!!receipt && receipt.card === true, `${tag}: the answer receipt carries the receipt card form`);
  assert(typeof A.rowText === 'string' && A.rowText.includes('firmware 2.4.1'), `${tag}: the answer and its receipt sit in one panel`, (A.rowText || '').slice(0, 80));
  const rec = part(receipt, 'Record');
  assert(!!rec && rec.links.length === 1 && rec.links[0].text === 'demo-g4', `${tag}: the Record part is a link naming demo-g4`,
    rec ? JSON.stringify(rec.links) : 'missing');
  const by = part(receipt, 'Written by');
  assert(!!by && by.value === 'grok', `${tag}: Written by names the author`, by ? by.value : 'missing');
  const arrived = part(receipt, 'How it arrived');
  assert(!!arrived && arrived.value === 'Through a proposal', `${tag}: How it arrived is plain words`, arrived ? arrived.value : 'missing');
  const rests = part(receipt, 'Rests on');
  assert(!!rests && JSON.stringify(rests.links.map((l) => l.text)) === JSON.stringify(['demo-g2', 'demo-g3']),
    `${tag}: Rests on names demo-g2 and demo-g3 as links`, rests ? JSON.stringify(rests.links) : 'missing');
  const validTo = part(receipt, 'Valid to');
  assert(!!validTo && validTo.value === 'Still held', `${tag}: Valid to reads Still held for a belief still in force`, validTo ? validTo.value : 'missing');

  const T = probes.trail || {};
  assert(typeof T.text === 'string' && T.text.includes('Provenance trail') && T.text.includes('demo-g4') && T.text.includes('firmware 2.4.1'),
    'follow walk: the receipt Record link opens the record it names (the demo-g4 trail)', (T.text || '').slice(0, 80));

  const N = probes.noanswer || {};
  const ntag = 'recall wifi no answer';
  assert(N.refusal === true, `${ntag}: the refusal renders in plain words`);
  assert(Array.isArray(N.rows) && N.rows.length >= 1, `${ntag}: near misses are listed`, `${(N.rows || []).length} rows`);
  (N.rows || []).forEach((row, i) => {
    const rtag = `${ntag} near miss ${i + 1}`;
    assert(row.badges.some((b) => b.includes('not an answer')), `${rtag}: labelled as not an answer`, JSON.stringify(row.badges));
    assert(!row.badges.some((b) => b === 'receipt'), `${rtag}: never takes the answer label`, JSON.stringify(row.badges));
    assert(row.hasCardAside === false, `${rtag}: never takes the receipt card border`);
    const r = row.receipts && row.receipts[0];
    assertSevenParts(rtag, r);
    if (i === 0) assertReceiptType(rtag, r);
    const rests = part(r, 'Rests on');
    if (rests) {
      for (const l of rests.links) assert(storeIds.has(l.text), `${rtag}: Rests on names only records that resolve (${l.text})`);
      assert(rests.links.length > 0 || rests.value === 'No grounding record',
        `${rtag}: Rests on names its grounding or says No grounding record in words`, rests.value);
    }
  });

  const LP = probes.loop || {};
  assert(LP.found === true, 'live loop: a decided row names the memory its proposal became');
  assert(LP.becameLink === true, 'live loop: the became memory id is a link that opens that record', JSON.stringify(LP));
}

server.kill('SIGTERM');
console.log(failures ? `receipt-d2: ${failures} FAILURES` : 'receipt-d2: all assertions passed');
process.exit(failures ? 1 : 0);
