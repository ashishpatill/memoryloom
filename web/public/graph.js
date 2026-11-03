/* The memory graph renderer — design tokens v2, the ONE renderer.
 *
 * This file is the v2 renderer that Iteration 5.1 built for the
 * landing page's hero weave, generalised in 5.2 to serve the console
 * graph view as well; the v1 renderer that used to live here (agent
 * hues, gold sources) is retired — there is no second layout left in
 * the product. Layout is a weave: each author owns a horizontal
 * thread, memories sit on their author's thread at their recorded
 * time, and cross-links (grounding, supersession, contradiction)
 * arc between the threads.
 *
 * Tokens v2 graph discipline: threads are ink, told apart by
 * position and label — never by hue. Supersession is a dashed ink
 * arc, contradiction a dotted ink arc, sources are ink diamonds.
 * Status is shape: solid knots are memories, hollow dashed knots
 * are proposals, crossed knots are superseded. The single accent
 * belongs to the caller: the landing page spends it on the animated
 * playhead (the moment a memory moved); the console's static graph
 * spends none. Callers style .playhead-line / .playhead-label.
 *
 * Threads are built from the authors the store actually returns.
 * The learning promotion (recorded as "memoryloom-learning",
 * labelled "learning") authored the standing lessons, and only its
 * records are labelled "lesson". Every other record is labelled
 * with its own type, never with a standing word that does not
 * belong to it.
 *
 * Layout (Iteration 5.4, defect round; placement rule completed by
 * card S4 under the frozen master plan, defect D1): the x axis is
 * ORDINAL over distinct recorded dates. Every distinct date gets one
 * column and all knots recorded that day share the column. Knots
 * that share an author and a date are offset from the column centre
 * at a fixed step, and that step is the recorded minimum separation
 * between neighbouring knots on one thread: 19 units. A column
 * moves right, and the frame grows wider to hold it, whenever the
 * widest same author group on a date would otherwise bring a knot
 * within that minimum of a knot on the neighbouring date, so the
 * minimum holds between every pair of neighbouring knots on a
 * thread and not only inside one day. The longest empty stretch
 * (45 days or more) is drawn as a labelled break band instead of
 * honest empty axis: the figure discloses that its spacing shows
 * the ORDER of dates, not elapsed time, and the axis prints every
 * real date. Every label is then placed by a bounded row solver
 * that keeps each label inside the frame with a clear gap from its
 * neighbours on the same row, so no label leaves the frame and no
 * two labels touch, at any date distribution the corpus can take.
 * The earlier linear time scale put thirteen October records inside
 * a tenth of the frame, and the 5.3 label-spreading pass then
 * satisfied a pairwise label-overlap measurement by construction
 * while the figure stayed unreadable; the post-mortem is in
 * LEARNINGS-F5.md. Card S4 found the two faults this rule closes:
 * knot labels had no placement pass at all, and the same day offset
 * could carry a knot most of a slot toward its neighbour, down to
 * 13.2 units apart in the accumulation case.
 *
 * API: MemoryLoomGraph.renderGraph(svg, graph, { animated, onSelect })
 *   -> { setTime(t), toggle(), settle(), stop() }
 * onSelect, when given, fires for EVERY knot kind (agent, memory,
 * proposal, source) — what a click means is the view's business,
 * but no knot is a silent dead end. The clicked knot wears an ink
 * ring in the figure itself (5.3 re-review: selection used to change
 * only the panel below, leaving the reader unable to see WHICH knot
 * they had picked in a dense cluster). The ring is ink shape, not
 * the accent — selection is a reading position, not a decision.
 */
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const INK = '#1d1a15';
  const INK2 = '#5f584a';
  const SURFACE = '#fdfbf6';
  const AGENT_LABEL = { grok: 'grok', moose: 'moose', 'memoryloom-learning': 'learning' };
  let clipSeq = 0;

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

  function layout(graph, W, H) {
    const nodes = new Map(graph.nodes.map((n) => [n.node_id, { ...n }]));
    const authorOf = new Map();
    for (const e of graph.edges) {
      if (e.type === 'authored_by' || e.type === 'proposed_by') authorOf.set(e.from, e.to.replace('agent:', ''));
    }
    // Thread positions are built from the authors in this graph.
    // The three long standing authors keep their places. Any other
    // author takes the first free place, in the order the graph
    // returns them, so a real author always gets a labelled thread
    // of their own instead of sharing a default line.
    const PRESET_Y = { grok: 70, moose: 182, 'memoryloom-learning': 262 };
    const SLOT_Y = [70, 182, 262];
    const yMap = new Map();
    const authorsInOrder = [];
    for (const n of graph.nodes) if (n.kind === 'agent' && !authorsInOrder.includes(n.id)) authorsInOrder.push(n.id);
    for (const a of authorOf.values()) if (a && !authorsInOrder.includes(a)) authorsInOrder.push(a);
    for (const a of authorsInOrder) {
      if (PRESET_Y[a] !== undefined && ![...yMap.values()].includes(PRESET_Y[a])) yMap.set(a, PRESET_Y[a]);
      else {
        const free = SLOT_Y.find((y) => ![...yMap.values()].includes(y));
        yMap.set(a, free !== undefined ? free : 70 + yMap.size * 80);
      }
    }
    const yOf = (a) => (a && yMap.has(a) ? yMap.get(a) : 130);
    const timed = graph.nodes.filter((n) => (n.kind === 'memory' || n.kind === 'proposal') && tOf(n) > 0);
    const tMin = Math.min(...timed.map(tOf));
    const tMax = Math.max(...timed.map(tOf));
    // ---- Ordinal date columns (5.4 defect round) ----
    // Distinct recorded days, in order. One column per day, a fixed
    // slot apart, so knot separation is a property of the
    // construction, not of the date distribution.
    const DAY = 86400000;
    const dayOf = (t) => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
    const slots = [...new Set(timed.map((n) => dayOf(tOf(n))))].sort((a, b) => a - b);
    // The break: the longest empty stretch of 45 days or more gets
    // one labelled band instead of empty axis.
    let gapAfter = -1, gapDays = 0;
    for (let i = 0; i < slots.length - 1; i++) {
      const g = Math.round((slots[i + 1] - slots[i]) / DAY);
      if (g >= 45 && g > gapDays) { gapDays = g; gapAfter = i; }
    }
    const GAPW = gapAfter >= 0 ? 76 : 0;
    const X0 = 112;
    let SLOT = 40;
    if (slots.length > 1) {
      const need = X0 + (slots.length - 1) * SLOT + GAPW + 64;
      if (need > W) SLOT = Math.max(24, Math.floor((W - 64 - X0 - GAPW) / (slots.length - 1)));
    }
    // Same author, same day: knots share a column but never a
    // point; they spread symmetrically around the column centre at
    // the MIN_SEP step. The groups are computed before the columns
    // are placed, because the widest group on a date sets how much
    // room that date needs around its centre.
    const MIN_SEP = 19;
    const sameDay = new Map();
    for (const n of timed) {
      const a = authorOf.get(n.node_id);
      const key = (a || '?') + '|' + dayOf(tOf(n));
      if (!sameDay.has(key)) sameDay.set(key, []);
      sameDay.get(key).push(n.node_id);
    }
    for (const ids of sameDay.values()) ids.sort();
    const dayHalf = new Map();
    for (const [key, ids] of sameDay) {
      const d = Number(key.slice(key.lastIndexOf('|') + 1));
      dayHalf.set(d, Math.max(dayHalf.get(d) || 0, ((ids.length - 1) * MIN_SEP) / 2));
    }
    // Column centres start on the uniform grid. A centre then moves
    // right whenever the groups on the two neighbouring dates would
    // bring their nearest knots closer than MIN_SEP, and the frame
    // grows wider by whatever the moves cost, so the minimum
    // separation holds between every pair of neighbouring knots on
    // a thread and the tail of the figure never leaves the frame.
    const centres = slots.map((d, i) => X0 + i * SLOT + (gapAfter >= 0 && i > gapAfter ? GAPW : 0));
    for (let i = 1; i < centres.length; i++) {
      const need = (dayHalf.get(slots[i - 1]) || 0) + MIN_SEP + (dayHalf.get(slots[i]) || 0);
      if (centres[i] < centres[i - 1] + need) centres[i] = centres[i - 1] + need;
    }
    const frameW = Math.max(W, centres[centres.length - 1] + (dayHalf.get(slots[slots.length - 1]) || 0) + 64);
    const slotX = (i) => centres[i];
    const slotIndex = new Map(slots.map((d, i) => [d, i]));
    const gap = gapAfter >= 0
      ? { x0: slotX(gapAfter) + SLOT / 2 - 4, x1: slotX(gapAfter + 1) - SLOT / 2 + 4, days: gapDays }
      : null;
    // Playhead mapping: piecewise between neighbouring date
    // columns, linear in real time inside each interval, so the
    // line still lands exactly on a column on its date.
    const xFor = (t) => {
      if (slots.length === 1 || t <= slots[0]) return slotX(0);
      if (t >= slots[slots.length - 1]) return slotX(slots.length - 1);
      let i = 0;
      while (i < slots.length - 2 && t >= slots[i + 1]) i++;
      const f = (t - slots[i]) / Math.max(1, slots[i + 1] - slots[i]);
      return slotX(i) + f * (slotX(i + 1) - slotX(i));
    };
    for (const n of nodes.values()) {
      if (n.kind === 'agent') { n.x = 44; n.y = yOf(n.id); }
      else if (n.kind === 'memory' || n.kind === 'proposal') {
        const a = authorOf.get(n.node_id);
        const key = (a || '?') + '|' + dayOf(tOf(n));
        const ids = sameDay.get(key) || [n.node_id];
        const j = ids.indexOf(n.node_id);
        n.x = slotX(slotIndex.get(dayOf(tOf(n)))) + (ids.length > 1 ? (j - (ids.length - 1) / 2) * MIN_SEP : 0);
        n.y = yOf(a) + hashJitter(n.id, 12);
        n.author = a || null;
      }
    }
    // Sources sit under the first memory that cites them.
    for (const e of graph.edges) {
      if (e.type === 'cites_source') {
        const s = nodes.get(e.to), m = nodes.get(e.from);
        if (s && m) { s.x = m.x; s.y = H - 66; }
      }
    }
    // ---- Label placement ----
    // Every label row (one side of one thread for knot labels, one
    // foot level for source labels) is placed by the bounded row
    // solver below. The solver repeats a forward pass, a backward
    // pass and an end clamp until the row settles, so both bounds
    // and the gap between neighbours hold at the same time. The
    // pass it replaces could not promise that: its left bound
    // recovery ran last and could push the tail label past the
    // right edge, the exact fault the 5.3 re-review measured at 30
    // units out, and knot labels had no pass at all, so nothing
    // kept a tail label inside the frame when a day gathered
    // records. A displaced label keeps a leader line back to its
    // knot, drawn at render whenever the label moved.
    const labelTextOf = (n) => {
      if (n.kind === 'source') return n.id.length > 22 ? n.id.slice(0, 21) + '…' : n.id;
      const short = n.id.startsWith('demo-') ? n.id.slice(5) : (n.author === 'memoryloom-learning' ? 'lesson' : (n.type || 'record'));
      return short.length > 14 ? short.slice(0, 13) + '…' : short;
    };
    // 9px IBM Plex Mono advances ≈5.4 units per character; the
    // estimate adds padding so measured boxes keep a real gap.
    const halfWidth = (n) => (labelTextOf(n).length * 5.4) / 2 + 3;
    function solveRow(items, { left, right, gap }) {
      if (!items.length) return;
      items.sort((a, b) => (a.labelX ?? a.x) - (b.labelX ?? b.x));
      for (const it of items) { it.labelHalf = halfWidth(it); if (it.labelX === undefined) it.labelX = it.x; }
      for (let round = 0; round < 60; round++) {
        let moved = 0;
        const set = (it, v) => { moved = Math.max(moved, Math.abs(it.labelX - v)); it.labelX = v; };
        for (let i = 1; i < items.length; i++) {
          const need = items[i - 1].labelX + items[i - 1].labelHalf + gap + items[i].labelHalf;
          if (items[i].labelX < need) set(items[i], need);
        }
        for (let i = items.length - 2; i >= 0; i--) {
          const cap = items[i + 1].labelX - items[i + 1].labelHalf - gap - items[i].labelHalf;
          if (items[i].labelX > cap) set(items[i], cap);
        }
        if (items[0].labelX - items[0].labelHalf < left) set(items[0], left + items[0].labelHalf);
        const last = items[items.length - 1];
        if (last.labelX + last.labelHalf > right) set(last, right - last.labelHalf);
        if (moved < 0.01) break;
      }
    }
    // Source diamonds first (they are positions, not labels), then
    // source labels on up to four foot levels so a tight cluster
    // stacks instead of colliding.
    const sources = [...nodes.values()].filter((n) => n.kind === 'source' && n.x !== undefined).sort((a, b) => a.x - b.x);
    {
      let prev = null;
      for (const s of sources) {
        if (prev && s.x < prev.x + 14) s.x = prev.x + 14;
        prev = s;
      }
      const lastS = sources[sources.length - 1];
      if (lastS && lastS.x > frameW - 30) {
        let overflow = lastS.x - (frameW - 30);
        for (let i = sources.length - 1; i >= 0 && overflow > 0; i--) {
          const room = i === 0 ? sources[0].x - 100 : sources[i].x - (sources[i - 1].x + 14);
          const take = Math.min(room, overflow);
          sources[i].x -= take; overflow -= take;
        }
      }
      const LEVELS = [-14, 16, -32, 34];
      let prevX = -Infinity, chain = 0;
      for (const s of sources) {
        chain = s.x - prevX < 90 ? chain + 1 : 0;
        s.labelDy = LEVELS[chain % LEVELS.length];
        prevX = s.x;
      }
      const byLevel = new Map();
      for (const s of sources) {
        if (!byLevel.has(s.labelDy)) byLevel.set(s.labelDy, []);
        byLevel.get(s.labelDy).push(s);
      }
      for (const group of byLevel.values()) solveRow(group, { left: 92, right: frameW - 20, gap: 7 });
    }
    // Knot labels: alternate above and below along each thread,
    // then each side of each thread goes through the same solver,
    // so a label crowded by a gathered day leans along its row with
    // a leader line instead of leaving the frame or touching its
    // neighbour.
    const byAuthor = new Map();
    for (const n of nodes.values()) {
      if (n.kind !== 'memory' && n.kind !== 'proposal') continue;
      if (!byAuthor.has(n.author)) byAuthor.set(n.author, []);
      byAuthor.get(n.author).push(n);
    }
    for (const group of byAuthor.values()) {
      group.sort((a, b) => a.x - b.x);
      group.forEach((n, i) => { n.labelDy = i % 2 ? 24 : -13; n.labelX = n.x; });
      for (const side of [-13, 24]) {
        solveRow(group.filter((n) => n.labelDy === side), { left: 10, right: frameW - 10, gap: 7 });
      }
    }
    for (const n of nodes.values()) {
      if (n.kind === 'source' && n.labelX === undefined) n.labelX = n.x;
    }
    return { nodes, tMin, tMax, xFor, slots, slotX, gap, frameW, yMap };
  }

  function renderGraph(svg, graph, opts = {}) {
    const W = 720, H = 372;
    svg.innerHTML = '';
    const timed = graph.nodes.filter((n) => (n.kind === 'memory' || n.kind === 'proposal') && tOf(n) > 0);
    if (!timed.length) {
      // No timed records: nothing honest to draw. The caller owns
      // the empty state; the renderer simply draws nothing.
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      return { setTime() {}, toggle: () => true, settle() {}, stop() {} };
    }
    const { nodes, tMin, tMax, xFor, slots, slotX, gap, frameW, yMap } = layout(graph, W, H);
    // The frame is at least the nominal width and grows by what
    // the column placement needed, so the viewBox always matches
    // the laid out figure.
    svg.setAttribute('viewBox', `0 0 ${frameW} ${H}`);
    const animated = Boolean(opts.animated);
    const shown = new Set(['agent', 'memory', 'proposal', 'source']);

    const clipId = 'weave-clip-' + (++clipSeq);
    const defs = el('defs', {}, svg);
    const clip = el('clipPath', { id: clipId }, defs);
    const clipRect = el('rect', { x: 0, y: 0, width: animated ? 0 : frameW, height: H }, clip);
    const weave = el('g', { 'clip-path': `url(#${clipId})` }, svg);

    // The break band first, under everything: a sunken panel with
    // hairline edges and a plain label, so the compressed stretch
    // reads as a break in the axis, not as missing data.
    if (gap) {
      el('rect', { x: gap.x0, y: 10, width: gap.x1 - gap.x0, height: H - 46, fill: '#efe9da', opacity: 0.65 }, weave);
      el('line', { x1: gap.x0, y1: 10, x2: gap.x0, y2: H - 36, stroke: '#dad1bb', 'stroke-width': 1 }, weave);
      el('line', { x1: gap.x1, y1: 10, x2: gap.x1, y2: H - 36, stroke: '#dad1bb', 'stroke-width': 1 }, weave);
      const gx = (gap.x0 + gap.x1) / 2;
      const t1 = el('text', { x: gx, y: 158, 'text-anchor': 'middle', class: 'node-sub', fill: INK2 }, weave);
      t1.textContent = gap.days + ' days';
      const t2 = el('text', { x: gx, y: 171, 'text-anchor': 'middle', class: 'node-sub', fill: INK2 }, weave);
      t2.textContent = 'no records';
    }

    // Thread lines: one per author, ink, told apart by position.
    // A thread stops at the break band and resumes after it, with
    // two short slashes inside the band carrying the eye across.
    for (const [agent, y] of yMap.entries()) {
      const mine = [...nodes.values()]
        .filter((n) => n.author === agent && (n.kind === 'memory' || n.kind === 'proposal'))
        .sort((a, b) => a.x - b.x);
      if (!mine.length) continue;
      const pts = [[64, y], ...mine.map((n) => [n.x, n.y]), [frameW - 30, y]];
      const segments = [[]];
      for (const p of pts) {
        if (gap && p[0] > gap.x0 && p[0] < gap.x1) continue;
        const cur = segments[segments.length - 1];
        if (gap && cur.length && cur[cur.length - 1][0] < gap.x0 && p[0] > gap.x1) {
          cur.push([gap.x0, y]);
          segments.push([[gap.x1, y]]);
        }
        segments[segments.length - 1].push(p);
      }
      for (const seg of segments) {
        if (seg.length < 2) continue;
        const d = seg.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
        el('path', { d, fill: 'none', stroke: INK, 'stroke-width': 1.5, opacity: agent === 'grok' ? 0.55 : 0.3 }, weave);
      }
      if (gap && mine.some((n) => n.x < gap.x0) && mine.some((n) => n.x > gap.x1)) {
        const gx = (gap.x0 + gap.x1) / 2;
        el('line', { x1: gx - 9, y1: y + 6, x2: gx - 2, y2: y - 6, stroke: INK, 'stroke-width': 1.4, opacity: 0.55 }, weave);
        el('line', { x1: gx + 2, y1: y + 6, x2: gx + 9, y2: y - 6, stroke: INK, 'stroke-width': 1.4, opacity: 0.55 }, weave);
      }
    }

    // Date axis: one tick and one real date per column, so the
    // reader can check every knot against its date. The axis runs
    // dashed across the break band.
    {
      const axis = el('g', {}, weave);
      const ax0 = slotX(0) - 20, ax1 = slotX(slots.length - 1) + 20;
      if (gap) {
        el('line', { x1: ax0, y1: H - 20, x2: gap.x0, y2: H - 20, stroke: INK2, 'stroke-width': 1, opacity: 0.6 }, axis);
        el('line', { x1: gap.x0, y1: H - 20, x2: gap.x1, y2: H - 20, stroke: INK2, 'stroke-width': 1, opacity: 0.6, 'stroke-dasharray': '4 4' }, axis);
        el('line', { x1: gap.x1, y1: H - 20, x2: ax1, y2: H - 20, stroke: INK2, 'stroke-width': 1, opacity: 0.6 }, axis);
      } else {
        el('line', { x1: ax0, y1: H - 20, x2: ax1, y2: H - 20, stroke: INK2, 'stroke-width': 1, opacity: 0.6 }, axis);
      }
      for (let i = 0; i < slots.length; i++) {
        el('line', { x1: slotX(i), y1: H - 24, x2: slotX(i), y2: H - 16, stroke: INK2, 'stroke-width': 1.2 }, axis);
        const t = el('text', { x: slotX(i), y: H - 4, 'text-anchor': 'middle', class: 'node-sub', fill: INK2 }, axis);
        t.textContent = new Date(slots[i]).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
      }
    }

    // Cross edges: grounding in secondary ink, supersession dashed
    // ink, contradiction dotted ink. Other edge types are record
    // plumbing, not belief relations, and are not drawn.
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

    // Nodes.
    const nodeG = el('g', {}, svg);
    const nodeEls = [];
    const built = [];
    let selectedRing = null;
    const markSelected = (g, n, ringR) => {
      if (selectedRing) selectedRing.remove();
      selectedRing = el('circle', { cx: n.x, cy: n.y, r: ringR, fill: 'none', stroke: INK, 'stroke-width': 1.5, class: 'knot-ring' }, g);
    };
    // The accessible name of a knot (card S8, Section 6.6): the
    // returned label, the returned date and the status word, in
    // the same words the figure and the record use.
    const knotName = (n) => {
      const label = n.kind === 'agent' ? (AGENT_LABEL[n.id] || n.id.split(' ')[0])
        : n.kind === 'source' ? n.id
        : (n.id.startsWith('demo-') ? n.id.slice(5) : (n.author === 'memoryloom-learning' ? 'lesson' : (n.type || 'record')));
      if (n.kind === 'agent') return label + ', agent';
      if (n.kind === 'source') return label + ', source';
      const date = new Date(tOf(n)).toISOString().slice(0, 10);
      const status = n.kind === 'proposal' ? (n.status || 'pending')
        : (n.valid_to && new Date(n.valid_to).getTime() <= tMax ? 'superseded' : 'live');
      return `${label}, ${date}, ${status}`;
    };
    for (const n of nodes.values()) {
      if (!shown.has(n.kind) || n.x === undefined) continue;
      const g = el('g', { 'data-t': tOf(n) || tMin, 'data-kind': n.kind, style: opts.onSelect ? 'cursor:pointer' : '' });
      if (opts.onSelect) {
        // The target rule (card S8, Section 6.1): an interactive
        // knot carries a hit area of at least 24 by 24 CSS pixels
        // at the sizes the figure is read. The drawn shapes stay
        // as drawn; a clear 28 unit square centred on the knot
        // carries the pointing target, behind every shape.
        el('rect', { x: n.x - 14, y: n.y - 14, width: 28, height: 28, fill: '#000', 'fill-opacity': 0, class: 'knot-hit' }, g);
      }
      if (n.kind === 'agent') {
        // Unknown actors appear once a human decides in the console
        // (the graph gains a "human (console)" agent node): label
        // them by their first word — the full id printed at x=44
        // clipped off the left edge in the 5.2 walk captures.
        const label = AGENT_LABEL[n.id] || n.id.split(' ')[0];
        el('circle', { cx: n.x, cy: n.y, r: 17, fill: SURFACE, stroke: INK, 'stroke-width': 1.5 }, g);
        const t = el('text', { x: n.x, y: n.y + 4, 'text-anchor': 'middle', fill: INK, 'font-size': 11, 'font-weight': 700 }, g);
        t.textContent = label[0].toUpperCase();
        const lbl = el('text', { x: n.x, y: n.y + 32, 'text-anchor': 'middle', class: 'node-label' }, g);
        lbl.textContent = label;
      } else if (n.kind === 'source') {
        el('rect', { x: n.x - 5, y: n.y - 5, width: 10, height: 10, fill: SURFACE, stroke: INK, transform: `rotate(45 ${n.x} ${n.y})` }, g);
        const lx = n.labelX ?? n.x, ly = n.y + (n.labelDy ?? 16);
        if (Math.abs(lx - n.x) > 3) {
          el('line', { x1: n.x, y1: n.y + ((n.labelDy ?? 16) < 0 ? -6 : 6), x2: lx, y2: ly + ((n.labelDy ?? 16) < 0 ? 4 : -10), stroke: INK2, 'stroke-width': 0.8, opacity: 0.55 }, g);
        }
        const lbl = el('text', { x: lx, y: ly, 'text-anchor': 'middle', class: 'node-sub' }, g);
        lbl.textContent = n.id.length > 22 ? n.id.slice(0, 21) + '…' : n.id;
      } else {
        const superseded = n.valid_to && new Date(n.valid_to).getTime() <= tMax;
        if (n.kind === 'proposal') {
          el('circle', { cx: n.x, cy: n.y, r: 6, fill: SURFACE, stroke: INK, 'stroke-width': 1.2, 'stroke-dasharray': '3 2' }, g);
        } else {
          el('circle', { cx: n.x, cy: n.y, r: 7.5, fill: INK, 'fill-opacity': superseded ? 0.35 : 0.92, stroke: INK, 'stroke-width': 1 }, g);
          if (superseded) el('line', { x1: n.x - 6, y1: n.y + 6, x2: n.x + 6, y2: n.y - 6, stroke: INK, 'stroke-width': 1.6 }, g);
        }
        const lx = n.labelX ?? n.x, ldy = n.labelDy ?? -13;
        if (Math.abs(lx - n.x) > 3) {
          el('line', { x1: n.x, y1: n.y + (ldy < 0 ? -8 : 8), x2: lx, y2: n.y + ldy + (ldy < 0 ? 4 : -10), stroke: INK2, 'stroke-width': 0.8, opacity: 0.55 }, g);
        }
        const lbl = el('text', { x: lx, y: n.y + ldy, 'text-anchor': 'middle', class: 'node-sub' }, g);
        const short = n.id.startsWith('demo-') ? n.id.slice(5) : (n.author === 'memoryloom-learning' ? 'lesson' : (n.type || 'record'));
        lbl.textContent = short.length > 14 ? short.slice(0, 13) + '…' : short;
      }
      if (opts.onSelect) {
        // Interactive callers (the console graph) get real
        // focusable buttons (card S8, Section 6.6): tabindex in
        // date order (the append order below), role button, the
        // accessible name above, and focus, Enter, Space and
        // click all performing the same activation, so focus and
        // selection show the same ink ring and reveal the same
        // detail panel. Callers without onSelect (the landing
        // hero) get no tab stops, as Section 6.2 states.
        g.setAttribute('tabindex', '0');
        g.setAttribute('role', 'button');
        g.setAttribute('aria-label', knotName(n));
        g.setAttribute('data-node-id', n.node_id);
        const activate = () => { markSelected(g, n, n.kind === 'agent' ? 23 : n.kind === 'memory' ? 13.5 : 12); opts.onSelect(n); };
        g.addEventListener('click', activate);
        g.addEventListener('focus', activate);
        g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } });
      }
      built.push({ g, n });
      nodeEls.push({ g, at: tOf(n) || tMin, kind: n.kind });
    }
    // Append order is paint order. Interactive renders append in
    // returned date order so the tab sequence walks the timeline;
    // static renders keep the returned order untouched.
    const ordered = opts.onSelect
      ? [...built].sort((a, b) => (tOf(a.n) || tMin) - (tOf(b.n) || tMin) || String(a.n.node_id).localeCompare(String(b.n.node_id)))
      : built;
    for (const { g } of ordered) nodeG.appendChild(g);
    // The drawn counts, recorded on the figure itself (card S8):
    // a caller that summarises the figure for its role img label
    // reads the count of knots actually drawn, so the words can
    // never disagree with the picture.
    svg.dataset.knotCount = String(built.length);
    svg.dataset.threadCount = String(new Set(built.filter((b) => b.n.kind === 'agent').map((b) => b.n.id)).size);

    // Playhead (animated callers only; the caller styles it with
    // the one accent, because it marks the moment a memory moved).
    let playLine = null, playLabel = null;
    if (animated) {
      // The label baseline sits at 15, not at the frame edge: at 10
      // the rendered text box crossed the top of the frame by more
      // than a unit at both widths (card S4 measurement), so the
      // date the sweep had reached was clipped by the frame it
      // lives in. The line starts below the label box.
      playLine = el('line', { x1: 118, y1: 19, x2: 118, y2: H - 44, class: 'playhead-line' }, svg);
      playLabel = el('text', { x: 118, y: 15, 'text-anchor': 'middle', class: 'playhead-label' }, svg);
    }
    function setTime(t) {
      for (const { g, at, kind } of nodeEls) {
        if (kind === 'agent' || kind === 'source') { g.style.opacity = ''; continue; }
        g.style.opacity = at <= t ? '1' : '0.12';
      }
      for (const { el: p, at } of edgeEls) p.style.opacity = at <= t ? '' : '0.06';
      // The axis lives inside the swept group, and its last tick
      // sits past the last knot centre, so a window that ends at
      // the centre plus a margin slices the final glyph of the
      // last date in the settled figure (a reader caught exactly
      // that in the card S4 captures). At the final time the
      // window therefore opens to the whole frame. Earlier times
      // keep the window at the playhead, as before.
      clipRect.setAttribute('width', t >= tMax ? frameW : Math.max(0, xFor(t) + 8));
      if (playLine) {
        const x = xFor(t);
        playLine.setAttribute('x1', x); playLine.setAttribute('x2', x);
        playLabel.setAttribute('x', x);
        playLabel.textContent = new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      }
    }
    if (!animated) { setTime(tMax); return { setTime, toggle: () => true, settle() { setTime(tMax); }, stop() {} }; }

    // The sweep plays ONCE and settles (Iteration 5.3, Finding J4):
    // the tokens' motion law is "nothing loops for decoration", and
    // the old modulo loop swept the corpus forever. One pass over
    // the timeline, a hold at the end, then the settled figure —
    // the end state is the truth, fully drawn. The caller's toggle
    // still pauses/resumes mid-sweep, and after the settle it
    // replays the sweep from the start (opts.onFinish lets the
    // caller relabel the control "Replay").
    let start = performance.now();
    const SPAN = 15000, HOLD = 2600;
    let raf = 0, paused = false, finished = false, running = false, pausedElapsed = 0;
    function frame(now) {
      if (!paused && !finished) {
        const elapsed = now - start;
        if (elapsed >= SPAN + HOLD) {
          finished = true; paused = true; running = false;
          setTime(tMax);
          if (opts.onFinish) opts.onFinish();
          return; // settled: no further frames are scheduled
        }
        // The sweep walks date columns, not raw time (5.4): each
        // inter date interval gets an equal share of the sweep, so
        // the playhead crosses the labelled break in one share
        // instead of spending most of the animation on empty axis.
        // setTime still receives a true time inside the interval,
        // so the date readout stays honest.
        let t = tMax;
        if (elapsed < SPAN && slots.length > 1) {
          const pos = (elapsed / SPAN) * (slots.length - 1);
          const i = Math.min(slots.length - 2, Math.floor(pos));
          t = slots[i] + (pos - i) * (slots[i + 1] - slots[i]);
        }
        setTime(t);
      }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame); running = true;
    return {
      setTime,
      toggle() {
        if (finished) {
          finished = false; paused = false;
          start = performance.now();
          if (!running) { raf = requestAnimationFrame(frame); running = true; }
          return paused;
        }
        paused = !paused;
        if (paused) pausedElapsed = performance.now() - start;
        else start = performance.now() - pausedElapsed;
        return paused;
      },
      settle() { finished = true; paused = true; running = false; cancelAnimationFrame(raf); setTime(tMax); },
      stop() { running = false; cancelAnimationFrame(raf); },
    };
  }

  window.MemoryLoomGraph = { renderGraph };
})();
