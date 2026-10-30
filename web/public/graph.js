/* Living memory graph renderer — shared by the site hero and the
   console graph view. Layout is a weave: each agent owns a horizontal
   thread line, memories sit on their author's line at their recorded
   time, and cross-links (grounding, supersession, contradiction,
   sources) arc between the threads. In animated mode a playhead
   sweeps the corpus timeline and memories appear as they were
   recorded — the data drives the motion, nothing is canned. */
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const AGENT_Y = { grok: 74, moose: 196 };
  const AGENT_COLOR = { grok: '#a63d2a', moose: '#2f5d50' };

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
      if (n.kind === 'agent') {
        n.x = 44; n.y = AGENT_Y[n.id] ?? 130;
      } else if (n.kind === 'memory' || n.kind === 'proposal') {
        const a = authorOf.get(n.node_id);
        n.x = xFor(tOf(n));
        n.y = (AGENT_Y[a] ?? 130) + hashJitter(n.id, 30);
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
    for (const n of nodes.values()) if (n.x === undefined) { n.x = W / 2; n.y = H - 26; }
    return { nodes, authorOf, tMin, tMax, xFor };
  }

  function renderGraph(svg, graph, opts = {}) {
    const W = 720, H = 300;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = '';
    const { nodes, tMin, tMax, xFor } = layout(graph, W, H);
    const animated = Boolean(opts.animated);

    // Thread lines (the weave): one per agent, drawn through their
    // memories in time order.
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
      el('path', { d, fill: 'none', stroke: AGENT_COLOR[agent], 'stroke-width': 1.6, opacity: 0.4 }, weave);
    }

    // Cross edges.
    const edgeG = el('g', {}, weave);
    const edgeEls = [];
    for (const e of graph.edges) {
      if (['authored_by', 'proposed_by', 'decided', 'promoted_to', 'derived_from', 'links_to', 'merged_into'].includes(e.type)) continue;
      const a = nodes.get(e.from), b = nodes.get(e.to);
      if (!a || !b) continue;
      const mx = (a.x + b.x) / 2, my = Math.min(a.y, b.y) - 26;
      const path = el('path', {
        d: `M${a.x},${a.y} Q${mx},${my} ${b.x},${b.y}`,
        class: `edge ${e.type}`,
        stroke: e.type === 'grounded_in' ? '#6a6250' : undefined,
      }, edgeG);
      edgeEls.push({ el: path, at: Math.max(tOf(a) || 0, tOf(b) || 0) });
    }

    // Nodes.
    const nodeG = el('g', {}, svg);
    const nodeEls = [];
    for (const n of nodes.values()) {
      const g = el('g', { 'data-t': tOf(n) || tMin, style: opts.onSelect ? 'cursor:pointer' : '' }, nodeG);
      if (n.kind === 'agent') {
        el('circle', { cx: n.x, cy: n.y, r: 17, fill: AGENT_COLOR[n.id] || '#6a6250' }, g);
        const t = el('text', { x: n.x, y: n.y + 4, 'text-anchor': 'middle', fill: '#f6f2e9', 'font-size': 11, 'font-weight': 700 }, g);
        t.textContent = n.id[0].toUpperCase();
        const lbl = el('text', { x: n.x, y: n.y + 32, 'text-anchor': 'middle', class: 'node-label' }, g);
        lbl.textContent = n.id;
      } else if (n.kind === 'source') {
        el('rect', { x: n.x - 5, y: n.y - 5, width: 10, height: 10, fill: '#a97b12', transform: `rotate(45 ${n.x} ${n.y})` }, g);
        const lbl = el('text', { x: n.x, y: n.y + 16, 'text-anchor': 'middle', class: 'node-sub' }, g);
        lbl.textContent = n.id.length > 22 ? n.id.slice(0, 21) + '…' : n.id;
      } else {
        const superseded = n.valid_to && new Date(n.valid_to).getTime() <= tMax;
        const fill = n.kind === 'proposal' ? '#f6f2e9' : (AGENT_COLOR[n.author] || '#6a6250');
        const attrs = { cx: n.x, cy: n.y, r: n.kind === 'proposal' ? 6 : 7.5, fill, 'fill-opacity': superseded ? 0.35 : 0.92, stroke: '#221d14', 'stroke-width': 1 };
        if (n.kind === 'proposal') { attrs.fill = '#f6f2e9'; attrs.stroke = AGENT_COLOR[n.author] || '#6a6250'; attrs['stroke-dasharray'] = '3 2'; }
        el('circle', attrs, g);
        if (superseded) el('line', { x1: n.x - 6, y1: n.y + 6, x2: n.x + 6, y2: n.y - 6, stroke: '#a97b12', 'stroke-width': 1.6 }, g);
        const lbl = el('text', { x: n.x, y: n.y - 13, 'text-anchor': 'middle', class: 'node-sub' }, g);
        lbl.textContent = n.id.replace('demo-', '');
      }
      if (opts.onSelect) g.addEventListener('click', () => opts.onSelect(n));
      nodeEls.push({ g, at: tOf(n) || tMin, kind: n.kind });
    }

    // Playhead.
    let playLine = null, playLabel = null;
    if (animated) {
      playLine = el('line', { x1: 118, y1: 14, x2: 118, y2: H - 44, class: 'playhead-line' }, svg);
      playLabel = el('text', { x: 118, y: 10, 'text-anchor': 'middle', class: 'playhead-label' }, svg);
    }
    const fmt = (t) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
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
        playLabel.textContent = fmt(t);
      }
    }
    if (!animated) { setTime(tMax); return { setTime }; }

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
      setTime,
      toggle() { paused = !paused; if (!paused) start = performance.now() - 0; return paused; },
      stop() { cancelAnimationFrame(raf); },
    };
  }

  window.MemoryLoomGraph = { renderGraph };
})();
