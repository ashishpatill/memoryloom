/* Landing page behaviour, design tokens v2.
 *
 * Every figure on this page that shows data renders from the real
 * backend (web/api.mjs) against the seeded demo namespace:
 *   - the hero weave, from GET /api/graph;
 *   - the believed-at answers, from GET /api/believed;
 *   - the learning story, from GET /api/learning;
 *   - the spend total, from GET /api/spend.
 * Nothing here is a canned picture: if the API is unreachable each
 * figure says so in its own designed empty state.
 *
 * The weave follows the tokens v2 graph discipline: ink threads told
 * apart by position and label, supersession as a dashed ink arc,
 * contradiction as a dotted ink arc, sources as ink diamonds, and
 * the single accent spent once, on the playhead, because the
 * playhead marks the moment a memory moved. The renderer itself is
 * shared with the console: web/public/graph.js (loaded before this
 * file) is the one graph layout in the product since Iteration 5.2. */
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (t) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

  /* ---- Hero weave: rendered by the shared v2 renderer (graph.js) - */

  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const state = document.getElementById('heroState');
  const svg = document.getElementById('heroGraph');
  const toggleBtn = document.getElementById('heroToggle');
  const heroLoading = document.getElementById('heroLoading');
  const heroCtl = document.getElementById('heroCtl');
  fetch('/api/graph')
    .then((r) => { if (!r.ok) throw new Error('api ' + r.status); return r.json(); })
    .then((graph) => {
      const mem = graph.nodes.filter((n) => n.kind === 'memory' || n.kind === 'proposal').length;
      if (heroLoading) heroLoading.remove();
      if (!mem) {
        // Honest empty state (Iteration 5.3, Finding I): an unseeded
        // store is not "0 records · live" over a blank figure, it
        // gets the designed empty state, in the landing's voice, the
        // way the console graph already had one.
        state.textContent = 'no records yet';
        svg.outerHTML = '<div class="empty-state" style="margin:6px"><p class="empty-title">The weave is empty</p><p>This store holds no records yet, so there is nothing to weave. When an approved memory lands, this figure draws it from the store. Nothing here is a canned picture.</p></div>';
        return;
      }
      state.textContent = mem + ' records · live';
      const ctl = MemoryLoomGraph.renderGraph(svg, graph, {
        animated: true,
        onFinish: () => { if (toggleBtn) toggleBtn.textContent = 'Replay'; },
      });
      // The role img summary is built from the returned data and
      // the drawn figure (card S8, Section 6.2): the thread count,
      // the knot count and the date range, never typed in.
      const times = graph.nodes.map((n) => n.recorded_at || n.created_at).filter(Boolean).map((t) => new Date(t).getTime()).sort((a, b) => a - b);
      if (times.length) svg.setAttribute('aria-label', 'The live store as a weave. ' + svg.dataset.threadCount + ' threads and ' + svg.dataset.knotCount + ' knots, recorded from ' + fmtDate(times[0]) + ' to ' + fmtDate(times[times.length - 1]) + '.');
      window.__weaveCtl = ctl;
      // Reduced motion (card S8, Section 6.2): the weave settles
      // at its final state at once and the control offers Replay
      // only. A replay the reader asks for still runs the sweep.
      if (reduced) { ctl.settle(); if (toggleBtn) toggleBtn.textContent = 'Replay'; }
      if (heroCtl) heroCtl.style.display = '';
      if (toggleBtn) toggleBtn.addEventListener('click', () => { toggleBtn.textContent = ctl.toggle() ? 'Play' : 'Pause'; });
    })
    .catch(() => {
      // Section 6.11 failure row for the graph call: the words in
      // a role alert inside the figure area, the rest of the page
      // in place, no stale figure presented as current.
      if (heroLoading) heroLoading.remove();
      state.textContent = 'could not be loaded';
      svg.outerHTML = '<div class="empty-state" style="margin:6px"><p role="alert" style="margin:0 0 var(--space-2)"><strong>The records could not be loaded.</strong></p><p>The store did not answer. Try again in a moment. Nothing here is a canned picture, so there is no honest fallback image.</p></div>';
    });

  /* ---- Believed-at, live ----------------------------------------- */
  /* The believed at panel carries the receipt under the same rule
     as recall (card S5, Section 6.5 of the master plan): seven
     labelled parts in the text face, one fact per part, and only
     records that resolve in the store named as grounding. The
     believed at answer arrives with its grounding ids already
     dereferenced by the API. The origin words match the console's
     gloss, so a route reads the same way on both surfaces. A
     record link hands its id to the console through session
     storage, and the console opens that record's trail. */
  const ORIGIN_PLAIN = {
    propose: 'a proposal', 'propose-auto': 'an automatic proposal', 'propose-jev': 'a gated proposal',
    ingest_file: 'a file import', consolidation: 'consolidation', 'mcp-store': 'a direct store', seed: 'the seed',
  };
  const originPlain = (o) => ORIGIN_PLAIN[o] || String(o || 'None').replace(/_/g, ' ');
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-record-link]');
    if (a) { try { sessionStorage.setItem('ml-open-record', a.dataset.recordLink); } catch { /* the link still lands on the graph */ } }
  });
  function believedReceipt(hit) {
    const rests = (hit.grounding_ids && hit.grounding_ids.length)
      ? hit.grounding_ids.map((g) => '<a class="record-id" href="/console#/graph" data-record-link="' + esc(g) + '" aria-label="Open the record ' + esc(g) + ' in the console memory graph">' + esc(g) + '</a>').join('')
      : 'No grounding record';
    const facts = [
      ['Record', '<a href="/console#/graph" data-record-link="' + esc(hit.id) + '" aria-label="Open the record ' + esc(hit.id) + ' in the console memory graph">' + esc(hit.id) + '</a>'],
      ['Written by', esc(hit.author || 'None')],
      ['How it arrived', 'Through ' + esc(originPlain(hit.origin))],
      ['Recorded', fmtDate(hit.recorded_at)],
      ['Valid from', fmtDate(hit.valid_from)],
      ['Valid to', hit.valid_to ? fmtDate(hit.valid_to) : 'Still held'],
      ['Rests on', rests, true],
    ];
    const items = facts.map(([l, v, wide]) =>
      '<div class="record-fact' + (wide ? ' wide' : '') + '"><dt class="record-label">' + esc(l) + '</dt><dd class="record-value">' + v + '</dd></div>').join('');
    return '<aside class="record receipt" aria-label="Receipt"><dl class="record-list">' + items + '</dl></aside>';
  }
  function believed(id, at, wantId) {
    const target = document.getElementById(id);
    if (!target) return;
    const card = target.closest('.card');
    const settleLoading = () => { const l = card && card.querySelector('.believed-loading'); if (l) l.remove(); };
    fetch('/api/believed?at=' + encodeURIComponent(at))
      .then((r) => { if (!r.ok) throw new Error('api ' + r.status); return r.json(); })
      .then((rows) => {
        settleLoading();
        const hit = rows.find((r) => r.id === wantId);
        if (!hit) { target.textContent = 'The store holds no record that was believed on this date.'; return; }
        target.textContent = hit.text;
        target.insertAdjacentHTML('afterend', believedReceipt(hit));
      })
      .catch(() => {
        // Section 6.11 failure row for the believed at call: the
        // words once, in a role alert in the figure area, with no
        // stale answer left standing in either card.
        settleLoading();
        const panel = document.getElementById('believedPanel');
        if (panel && !document.getElementById('believedAlert')) {
          panel.insertAdjacentHTML('beforebegin', '<p class="view-alert" role="alert" id="believedAlert">The records could not be loaded.</p>');
        }
        target.textContent = 'No answer could be loaded for this date.';
      });
  }
  believed('believed12', '2026-10-12T00:00:00Z', 'demo-v1');
  believed('believed25', '2026-10-25T00:00:00Z', 'demo-v2');

  /* ---- Learning story, live -------------------------------------- */
  const learnState = document.getElementById('learningState');
  const learnSteps = document.getElementById('learningSteps');
  if (learnSteps) {
    const badgeFor = (decision) => {
      if (decision === 'approve') return '<span class="badge" data-state="approved">approved</span>';
      if (decision === 'escalate') return '<span class="badge" data-state="escalated">escalated</span>';
      if (decision === 'reject') return '<span class="badge" data-state="rejected">rejected</span>';
      return '';
    };
    fetch('/api/learning')
      .then((r) => { if (!r.ok) throw new Error('api ' + r.status); return r.json(); })
      .then((data) => {
        const events = [...(data.events || [])].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        const story = events.filter((e) =>
          e.subject_id === 'lodge-global-claim' || e.kind === 'promotion_decision' || e.kind === 'lesson_applied');
        if (!story.length) {
          // Connected but empty is a different truth from a dead
          // database (5.3 re-review): the store answered, it simply
          // holds no learning story, say exactly that, and name
          // the condition under which the story gets recorded.
          learnState.textContent = 'no story recorded yet';
          learnSteps.innerHTML = '<div class="empty-state"><h3>No learning story recorded yet</h3><p>This store is connected and answering. It holds no learning story yet. A story appears here when real work is recorded through the gate.</p></div>';
          const auditEl = document.getElementById('learningAudit');
          if (auditEl && data.audit) {
            auditEl.textContent = 'Lesson audit, read live. ' + data.audit.checked + ' standing lesson(s) checked, ' + data.audit.forged_lesson_ids.length + ' forged. A lesson whose record carries no gate verdict is forged by definition and is quarantined.';
          }
          return;
        }
        learnState.textContent = story.length + ' recorded events · live';
        const rows = story.map((e) => {
          let kind = e.kind, evidence = '';
          if (e.kind === 'proposal') {
            kind = 'Proposal · ' + e.actor;
            const ids = e.evidence?.grounding_ids || [];
            evidence = ids.length ? 'Cited records. ' + ids.join(', ') + '.' : 'It cited no records.';
          } else if (e.kind === 'gate_verdict') {
            kind = 'Gate verdict · Jev';
            const d = e.evidence?.decision;
            evidence = (d ? badgeFor(d.decision) + ' ' : '') + 'Reason given. ' + esc(d?.reason || e.summary);
            return '<div class="step-row"><span class="step-kind">' + esc(kind) + '</span><div><p>' + esc(e.summary) + '</p><p class="evidence-line">' + evidence + '</p></div></div>';
          } else if (e.kind === 'in_turn_correction') {
            kind = 'Correction · same turn';
            evidence = 'Corrected directive. ' + esc(e.evidence?.correction || '');
          } else if (e.kind === 'eval_outcome') {
            kind = 'Lesson proposed';
            // Derived, not hardcoded (Iteration 5.3, Finding H):
            // pair each recorded proposal for this task with the
            // gate verdict that followed it and count the verdicts
            // by how many records the claim cited. The old line was
            // a literal string that omitted the 1-citation
            // escalation, on a figure captioned "every line is an
            // event or a verdict read live from the store".
            const tally = new Map();
            let cited = null;
            for (const ev of events) {
              if (ev.subject_id !== 'lodge-global-claim') continue;
              if (ev.kind === 'proposal') cited = (ev.evidence?.grounding_ids || []).length;
              else if (ev.kind === 'gate_verdict' && cited !== null) {
                const dec = ev.evidence?.decision?.decision || 'recorded';
                const key = cited + '|' + dec;
                tally.set(key, (tally.get(key) || 0) + 1);
                cited = null;
              }
            }
            const parts = [...tally.entries()]
              .sort((a, b) => Number(a[0].split('|')[0]) - Number(b[0].split('|')[0]))
              .map(([key, n]) => {
                const [g, dec] = key.split('|');
                const word = dec === 'approve' ? 'approved' : dec === 'escalate' ? 'escalated' : dec;
                return g + ' citation' + (g === '1' ? '' : 's') + ' ' + word + (n > 1 ? ' ×' + n : '');
              });
            evidence = 'Checked against the recorded verdicts. ' + (parts.length ? parts.join(', ') + '.' : 'No verdicts recorded for this task.');
          } else if (e.kind === 'promotion_decision') {
            kind = 'Gate decides the lesson';
            const d = e.evidence?.decision;
            evidence = '<span class="badge" data-state="approved">promoted</span> The gate decided ' + esc(d?.decision || 'not recorded') + '. Calibrated score ' + (d?.calibrated?.promote ?? 'not recorded') + '.';
          } else if (e.kind === 'lesson_applied') {
            kind = 'Lesson applied · ' + e.actor;
            evidence = '<span class="evidence-label">Evidence</span> Lesson record ' + esc(e.evidence?.receipt?.memory_id || e.evidence?.lesson_id || '') + (e.evidence?.receipt?.record_created_at ? ', recorded ' + fmtDate(e.evidence.receipt.record_created_at) : '') + '.';
          }
          return '<div class="step-row"><span class="step-kind">' + esc(kind) + '</span><div><p>' + esc(e.summary) + '</p>' + (evidence ? '<p class="evidence-line">' + evidence + '</p>' : '') + '</div></div>';
        });
        learnSteps.innerHTML = '<div class="steps">' + rows.join('') + '</div>';
        const lesson = (data.lessons || [])[0];
        const card = document.getElementById('lessonCard');
        if (lesson && card) {
          // The standing lesson as a Record (5.4): the lesson text
          // first, then one fact per labelled part. The model fact
          // renders only when the API returns one. A typed fallback
          // model id used to sit here, which is a hardcoded provider
          // fact in frontend code, and it is gone.
          const facts = [
            '<div class="record-fact"><dt class="record-label">Record</dt><dd class="record-value">' + esc(lesson.id) + '</dd></div>',
            '<div class="record-fact"><dt class="record-label">Gate verdict</dt><dd class="record-value">' + esc(lesson.jev?.decision || 'promoted') + '</dd></div>',
            lesson.jev?.model ? '<div class="record-fact"><dt class="record-label">Model</dt><dd class="record-value">' + esc(lesson.jev.model) + '</dd></div>' : '',
            lesson.jev?.calibrated?.promote != null ? '<div class="record-fact"><dt class="record-label">Calibrated score</dt><dd class="record-value">' + Number(lesson.jev.calibrated.promote).toFixed(2) + '</dd></div>' : '',
            lesson.learning_event_id ? '<div class="record-fact wide"><dt class="record-label">Learned from</dt><dd class="record-value">learning event ' + esc(lesson.learning_event_id) + '</dd></div>' : '',
          ].join('');
          card.innerHTML = '<article class="record" aria-label="Standing lesson record"><p class="record-text">' + esc(lesson.text) + '</p><dl class="record-list">' + facts + '</dl></article>';
        }
        const audit = document.getElementById('learningAudit');
        if (audit && data.audit) {
          audit.textContent = 'Lesson audit, read live. ' + data.audit.checked + ' standing lesson(s) checked, ' + data.audit.forged_lesson_ids.length + ' forged. A lesson whose record carries no gate verdict is forged by definition and is quarantined.';
        }
      })
      .catch(() => {
        // Section 6.11 failure row for the learning call.
        learnState.textContent = 'could not be loaded';
        learnSteps.innerHTML = '<div class="empty-state"><p role="alert" style="margin:0 0 var(--space-2)"><strong>The records could not be loaded.</strong></p><p>The story is told from the records, so there is no honest version of it without them. When events are recorded, this figure lists them in order.</p></div>';
      });
  }

  /* ---- Spend and the cascade, live (card S7) ----------------------
   * One GET /api/spend response fills four surfaces: the section 04
   * cascade table, its live strip, the section 05 cascade sub table
   * and the section 05 spend cell. A cascade part renders only when
   * the response returns rows for it, and every name, count and
   * figure comes from those rows. The decides and refuses sentences
   * are behaviour claims, checked line by line against the routing
   * code and the plan's provider section, the same treatment the
   * console providers view gives its refuses column. No endpoint
   * returns a tier roster, so the part a row belongs to is read from
   * its returned tier and provider values, and a part with no
   * returned rows is recorded as needing backend data in the card
   * S7 completion record instead of being drawn from a guess. */
  const spendCell = document.getElementById('spendLive');
  const cascadeBody = document.getElementById('cascadeBody');
  const cascadeStrip = document.getElementById('cascadeStrip');
  const cascadeSubBody = document.getElementById('cascadeSubBody');
  if (spendCell || cascadeBody) {
    const usd = (v) => '$' + (Math.round(v * 10000) / 10000).toFixed(4);
    const usdGroup = (v) => (v > 0 && v < 0.001 ? '<$0.001' : usd(v));
    const PROVIDER_PLAIN = { meta: 'Meta Model API', jev: 'Jev, the TypeSafe decision API', baseten: 'Baseten' };
    const PROVIDER_SHORT = { meta: 'Meta', jev: 'Jev', baseten: 'Baseten' };
    const TASK_PLAIN = {
      prescreen: 'pre-screening', triage: 'triage',
      consolidate: 'consolidation', narrate: 'narration', explain: 'explanation',
      gate_decision: 'the write gate', consolidation_accept: 'consolidation acceptance',
      decay_drop: 'decay keep or drop', learning_promotion: 'lesson promotion',
    };
    const CLASS_PLAIN = { calibration: 'calibration', demo_final: 'demo final', decisions: 'decisions', product: 'product', gate_calibration: 'gate calibration' };
    const plain = (s) => String(s || '').replace(/_/g, ' ');
    const partOfSpendRow = (row) => {
      if (row.tier === 'tier0') return 'tier0';
      if (row.provider === 'jev') return 'gate';
      if (row.tier === 'wonder') return 'tier1';
      if (row.tier === 'wonder-full') return 'tier2';
      return 'other';
    };
    const PART_ORDER = ['tier0', 'gate', 'tier1', 'tier2', 'other'];
    const PART_NAME = { tier0: 'Tier 0', gate: 'The gate', tier1: 'Tier 1', tier2: 'Tier 2' };
    const PART_DECIDES = {
      tier0: 'Nothing. Its lean is advice only, and the gate decides every item it touches.',
      gate: 'The outcome of every item in the four decision classes.',
      tier1: 'Nothing. It drafts, narrates and explains, and every enumerable outcome stays with the gate or a named human.',
      tier2: 'Nothing. When a judged outcome changes the record, this tier writes the account of it. The outcome itself is never its call.',
    };
    const PART_REFUSES = {
      tier0: 'Approving an item into truth, or dropping an item on its own.',
      gate: 'Approving anything on a backend failure. A failure fails closed, and the item queues for a human.',
      tier1: 'Changing an outcome the gate has made. A disagreement is answered by the gate, not by the draft.',
      tier2: 'Making the decision it writes about. The written account follows the decision record, never the other way round.',
    };
    const joinWords = (items) => items.length <= 1 ? (items[0] || '') : items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
    function partWork(part, rows) {
      const tasks = [...new Set(rows.map((r) => r.task))];
      const classes = [...new Set(rows.map((r) => CLASS_PLAIN[r.spend_class] || plain(r.spend_class)))];
      let lead = '';
      if (part === 'gate') lead = 'Deciding ' + joinWords(tasks.map((t) => TASK_PLAIN[t] || plain(t))) + '.';
      else if (part === 'tier0') {
        const drafts = tasks.filter((t) => t !== 'prescreen').map((t) => TASK_PLAIN[t] || plain(t));
        lead = 'Screening' + (drafts.length ? ', plus first pass drafts of ' + joinWords(drafts) : '') + '.';
      } else if (part === 'tier2') {
        const full = { consolidate: 'consolidation writing', narrate: 'recall narration', explain: 'contradiction explanation' };
        lead = joinWords(tasks.map((t) => full[t] || TASK_PLAIN[t] || plain(t))) + '.';
        lead = lead.charAt(0).toUpperCase() + lead.slice(1);
      } else {
        const drafts = tasks.filter((t) => t !== 'triage').map((t) => TASK_PLAIN[t] || plain(t));
        lead = (tasks.includes('triage') ? 'Triage' : '') + (drafts.length ? (tasks.includes('triage') ? ', plus drafts of ' : 'Drafts of ') + joinWords(drafts) : '') + '.';
      }
      return lead + ' Recorded under the ' + joinWords(classes) + (classes.length > 1 ? ' classes.' : ' class.');
    }
    fetch('/api/spend')
      .then((r) => { if (!r.ok) throw new Error('api ' + r.status); return r.json(); })
      .then((data) => {
        const rows = data.router || [];
        if (!rows.length) {
          if (cascadeBody) cascadeBody.innerHTML = '<tr><td colspan="5">No model work has been recorded yet.</td></tr>';
          if (cascadeSubBody) cascadeSubBody.innerHTML = '<tr><td colspan="6">No model work has been recorded yet.</td></tr>';
          if (spendCell) spendCell.textContent = 'No spend recorded yet.';
          return;
        }
        const parts = new Map();
        for (const row of rows) {
          const p = partOfSpendRow(row);
          if (!parts.has(p)) parts.set(p, []);
          parts.get(p).push(row);
        }
        const order = PART_ORDER.filter((p) => parts.has(p));
        if (cascadeBody) {
          cascadeBody.innerHTML = order.map((p) => {
            const rs = parts.get(p);
            const runOn = [...new Set(rs.map((r) => (PROVIDER_PLAIN[r.provider] || esc(r.provider)) + ' · ' + esc(r.model)))].join('<br>');
            const name = PART_NAME[p] || esc(rs[0].tier || rs[0].provider);
            return '<tr><th scope="row"><strong>' + name + '</strong></th><td>' + esc(partWork(p, rs)) + '</td><td>' + runOn + '</td><td>' + esc(PART_DECIDES[p] || 'Not recorded in the routing record.') + '</td><td>' + esc(PART_REFUSES[p] || 'Not recorded in the routing record.') + '</td></tr>';
          }).join('');
        }
        if (cascadeStrip) {
          let tCalls = 0, tCached = 0, tCost = 0;
          const cells = order.map((p) => {
            const rs = parts.get(p);
            const calls = rs.reduce((a, r) => a + (r.calls || 0), 0);
            const cached = rs.reduce((a, r) => a + (r.cached || 0), 0);
            const cost = rs.reduce((a, r) => a + (r.est_cost_usd || 0), 0);
            tCalls += calls; tCached += cached; tCost += cost;
            const name = PART_NAME[p] || rs[0].tier || rs[0].provider;
            return '<div><span class="fact-k mono">' + esc(name) + '</span><span class="strip-value">' + calls + ' calls · ' + cached + ' cached, free · ' + usdGroup(cost) + ' spent</span></div>';
          });
          cells.push('<div><span class="fact-k mono">Total of the rows shown</span><span class="strip-value">' + tCalls + ' calls · ' + tCached + ' cached, free · ' + usdGroup(tCost) + ' spent</span></div>');
          cascadeStrip.innerHTML = cells.join('');
        }
        if (cascadeSubBody) {
          cascadeSubBody.innerHTML = rows.map((r) => {
            const p = partOfSpendRow(r);
            const name = PART_NAME[p] || esc(r.tier || r.provider);
            return '<tr><th scope="row">' + name + '</th><td>' + esc((TASK_PLAIN[r.task] || plain(r.task)) + ' · ' + (CLASS_PLAIN[r.spend_class] || plain(r.spend_class)) + ' class') + '</td><td>' + esc((PROVIDER_PLAIN[r.provider] || r.provider) + ' · ' + r.model) + '</td><td class="num">' + (r.calls || 0) + '</td><td class="num">' + (r.cached || 0) + '</td><td class="num">' + usdGroup(r.est_cost_usd || 0) + '</td></tr>';
          }).join('');
        }
        if (spendCell) {
          const byProvider = {};
          const providerOrder = [];
          let total = 0;
          for (const row of rows) {
            if (!(row.provider in byProvider)) providerOrder.push(row.provider);
            byProvider[row.provider] = (byProvider[row.provider] || 0) + (row.est_cost_usd || 0);
            total += row.est_cost_usd || 0;
          }
          spendCell.innerHTML = providerOrder.map((p) => esc(PROVIDER_SHORT[p] || p) + ' ' + usd(byProvider[p])).join(' · ') + '<br>total ' + usd(total);
        }
      })
      .catch(() => {
        // Section 6.11 failure row for the spend call: the words
        // in a role alert in the section 04 figure area, the same
        // words stated plainly in the section 05 cell, and no
        // stale figure left standing as current.
        if (cascadeBody) cascadeBody.innerHTML = '<tr><td colspan="5">The records could not be loaded.</td></tr>';
        if (cascadeStrip) cascadeStrip.innerHTML = '<p class="small" role="alert" style="margin:0">The records could not be loaded.</p>';
        if (cascadeSubBody) cascadeSubBody.innerHTML = '<tr><td colspan="6">The records could not be loaded.</td></tr>';
        if (spendCell) spendCell.textContent = 'The records could not be loaded.';
      });
  }

  /* ---- Reveal on scroll, once ------------------------------------ */
  // Progressive (5.3, Finding J5): figures are visible by default;
  // only this running script arms the hidden start, so a script
  // failure can never leave a figure invisible.
  const revealEls = document.querySelectorAll('.reveal');
  if (revealEls.length) {
    if (!('IntersectionObserver' in window) || reduced) revealEls.forEach((n) => n.classList.add('seen'));
    else {
      revealEls.forEach((n) => n.classList.add('armed'));
      const io = new IntersectionObserver((entries) => {
        entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('seen'); io.unobserve(e.target); } });
      }, { threshold: 0.15 });
      revealEls.forEach((n) => io.observe(n));
    }
  }
})();
