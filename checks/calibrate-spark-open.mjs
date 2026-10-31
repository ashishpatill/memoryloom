/**
 * Calibration: Muse Spark Open on Baseten (Tier 0) against the two
 * existing synthetic golden sets, before any product path uses it.
 *
 * Part A runs the 40-item write-gate golden set through the
 * provider's 'prescreen' task (a drafting aid — Jev still decides)
 * and reports the lean's agreement with each item's expected outcome
 * and with the recorded Jev decision. Part B runs the 36-item Meta
 * calibration set (consolidate / narrate / explain) through the same
 * provider with the same prompts and deterministic scorers that
 * produced the recorded Wonder outcomes. The golden items and
 * scorers below are replicated from checks/calibrate-meta.mjs
 * (verified line for line), because that script exports nothing.
 *
 * Every call goes through the router in live mode with
 * spendClass=calibration, so spend is logged and cached.
 * Usage: node checks/calibrate-spark-open.mjs
 * Writes: checks/out/calibration-spark-open.json
 */
process.env.MEMORYLOOM_ROUTER_MODE = 'live';

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { route } from '../router/router.mjs';
import { spendSummary } from '../router/spend.mjs';
import { GATE_GOLDEN_ITEMS } from './fixtures/gate-golden.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'out');
const outPath = join(outDir, 'calibration-spark-open.json');

const jevRecorded = JSON.parse(
  readFileSync(join(outDir, 'calibration-jev-gate.json'), 'utf8'),
);
const jevByName = new Map(
  (jevRecorded.results || []).map((r) => [r.name, r.decision]),
);

const metaRecorded = JSON.parse(
  readFileSync(join(outDir, 'calibration-meta.json'), 'utf8'),
);
const wonderFullTier = (metaRecorded.tiers || []).find(
  (t) => t.tier === 'wonder-full',
);
const wonderFullByKey = new Map(
  (wonderFullTier?.items || []).map((item) => [
    `${item.kind}:${item.name}`,
    item.pass,
  ]),
);

async function runPool(items, workerCount, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(workerCount, items.length) }, () => worker()),
  );
  return results;
}

function pct(count, total) {
  return total ? Math.round((count / total) * 1000) / 10 : 0;
}

const C = {
  s06: 'Hybrid recall fuses a keyword ranking with a vector ranking.',
  s17: 'The keyword leg of recall matches staged and indexed rows.',
  s02: 'Recall returns a receipt that cites the record id for every result.',
  s09: 'The write gate queues low evidence claims instead of storing them.',
  s11: 'Embeddings are computed after a memory is staged, not before.',
  s13: 'Memories carry valid from and valid to dates for time travel recall.',
  s15: 'A superseded fact stays readable after a newer fact replaces it.',
  s19: 'Decay lowers the strength of memories that are never recalled.',
  s23: 'Cold start means a namespace has no live memories yet.',
  s04: 'The fictional product is a solar lamp kit assembled from flat packed parts.',
};

