/**
 * LongMemEval-style evaluation of MemoryLoom recall.
 *
 * A synthetic haystack (Project Kestrel, a fictional bird-survey field
 * app) of ~120 memories across six dated sessions, with 40 questions
 * in the five LongMemEval families: single-session recall,
 * multi-session recall, temporal reasoning, knowledge update /
 * supersession, and abstention. Every question is scored with
 * deterministic checks against the records recall actually returned
 * (needle rank, answer terms present in the recalled text, believed-at
 * set membership, near-miss absence). No model judge is used: where a
 * string or record check can decide, it decides.
 *
 * This is a measurement, not a gate: it prints and records honest
 * numbers, including the weak spots. Small-n caveats apply — the
 * haystack is small and dense next to the real LongMemEval, which
 * uses ~500 sessions per question; treat these results as a smoke
 * signal for the mechanics, not a benchmark claim.
 *
 * The dataset is generated deterministically below and written to
 * checks/fixtures/longmem-haystack.jsonl on every run, so the
 * committed fixture is exactly what was measured.
 *
 * Usage: DATABASE_URL=postgres://… node checks/eval-longmem.mjs
 * Writes: checks/out/eval-longmem.json, docs/eval-longmem.md
 * Owning file: checks/eval-longmem.mjs
 * Accountable layer: Recall eval layer
 * Provider need: None
 * Declared mode: Keyless, separate dated command in the runbook
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { embedStaged, recallWithReceipts } from '../lib/planes.mjs';
import { believedAt } from '../lib/graph.mjs';
import { preflightOrExit } from './db-preflight.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const NS = 'memoryloom-longmem-eval';
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL missing'); process.exit(1); }
preflightOrExit();

// ---- dataset -----------------------------------------------------------------

const S = {
  s1: '2026-08-03T09:00:00Z',
  s2: '2026-08-17T09:00:00Z',
  s3: '2026-09-02T09:00:00Z',
  s4: '2026-09-21T09:00:00Z',
  s5: '2026-10-05T09:00:00Z',
  s6: '2026-10-19T09:00:00Z',
};
const RECORDS = [];
function rec(id, session, author, text, opts = {}) {
  RECORDS.push({
    id, session, author, text,
    type: opts.type || 'semantic',
    valid_from: opts.valid_from || S[session],
    valid_to: opts.valid_to || null,
    superseded_by: opts.superseded_by || null,
    created_at: opts.created_at || S[session],
  });
}

// Single-session needles (one fact, one session).
rec('lm-ss1', 's2', 'scout', 'The Kestrel field app stores survey photos in the bucket named kestrel-media-eu.');
rec('lm-ss2', 's3', 'herald', 'The Kestrel sync worker retries a failed upload exactly four times before giving up.');
rec('lm-ss3', 's4', 'scout', 'The Kestrel beta cohort is capped at 240 field testers.');
rec('lm-ss4', 's1', 'herald', 'The Kestrel offline map pack for the coastal region weighs 380 megabytes.');
rec('lm-ss5', 's5', 'scout', 'The Kestrel API rate limit for partner accounts is 900 requests per hour.');
rec('lm-ss6', 's2', 'herald', 'The Kestrel crash-report symbol server lives at symbols.kestrel-dev.example.');
rec('lm-ss7', 's3', 'scout', 'The Kestrel field app minimum supported Android version is 12.');
rec('lm-ss8', 's6', 'herald', 'The Kestrel data-retention window for raw GPS tracks is 45 days.');

// Multi-session needles (the answer needs both records).
rec('lm-ms1a', 's2', 'scout', 'The team chose the vendor Fieldnote Systems to print the Kestrel field guides.');
rec('lm-ms1b', 's5', 'herald', 'The printing contract with Fieldnote Systems was signed at a value of 18,500 dollars.');
rec('lm-ms2a', 's1', 'herald', 'The Kestrel staging environment is hosted in the eu-west region.');
rec('lm-ms2b', 's4', 'scout', 'The staging database for Kestrel runs Postgres 16 with the PostGIS 3.4 extension.');
rec('lm-ms3a', 's3', 'scout', 'The Kestrel icon set was drawn by the illustrator Mara Venn.');
rec('lm-ms3b', 's6', 'herald', 'Mara Venn delivered the final icon set with 64 icons.');
rec('lm-ms4a', 's2', 'herald', 'The survey protocol requires two observers per transect.');
rec('lm-ms4b', 's5', 'scout', 'Each transect shift lasts three hours.');
rec('lm-ms5a', 's1', 'scout', 'The Kestrel kickoff budget line for hardware was set at 12,000 dollars.');
rec('lm-ms5b', 's6', 'herald', 'The hardware budget line closed 1,750 dollars under budget.');
rec('lm-ms6a', 's3', 'herald', 'The offline queue in the Kestrel app flushes when the device reaches a Wi-Fi network.');
rec('lm-ms6b', 's4', 'scout', 'A manual flush button was rejected because it drained the battery during tests.');
rec('lm-ms7a', 's2', 'scout', 'The Kestrel alpha testers report bugs through the in-app shake gesture.');
rec('lm-ms7b', 's6', 'herald', 'Shake-gesture bug reports averaged 14 per week in October.');
rec('lm-ms8a', 's4', 'herald', 'The Kestrel export format for researchers is GeoJSON.');
rec('lm-ms8b', 's5', 'scout', 'GeoJSON exports are capped at 50,000 features per file.');

// Temporal needles. Pairs carry valid_to / superseded_by on the old record.
rec('lm-t1a', 's1', 'scout', 'The Kestrel public launch is planned for 14 November 2026.', { valid_to: S.s5, superseded_by: 'lm-t1b' });
rec('lm-t1b', 's5', 'herald', 'The Kestrel public launch moved to 28 November 2026.');
rec('lm-t2a', 's2', 'herald', 'The Kestrel weekly sync call happens on Tuesdays at 10:00.', { valid_to: S.s6, superseded_by: 'lm-t2b' });
rec('lm-t2b', 's6', 'scout', 'The Kestrel weekly sync call moved to Thursdays at 11:30.');
rec('lm-t3', 's3', 'scout', 'The Kestrel team froze the feature list on 2 September 2026, two weeks before the beta opened.');
rec('lm-t4', 's4', 'herald', 'The beta feedback window for Kestrel closes on 9 October 2026.');
rec('lm-t5', 's1', 'herald', 'The first Kestrel field trial ran from 10 to 14 August 2026.');
rec('lm-t6', 's6', 'scout', 'The Kestrel 1.0 release candidate was tagged on 19 October 2026.');
rec('lm-t7a', 's2', 'scout', 'The Kestrel staging freeze begins on 25 August 2026.', { valid_to: S.s4, superseded_by: 'lm-t7b' });
rec('lm-t7b', 's4', 'herald', 'The Kestrel staging freeze begins on 8 September 2026.');
rec('lm-t8', 's5', 'herald', 'The Kestrel security review finished on 5 October 2026, the day before the export feature shipped.');

// Knowledge-update needles (old -> new).
rec('lm-u1a', 's2', 'scout', 'The Kestrel demo day will be held in the Riverside Pavilion.', { valid_to: S.s5, superseded_by: 'lm-u1b' });
rec('lm-u1b', 's5', 'herald', 'The Kestrel demo day moved to the Harbour Hall.');
rec('lm-u2a', 's1', 'herald', 'The Kestrel project lead is Tomas Rey.', { valid_to: S.s4, superseded_by: 'lm-u2b' });
rec('lm-u2b', 's4', 'scout', 'The Kestrel project lead is now Priya Nair.');
rec('lm-u3a', 's3', 'scout', 'The Kestrel Pro subscription costs 8 dollars per month.', { valid_to: S.s6, superseded_by: 'lm-u3b' });
rec('lm-u3b', 's6', 'herald', 'The Kestrel Pro subscription now costs 10 dollars per month.');
rec('lm-u4a', 's1', 'scout', 'Survey photos upload at a maximum size of 12 megabytes each.', { valid_to: S.s5, superseded_by: 'lm-u4b' });
rec('lm-u4b', 's5', 'herald', 'Survey photos now upload at a maximum size of 25 megabytes each.');
rec('lm-u5a', 's2', 'herald', 'The Kestrel design review meets in Room 4 of the annex.', { valid_to: S.s6, superseded_by: 'lm-u5b' });
rec('lm-u5b', 's6', 'scout', 'The Kestrel design review moved to Room 9 of the annex.');
rec('lm-u6a', 's3', 'herald', 'Kestrel beta support is handled through beta-support@kestrel-dev.example.', { valid_to: S.s6, superseded_by: 'lm-u6b' });
rec('lm-u6b', 's6', 'scout', 'Kestrel beta support is now handled through helpdesk@kestrel-dev.example.');
rec('lm-u7a', 's2', 'scout', 'The aerial survey drone for Kestrel is the DJI Mini 3.', { valid_to: S.s4, superseded_by: 'lm-u7b' });
rec('lm-u7b', 's4', 'herald', 'The aerial survey drone for Kestrel was replaced with the DJI Mini 4 Pro.');
rec('lm-u8a', 's1', 'herald', 'The Kestrel onboarding guide is written in Markdown.', { valid_to: S.s5, superseded_by: 'lm-u8b' });
rec('lm-u8b', 's5', 'scout', 'The Kestrel onboarding guide moved to the team wiki.');

// Near-miss records about a different project (abstention confusion set).
rec('lm-os1', 's2', 'scout', 'The Osprey field app tracks river turbidity for the water board.');
rec('lm-os2', 's3', 'herald', 'The Osprey beta runs on the same bench devices as Kestrel.');
rec('lm-os3', 's4', 'scout', 'Osprey survey photos are reviewed every Friday by the water board.');
rec('lm-os4', 's5', 'herald', 'The Osprey sync worker uploads readings every hour on the hour.');
rec('lm-os5', 's1', 'scout', 'Osprey field testers carry green clipboards for the turbidity forms.');

// Distractors: plausible Kestrel facts that answer none of the questions.
const DISTRACTORS = [
  ['s1', 'scout', 'The Kestrel standup moves to the harbour office on rainy days.'],
  ['s1', 'herald', 'The Kestrel app ships with a SQLite store for offline drafts.'],
  ['s1', 'scout', 'The team ordered 30 laminated bird-identification cards for the first trial.'],
  ['s1', 'herald', 'The Kestrel mascot sketch is a heron holding a clipboard.'],
  ['s2', 'scout', 'The Kestrel map layer uses MapLibre tiles cached per region.'],
  ['s2', 'herald', 'A spare charging cable lives in the glove box of the field van.'],
  ['s2', 'scout', 'The Kestrel translation pack covers Welsh and Scots Gaelic place names.'],
  ['s2', 'herald', 'The weekly rota puts herald on data cleaning every second Friday.'],
  ['s3', 'scout', 'The Kestrel poster for the library wall was printed by QuickPress on King Street.'],
  ['s3', 'herald', 'The field team prefers the grey notebooks with the elastic strap.'],
  ['s3', 'scout', 'The Kestrel training video runs eleven minutes including the intro.'],
  ['s3', 'herald', 'A broken tripod was returned to the supplier under warranty in September.'],
  ['s4', 'scout', 'The Kestrel beta survey asks testers five questions after each outing.'],
  ['s4', 'herald', 'The office kettle was replaced after it started tripping the breaker.'],
  ['s4', 'scout', 'The Kestrel help pages link to a printable one-page field checklist.'],
  ['s4', 'herald', 'The demo laptop has a cracked hinge but a healthy battery.'],
  ['s5', 'scout', 'The Kestrel team photo was taken on the steps of the natural history museum.'],
  ['s5', 'herald', 'The survey app chimes softly when a transect point is reached.'],
  ['s5', 'scout', 'The Kestrel winter rota adds a second data-cleaning slot in December.'],
  ['s5', 'herald', 'A lost stylus was found inside the field van door pocket.'],
  ['s6', 'scout', 'The Kestrel release notes thank the harbour cafe for the meeting space.'],
  ['s6', 'herald', 'The team keeps a spare projector remote in the top drawer of the annex desk.'],
  ['s6', 'scout', 'The Kestrel field guide PDF is 96 pages including the index.'],
  ['s6', 'herald', 'The backup bench unit wears a blue case so it is easy to tell apart.'],
  ['s1', 'scout', 'The Kestrel kickoff meeting lasted two hours and ended with a harbour walk.'],
  ['s2', 'herald', 'The survey form asks for wind speed in whole numbers only.'],
  ['s3', 'scout', 'The Kestrel colour palette for charts uses four muted greens.'],
  ['s4', 'herald', 'The night survey add-on was postponed until the spring season.'],
  ['s5', 'scout', 'The Kestrel changelog is read aloud at the start of each demo day rehearsal.'],
  ['s6', 'herald', 'The field kit now includes two head torches for dawn surveys.'],
  ['s1', 'herald', 'The Kestrel repository README carries a photo of the first prototype.'],
  ['s2', 'scout', 'The tide table printout is pinned above the bench in the annex.'],
  ['s3', 'herald', 'The Kestrel onboarding buddy for new testers is the scout agent.'],
  ['s4', 'scout', 'The app draws transect lines in dashed orange on the map.'],
  ['s5', 'herald', 'The Kestrel privacy notice was reviewed by the university ethics contact.'],
  ['s6', 'scout', 'A box of spare lanyards sits under the annex signing-in desk.'],
];
DISTRACTORS.forEach(([session, author, text], i) => rec(`lm-d${String(i + 1).padStart(2, '0')}`, session, author, text, { type: 'episodic' }));

// Parametric work-note distractors (deterministic rotation, no collisions
// with any needle value).
const COMPONENTS = ['photo uploader', 'transect editor', 'tide overlay', 'species picker', 'offline cache', 'export wizard', 'rota planner', 'checklist runner'];
for (let i = 0; i < 28; i++) {
  const session = ['s1', 's2', 's3', 's4', 's5', 's6'][i % 6];
  const author = i % 2 ? 'herald' : 'scout';
  const comp = COMPONENTS[i % COMPONENTS.length];
  const n = 20 + ((i * 7) % 60);
  rec(`lm-w${String(i + 1).padStart(2, '0')}`, session, author, `Work note: the ${comp} check passed with ${n} test cases in the nightly run.`, { type: 'episodic' });
}

// ---- questions -----------------------------------------------------------------

const Q = [];
function q(id, type, query, opts) { Q.push({ id, type, query, ...opts }); }

// single-session: needle in top-k + answer terms in recalled text.
for (let i = 1; i <= 8; i++) {
  const meta = [
    ['Which bucket stores the Kestrel survey photos?', ['kestrel-media-eu']],
    ['How many times does the Kestrel sync worker retry a failed upload?', ['four']],
    ['How many field testers is the Kestrel beta cohort capped at?', ['240']],
    ['How large is the Kestrel offline map pack for the coastal region?', ['380']],
    ['What is the Kestrel API rate limit for partner accounts?', ['900']],
    ['Where does the Kestrel crash-report symbol server live?', ['symbols.kestrel-dev.example']],
    ['What is the minimum supported Android version for the Kestrel field app?', ['version is 12']],
    ['How long are raw GPS tracks retained in Kestrel?', ['45 days']],
  ][i - 1];
  q(`ss${i}`, 'single-session', meta[0], { mode: 'recall', needles: [`lm-ss${i}`], terms: meta[1] });
}
// multi-session: both needles in top-10 + both term sets present.
const MS = [
  ['Which vendor prints the Kestrel field guides, and what was the printing contract value?', ['lm-ms1a', 'lm-ms1b'], ['fieldnote', '18,500']],
  ['Which region hosts the Kestrel staging environment, and what does its database run?', ['lm-ms2a', 'lm-ms2b'], ['eu-west', 'postgis 3.4']],
  ['Who drew the Kestrel icon set, and how many icons did the final set have?', ['lm-ms3a', 'lm-ms3b'], ['mara venn', '64 icons']],
  ['How many observers does a Kestrel transect need, and how long is each shift?', ['lm-ms4a', 'lm-ms4b'], ['two observers', 'three hours']],
  ['What was the Kestrel hardware budget line at kickoff, and how far under budget did it close?', ['lm-ms5a', 'lm-ms5b'], ['12,000', '1,750']],
  ['When does the Kestrel offline queue flush, and why is there no manual flush button?', ['lm-ms6a', 'lm-ms6b'], ['wi-fi', 'battery']],
  ['How do Kestrel alpha testers report bugs, and how many reports came in per week in October?', ['lm-ms7a', 'lm-ms7b'], ['shake gesture', '14 per week']],
  ['What export format does Kestrel give researchers, and what is the per-file feature cap?', ['lm-ms8a', 'lm-ms8b'], ['geojson', '50,000']],
];
MS.forEach(([query, needles, terms], i) => q(`ms${i + 1}`, 'multi-session', query, { mode: 'recall-all', needles, terms }));
// temporal: as-of pairs via believed-at, the rest via recall.
q('t1', 'temporal', 'What was the Kestrel launch date before it moved?', { mode: 'asof', asof: '2026-09-01T00:00:00Z', old_id: 'lm-t1a', new_id: 'lm-t1b', terms: ['14 november'] });
q('t2', 'temporal', 'When was the Kestrel weekly sync call in early September?', { mode: 'asof', asof: '2026-09-10T00:00:00Z', old_id: 'lm-t2a', new_id: 'lm-t2b', terms: ['tuesdays'] });
q('t3', 'temporal', 'When did the Kestrel team freeze the feature list?', { mode: 'recall', needles: ['lm-t3'], terms: ['2 september 2026'] });
q('t4', 'temporal', 'When does the Kestrel beta feedback window close?', { mode: 'recall', needles: ['lm-t4'], terms: ['9 october 2026'] });
q('t5', 'temporal', 'When did the first Kestrel field trial run?', { mode: 'recall', needles: ['lm-t5'], terms: ['10 to 14 august'] });
q('t6', 'temporal', 'When was the Kestrel 1.0 release candidate tagged?', { mode: 'recall', needles: ['lm-t6'], terms: ['19 october 2026'] });
q('t7', 'temporal', 'When did the Kestrel staging freeze begin, as planned in late August?', { mode: 'asof', asof: '2026-08-20T00:00:00Z', old_id: 'lm-t7a', new_id: 'lm-t7b', terms: ['25 august'] });
q('t8', 'temporal', 'When did the Kestrel security review finish?', { mode: 'recall', needles: ['lm-t8'], terms: ['5 october 2026'] });
// knowledge update: the new record must outrank the old one in recall;
// two also check the as-of (old) side through believed-at.
const U = [
  ['Where will the Kestrel demo day be held?', 'lm-u1a', 'lm-u1b', ['harbour hall']],
  ['Who leads the Kestrel project now?', 'lm-u2a', 'lm-u2b', ['priya nair']],
  ['What does the Kestrel Pro subscription cost per month now?', 'lm-u3a', 'lm-u3b', ['10 dollars']],
  ['What is the maximum upload size for a survey photo now?', 'lm-u4a', 'lm-u4b', ['25 megabytes']],
  ['Which room does the Kestrel design review meet in now?', 'lm-u5a', 'lm-u5b', ['room 9']],
  ['How is Kestrel beta support handled now?', 'lm-u6a', 'lm-u6b', ['helpdesk@kestrel-dev.example']],
  ['Which drone does the Kestrel aerial survey use now?', 'lm-u7a', 'lm-u7b', ['dji mini 4 pro']],
  ['Where does the Kestrel onboarding guide live now?', 'lm-u8a', 'lm-u8b', ['team wiki']],
];
U.forEach(([query, old_id, new_id, terms], i) => q(`u${i + 1}`, 'knowledge-update', query, { mode: 'update', old_id, new_id, terms }));
q('u5-asof', 'knowledge-update', 'Which room did the Kestrel design review meet in during September?', { mode: 'asof', asof: '2026-09-15T00:00:00Z', old_id: 'lm-u5a', new_id: 'lm-u5b', terms: ['room 4'] });
q('u8-asof', 'knowledge-update', 'Where was the Kestrel onboarding guide kept in August?', { mode: 'asof', asof: '2026-08-20T00:00:00Z', old_id: 'lm-u8a', new_id: 'lm-u8b', terms: ['markdown'] });
// abstention: nothing in the haystack answers these. Pass = none of the
// designated near-miss records appears in the top-10.
const A = [
  ["What is the Kestrel app's user rating on the app store?", ['lm-ss3']],
  ['Which bucket stores the Osprey survey photos?', ['lm-ss1', 'lm-os3']],
  ['How many field testers does the Osprey beta have?', ['lm-ss3', 'lm-os2']],
  ["What is the Kestrel team's office street address?", ['lm-d30']],
  ['Who designed the Kestrel logo?', ['lm-ms3a', 'lm-ms3b']],
  ['What colour is the Kestrel field vest?', ['lm-os5']],
  ['How many times does the Osprey sync worker retry a failed upload?', ['lm-ss2', 'lm-os4']],
  ['Which caterer is booked for the Kestrel launch event?', ['lm-t1b']],
];
A.forEach(([query, nearmiss], i) => q(`a${i + 1}`, 'abstention', query, { mode: 'abstain', nearmiss }));

// ---- run -----------------------------------------------------------------------

mkdirSync(join(__dir, 'fixtures'), { recursive: true });
writeFileSync(
  join(__dir, 'fixtures', 'longmem-haystack.jsonl'),
  RECORDS.map((r) => JSON.stringify(r)).join('\n') + '\n'
);

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });
await pool.query(`DELETE FROM memories WHERE namespace = $1`, [NS]);
for (const r of RECORDS) {
  await pool.query(
    `INSERT INTO memories (id, namespace, type, scope, text, importance, strength,
                           index_status, approval, grounding_ids, provenance,
                           valid_from, valid_to, superseded_by, created_at)
     VALUES ($1,$2,$3,'global',$4,5,5.0,'staged','live','{}',$5::jsonb,$6,$7,$8,$9)`,
    [
      r.id, NS, r.type, r.text,
      JSON.stringify({ author: r.author, origin: 'eval-seed', source_session: r.session, created_at: r.created_at }),
      r.valid_from, r.valid_to, null, r.created_at,
    ]
  );
}
// Second pass for supersession links (superseded_by is a foreign key
// into memories, so both rows must exist first — same pattern as
// scripts/seed-demo.mjs).
for (const r of RECORDS) {
  if (r.superseded_by) {
    await pool.query(`UPDATE memories SET superseded_by = $2 WHERE id = $1`, [r.id, r.superseded_by]);
  }
}
const embedded = await embedStaged(pool, NS);
console.log(`haystack: ${RECORDS.length} memories seeded, ${embedded} embedded; ${Q.length} questions`);

const rankOf = (ids, id) => { const i = ids.indexOf(id); return i < 0 ? null : i + 1; };
const results = [];
for (const item of Q) {
  const row = { id: item.id, type: item.type, mode: item.mode, query: item.query };
  if (item.mode === 'asof') {
    const believed = await believedAt(pool, NS, new Date(item.asof));
    const ids = believed.map((b) => b.id);
    const oldIn = ids.includes(item.old_id);
    const newIn = ids.includes(item.new_id);
    const oldRow = believed.find((b) => b.id === item.old_id);
    const termsOk = oldRow ? item.terms.every((t) => oldRow.text.toLowerCase().includes(t)) : false;
    row.pass = oldIn && !newIn && termsOk;
    row.detail = `believed-at ${item.asof}: old ${oldIn ? 'present' : 'MISSING'}, new ${newIn ? 'PRESENT (wrong)' : 'absent'}, terms ${termsOk ? 'ok' : 'missing'}`;
  } else {
    const out = await recallWithReceipts(pool, { namespace: NS, query: item.query, k: 10 });
    const ids = out.results.map((r) => r.id);
    const joined = out.results.map((r) => r.text).join(' \n ').toLowerCase();
    row.returned = ids.length;
    if (item.mode === 'abstain') {
      const hits = item.nearmiss.filter((id) => ids.includes(id));
      row.pass = hits.length === 0;
      row.detail = hits.length ? `false hits in top-10: ${hits.join(', ')}` : `no near-miss in top-10 (${ids.length} unrelated results returned)`;
    } else if (item.mode === 'recall-all') {
      const ranks = item.needles.map((id) => rankOf(ids, id));
      row.ranks = ranks;
      row.effective_rank = ranks.every((r) => r !== null) ? Math.max(...ranks) : null;
      const termsOk = item.terms.every((t) => joined.includes(t));
      row.pass = row.effective_rank !== null && termsOk;
      row.detail = `ranks ${ranks.map((r) => r ?? '—').join('/')}, terms ${termsOk ? 'ok' : 'missing'}`;
    } else if (item.mode === 'update') {
      const newRank = rankOf(ids, item.new_id);
      const oldRank = rankOf(ids, item.old_id);
      row.ranks = { new: newRank, old: oldRank };
      row.effective_rank = newRank;
      const newRow = out.results.find((r) => r.id === item.new_id);
      const termsOk = newRow ? item.terms.every((t) => newRow.text.toLowerCase().includes(t)) : false;
      row.pass = newRank !== null && (oldRank === null || newRank < oldRank) && termsOk;
      row.detail = `new rank ${newRank ?? '—'}, old rank ${oldRank ?? '—'}, terms ${termsOk ? 'ok' : 'missing'}`;
    } else {
      const rank = rankOf(ids, item.needles[0]);
      row.effective_rank = rank;
      const termsOk = item.terms.every((t) => joined.includes(t));
      row.pass = rank !== null && termsOk;
      row.detail = `rank ${rank ?? '—'}, terms ${termsOk ? 'ok' : 'missing'}`;
    }
  }
  results.push(row);
  console.log(`  [${item.type}] ${item.id} ${row.pass ? 'PASS' : 'FAIL'} — ${row.detail}`);
}
await pool.end();

// ---- aggregates ------------------------------------------------------------------

const byType = {};
for (const r of results) {
  byType[r.type] ||= { total: 0, passed: 0 };
  byType[r.type].total += 1;
  if (r.pass) byType[r.type].passed += 1;
}
const ranked = results.filter((r) => r.mode !== 'asof' && r.mode !== 'abstain');
const recallAt = (k) => {
  const hit = ranked.filter((r) => r.effective_rank !== null && r.effective_rank !== undefined && r.effective_rank <= k).length;
  return { k, hit, total: ranked.length, rate: ranked.length ? Math.round((hit / ranked.length) * 1000) / 1000 : null };
};
const recall = [recallAt(1), recallAt(5), recallAt(10)];
const abst = byType['abstention'] || { total: 0, passed: 0 };

const out = {
  at: new Date().toISOString(),
  haystack: { memories: RECORDS.length, sessions: Object.keys(S).length, namespace: NS },
  questions: { total: Q.length, by_type: byType },
  recall_at_k: recall,
  results,
};
mkdirSync(join(__dir, 'out'), { recursive: true });
writeFileSync(join(__dir, 'out', 'eval-longmem.json'), JSON.stringify(out, null, 2));

const pct = (a, b) => (b ? `${a}/${b} (${Math.round((a / b) * 100)}%)` : 'n/a');
const doc = `# Eval — LongMemEval-style recall evaluation

Run ${out.at}. Harness: checks/eval-longmem.mjs. Dataset:
checks/fixtures/longmem-haystack.jsonl (generated deterministically by
the harness; the committed fixture is exactly what was measured).

## Shape

- Haystack: ${RECORDS.length} memories about a fictional project
  (Project Kestrel), written as six dated sessions from
  ${S.s1.slice(0, 10)} to ${S.s6.slice(0, 10)}, seeded into a throwaway
  database and nothing else. Needles are buried among hand-written and
  templated distractor work notes.
- Questions: ${Q.length} — ${byType['single-session']?.total ?? 0} single-session,
  ${byType['multi-session']?.total ?? 0} multi-session,
  ${byType['temporal']?.total ?? 0} temporal,
  ${byType['knowledge-update']?.total ?? 0} knowledge-update (two of them asked as-of an
  earlier date), ${byType['abstention']?.total ?? 0} abstention.
- Scoring is deterministic: needle rank in the receipts recall
  actually returned, answer terms present in the recalled text,
  believed-at set membership for as-of questions, and near-miss
  absence for abstention. No model judge was used.

## Results

- Recall@1: ${pct(recall[0].hit, recall[0].total)} of answerable ranked questions.
- Recall@5: ${pct(recall[1].hit, recall[1].total)}.
- Recall@10: ${pct(recall[2].hit, recall[2].total)}.
- Accuracy by type (full per-type criterion):
${Object.entries(byType).map(([t, v]) => `  - ${t}: ${pct(v.passed, v.total)}`).join('\n')}

## Caveats, stated plainly

- Small n: ${Q.length} questions against a ${RECORDS.length}-memory
  haystack. The real LongMemEval uses roughly 500 sessions of
  haystack per question; this is a smoke signal for the mechanics,
  not a benchmark score, and the percentages swing on single items.
- The haystack is dense: distractors share vocabulary with needles by
  design, which makes ranking harder per item than a sparse corpus
  would, but the corpus is still small enough that the vector leg
  sees every record.
- Recall ranking has no recency preference: for knowledge-update
  questions the newer record must outrank a near-identical older one
  on relevance alone. The bi-temporal believed-at path is the
  product's mechanism for "what was true then", and it is scored
  separately above.
- Abstention here is measured at the recall layer (a near-miss record
  in the top-10 is a false hit). The hybrid vector leg returns nearest
  neighbours even for unanswerable questions, so the top-10 is rarely
  empty; the product's abstention behaviour lives in the receipt and
  narration layer above recall, which this eval does not score.

Raw per-question results: checks/out/eval-longmem.json.
`;
mkdirSync(join(__dir, '..', 'docs'), { recursive: true });
writeFileSync(join(__dir, '..', 'docs', 'eval-longmem.md'), doc);

console.log(`\nrecall@1 ${recall[0].rate} · recall@5 ${recall[1].rate} · recall@10 ${recall[2].rate}`);
for (const [t, v] of Object.entries(byType)) console.log(`${t}: ${v.passed}/${v.total}`);
console.log('wrote checks/out/eval-longmem.json and docs/eval-longmem.md');
