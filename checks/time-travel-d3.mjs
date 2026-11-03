/**
 * Time travel D3 browser check. The time travel control on the
 * running app.
 *
 * Card S6 of the frozen master plan. Drives the real console time
 * travel view through the committed capture driver
 * (checks/capture-driver-v1.mjs, the Playwright headless shell over
 * CDP route) and proves the control's one selected date is the same
 * fact in every presentation: the date input, the slider handle,
 * the readout, the slider aria value text and the believed at list.
 *
 * The assertions:
 *   - the overview response returns earliest_date and latest_date
 *     as date strings, and they are the UTC calendar dates of the
 *     first and last recorded records (the API check that reads
 *     both fields back);
 *   - the believed at endpoint answers a bare date string with the
 *     belief in force: Hall A on 12 October 2026, Hall B on 25
 *     October 2026, nothing before the corpus;
 *   - the date input is labelled Believed at date and the slider
 *     Believed at date slider, with distinct programmatic names;
 *   - the selected date readout is set in the mono face at 14px
 *     directly above the slider, and the slider aria value text is
 *     the selected date string exactly as returned;
 *   - the walked cases agree in every presentation: an exact
 *     returned date (12 October 2026), a date between two returned
 *     dates (the belief in force, with the record date visible), a
 *     date before the first returned record (the handle rests at
 *     the first end, the view states that no belief was recorded
 *     in force and names the first returned date) and a date after
 *     the last returned record (the handle rests at the last end,
 *     the latest belief stands as in force and the view states
 *     that no later returned record exists);
 *   - the keyboard walk: the slider focused, one arrow key moves
 *     one calendar day, Home and End move to the first and last
 *     returned dates, and the date input, the readout and the list
 *     follow every step;
 *   - a failed believed at request uses role alert and leaves the
 *     previous list and the selected date in place;
 *   - the empty corpus renders its designed empty state with no
 *     slider bound to 1 January 1970 and no earliest date claimed.
 *
 * Owning file: checks/time-travel-d3.mjs
 * Accountable layer: Browser layer
 * Provider need: None. The suite seeds keyless, so the corpus and
 *   time travel seed in full and the gate paths stand in their fail
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

const DAY = 86400000;
const dayMs = (s) => Date.parse(`${s}T00:00:00Z`);
const dateStr = (ms) => new Date(ms).toISOString().slice(0, 10);
const fmtDay = (s) => new Date(dayMs(s)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Seed through the documented path. Keyless: the corpus, recall and
// time travel seed in full.
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

// ---- the API check: both fields read back -------------------------
const ov = await (await fetch(base + '/api/overview')).json();
assert(typeof ov.earliest_date === 'string' && DATE_RE.test(ov.earliest_date),
  'API: the overview returns earliest_date as a date string', `got ${JSON.stringify(ov.earliest_date)}`);
assert(typeof ov.latest_date === 'string' && DATE_RE.test(ov.latest_date),
  'API: the overview returns latest_date as a date string', `got ${JSON.stringify(ov.latest_date)}`);
const earliest = DATE_RE.test(ov.earliest_date || '') ? ov.earliest_date : (ov.first_recorded_at || '').slice(0, 10);
const latest = DATE_RE.test(ov.latest_date || '') ? ov.latest_date : (ov.last_recorded_at || '').slice(0, 10);
assert(ov.earliest_date === (ov.first_recorded_at || '').slice(0, 10),
  'API: earliest_date is the UTC calendar date of the first recorded record',
  `${ov.earliest_date} against first_recorded_at ${ov.first_recorded_at}`);
assert(ov.latest_date === (ov.last_recorded_at || '').slice(0, 10),
  'API: latest_date is the UTC calendar date of the last recorded record',
  `${ov.latest_date} against last_recorded_at ${ov.last_recorded_at}`);
assert(earliest <= latest, 'API: earliest_date is not after latest_date', `${earliest} .. ${latest}`);
info(`returned range: ${earliest} .. ${latest}`);
// Run condition for the named walks below: the seeded corpus is
// seeded exactly once into a fresh database (the verify entry
// guarantees this), which puts the first returned date at or
// before 12 October 2026 and the last returned date at or after
// 25 October 2026, the two dates the frozen plan names. A database
// seeded twice breaks that condition, because the seed's first
// step rewrites the corpus while its second step stands down, and
// this assertion fails as that run condition rather than as six
// confusing walk failures.
assert(earliest <= '2026-10-12' && latest >= '2026-10-25',
  'run condition: the returned range covers the named walk dates, 12 and 25 October 2026',
  `range is ${earliest} .. ${latest}`);

const believedIds = async (dateString) => {
  const rows = await (await fetch(`${base}/api/believed?at=${encodeURIComponent(dateString)}`)).json();
  return Array.isArray(rows) ? rows.map((r) => r.id) : [];
};
const b12 = await believedIds('2026-10-12');
assert(b12.includes('demo-v1') && !b12.includes('demo-v2'),
  'API: believed on 2026-10-12 holds Hall A and not Hall B', JSON.stringify(b12));
const b25 = await believedIds('2026-10-25');
assert(b25.includes('demo-v2') && !b25.includes('demo-v1'),
  'API: believed on 2026-10-25 holds Hall B and not Hall A', JSON.stringify(b25));
const bBefore = await believedIds('2026-01-01');
assert(bBefore.length === 0, 'API: believed before the corpus is an honest empty set', JSON.stringify(bBefore));

// ---- probes --------------------------------------------------------
// One state probe, shared by every walk. It waits until the list
// names the expected date (or the wait runs out), lets fonts
// settle, then reads every presentation of the selected date from
// the rendered page: the date input and its label, the slider and
// its label, the readout with its computed style, the aria value
// text, the track end labels and the believed at list itself.
const stateProbe = (expectFmt) => `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let slider = null;
  for (let i = 0; i < 60; i++) {
    slider = document.getElementById('asof');
    if (slider) break;
    await sleep(200);
  }
  if (!slider) return { error: 'the time travel slider never rendered' };
  const out = document.getElementById('believedOut');
  const want = ${JSON.stringify(expectFmt)};
  if (want) {
    for (let i = 0; i < 40; i++) {
      if (out && out.textContent.includes(want)) break;
      await sleep(200);
    }
  }
  await document.fonts.ready;
  const labelFor = (el) => {
    if (!el) return null;
    const lab = el.id ? document.querySelector('label[for="' + el.id + '"]') : null;
    return lab ? lab.textContent.trim() : null;
  };
  const dateInput = document.querySelector('input[type="date"]');
  const readout = document.getElementById('asofLabel');
  const cs = readout ? getComputedStyle(readout) : null;
  const rows = out ? [...out.querySelectorAll('.row-item .text')].map((t) => t.textContent.trim()) : [];
  const alert = document.querySelector('#believedAlert [role="alert"], #believedOut [role="alert"]');
  return {
    slider: { min: slider.min, max: slider.max, step: slider.step, value: slider.value,
              valueDate: new Date(Number(slider.value)).toISOString().slice(0, 10),
              ariaValuetext: slider.getAttribute('aria-valuetext'),
              name: slider.getAttribute('name'), label: labelFor(slider) },
    dateInput: dateInput ? { value: dateInput.value, name: dateInput.getAttribute('name'), label: labelFor(dateInput) } : null,
    readout: readout ? { text: readout.textContent, family: cs.fontFamily, size: cs.fontSize } : null,
    status: (document.getElementById('asofStatus') || {}).textContent || null,
    ends: [...document.querySelectorAll('.time-end-date')].map((e) => e.textContent.trim()),
    listText: out ? out.textContent : '',
    rowTexts: rows,
    alertText: alert ? alert.textContent.trim() : null,
    docScrollW: document.documentElement.scrollWidth, docClientW: document.documentElement.clientWidth,
  };
})()`;

const FAIL_PROBE = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const out = document.getElementById('believedOut');
  const before = out ? out.textContent : '';
  const origFetch = window.fetch;
  window.fetch = (u, o) => String(u).includes('/api/believed') ? Promise.reject(new Error('network down (injected by the D3 check)')) : origFetch(u, o);
  const dateInput = document.querySelector('input[type="date"]');
  return { before, armed: !!dateInput };
})()`;

const FAIL_READ = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  await sleep(1200);
  const out = document.getElementById('believedOut');
  const alert = document.querySelector('#believedAlert [role="alert"], #believedOut [role="alert"], [role="alert"]');
  const dateInput = document.querySelector('input[type="date"]');
  const readout = document.getElementById('asofLabel');
  return {
    listText: out ? out.textContent : '',
    alertText: alert ? alert.textContent.trim() : null,
    dateValue: dateInput ? dateInput.value : null,
    readout: readout ? readout.textContent : null,
  };
})()`;

const work = mkdtempSync(join(tmpdir(), 'ml-time-d3-'));
const DRIVER_PORT = 9350 + Math.floor(Math.random() * 90);
async function drive(name, steps) {
  const stepsPath = join(work, `steps-${name}.json`);
  writeFileSync(stepsPath, JSON.stringify({ port: DRIVER_PORT, steps }));
  const outdir = join(work, `out-${name}`);
  // A step can fail on the defective tree (a walk types into a date
  // input that does not exist yet). The walk report still records
  // every probe, so the driver exit code is not fatal here: the
  // assertions below judge what the probes found.
  await new Promise((resolve) => {
    const p = spawn(process.execPath, ['checks/capture-driver-v1.mjs', stepsPath, outdir], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    p.on('close', () => resolve());
    p.on('error', () => resolve());
  });
  return JSON.parse(readFileSync(join(outdir, 'walk-report.json'), 'utf8')).probes;
}

// The agreement assertion every walked case shares: the date
// input, the handle, the readout and the aria value text all name
// the one selected date, and the handle rests on the clamped day.
function assertAgreement(tag, S, selected, handleDate) {
  assert(!!S && !S.error, `${tag}: the control renders`, S ? String(S.error || '') : 'probe missing');
  if (!S || S.error) return;
  assert(!!S.dateInput, `${tag}: a date input is present`);
  assert(!!S.dateInput && S.dateInput.value === selected, `${tag}: the date input holds the selected date ${selected}`,
    S.dateInput ? `got ${S.dateInput.value}` : 'no date input');
  assert(S.slider.valueDate === handleDate, `${tag}: the handle rests on ${handleDate}`,
    `got ${S.slider.valueDate} (value ${S.slider.value})`);
  assert(!!S.readout && S.readout.text === fmtDay(selected), `${tag}: the readout names ${fmtDay(selected)}`,
    S.readout ? `got ${S.readout.text}` : 'no readout');
  assert(S.slider.ariaValuetext === selected, `${tag}: the aria value text is the selected date string ${selected}`,
    `got ${JSON.stringify(S.slider.ariaValuetext)}`);
}
const listHas = (S, text) => !!S && typeof S.listText === 'string' && S.listText.includes(text);
const HALL_A = 'held in Hall A';
const HALL_B = 'held in Hall B';

// ---- the walked cases on the seeded corpus -------------------------
const afterLatest = dateStr(dayMs(latest) + 30 * DAY);
const beforeEarliest = '2026-04-01';
const betweenDate = '2026-10-21';
{
  const probes = await drive('walks', [
    { goto: `${base}/console#/time`, waitMs: 1000 },
    { eval: stateProbe(fmtDay(latest)), as: 'rest' },
    { shot: 'time-latest-1280', width: 1280, height: 1000, fullPage: true },
    { type: ['input[type="date"]', '2026-10-12'] },
    { eval: stateProbe(fmtDay('2026-10-12')), as: 'exact' },
    { shot: 'time-2026-10-12-1280', width: 1280, height: 1000, fullPage: true },
    { shot: 'time-2026-10-12-360', width: 360, height: 900, fullPage: true },
    { type: ['input[type="date"]', betweenDate] },
    { eval: stateProbe(fmtDay(betweenDate)), as: 'between' },
    { type: ['input[type="date"]', beforeEarliest] },
    { eval: stateProbe('No belief was recorded in force'), as: 'before' },
    { shot: 'time-before-first-1280', width: 1280, height: 1000, fullPage: true },
    { type: ['input[type="date"]', afterLatest] },
    { eval: stateProbe(fmtDay(afterLatest)), as: 'after' },
    { shot: 'time-after-last-1280', width: 1280, height: 1000, fullPage: true },
    { eval: `(() => { const s = document.getElementById('asof'); s.value = ${JSON.stringify(String(dayMs('2026-10-25')))}; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()` },
    { eval: stateProbe(fmtDay('2026-10-25')), as: 'sliderDriven' },
    { shot: 'time-2026-10-25-1280', width: 1280, height: 1000, fullPage: true },
  ]);
  const rest = probes.rest || {};
  assertAgreement('rest at the last returned date', rest, latest, latest);
  if (rest && !rest.error) {
    assert(rest.slider.min === String(dayMs(earliest)) && rest.slider.max === String(dayMs(latest)) && rest.slider.step === String(DAY),
      'rest: the slider steps are calendar days from the earliest returned date to the latest returned date',
      `min ${rest.slider.min}, max ${rest.slider.max}, step ${rest.slider.step}`);
    assert(!!rest.dateInput && rest.dateInput.label === 'Believed at date',
      'rest: the date input label is Believed at date', rest.dateInput ? JSON.stringify(rest.dateInput.label) : 'no date input');
    assert(rest.slider.label === 'Believed at date slider',
      'rest: the slider label is Believed at date slider', JSON.stringify(rest.slider.label));
    assert(!!rest.dateInput && !!rest.dateInput.name && !!rest.slider.name && rest.dateInput.name !== rest.slider.name,
      'rest: the two controls carry distinct programmatic names',
      `date input ${JSON.stringify(rest.dateInput && rest.dateInput.name)}, slider ${JSON.stringify(rest.slider.name)}`);
    assert(!!rest.readout && rest.readout.family.includes('IBM Plex Mono') && rest.readout.size === '14px',
      'rest: the readout is set in the mono face at 14px',
      rest.readout ? `${rest.readout.family} at ${rest.readout.size}` : 'no readout');
    assert(JSON.stringify(rest.ends) === JSON.stringify([fmtDay(earliest), fmtDay(latest)]),
      'rest: the first and last returned dates label the track ends', JSON.stringify(rest.ends));
    assert(rest.docScrollW - rest.docClientW <= 0, 'rest: the page does not overflow sideways at 1280', `overflow ${rest.docScrollW - rest.docClientW}px`);
  }
  const exact = probes.exact || {};
  assertAgreement('exact returned date 2026-10-12', exact, '2026-10-12', '2026-10-12');
  assert(listHas(exact, HALL_A) && !listHas(exact, HALL_B),
    'exact returned date 2026-10-12: the list holds the Hall A belief and omits Hall B');
  assert(listHas(exact, 'beliefs held on 12 Oct 2026'),
    'exact returned date 2026-10-12: the list heading names the selected date', (exact.listText || '').slice(0, 100));

  const between = probes.between || {};
  assertAgreement(`date between returned dates ${betweenDate}`, between, betweenDate, betweenDate);
  assert(listHas(between, HALL_B) && !listHas(between, HALL_A),
    `date between returned dates ${betweenDate}: the belief in force is Hall B`);
  assert(listHas(between, 'valid from 20 Oct 2026'),
    `date between returned dates ${betweenDate}: the record date stays visible on the belief shown`, (between.listText || '').slice(0, 160));

  const before = probes.before || {};
  assertAgreement(`date before the first returned record ${beforeEarliest}`, before, beforeEarliest, earliest);
  assert(listHas(before, 'No belief was recorded in force'),
    'before the first returned record: the view states that no belief was recorded in force on that date', (before.listText || '').slice(0, 140));
  assert(listHas(before, fmtDay(earliest)),
    'before the first returned record: the view names the first returned date', (before.listText || '').slice(0, 140));
  assert(!!before && Array.isArray(before.rowTexts) && before.rowTexts.length === 0,
    'before the first returned record: no belief is presented as current for that date', `${(before.rowTexts || []).length} rows`);

  const after = probes.after || {};
  assertAgreement(`date after the last returned record ${afterLatest}`, after, afterLatest, latest);
  assert(listHas(after, 'No later returned record exists'),
    'after the last returned record: the view states that no later returned record exists in the returned range', (after.listText || '').slice(0, 140));
  const afterIds = await believedIds(afterLatest);
  assert(afterIds.length > 0, 'after the last returned record: the API still returns the beliefs in force', JSON.stringify(afterIds));
  assert(!!after && Array.isArray(after.rowTexts) && after.rowTexts.length === afterIds.length,
    'after the last returned record: the list shows the latest beliefs as the belief in force',
    `${(after.rowTexts || []).length} rows against ${afterIds.length} from the API`);

  const driven = probes.sliderDriven || {};
  assertAgreement('slider driven to 2026-10-25', driven, '2026-10-25', '2026-10-25');
  assert(listHas(driven, HALL_B) && !listHas(driven, HALL_A),
    'slider driven to 2026-10-25: the list holds the Hall B belief and omits Hall A');
}

// ---- the keyboard walk ----------------------------------------------
{
  const day1 = dateStr(dayMs(earliest) + DAY);
  const probes = await drive('keyboard', [
    { goto: `${base}/console#/time`, waitMs: 1000 },
    { type: ['input[type="date"]', earliest] },
    { eval: stateProbe(fmtDay(earliest)), as: 'start' },
    { eval: `(() => { document.getElementById('asof').focus(); return document.activeElement && document.activeElement.id; })()`, as: 'focus' },
    { key: 'ArrowRight' },
    { eval: stateProbe(fmtDay(day1)), as: 'afterRight' },
    { key: 'ArrowLeft' },
    { eval: stateProbe(fmtDay(earliest)), as: 'afterLeft' },
    { key: 'End' },
    { eval: stateProbe(fmtDay(latest)), as: 'afterEnd' },
    { key: 'Home' },
    { eval: stateProbe(fmtDay(earliest)), as: 'afterHome' },
  ]);
  info(`keyboard walk: focus ${JSON.stringify(probes.focus)}, start ${earliest}, ArrowRight ${(probes.afterRight || {}).dateInput?.value}, ArrowLeft ${(probes.afterLeft || {}).dateInput?.value}, End ${(probes.afterEnd || {}).dateInput?.value}, Home ${(probes.afterHome || {}).dateInput?.value}`);
  assert(probes.focus === 'asof', 'keyboard walk: the slider takes focus', JSON.stringify(probes.focus));
  assertAgreement('keyboard walk at the earliest returned date', probes.start || {}, earliest, earliest);
  assertAgreement('keyboard walk after one ArrowRight', probes.afterRight || {}, day1, day1);
  assertAgreement('keyboard walk after one ArrowLeft', probes.afterLeft || {}, earliest, earliest);
  assertAgreement('keyboard walk after End', probes.afterEnd || {}, latest, latest);
  assertAgreement('keyboard walk after Home', probes.afterHome || {}, earliest, earliest);
}

// ---- the failed request ----------------------------------------------
{
  const probes = await drive('failure', [
    { goto: `${base}/console#/time`, waitMs: 1000 },
    { type: ['input[type="date"]', '2026-10-12'] },
    { eval: stateProbe(fmtDay('2026-10-12')), as: 'settled' },
    { eval: FAIL_PROBE, as: 'armed' },
    { type: ['input[type="date"]', '2026-10-25'] },
    { eval: FAIL_READ, as: 'failed' },
  ]);
  const armed = probes.armed || {};
  const failed = probes.failed || {};
  assert(armed.armed === true, 'failed request: the failure was injected against a rendered control', JSON.stringify(armed).slice(0, 80));
  assert(typeof armed.before === 'string' && armed.before.includes(HALL_A),
    'failed request: the list held the Hall A belief before the failure');
  assert(typeof failed.alertText === 'string' && failed.alertText.length > 0,
    'failed request: the failure is announced with role alert', JSON.stringify(failed.alertText));
  assert(typeof failed.listText === 'string' && failed.listText === armed.before,
    'failed request: the previous list stays in place, word for word');
  assert(failed.dateValue === '2026-10-25' && failed.readout === fmtDay('2026-10-25'),
    'failed request: the selected date stays in place on both controls',
    `date input ${JSON.stringify(failed.dateValue)}, readout ${JSON.stringify(failed.readout)}`);
}

// ---- the empty corpus --------------------------------------------------
const EMPTY_PORT = PORT + 500;
const emptyServer = spawn(process.execPath, ['web/server.mjs'], {
  cwd: root,
  env: { ...process.env, DATABASE_URL, WEB_PORT: String(EMPTY_PORT), WEB_NAMESPACE: 's6-empty-namespace' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const emptyBase = `http://127.0.0.1:${EMPTY_PORT}`;
async function waitUpEmpty() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(emptyBase + '/api/overview'); if (r.ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('empty server did not come up');
}
await waitUpEmpty();
{
  const ovEmpty = await (await fetch(emptyBase + '/api/overview')).json();
  assert(ovEmpty.earliest_date === null && ovEmpty.latest_date === null,
    'API: on an empty corpus earliest_date and latest_date read back as null',
    `got ${JSON.stringify(ovEmpty.earliest_date)} and ${JSON.stringify(ovEmpty.latest_date)}`);
  const probes = await drive('empty', [
    { goto: `${emptyBase}/console#/time`, waitMs: 1000 },
    { eval: `(() => ({ text: document.body.textContent, hasSlider: !!document.querySelector('input[type="range"]'), hasDateInput: !!document.querySelector('input[type="date"]') }))()`, as: 'empty' },
    { shot: 'time-empty-1280', width: 1280, height: 1000, fullPage: true },
    { shot: 'time-empty-360', width: 360, height: 900, fullPage: true },
  ]);
  const E = probes.empty || {};
  assert(E.hasSlider === false && E.hasDateInput === false,
    'empty corpus: no slider and no date input are bound', JSON.stringify(E).slice(0, 80));
  assert(typeof E.text === 'string' && E.text.includes('There is no past to travel to yet'),
    'empty corpus: the designed empty state renders');
  assert(typeof E.text === 'string' && !E.text.includes('1970'),
    'empty corpus: nothing on the page binds to 1 January 1970');
  assert(typeof E.text === 'string' && !E.text.includes('First returned'),
    'empty corpus: no earliest returned date is claimed when none is returned');
}

server.kill('SIGTERM');
emptyServer.kill('SIGTERM');
console.log(failures ? `time-travel-d3: ${failures} FAILURES` : 'time-travel-d3: all assertions passed');
process.exit(failures ? 1 : 0);