const consolidateItems = [
  { name: 'c1', episodes: [{ id: 'e1', text: C.s06 }, { id: 'e2', text: C.s06.toLowerCase() }, { id: 'e3', text: C.s17 }], atoms: 2, phrases: ['keyword ranking', 'staged and indexed'] },
  { name: 'c2', episodes: [{ id: 'e1', text: C.s02 }, { id: 'e2', text: '  ' + C.s02 + ' ' }], atoms: 1, phrases: ['receipt'] },
  { name: 'c3', episodes: [{ id: 'e1', text: C.s11 }, { id: 'e2', text: C.s13 }, { id: 'e3', text: C.s11 }], atoms: 2, phrases: ['Embeddings are computed', 'valid from'] },
  { name: 'c4', episodes: [{ id: 'e1', text: C.s09 }, { id: 'e2', text: C.s19 }], atoms: 2, phrases: ['write gate queues', 'Decay lowers'] },
  { name: 'c5', episodes: [{ id: 'e1', text: C.s15 }, { id: 'e2', text: C.s15.toUpperCase() }, { id: 'e3', text: C.s15 }, { id: 'e4', text: C.s23 }], atoms: 2, phrases: ['superseded fact', 'Cold start'] },
  { name: 'c6', episodes: [{ id: 'e1', text: C.s04 }], atoms: 1, phrases: ['solar lamp'] },
  { name: 'c7', episodes: [{ id: 'e1', text: C.s17 }, { id: 'e2', text: C.s06 }, { id: 'e3', text: C.s17.toLowerCase() }], atoms: 2, phrases: ['keyword leg', 'vector ranking'] },
  { name: 'c8', episodes: [{ id: 'e1', text: C.s13 }, { id: 'e2', text: C.s15 }], atoms: 2, phrases: ['time travel', 'stays readable'] },
  { name: 'c9', episodes: [{ id: 'e1', text: C.s19 }, { id: 'e2', text: C.s19 }, { id: 'e3', text: C.s19 }], atoms: 1, phrases: ['never recalled'] },
  { name: 'c10', episodes: [{ id: 'e1', text: C.s23 }, { id: 'e2', text: C.s02 }], atoms: 2, phrases: ['no live memories', 'record id'] },
  { name: 'c11', episodes: [{ id: 'e1', text: C.s11.toLowerCase() }, { id: 'e2', text: C.s11 }], atoms: 1, phrases: ['after a memory is staged'] },
  { name: 'c12', episodes: [{ id: 'e1', text: C.s09 }, { id: 'e2', text: C.s09.toLowerCase() }, { id: 'e3', text: C.s04 }, { id: 'e4', text: C.s04.toLowerCase() }], atoms: 2, phrases: ['low evidence', 'flat packed'] },
];

const narrateItems = [
  { name: 'n1', query: 'how does recall prove itself', results: [{ id: 'm-s02', text: C.s02 }], phrases: ['receipt'], forbidden: 'solar lamp' },
  { name: 'n2', query: 'how does hybrid recall work', results: [{ id: 'm-s06', text: C.s06 }, { id: 'm-s17', text: C.s17 }], phrases: ['keyword'], forbidden: 'solar lamp' },
  { name: 'n3', query: 'what happens to stale memories', results: [{ id: 'm-s19', text: C.s19 }], phrases: ['strength'], forbidden: 'solar lamp' },
  { name: 'n4', query: 'what does the write gate do with weak claims', results: [{ id: 'm-s09', text: C.s09 }], phrases: ['queues'], forbidden: 'solar lamp' },
  { name: 'n5', query: 'when are embeddings computed', results: [{ id: 'm-s11', text: C.s11 }], phrases: ['staged'], forbidden: 'Cold start' },
  { name: 'n6', query: 'can we see what the team believed last month', results: [{ id: 'm-s13', text: C.s13 }, { id: 'm-s15', text: C.s15 }], phrases: ['valid'], forbidden: 'solar lamp' },
  { name: 'n7', query: 'what is cold start', results: [{ id: 'm-s23', text: C.s23 }], phrases: ['no live memories'], forbidden: 'solar lamp' },
  { name: 'n8', query: 'what is the demo product', results: [{ id: 'm-s04', text: C.s04 }], phrases: ['solar lamp'], forbidden: 'write gate queues' },
  { name: 'n9', query: 'which rows does the keyword leg match', results: [{ id: 'm-s17', text: C.s17 }], phrases: ['staged and indexed'], forbidden: 'vector ranking' },
  { name: 'n10', query: 'what stays readable after replacement', results: [{ id: 'm-s15', text: C.s15 }], phrases: ['superseded'], forbidden: 'solar lamp' },
  { name: 'n11', query: 'how do the two recall legs combine', results: [{ id: 'm-s06', text: C.s06 }, { id: 'm-s02', text: C.s02 }], phrases: ['fuses'], forbidden: 'solar lamp' },
  { name: 'n12', query: 'what happens before a memory is embedded', results: [{ id: 'm-s11', text: C.s11 }, { id: 'm-s09', text: C.s09 }], phrases: ['staged'], forbidden: 'solar lamp' },
];

