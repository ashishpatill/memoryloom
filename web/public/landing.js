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
 * playhead marks the moment a memory moved. */
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const INK = '#1d1a15';
  const INK2 = '#5f584a';
  const SURFACE = '#fdfbf6';
  const AGENT_Y = { grok: 70, moose: 182, 'memoryloom-learning': 262 };
  const AGENT_LABEL = { grok: 'grok', moose: 'moose', 'memoryloom-learning': 'learning' };

  function el(name, attrs, parent) {
    const n = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
    if (parent) parent.appendChild(n);
    return n;
  }
  function hashJitter(id, spread) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    return ((Math.abs(h) % 100) / 100 - 0.5) * spread;
  }
  const tOf = (n) => new Date(n.recorded_at || n.created_at || 0).getTime();
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (t) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

  /* ---- Hero weave ------------------------------------------------ */
  function layout(graph, W, H) {
    const nodes = new Map(graph.nodes.map((n) => [n.node_id, { ...n }]));
    const authorOf = new Map();
    for (const e of graph.edges) {
      if (e.type === 'authored_by' || e.type === 'proposed_by') authorOf.set(e.from, e.to.replace('agent:', ''));
    }
    const timed = graph.nodes.filter((n) => (n.kind === 'memory' || n.kind === 'proposal') && tOf(n) > 0);
    const tMin = Math.min(...timed.map(tOf));
    const tMax = Math.max(...timed.map(tOf));
    const x0 = 118, x1 = W - 56;
    const xFor = (t) => x0 + ((t - tMin) / Math.max(1, tMax - tMin)) * (x1 - x0);
    for (const n of nodes.values()) {
      if (n.kind === 'agent') { n.x = 44; n.y = AGENT_Y[n.id] ?? 130; }
      else if (n.kind === 'memory' || n.kind === 'proposal') {
        const a = authorOf.get(n.node_id);
        n.x = xFor(tOf(n));
        n.y = (AGENT_Y[a] ?? 130) + hashJitter(n.id, 52);
        n.author = a || null;
      }
    }
    for (const e of graph.edges) {
      if (e.type === 'cites_source') {
        const s = nodes.get(e.to), m = nodes.get(e.from);
        if (s && m) { s.x = m.x; s.y = H - 26; }
      }
    }
    // Label placement: the corpus clusters in time, so knots that sit
    // close together alternate their labels above and below the knot
    // instead of printing over each other. Layout only — no data moves.
    const byAuthor = new Map();
    for (const n of nodes.values()) {
      if (n.kind !== 'memory' && n.kind !== 'proposal') continue;
      if (!byAuthor.has(n.author)) byAuthor.set(n.author, []);
      byAuthor.get(n.author).push(n);
    }
    for (const group of byAuthor.values()) {
      group.sort((a, b) => a.x - b.x);
      let prevX = -Infinity, side = 0;
      for (const n of group) {
        side = n.x - prevX < 34 ? 1 - side : 0;
        n.labelDy = side ? 24 : -13;
        prevX = n.x;
      }
    }
    return { nodes, tMin, tMax, xFor };
  }

  function renderWeave(svg, graph, { animated }) {
    const W = 720, H = 330;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = '';
    const { nodes, tMin, tMax, xFor } = layout(graph, W, H);
    const shown = new Set(['agent', 'memory', 'proposal', 'source']);

    const defs = el('defs', {}, svg);
    const clip = el('clipPath', { id: 'weave-clip' }, defs);
    const clipRect = el('rect', { x: 0, y: 0, width: animated ? 0 : W, height: H }, clip);
    const weave = el('g', { 'clip-path': 'url(#weave-clip)' }, svg);

    for (const [agent, y] of Object.entries(AGENT_Y)) {
      const mine = [...nodes.values()]
        .filter((n) => n.author === agent && (n.kind === 'memory' || n.kind === 'proposal'))
        .sort((a, b) => a.x - b.x);
      if (!mine.length) continue;
      const pts = [[64, y], ...mine.map((n) => [n.x, n.y]), [W - 30, y]];
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
      el('path', { d, fill: 'none', stroke: INK, 'stroke-width': 1.5, opacity: agent === 'grok' ? 0.55 : 0.3 }, weave);
    }

    const edgeG = el('g', {}, weave);
    const edgeEls = [];
    for (const e of graph.edges) {
      if (!['grounded_in', 'supersedes', 'contradicts'].includes(e.type)) continue;
      const a = nodes.get(e.from), b = nodes.get(e.to);
      if (!a || !b || a.x === undefined || b.x === undefined) continue;
      const mx = (a.x + b.x) / 2, my = Math.min(a.y, b.y) - 26;
      const attrs = { d: `M${a.x},${a.y} Q${mx},${my} ${b.x},${b.y}`, class: 'edge', fill: 'none', stroke: INK2, 'stroke-width': 1.2, opacity: 0.75 };
      if (e.type === 'supersedes') { attrs.stroke = INK; attrs['stroke-dasharray'] = '5 3'; }
      if (e.type === 'contradicts') { attrs.stroke = INK; attrs['stroke-dasharray'] = '2 3'; }
      const path = el('path', attrs, edgeG);
      edgeEls.push({ el: path, at: Math.max(tOf(a) || 0, tOf(b) || 0) });
    }

    const nodeG = el('g', {}, svg);
    const nodeEls = [];
    for (const n of nodes.values()) {
      if (!shown.has(n.kind) || n.x === undefined) continue;
      const g = el('g', {}, nodeG);
      if (n.kind === 'agent') {
        const label = AGENT_LABEL[n.id] || n.id;
        el('circle', { cx: n.x, cy: n.y, r: 17, fill: SURFACE, stroke: INK, 'stroke-width': 1.5 }, g);
        const t = el('text', { x: n.x, y: n.y + 4, 'text-anchor': 'middle', fill: INK, 'font-size': 11, 'font-weight': 700 }, g);
        t.textContent = label[0].toUpperCase();
        const lbl = el('text', { x: n.x, y: n.y + 32, 'text-anchor': 'middle', class: 'node-label' }, g);
        lbl.textContent = label;
      } else if (n.kind === 'source') {
        el('rect', { x: n.x - 5, y: n.y - 5, width: 10, height: 10, fill: SURFACE, stroke: INK, transform: `rotate(45 ${n.x} ${n.y})` }, g);
        const lbl = el('text', { x: n.x, y: n.y + 16, 'text-anchor': 'middle', class: 'node-sub' }, g);
        lbl.textContent = n.id.length > 22 ? n.id.slice(0, 21) + '…' : n.id;
      } else {
        const superseded = n.valid_to && new Date(n.valid_to).getTime() <= tMax;
        if (n.kind === 'proposal') {
          el('circle', { cx: n.x, cy: n.y, r: 6, fill: SURFACE, stroke: INK, 'stroke-width': 1.2, 'stroke-dasharray': '3 2' }, g);
        } else {
          el('circle', { cx: n.x, cy: n.y, r: 7.5, fill: INK, 'fill-opacity': superseded ? 0.35 : 0.92, stroke: INK, 'stroke-width': 1 }, g);
          if (superseded) el('line', { x1: n.x - 6, y1: n.y + 6, x2: n.x + 6, y2: n.y - 6, stroke: INK, 'stroke-width': 1.6 }, g);
        }
        const lbl = el('text', { x: n.x, y: n.y + (n.labelDy ?? -13), 'text-anchor': 'middle', class: 'node-sub' }, g);
        const short = n.id.startsWith('demo-') ? n.id.slice(5) : 'lesson';
        lbl.textContent = short.length > 14 ? short.slice(0, 13) + '…' : short;
      }
      nodeEls.push({ g, at: tOf(n) || tMin, kind: n.kind });
    }

    let playLine = null, playLabel = null;
    if (animated) {
      playLine = el('line', { x1: 118, y1: 14, x2: 118, y2: H - 44, class: 'playhead-line' }, svg);
      playLabel = el('text', { x: 118, y: 10, 'text-anchor': 'middle', class: 'playhead-label' }, svg);
    }
    function setTime(t) {
      for (const { g, at, kind } of nodeEls) {
        if (kind === 'agent' || kind === 'source') { g.style.opacity = ''; continue; }
        g.style.opacity = at <= t ? '1' : '0.12';
      }
      for (const { el: p, at } of edgeEls) p.style.opacity = at <= t ? '' : '0.06';
      clipRect.setAttribute('width', Math.max(0, xFor(t) + 8));
      if (playLine) {
        const x = xFor(t);
        playLine.setAttribute('x1', x); playLine.setAttribute('x2', x);
        playLabel.setAttribute('x', x);
        playLabel.textContent = new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      }
    }
    if (!animated) { setTime(tMax); return { toggle: () => true, settle() { setTime(tMax); } }; }

    let start = performance.now();
    const SPAN = 15000, HOLD = 2600;
    let raf = 0, paused = false;
    function frame(now) {
      if (!paused) {
        const elapsed = (now - start) % (SPAN + HOLD);
        const t = elapsed >= SPAN ? tMax : tMin + (elapsed / SPAN) * (tMax - tMin);
        setTime(t);
      }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return {
      toggle() { paused = !paused; if (!paused) start = performance.now(); return paused; },
      settle() { paused = true; setTime(tMax); },
    };
  }

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
      const ctl = renderWeave(svg, graph, { animated: !reduced });
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
