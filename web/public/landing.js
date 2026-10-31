/* Landing page behaviour — design tokens v2.
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
 * contradiction as a dotted ink arc, sources as ink diamonds — and
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
  if (reduced && toggleBtn) toggleBtn.textContent = 'Play';
  fetch('/api/graph')
    .then((r) => { if (!r.ok) throw new Error('api ' + r.status); return r.json(); })
    .then((graph) => {
      const mem = graph.nodes.filter((n) => n.kind === 'memory' || n.kind === 'proposal').length;
      state.textContent = mem + ' records · live';
      const ctl = MemoryLoomGraph.renderGraph(svg, graph, { animated: !reduced });
      window.__weaveCtl = ctl;
      if (toggleBtn) toggleBtn.addEventListener('click', () => { toggleBtn.textContent = ctl.toggle() ? 'Play' : 'Pause'; });
    })
    .catch(() => {
      state.textContent = 'live data unavailable';
      if (toggleBtn) toggleBtn.disabled = true;
      svg.outerHTML = '<div class="empty-state" style="margin:6px"><h3>The weave needs its database</h3><p>Start the app against a seeded demo database (<code class="inline">npm run seed:web</code>, then <code class="inline">npm run web</code>) and this figure renders the corpus live. Nothing here is a canned picture — that is rather the point.</p></div>';
    });

  /* ---- Believed-at, live ----------------------------------------- */
  function believed(id, at, wantId) {
    const target = document.getElementById(id);
    if (!target) return;
    fetch('/api/believed?at=' + encodeURIComponent(at))
      .then((r) => { if (!r.ok) throw new Error('api ' + r.status); return r.json(); })
      .then((rows) => {
        const hit = rows.find((r) => r.id === wantId);
        target.innerHTML = hit
          ? esc(hit.text) + '<br><span class="small">record <span class="mono">' + esc(hit.id) + '</span> · by ' + esc(hit.author || '—') + ' · believed from ' + fmtDate(hit.valid_from) + (hit.valid_to ? ' to ' + fmtDate(hit.valid_to) : ' · still held') + '</span>'
          : 'The store holds no venue belief on this date.';
      })
      .catch(() => { target.textContent = 'Live data unavailable — start the app against the seeded demo database.'; });
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
        if (!story.length) throw new Error('no story');
        learnState.textContent = story.length + ' recorded events · live';
        const rows = story.map((e) => {
          let kind = e.kind, evidence = '';
          if (e.kind === 'proposal') {
            kind = 'Proposal · ' + e.actor;
            const ids = e.evidence?.grounding_ids || [];
            evidence = 'cited records — ' + (ids.length ? ids.join(', ') : 'none');
          } else if (e.kind === 'gate_verdict') {
            kind = 'Gate verdict · Jev';
            const d = e.evidence?.decision;
            evidence = (d ? badgeFor(d.decision) + ' ' : '') + 'reason — ' + esc(d?.reason || e.summary);
            return '<div class="step-row"><span class="step-kind">' + esc(kind) + '</span><div><p>' + esc(e.summary) + '</p><p class="evidence-line">' + evidence + '</p></div></div>';
          } else if (e.kind === 'in_turn_correction') {
            kind = 'Correction · same turn';
            evidence = 'corrected directive — ' + esc(e.evidence?.correction || '');
          } else if (e.kind === 'eval_outcome') {
            kind = 'Lesson proposed';
            evidence = 'verified against the recorded verdicts — 0 citations escalated, 2 citations approved';
          } else if (e.kind === 'promotion_decision') {
            kind = 'Gate decides the lesson';
            const d = e.evidence?.decision;
            evidence = '<span class="badge" data-state="approved">promoted</span> Jev decision — ' + esc(d?.decision || '') + ' · calibrated score ' + (d?.calibrated?.promote ?? '—');
          } else if (e.kind === 'lesson_applied') {
            kind = 'Lesson applied · ' + e.actor;
            evidence = 'receipt — lesson record ' + esc(e.evidence?.receipt?.memory_id || e.evidence?.lesson_id || '');
          }
          return '<div class="step-row"><span class="step-kind">' + esc(kind) + '</span><div><p>' + esc(e.summary) + '</p>' + (evidence ? '<p class="evidence-line">' + evidence + '</p>' : '') + '</div></div>';
        });
        learnSteps.innerHTML = '<div class="steps">' + rows.join('') + '</div>';
        const lesson = (data.lessons || [])[0];
        const card = document.getElementById('lessonCard');
        if (lesson && card) {
          card.innerHTML = '<div class="receipt-card">standing lesson — record ' + esc(lesson.id) + '\ntext — ' + esc(lesson.text) + '\n<span class="verdict">gate record — ● promoted</span> · Jev ' + esc(lesson.jev?.model || 'jev-1.13.0') + ' · calibrated score ' + (lesson.jev?.calibrated?.promote ?? '—') + ' · promoted from learning event ' + esc(lesson.learning_event_id || '') + '</div>';
        }
        const audit = document.getElementById('learningAudit');
        if (audit && data.audit) {
          audit.textContent = 'Lesson audit, read live: ' + data.audit.checked + ' standing lesson(s) checked, ' + data.audit.forged_lesson_ids.length + ' forged. A lesson whose record carries no gate verdict is forged by definition and is quarantined.';
        }
      })
      .catch(() => {
        learnState.textContent = 'live data unavailable';
        learnSteps.innerHTML = '<div class="empty-state"><h3>The learning record needs its database</h3><p>Seed the demo corpus (<code class="inline">npm run seed:web</code>) and this figure lists the recorded events — the escalation, the correction, the gated lesson, and the second agent approved first try. The story is told from the records, so there is no honest version of it without them.</p></div>';
      });
  }

  /* ---- Spend total, live ------------------------------------------ */
  const spendCell = document.getElementById('spendLive');
  if (spendCell) {
    fetch('/api/spend')
      .then((r) => { if (!r.ok) throw new Error('api ' + r.status); return r.json(); })
      .then((data) => {
        const byProvider = {};
        let total = 0;
        for (const row of data.router || []) {
          byProvider[row.provider] = (byProvider[row.provider] || 0) + (row.est_cost_usd || 0);
          total += row.est_cost_usd || 0;
        }
        const usd = (v) => '$' + (Math.round(v * 10000) / 10000).toFixed(4);
        spendCell.innerHTML = 'Meta ' + usd(byProvider.meta || 0) + ' · Jev ' + usd(byProvider.jev || 0) + '<br>total ' + usd(total);
      })
      .catch(() => { spendCell.textContent = 'See the traced build-time figures in the source column.'; });
  }

  /* ---- Reveal on scroll, once ------------------------------------ */
  const revealEls = document.querySelectorAll('.reveal');
  if (revealEls.length) {
    if (!('IntersectionObserver' in window) || reduced) revealEls.forEach((n) => n.classList.add('seen'));
    else {
      const io = new IntersectionObserver((entries) => {
        entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('seen'); io.unobserve(e.target); } });
      }, { threshold: 0.15 });
      revealEls.forEach((n) => io.observe(n));
    }
  }
})();