const explainItems = [
  ['Monday', 'Friday', 'weekly planning session'],
  ['six hours', 'three hours', 'lamp charging time'],
  ['five seconds', 'ten seconds', 'device reset hold'],
  ['forty households', 'sixty households', 'pilot size'],
  ['two thousand characters', 'five hundred characters', 'ingest chunk limit'],
  ['RRF k=60', 'RRF k=30', 'fusion constant'],
  ['staged first', 'indexed first', 'embedding order'],
  ['human always', 'auto-approved', 'procedural routing'],
  ['receipt cites the record id', 'no receipt is kept', 'recall evidence'],
  ['strength decays', 'strength never changes', 'decay behaviour'],
  ['superseded stays readable', 'superseded is deleted', 'superseded handling'],
  ['two grounding records', 'no grounding records', 'auto-approve evidence bar'],
].map(([av, bv, topic], i) => ({
  name: `x${i + 1}`,
  a: { id: `x${i + 1}a`, text: `For ${topic}, the current record says: ${av}.` },
  b: { id: `x${i + 1}b`, text: `For ${topic}, the current record says: ${bv}.` },
  phrases: [av, bv],
}));

function scoreConsolidate(item, result) {
  if (!result || !Array.isArray(result.atoms)) return { pass: false, why: 'no atoms' };
  const joined = result.atoms.map((a) => a.text).join(' \n ').toLowerCase();
  const missing = item.phrases.filter((p) => !joined.includes(p.toLowerCase()));
  if (result.atoms.length !== item.atoms) return { pass: false, why: `atoms ${result.atoms.length} != ${item.atoms}` };
  if (missing.length) return { pass: false, why: `missing phrases: ${missing.join('; ')}` };
  return { pass: true };
}

function scoreNarrate(item, result) {
  if (!result || typeof result.narration !== 'string') return { pass: false, why: 'no narration' };
  const want = item.results.map((r) => r.id);
  const got = new Set(result.receipts || []);
  const missingReceipts = want.filter((id) => !got.has(id));
  if (missingReceipts.length) return { pass: false, why: `missing receipts: ${missingReceipts.join(',')}` };
  const low = result.narration.toLowerCase();
  const missing = item.phrases.filter((p) => !low.includes(p.toLowerCase()));
  if (missing.length) return { pass: false, why: `missing phrases: ${missing.join('; ')}` };
  if (item.forbidden && low.includes(item.forbidden.toLowerCase())) {
    return { pass: false, why: `invented content: ${item.forbidden}` };
  }
  return { pass: true };
}

function scoreExplain(item, result) {
  if (!result || typeof result.explanation !== 'string') return { pass: false, why: 'no explanation' };
  const text = result.explanation;
  const low = text.toLowerCase();
  const cites = new Set(result.cites || []);
  const citesOk = (cites.has(item.a.id) && cites.has(item.b.id)) || (text.includes(item.a.id) && text.includes(item.b.id));
  if (!citesOk) return { pass: false, why: 'both record ids not cited' };
  const missing = item.phrases.filter((p) => !low.includes(p.toLowerCase()));
  if (missing.length) return { pass: false, why: `missing phrases: ${missing.join('; ')}` };
  if (!/(differ|conflict|contradict|while|whereas|but|instead|disagree|inconsistent)/i.test(text)) {
    return { pass: false, why: 'no contrast language' };
  }
  return { pass: true };
}

const gateItems = await runPool(GATE_GOLDEN_ITEMS, 4, async (item) => {
  let r = null;
  let result = null;
  try {
    r = await route(
      'prescreen',
      { proposal: item.proposal, evidence: item.evidence },
      { provider: 'baseten', synthetic: true, spendClass: 'calibration' },
    );
    result = r?.result ?? null;
  } catch {
    r = null;
    result = null;
  }
  const lean = result?.lean ?? null;
  const jev = jevByName.get(item.name) ?? null;
  return {
    name: item.name,
    expect: item.expect,
    lean,
    grounding_ok: result?.grounding_ok ?? null,
    reason: result?.reason ?? null,
    provider_ok: r?.provider_used === 'baseten',
    cached: r?.cached ?? false,
    agree_expect: lean === item.expect,
    agree_jev: jev !== null && lean === jev,
  };
});

const gateTotal = gateItems.length;
const gateProviderOk = gateItems.filter((item) => item.provider_ok).length;
const agreeExpectCount = gateItems.filter((item) => item.agree_expect).length;
const agreeJevCount = gateItems.filter((item) => item.agree_jev).length;

