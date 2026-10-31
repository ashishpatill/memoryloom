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
 * The demo corpus has THREE authors: grok, moose, and the learning
 * promotion (recorded as "memoryloom-learning", labelled "learning")
 * that authored the standing lesson. Promoted records carry UUID
 * ids and are labelled "lesson".
 *
 * API: MemoryLoomGraph.renderGraph(svg, graph, { animated, onSelect })
 *   -> { setTime(t), toggle(), settle(), stop() }
 * onSelect, when given, fires for EVERY knot kind (agent, memory,
 * proposal, source) — what a click means is the view's business,
 * but no knot is a silent dead end.
 */
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const INK = '#1d1a15';
  const INK2 = '#5f584a';
  const SURFACE = '#fdfbf6';
  const AGENT_Y = { grok: 70, moose: 182, 'memoryloom-learning': 262 };
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
    // Sources sit under the first memory that cites them.
    for (const e of graph.edges) {
      if (e.type === 'cites_source') {
        const s = nodes.get(e.to), m = nodes.get(e.from);
        if (s && m) { s.x = m.x; s.y = H - 26; }
      }
    }
    // ---- Collision-aware label placement (Iteration 5.3, Finding E)
    // Alternating labels above/below (the 5.2 discipline) is not
    // enough in the October cluster: knots one day apart sit ~3
    // units apart on the axis, so every second label on the same
    // side printed over its neighbour (g1/g4/p1 garbled), and the
    // source labels at the foot are each far wider than the gap
    // between their diamonds. The rule now is a minimum separation,
    // enforced geometrically: labels on the same side of the same
    // thread (or foot level) are spread along the axis until no two
    // label boxes touch, and a thin leader line ties a displaced
    // label back to its knot's true position. The knots themselves
    // never move — only labels do — except source diamonds, which
    // carry no drawn edges and are spread to a 14-unit minimum so
    // the diamonds themselves cannot overlap either.
    const labelTextOf = (n) => {
      if (n.kind === 'source') return n.id.length > 22 ? n.id.slice(0, 21) + '…' : n.id;
      const short = n.id.startsWith('demo-') ? n.id.slice(5) : 'lesson';
      return short.length > 14 ? short.slice(0, 13) + '…' : short;
    };
    // 9px IBM Plex Mono advances ≈5.4 units per character; the
    // estimate adds padding so measured boxes keep a real gap.
    const halfWidth = (n) => (labelTextOf(n).length * 5.4) / 2 + 3;
    function spread(items, { left = 92, right = W - 20, gap = 7, preserve = false } = {}) {
      items.sort((a, b) => (a.labelX ?? a.x) - (b.labelX ?? b.x));
      for (const it of items) { it.labelHalf = halfWidth(it); if (!preserve || it.labelX === undefined) it.labelX = it.x; }
      const forward = () => {
        for (let i = 1; i < items.length; i++) {
          const need = items[i - 1].labelX + items[i - 1].labelHalf + gap + items[i].labelHalf;
          if (items[i].labelX < need) items[i].labelX = need;
        }
      };
      forward();
      const last = items[items.length - 1];
      if (last && last.labelX + last.labelHalf > right) {
        const shift = last.labelX + last.labelHalf - right;
        for (const it of items) it.labelX -= shift;
        forward(); // re-assert separation after the pull-back
      }
      const first = items[0];
      if (first && first.labelX - first.labelHalf < left) {
        const shift = left - (first.labelX - first.labelHalf);
        for (const it of items) it.labelX += shift;
        forward();
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
      if (lastS && lastS.x > W - 30) {
        let overflow = lastS.x - (W - 30);
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
      for (const group of byLevel.values()) spread(group);
    }
    // Knot labels: alternate sides as before, then spread each
    // (thread, side) group to the minimum separation.
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
      for (const dy of [-13, 24]) {
        const sameSide = group.filter((n) => n.labelDy === dy);
        if (sameSide.length) spread(sameSide);
      }
    }
    // Final pass, global (same finding, second review): side
    // grouping alone still collided once — thread jitter can put
    // one knot's above-label and a neighbour's below-label at
    // almost the same height (g1/p1 measured 10.5 units of box
    // overlap in the first 5.3 capture). So every label in the
    // figure is clustered by its actual label height (within 12
    // units = one row, the rendered box height of the 9px mono
    // labels) and each row is spread once more, preserving the
    // positions the earlier passes chose.
    {
      const all = [...nodes.values()].filter(
        (n) => (n.kind === 'memory' || n.kind === 'proposal' || n.kind === 'source') && n.x !== undefined
      );
      for (const n of all) {
        n.labelY = n.y + (n.labelDy ?? -13);
        if (n.labelX === undefined) n.labelX = n.x;
      }
      all.sort((a, b) => a.labelY - b.labelY);
      let row = [];
      const rows = [row];
      for (const n of all) {
        if (row.length && n.labelY - row[row.length - 1].labelY > 12) { row = []; rows.push(row); }
        row.push(n);
      }
      for (const r of rows) if (r.length > 1) spread(r, { preserve: true });
    }
    return { nodes, tMin, tMax, xFor };
  }

  function renderGraph(svg, graph, opts = {}) {
    const W = 720, H = 330;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = '';
    const timed = graph.nodes.filter((n) => (n.kind === 'memory' || n.kind === 'proposal') && tOf(n) > 0);
    if (!timed.length) {
      // No timed records: nothing honest to draw. The caller owns
      // the empty state; the renderer simply draws nothing.
      return { setTime() {}, toggle: () => true, settle() {}, stop() {} };
    }
    const { nodes, tMin, tMax, xFor } = layout(graph, W, H);
    const animated = Boolean(opts.animated);
    const shown = new Set(['agent', 'memory', 'proposal', 'source']);

    const clipId = 'weave-clip-' + (++clipSeq);
    const defs = el('defs', {}, svg);
    const clip = el('clipPath', { id: clipId }, defs);
    const clipRect = el('rect', { x: 0, y: 0, width: animated ? 0 : W, height: H }, clip);
    const weave = el('g', { 'clip-path': `url(#${clipId})` }, svg);

    // Thread lines: one per author, ink, told apart by position.
    for (const [agent, y] of Object.entries(AGENT_Y)) {
      const mine = [...nodes.values()]
        .filter((n) => n.author === agent && (n.kind === 'memory' || n.kind === 'proposal'))
        .sort((a, b) => a.x - b.x);
      if (!mine.length) continue;
      const pts = [[64, y], ...mine.map((n) => [n.x, n.y]), [W - 30, y]];
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
      el('path', { d, fill: 'none', stroke: INK, 'stroke-width': 1.5, opacity: agent === 'grok' ? 0.55 : 0.3 }, weave);
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
    for (const n of nodes.values()) {
      if (!shown.has(n.kind) || n.x === undefined) continue;
      const g = el('g', { 'data-t': tOf(n) || tMin, 'data-kind': n.kind, style: opts.onSelect ? 'cursor:pointer' : '' }, nodeG);
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
        const short = n.id.startsWith('demo-') ? n.id.slice(5) : 'lesson';
        lbl.textContent = short.length > 14 ? short.slice(0, 13) + '…' : short;
      }
      if (opts.onSelect) g.addEventListener('click', () => opts.onSelect(n));
      nodeEls.push({ g, at: tOf(n) || tMin, kind: n.kind });
    }

    // Playhead (animated callers only; the caller styles it with
    // the one accent, because it marks the moment a memory moved).
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
        const t = elapsed >= SPAN ? tMax : tMin + (elapsed / SPAN) * (tMax - tMin);
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