const disagreementsVsExpect = gateItems
  .filter((item) => !item.agree_expect)
  .map((item) => ({
    name: item.name,
    expect: item.expect,
    jev: jevByName.get(item.name) ?? null,
    lean: item.lean,
  }));

const disagreementsVsJev = gateItems
  .filter((item) => !item.agree_jev)
  .map((item) => ({
    name: item.name,
    expect: item.expect,
    jev: jevByName.get(item.name) ?? null,
    lean: item.lean,
  }));

if (gateProviderOk === 0) {
  console.warn(
    '!!! WARNING: BASETEN provider_ok IS 0 FOR THE WRITE-GATE SET — NO PRESCREEN CALLS WERE SERVED BY baseten. CONTINUING WITH PART B FOR SPEND-GUARD AND DIAGNOSTIC COMPLETENESS. !!!',
  );
}

const metaWork = [
  ...consolidateItems.map((item) => ({
    name: item.name,
    kind: 'consolidate',
    item,
    payload: { episodes: item.episodes },
    score: scoreConsolidate,
  })),
  ...narrateItems.map((item) => ({
    name: item.name,
    kind: 'narrate',
    item,
    payload: { query: item.query, results: item.results },
    score: scoreNarrate,
  })),
  ...explainItems.map((item) => ({
    name: item.name,
    kind: 'explain',
    item,
    payload: { a: item.a, b: item.b },
    score: scoreExplain,
  })),
];

const metaItems = await runPool(metaWork, 4, async (work) => {
  let r = null;
  let result = null;
  try {
    r = await route(work.kind, work.payload, {
      provider: 'baseten',
      synthetic: true,
      spendClass: 'calibration',
    });
    result = r?.result ?? null;
  } catch {
    r = null;
    result = null;
  }
  let scored;
  if (r?.provider_used === 'baseten') {
    scored = work.score(work.item, result);
  } else {
    scored = { pass: false, why: `provider_used=${r?.provider_used}` };
  }
  return {
    name: work.name,
    kind: work.kind,
    pass: scored.pass,
    why: scored.why ?? null,
    cached: r?.cached ?? false,
  };
});

const metaTotal = metaItems.length;
const metaPassed = metaItems.filter((item) => item.pass).length;

const differingFromWonder = metaItems
  .filter((item) => {
    const key = `${item.kind}:${item.name}`;
    return wonderFullByKey.has(key) && wonderFullByKey.get(key) !== item.pass;
  })
  .map((item) => ({
    name: item.name,
    kind: item.kind,
    spark_pass: item.pass,
    wonder_full_pass: wonderFullByKey.get(`${item.kind}:${item.name}`),
    why: item.why,
  }));

const output = {
  at: new Date().toISOString(),
  model: 'meta-models/muse-spark-open-1026',
  provider: 'baseten',
  tier: 'tier0',
  effort: {
    prescreen: 'low',
    consolidate: 'medium',
    narrate: 'medium',
    explain: 'medium',
  },
  gate_set: {
    total: gateTotal,
    provider_ok: gateProviderOk,
    agree_expect: {
      count: agreeExpectCount,
      pct: pct(agreeExpectCount, gateTotal),
    },
    agree_jev: { count: agreeJevCount, pct: pct(agreeJevCount, gateTotal) },
    disagreements_vs_expect: disagreementsVsExpect,
    disagreements_vs_jev: disagreementsVsJev,
    items: gateItems,
  },
  meta_set: {
    total: metaTotal,
    passed: metaPassed,
    wonder_full_recorded_passed: wonderFullTier?.passed ?? 36,
    differing_from_wonder: differingFromWonder,
    items: metaItems,
  },
  spend_calibration_class: await spendSummary('baseten', 'calibration'),
};

mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);

console.log(
  JSON.stringify({
    out: outPath,
    gate_set: {
      total: gateTotal,
      provider_ok: gateProviderOk,
      agree_expect: output.gate_set.agree_expect,
      agree_jev: output.gate_set.agree_jev,
      disagreements_vs_expect: disagreementsVsExpect.length,
      disagreements_vs_jev: disagreementsVsJev.length,
    },
    meta_set: {
      total: metaTotal,
      passed: metaPassed,
      differing_from_wonder: differingFromWonder.length,
    },
    spend_calibration_class: output.spend_calibration_class,
  }),
);
