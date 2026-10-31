/* MemoryLoom console — seven views over the real backend.
   Three states everywhere: a still skeleton while loading, a
   designed empty state when there is nothing to show, and the
   populated view. The console displays decisions; it never makes
   or overrides one.
   Design tokens v2 (Iteration 5.2): the console wears the same
   type, spacing, rules and motion as the landing page. Standing
   is carried by word + marker shape in ink (the tokens' badges,
   via data-state) — never by colour; agents are told apart by
   their name, never by a hue; the accent is spent nowhere in the
   console, because no console view marks a live decision with it
   — the gate's verdicts here are records, and records are ink. */
(function () {
  const main = document.getElementById('main');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
  const fmtTs = (d) => d ? new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
  // Sub-thousandth costs must not print as $0.000 in a table whose
  // purpose is cost evidence (5.3 re-review): a real charge rounded
  // to "free" is a false claim.
  const fmtUsd = (v) => (v === 0 ? '$0' : v < 0.0005 ? '<$0.001' : '$' + Number(v).toFixed(3));

  async function api(path, opts) {
    const r = await fetch(path, opts);
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || ('HTTP ' + r.status));
    return body;
  }
  function skeleton() {
    main.innerHTML = '<div class="skeleton" role="status"><span class="sr-only">Loading…</span><div class="sk"></div><div class="sk"></div><div class="sk"></div><div class="sk"></div></div>';
  }
  function errorState(err, retry) {
    main.innerHTML = `<div class="empty-state error-state"><h3>The store did not answer</h3>
      <p>${esc(err.message || err)}</p>
      <p class="small">The console reads a seeded demo database. If this is a fresh checkout: <code class="inline">npm run db:init</code>, <code class="inline">npm run seed:web</code>, then reload.</p>
      <button class="btn" id="retryBtn" type="button">Try again</button></div>`;
    document.getElementById('retryBtn').addEventListener('click', retry);
  }
  function head(title, sub, pull) {
    // View titles match the nav labels word for word (5.2 friction
    // fix: the two used to differ on five of seven views). The
    // italic pull line is the view's one-sentence promise, set in
    // Newsreader italic — the console is where that face is used.
    return `<h2>${esc(title)}</h2>${pull ? `<p class="pull-line">${pull}</p>` : ''}<p class="view-sub">${sub}</p>`;
  }
  function verdictBadge(d) {
    // Standing by word + marker shape, in ink (tokens v2). The
    // escalated badge keeps its full form — "escalated · awaiting
    // a human" — wherever a status first appears: it is the
    // in-place gloss for the word (5.1 stranger-read lesson).
    if (d === 'approve' || d === 'approved' || d === 'auto_approved') return '<span class="badge" data-state="approved">approved</span>';
    if (d === 'reject' || d === 'rejected') return '<span class="badge" data-state="rejected">rejected</span>';
    if (d === 'escalate' || d === 'queued_for_review' || d === 'pending') return '<span class="badge" data-state="escalated">escalated · awaiting a human</span>';
    return `<span class="badge">${esc(d || '—')}</span>`;
  }
  function agentBadge(a) {
    // Agents carry no hue in v2: the name is the badge.
    return a ? `<span class="badge">${esc(a)}</span>` : '';
  }
  /* Plain words for machine vocabulary (Iteration 5.3, Finding J):
     event kinds, daemon kinds and gate route reasons are stored as
     snake_case / machine strings; the console renders what they
     mean. The grounding glosses use resolved-records semantics
     (Finding A): a citation counts only when it resolves in the
     store. */
  const KIND_PLAIN = {
    proposal: 'proposal', gate_verdict: 'gate verdict',
    human_approval: 'human approval', human_rejection: 'human rejection', human_correction: 'human correction',
    recall_hit: 'recall hit', recall_miss: 'recall miss', eval_outcome: 'eval outcome',
    in_turn_correction: 'in-turn correction', promotion_decision: 'promotion decision', lesson_applied: 'lesson applied',
  };
  const kindPlain = (k) => KIND_PLAIN[k] || String(k || '').replace(/_/g, ' ');
  const DAEMON_KIND_PLAIN = {
    import_contradiction: 'imported contradiction',
    contradiction_flag: 'contradiction flagged',
    consolidation_candidate: 'consolidation candidate',
    decay_candidate: 'decay candidate',
    resolution: 'daemon proposal',
  };
  function daemonBadge(item) {
    const p = item.payload || {};
    const key = p.daemon_kind || item.kind || '';
    return DAEMON_KIND_PLAIN[key] || kindPlain(key);
  }
  const ROUTE_PLAIN = {
    'grounding_ids>=2': 'grounding rule — at least two cited records resolved in the store',
    'low-evidence': 'low evidence — fewer than two cited records resolved in the store',
    'procedural-human-always': 'procedural — always decided by a human',
    'pinned-human-always': 'pinned — always decided by a human',
    'jev-escalate': 'the gate escalated this to a human',
    'jev-unavailable-fail-closed': 'the gate was unavailable — failed closed to a human',
    'episodic-or-node_local': 'episodic or node-local — approved by rule',
  };
  const routePlain = (r) => ROUTE_PLAIN[r] || kindPlain(r || '—');
  /* The propose banner speaks plain words too (5.3 re-review: it
     printed the raw decision and route strings — "queued_for_review
     — jev-unavailable-fail-closed" — directly over the row that
     translated them properly). */
  const DECISION_PLAIN = {
    auto_approved: 'approved by the gate',
    rejected: 'rejected by the gate',
    queued_for_review: 'sent to a human',
  };
  const decisionPlain = (d) => DECISION_PLAIN[d] || kindPlain(d || '—');
  /* Subject types on learning rows and record origins on receipts:
     stored as machine strings, rendered as what they mean. */
  const SUBJECT_PLAIN = { memory: 'record', learning_event: 'learning event', proposal: 'proposal' };
  const subjectPlain = (s) => SUBJECT_PLAIN[s] || kindPlain(s || '');
  const ORIGIN_PLAIN = {
    propose: 'a proposal', 'propose-auto': 'an automatic proposal', 'propose-jev': 'a gated proposal',
    ingest_file: 'a file import', consolidation: 'consolidation', 'mcp-store': 'a direct store', seed: 'the seed',
  };
  const originPlain = (o) => ORIGIN_PLAIN[o] || kindPlain(o || '—');
  function jevDetail(jev) {
    if (!jev) return '';
    const bits = [];
    if (jev.decision) bits.push('decision ' + jev.decision);
    if (jev.probability !== undefined) bits.push('calibrated score ' + Number(jev.probability).toFixed(3));
    if (jev.raw_probability !== undefined) bits.push('raw ' + Number(jev.raw_probability).toFixed(3));
    if (jev.model) bits.push(jev.model);
    if (jev.reason) bits.push(jev.reason);
    return `<div class="receipt">gate record — ${esc(bits.join(' · '))}</div>`;
  }

  /* The gate's last answer, kept across the loop's auto-reload
     (5.2 friction fix: the answer used to be wiped by the reload
     after 900ms, leaving the reader to hunt the Decided list to
     learn what the gate said). */
  let loopFlash = '';
  function daemonSummary(item) {
    // Daemon review items used to render their raw JSON payload —
    // unreadable, and the worst 360px overflow in the console.
    // The summary is built only from fields the payload actually
    // carries; anything unrecognised is described, never dumped.
    const p = item.payload || {};
    if (p.summary) return String(p.summary);
    if (p.text) return String(p.text);
    const ids = [...(Array.isArray(p.memory_ids) ? p.memory_ids : []), ...(p.memory_id ? [p.memory_id] : [])];
    const about = ids.length ? ids.join(', ') : 'the corpus';
    // The specific daemon_kind in the payload outranks the generic
    // review-item kind ("resolution" covers decay candidates too —
    // the first 5.2 capture summarised a decay candidate as a
    // generic resolution, which is why the order below matters).
    const kind = `${p.daemon_kind || ''} ${item.kind || ''}`;
    if (kind.includes('contradiction') || p.detector) return `Contradiction flagged between ${about}${p.detector ? ` (detector: ${p.detector})` : ''}. A human settles which belief stands.`;
    if (kind.includes('decay')) return `Decay candidate: ${about} — recorded, not recently used. The gate decides keep or drop.`;
    if (kind.includes('consolidation')) return `Consolidation candidate: ${about} may say the same thing more than once.`;
    if (kind.includes('resolution')) return `Resolution proposed for ${about}.`;
    return `Daemon proposal about ${about}.`;
  }

  /* ---------------- Live loop ---------------- */
  async function viewLoop() {
    skeleton();
    let ov, props;
    try {
      [ov, props] = await Promise.all([api('/api/overview'), api('/api/proposals')]);
    } catch (e) { return errorState(e, viewLoop); }
    const pending = props.proposals.filter((p) => p.status === 'pending');
    const decided = props.proposals.filter((p) => p.status !== 'pending');
    const memCount = ov.memories_by_type.reduce((a, r) => a + r.n, 0);
    const flash = loopFlash; loopFlash = '';
    main.innerHTML = `
      ${head('Live loop', 'Agents propose; the gate decides; humans settle what the gate escalates. Propose something yourself and watch the real gate answer.', 'Nothing enters memory unexamined.')}
      ${flash ? `<div class="flash" role="status"><span class="flash-label">Last gate answer</span>${esc(flash)}</div>` : ''}
      <div class="kv">
        <div class="card"><div class="big">${memCount}</div><div class="small">memories in truth</div></div>
        <div class="card"><div class="big">${pending.length}</div><div class="small">proposals awaiting a human</div></div>
        <div class="card"><div class="big">${ov.lessons}</div><div class="small">playbook lessons standing</div></div>
        <div class="card"><div class="big">${ov.learning_events}</div><div class="small">learning events on record</div></div>
      </div>
      <div class="card" style="margin-bottom:20px">
        <h3>Propose a memory</h3>
        <div class="toolbar" style="margin-bottom:0">
          <div><label class="f" for="pAuthor">Agent</label>
            <select id="pAuthor"><option>grok</option><option>moose</option></select></div>
          <div><label class="f" for="pType">Type</label>
            <select id="pType"><option value="semantic">semantic (a fact)</option><option value="episodic">episodic (an event)</option><option value="procedural">procedural (a how-to)</option></select></div>
          <div><label class="f" for="pGround">Grounding record ids (comma-separated, optional)</label>
            <input type="text" id="pGround" placeholder="e.g. demo-g2, demo-g3"></div>
        </div>
        <label class="f" for="pText">The memory</label>
        <textarea id="pText" placeholder="One atomic claim. Try the firmware claim with no grounding, then with demo-g2 and demo-g3 cited."></textarea>
        <div style="margin-top:12px;display:flex;gap:10px;align-items:center">
          <button class="btn primary" id="pSend" type="button">Send through the gate</button>
          <span id="pResult" class="small"></span>
        </div>
      </div>
      <h3>Waiting for a human (${pending.length})</h3>
      <div id="pendingList">${pending.length ? '' : '<div class="empty-state"><h3>The inbox is clear</h3><p>Nothing is escalated right now. Propose a procedural memory, or a fact with no grounding, and the gate will send it here.</p></div>'}</div>
      <h3 style="margin-top:22px">Decided (${decided.length})</h3>
      <div id="decidedList">${decided.length ? '' : '<div class="empty-state"><h3>No decisions yet</h3><p>Decided proposals will appear here with who decided them and why.</p></div>'}</div>
      ${props.daemon_review_items.length ? `<h3 style="margin-top:22px">Daemon proposals (${props.daemon_review_items.length})</h3>
        <p class="small">The background daemon may only propose. These items wait for the same human decision as everything else.</p>
        <div>${props.daemon_review_items.map((i) => `<div class="row-item"><div class="meta"><span class="badge">${esc(daemonBadge(i))}</span><span class="small">${fmtTs(i.created_at)}</span></div><div class="text">${esc(daemonSummary(i))}</div></div>`).join('')}</div>` : ''}
    `;
    const pendingList = document.getElementById('pendingList');
    for (const p of pending) pendingList.appendChild(proposalRow(p, true));
    const decidedList = document.getElementById('decidedList');
    for (const p of decided) decidedList.appendChild(proposalRow(p, false));
    document.getElementById('pSend').addEventListener('click', async () => {
      const btn = document.getElementById('pSend');
      const out = document.getElementById('pResult');
      btn.disabled = true; out.textContent = 'The gate is deciding…';
      try {
        const r = await api('/api/propose', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            author: document.getElementById('pAuthor').value,
            type: document.getElementById('pType').value,
            text: document.getElementById('pText').value,
            grounding_ids: document.getElementById('pGround').value.split(',').map((s) => s.trim()).filter(Boolean),
          }),
        });
        loopFlash = `Gate: ${decisionPlain(r.decision)} — ${routePlain(r.reason)}`;
        out.innerHTML = `Gate: <b>${esc(decisionPlain(r.decision))}</b> — ${esc(routePlain(r.reason))}. Reloading the loop…`;
        setTimeout(viewLoop, 900);
      } catch (e) {
        out.textContent = 'The gate did not answer: ' + e.message;
        btn.disabled = false;
      }
    });
  }
  function proposalRow(p, actionable) {
    const div = document.createElement('div');
    div.className = 'row-item';
    const prov = p.provenance || {};
    div.innerHTML = `
      <div class="meta">${agentBadge(prov.author)}<span class="badge">${esc(p.type)}</span>${verdictBadge(p.status === 'pending' ? 'pending' : p.status)}
        <span class="small">${fmtTs(p.created_at)} · route: ${esc(routePlain(p.route_reason))}</span></div>
      <div class="text">${esc(p.text)}</div>
      ${p.grounding_ids?.length ? `<div class="detail">cites: ${p.grounding_ids.map((g) => `<code class="inline">${esc(g)}</code>`).join(' ')}</div>` : (prov.unresolved_citations?.length ? `<div class="detail">cites: nothing that resolves in this store (${prov.unresolved_citations.length} cited, none found)</div>` : '<div class="detail">cites: nothing</div>')}
      ${jevDetail(prov.jev)}
      ${p.status !== 'pending' ? `<div class="detail">decided by ${esc(p.decided_by || '—')}${p.promoted_id ? ` · became memory <code class="inline">${esc(p.promoted_id)}</code>` : ''}</div>` : ''}
      ${actionable ? '<div class="actions"><button class="btn small-btn" data-act="approve" type="button">Approve into truth</button><button class="btn small-btn" data-act="reject" type="button">Reject</button><span class="small act-msg"></span></div>' : ''}
    `;
    if (actionable) {
      div.querySelectorAll('button[data-act]').forEach((b) => b.addEventListener('click', async () => {
        const msg = div.querySelector('.act-msg');
        div.querySelectorAll('button').forEach((x) => (x.disabled = true));
        msg.textContent = 'Recording your decision…';
        try {
          await api(`/api/proposals/${encodeURIComponent(p.id)}/decide`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ decision: b.dataset.act }),
          });
          loopFlash = `Your decision was recorded: ${b.dataset.act === 'approve' ? 'approved into truth' : 'rejected'}.`;
          msg.textContent = 'Decided. Reloading…';
          setTimeout(viewLoop, 700);
        } catch (e) {
          msg.textContent = 'Failed: ' + e.message;
          div.querySelectorAll('button').forEach((x) => (x.disabled = false));
        }
      }));
    }
    return div;
  }

  /* ---------------- Recall ---------------- */
  async function viewRecall(prefill) {
    main.innerHTML = `
      ${head('Recall + receipts', 'Ask the store a question. Every answer carries its receipt — the record it came from, who wrote it, what it rests on. Anything that cannot produce a receipt is dropped, and the drop is shown too.', 'No receipt, no answer.')}
      <div class="toolbar">
        <div><label class="f" for="q">Question</label>
          <input type="text" id="q" placeholder="e.g. what firmware does the rig run?"></div>
        <button class="btn primary" id="ask" type="button">Recall</button>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
        ${['what firmware does the rig run?', 'where is the demo held?', 'when does the venue open?', 'what is the wifi password?'].map((q) => `<button class="btn small-btn chip" data-q="${esc(q)}" type="button">${esc(q)}</button>`).join('')}
      </div>
      <div id="recallOut"><div class="empty-state"><h3>Nothing recalled yet</h3><p>Ask a question above. Ask something the corpus cannot answer — the wifi password — and the view says there is no answer: the closest records are listed underneath, labelled as records that do not answer, with their fusion scores, and anything that cannot produce a receipt is dropped in the open.</p></div></div>
    `;
    const ask = async () => {
      const q = document.getElementById('q').value.trim();
      const out = document.getElementById('recallOut');
      if (!q) return;
      out.innerHTML = '<div class="skeleton"><div class="sk"></div><div class="sk"></div></div>';
      try {
        const r = await api('/api/recall?q=' + encodeURIComponent(q) + '&k=8');
        if (!r.results.length && !r.dropped.length) {
          out.innerHTML = '<div class="empty-state"><h3>No receipts, no answer</h3><p>The store holds nothing that answers this — and says so, instead of inventing one. That refusal is the feature.</p></div>';
          return;
        }
        // No-answer state (Iteration 5.3, Finding B): when the best
        // fusion score is under the answer threshold (the API marks
        // it `no_answer`; the same rule is re-checked here from the
        // scores so the view is honest against any payload), the
        // near-misses are NOT an answer. They are listed below the
        // refusal, labelled as the closest records that do not
        // answer, with their scores shown.
        const topScore = Math.max(...r.results.map((res) => res.rrf ?? 0));
        const noAnswer = r.no_answer === true || (r.results.length > 0 && r.answerable === undefined && topScore > 0 && topScore < 0.025);
        if (noAnswer) {
          out.innerHTML =
            '<div class="empty-state"><h3>No receipts, no answer</h3><p>No receipts, no answer — the store holds nothing that answers this, and says so, instead of inventing one. The best match scored ' + topScore.toFixed(3) + ', below the 0.025 answer threshold: both search legs must agree before a record counts as an answer.</p></div>' +
            '<h3 style="margin-top:18px">Closest records — these do not answer the question (' + r.results.length + ')</h3>' +
            r.results.map((res) => `
            <div class="row-item">
              <div class="meta"><span class="badge">closest record — not an answer</span><span class="badge">${esc(res.type)}</span>${res.rrf != null ? `<span class="small">fusion score ${Number(res.rrf).toFixed(3)}</span>` : ''}</div>
              <div class="text">${esc(res.text)}</div>
              <div class="receipt">receipt — record ${esc(res.receipt.memory_id)} · by ${esc(res.receipt.author)} via ${esc(originPlain(res.receipt.origin))} · recorded ${fmtDate(res.receipt.record_created_at)}</div>
            </div>`).join('') +
            (r.dropped.length ? `<h3 style="margin-top:18px">Dropped before the agent could see them (${r.dropped.length})</h3>` +
              r.dropped.map((d) => `<div class="row-item"><div class="meta"><span class="badge" data-state="rejected">dropped</span><code class="inline">${esc(d.id)}</code></div><div class="detail">${esc(d.why)}</div></div>`).join('') : '');
          return;
        }
        out.innerHTML =
          r.results.map((res) => `
            <div class="row-item">
              <div class="meta"><span class="badge">receipt</span><span class="badge">${esc(res.type)}</span>${res.rrf != null ? `<span class="small">fusion score ${Number(res.rrf).toFixed(3)}</span>` : ''}</div>
              <div class="text">${esc(res.text)}</div>
              <div class="receipt">receipt — record ${esc(res.receipt.memory_id)} · by ${esc(res.receipt.author)} via ${esc(originPlain(res.receipt.origin))} · recorded ${fmtDate(res.receipt.record_created_at)} · valid ${fmtDate(res.receipt.valid_from)}${res.receipt.valid_to ? ' → ' + fmtDate(res.receipt.valid_to) : ' → still held'}${res.receipt.grounding_ids?.length ? ' · rests on ' + res.receipt.grounding_ids.join(', ') : ''}${res.receipt.evidence_refs?.length ? ' · sources ' + res.receipt.evidence_refs.join(', ') : ''}</div>
            </div>`).join('') +
          (r.dropped.length ? `<h3 style="margin-top:18px">Dropped before the agent could see them (${r.dropped.length})</h3>` +
            r.dropped.map((d) => `<div class="row-item"><div class="meta"><span class="badge" data-state="rejected">dropped</span><code class="inline">${esc(d.id)}</code></div><div class="detail">${esc(d.why)}</div></div>`).join('') : '');
      } catch (e) {
        out.innerHTML = `<div class="empty-state error-state"><h3>Recall failed</h3><p>${esc(e.message)}</p></div>`;
      }
    };
    document.getElementById('ask').addEventListener('click', ask);
    document.getElementById('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') ask(); });
    document.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => { document.getElementById('q').value = c.dataset.q; ask(); }));
    if (prefill) { document.getElementById('q').value = prefill; ask(); }
  }

  /* ---------------- Graph ---------------- */
  async function viewGraph() {
    skeleton();
    let graph;
    try { graph = await api('/api/graph'); } catch (e) { return errorState(e, viewGraph); }
    const records = graph.nodes.filter((n) => n.kind === 'memory' || n.kind === 'proposal');
    if (!records.length) {
      // Designed empty state (5.2 fix: an empty corpus used to draw
      // a blank figure captioned "0 nodes · 0 edges" and nothing else).
      main.innerHTML = `
        ${head('Memory graph', 'Truth, drawn. Threads are authorship; arcs are grounding, supersession and contradiction. Click any knot for its provenance trail — the full answer to “why does this exist?”', 'Every belief, drawn from the record.')}
        <div class="empty-state"><h3>The graph is empty</h3><p>This namespace holds no records yet, so there is nothing to draw. Seed the demo corpus (<code class="inline">npm run seed:web</code>) or approve a proposal in the Live loop, and the weave appears here.</p></div>
      `;
      return;
    }
    main.innerHTML = `
      ${head('Memory graph', 'Truth, drawn. Threads are authorship; arcs are grounding, supersession and contradiction. Click any knot for its provenance trail — the full answer to “why does this exist?”', 'Every belief, drawn from the record.')}
      <figure class="fig">
        <div class="fig-head"><span>${graph.nodes.length} nodes · ${graph.edges.length} edges</span><span>namespace ${esc(graph.namespace || '')}</span></div>
        <div class="fig-body"><svg id="graphSvg" class="graph-svg" role="img" aria-label="The demo corpus as a graph"></svg></div>
        <figcaption><b>Reading it:</b> threads top to bottom are grok, moose, and the learning promotion that authored the standing lesson — told apart by position and label, never by colour. Solid knots are memories; hollow dashed knots are proposals; crossed knots are superseded; ink diamonds are cited sources; the knot you clicked wears an ink ring. This view spends no accent: nothing here is a live decision. <b>Limit:</b> a derived view — it shows only what Plane 1 holds.</figcaption>
      </figure>
      <div id="trailOut" style="margin-top:16px"><div class="empty-state"><h3>No knot selected</h3><p>Click a memory in the graph to see its provenance trail and supersession chain. Proposals, sources and thread heads answer too — each says what it is and where it is acted on.</p></div></div>
    `;
    MemoryLoomGraph.renderGraph(document.getElementById('graphSvg'), graph, {
      onSelect: (n) => {
        if (n.kind === 'memory') return showTrail(n.id);
        showKnotNote(n, graph);
      },
    });
  }
  function showKnotNote(n, graph) {
    // Every knot answers a click (5.2 fix: proposals, sources and
    // agent heads used to be silent dead ends — only memories
    // responded). Each note says what the knot is and where the
    // reader acts on it.
    const out = document.getElementById('trailOut');
    if (!out) return;
    if (n.kind === 'proposal') {
      out.innerHTML = `<div class="card"><h3>A proposal, still waiting</h3><p style="margin:0">This hollow knot is a proposal that has not entered truth. Proposals are decided in the <a href="#/loop">Live loop</a> — approved by the gate or settled by a human there, never from the graph.</p></div>`;
    } else if (n.kind === 'source') {
      out.innerHTML = `<div class="card"><h3>A cited source — <code class="inline">${esc(n.id)}</code></h3><p style="margin:0">Sources are the evidence records memories rest on. A source appears in the receipt of every memory that cites it — ask in <a href="#/recall">Recall + receipts</a> and read it there.</p></div>`;
    } else if (n.kind === 'agent') {
      const label = n.id === 'memoryloom-learning' ? 'learning' : n.id.split(' ')[0];
      // Raw graph nodes carry no author field — authorship lives in
      // the authored_by / proposed_by edges (the same source the
      // renderer lays out from).
      const mine = graph.edges.filter((e) => (e.type === 'authored_by' || e.type === 'proposed_by') && e.to === 'agent:' + n.id).length;
      out.innerHTML = `<div class="card"><h3>The ${esc(label)} thread</h3><p style="margin:0">Every knot on this thread was authored by ${esc(label)}${n.id === 'memoryloom-learning' ? ' — the name the standing lesson was promoted under' : ''}. ${mine} record${mine === 1 ? '' : 's'} sit${mine === 1 ? 's' : ''} on it. Click any knot on the thread for its trail.</p></div>`;
    }
  }
  async function showTrail(id) {
    const out = document.getElementById('trailOut');
    out.innerHTML = '<div class="skeleton"><div class="sk"></div></div>';
    try {
      const [trail, chain] = await Promise.all([api('/api/trail/' + encodeURIComponent(id)), api('/api/chain/' + encodeURIComponent(id))]);
      if (!trail || !trail.memory) throw new Error('no trail for this record');
      const chainRows = Array.isArray(chain) ? chain : [];
      out.innerHTML = `
        <div class="card">
          <h3>Provenance trail — <code class="inline">${esc(id)}</code></h3>
          <div class="row-item"><div class="meta">${agentBadge(trail.author)}<span class="badge">${esc(trail.memory.type)}</span><span class="small">via ${esc(originPlain(trail.origin))} · recorded ${fmtDate(trail.memory.recorded_at)}</span></div>
          <div class="text">${esc(trail.memory.text)}</div>
          ${trail.sources?.length ? `<div class="detail">cited sources: ${trail.sources.map((s) => `<code class="inline">${esc(s)}</code>`).join(' ')}</div>` : ''}</div>
          ${trail.grounding?.length ? `<h3 style="margin-top:14px">It rests on (${trail.grounding.length})</h3>` + trail.grounding.map((g) => `<div class="row-item"><div class="meta">${agentBadge(g.author)}<code class="inline">${esc(g.id)}</code></div><div class="text">${esc(g.text)}</div></div>`).join('') : ''}
          ${trail.decisions?.length ? `<h3 style="margin-top:14px">Decisions on its path (${trail.decisions.length})</h3>` + trail.decisions.map((d) => `<div class="row-item"><div class="meta"><span class="badge">${esc(kindPlain(d.kind))}</span><span class="small">${esc(d.status || '')} ${d.decided_by ? '· by ' + esc(d.decided_by) : ''} ${d.route_reason ? '· ' + esc(routePlain(d.route_reason)) : ''}</span></div>${d.proposal_id ? `<div class="detail">proposal <code class="inline">${esc(d.proposal_id)}</code></div>` : ''}${jevDetail(d.kind === 'consolidation' ? d : null)}</div>`).join('') : ''}
          ${trail.superseded_by ? `<div class="detail" style="margin-top:10px">Superseded by <code class="inline">${esc(trail.superseded_by.id)}</code> — ${esc(trail.superseded_by.text)}</div>` : ''}
          <h3 style="margin-top:16px">Supersession chain</h3>
          ${chainRows.length > 1 ? `<div class="timeline-strip">${chainRows.map((c, i) => `${i ? '<div class="arrow">→</div>' : ''}<div class="step"><b>${esc(c.id)}</b><br>${esc(c.text || '')}<br><span class="small">${fmtDate(c.valid_from)}${c.valid_to ? ' → ' + fmtDate(c.valid_to) : ' → held now'}</span></div>`).join('')}</div>` : '<p class="small">This belief has never been superseded.</p>'}
        </div>`;
    } catch (e) {
      out.innerHTML = `<div class="empty-state error-state"><h3>Trail failed</h3><p>${esc(e.message)}</p></div>`;
    }
  }

  /* ---------------- Time travel ---------------- */
  async function viewTime() {
    skeleton();
    let ov;
    try { ov = await api('/api/overview'); } catch (e) { return errorState(e, viewTime); }
    if (!ov.first_recorded_at || !ov.last_recorded_at) {
      // Designed empty state (5.2 fix: an empty store used to bind
      // the slider to 1 Jan 1970 — new Date(null) — and sit on a
      // permanent skeleton while it queried beliefs at the epoch).
      main.innerHTML = `
        ${head('Time travel', 'Every fact carries the dates it was believed between. Drag the date and ask the store what the team believed then — answered from the record, not from what is true now.', 'What did the team believe on this date — and on what evidence?')}
        <div class="empty-state"><h3>There is no past to travel to yet</h3><p>Nothing has been recorded in this namespace, so no date has beliefs attached to it. Seed the demo corpus (<code class="inline">npm run seed:web</code>) and the slider covers the recorded dates.</p></div>
      `;
      return;
    }
    const min = new Date(ov.first_recorded_at), max = new Date(ov.last_recorded_at);
    main.innerHTML = `
      ${head('Time travel', 'Every fact carries the dates it was believed between. Drag the date and ask the store what the team believed then — answered from the record, not from what is true now.', 'What did the team believe on this date — and on what evidence?')}
      <div class="card">
        <label class="f" for="asof">Believed on: <span id="asofLabel" class="mono"></span></label>
        <input type="range" id="asof" min="${min.getTime()}" max="${max.getTime() + 86400000}" step="86400000" value="${max.getTime() + 86400000}">
        <div style="display:flex;justify-content:space-between" class="small"><span>${fmtDate(min)}</span><span>${fmtDate(max)}</span></div>
      </div>
      <div id="believedOut" style="margin-top:16px"></div>
    `;
    const slider = document.getElementById('asof');
    const label = document.getElementById('asofLabel');
    const load = async () => {
      const at = new Date(Number(slider.value));
      label.textContent = fmtDate(at);
      const out = document.getElementById('believedOut');
      out.innerHTML = '<div class="skeleton"><div class="sk"></div><div class="sk"></div></div>';
      try {
        const rows = await api('/api/believed?at=' + encodeURIComponent(at.toISOString()));
        const list = Array.isArray(rows) ? rows : rows.beliefs || [];
        if (!list.length) {
          out.innerHTML = '<div class="empty-state"><h3>The team believed nothing yet</h3><p>No record had been written by this date. An empty answer is a truthful one.</p></div>';
          return;
        }
        out.innerHTML = `<p class="small">${list.length} beliefs held on ${fmtDate(at)}:</p>` + list.map((b) => `
          <div class="row-item"><div class="meta">${agentBadge(b.author)}<span class="badge">${esc(b.type)}</span><span class="small">valid ${fmtDate(b.valid_from)}${b.valid_to ? ' → ' + fmtDate(b.valid_to) : ' → still held'}</span></div>
          <div class="text">${esc(b.text)}</div></div>`).join('');
      } catch (e) {
        out.innerHTML = `<div class="empty-state error-state"><h3>Query failed</h3><p>${esc(e.message)}</p></div>`;
      }
    };
    // Debounced (5.2): a drag fires input continuously; the view
    // used to flash its skeleton and re-query on every tick.
    let loadTimer = null;
    slider.addEventListener('input', () => {
      label.textContent = fmtDate(new Date(Number(slider.value)));
      clearTimeout(loadTimer);
      loadTimer = setTimeout(load, 140);
    });
    load();
  }

  /* ---------------- Providers ---------------- */
  async function viewProviders() {
    skeleton();
    let s;
    try { s = await api('/api/spend'); } catch (e) { return errorState(e, viewProviders); }
    const totalCost = s.router.reduce((a, r) => a + r.est_cost_usd, 0);
    const totalCalls = s.router.reduce((a, r) => a + r.calls, 0);
    const metaBudget = s.budgets_usd?.meta?.total || 150;
    main.innerHTML = `
      ${head('Providers', 'Only providers that actually did work appear here. Every paid call went through the router — spend-logged, cached, refused past the 80% stop-loss. Decisions are not model calls; the gate&rsquo;s record is below.', 'Who did the work, and what did it cost?')}
      <div class="kv">
        <div class="card"><div class="big">${totalCalls}</div><div class="small">paid router calls (uncached)</div></div>
        <div class="card"><div class="big">$${totalCost.toFixed(2)}</div><div class="small">estimated router spend, all time</div></div>
        <div class="card"><div class="big">$${metaBudget}</div><div class="small">Meta credit budget · stop-loss at 80%</div></div>
        <div class="card"><div class="big">${s.jev_decisions_in_namespace}</div><div class="small">gate verdicts recorded in this namespace</div></div>
      </div>
      ${s.router.length ? `<div class="card" style="padding:6px 14px"><div class="table-wrap"><table class="data">
        <thead><tr><th>Provider · model · tier · task</th><th>Calls</th><th>Cached (free)</th><th>Tokens in / out</th><th>Est. cost</th></tr></thead>
        <tbody>${s.router.map((r) => `<tr><td>${esc(r.key)}</td><td class="num">${r.calls}</td><td class="num">${r.cached}</td><td class="num">${r.input_tokens.toLocaleString()} / ${r.output_tokens.toLocaleString()}</td><td class="num">${fmtUsd(r.est_cost_usd)}</td></tr>`).join('')}</tbody></table></div></div>`
      : '<div class="empty-state"><h3>No paid calls yet</h3><p>The router has logged no spend. Calibration and evaluation runs will appear here when they happen.</p></div>'}
      <h3 style="margin-top:24px">Per-memory work</h3>
      ${s.per_memory.length ? s.per_memory.map((w) => `<div class="row-item"><div class="meta"><span class="badge">${esc(w.provider)}</span><span class="small">${esc(w.work)} · ${fmtTs(w.at)}</span></div><div class="text">memory <code class="inline">${esc(w.memory_id)}</code></div>${jevDetail(w.decision)}</div>`).join('')
      : '<div class="empty-state"><h3>No per-memory provider work recorded</h3><p>When the gate decides a proposal from this console, its verdict lands here against the memory it created.</p></div>'}
      <p class="small" style="margin-top:14px">A note on absence: two further sponsor providers were evaluated for this build and did no work — one grant key proved scoped to a model this product does not use, the other never confirmed a balance. They are not listed, because a provider panel that credits work nobody did would be decoration, not evidence.</p>
    `;
  }

  /* ---------------- Learning ---------------- */
  async function viewLearning() {
    skeleton();
    let L;
    try { L = await api('/api/learning'); } catch (e) { return errorState(e, viewLearning); }
    // The filter offers the full kind vocabulary, not only the
    // kinds present in this stream (5.3 re-review: options built
    // from the stream alone made the filtered-empty state
    // unreachable — a state the product renders but no user could
    // ever see is a claim, not a feature).
    const kinds = [...new Set([...Object.keys(KIND_PLAIN), ...L.events.map((e) => e.kind)])];
    const verdicts = L.before_after.verdicts;
    main.innerHTML = `
      ${head('Learning', 'Every interaction is an append-only learning event. A lesson stands only because the gate promoted it — its verdict travels with it. Forged lessons (a lesson-shaped record with no gate verdict) are flagged by audit.', 'Improvement is shown, event by event — not asserted.')}
      <h3>Before / after — one task class</h3>
      ${verdicts.length ? `<div class="timeline-strip">${verdicts.map((v, i, a) => `${i ? '<div class="arrow">→</div>' : ''}<div class="step">${v.decision ? verdictBadge(v.decision.decision) : ''}<br>${esc(v.summary)}<br><span class="small">${fmtTs(v.at)}</span></div>`).join('')}</div>
        <p class="small">The task: lodge a global factual claim so the gate approves it. Before the lesson, claims escalated for want of citations. After it, the second agent — never corrected itself — approved first try. The full event trail is in the stream below.</p>`
      : '<div class="empty-state"><h3>No before/after story seeded</h3><p>Run <code class="inline">npm run seed:web</code> to record the learning story into this namespace.</p></div>'}
      <h3 style="margin-top:22px">Standing playbook lessons (${L.lessons.length})</h3>
      ${L.lessons.length ? L.lessons.map((l) => `<div class="row-item"><div class="meta"><span class="badge" data-state="approved">gate-promoted</span><span class="small">${fmtDate(l.created_at)}</span>${L.audit.forged_lesson_ids.includes(l.id) ? '<span class="badge" data-state="rejected">audit: no verdict — forged</span>' : ''}</div><div class="text">${esc(l.text)}</div>${jevDetail(l.jev ? { ...l.jev, decision: l.jev.promote ? 'promote' : 'decline' } : null)}</div>`).join('')
      : '<div class="empty-state"><h3>No lessons standing</h3><p>No event has been promoted yet. Promotion is the gate&rsquo;s decision, not a button here.</p></div>'}
      <h3 style="margin-top:22px">Event stream (${L.events.length})</h3>
      <div class="toolbar"><div><label class="f" for="kindFilter">Filter by kind</label>
        <select id="kindFilter"><option value="">all kinds</option>${kinds.map((k) => `<option value="${esc(k)}">${esc(kindPlain(k))}</option>`).join('')}</select></div></div>
      <div id="eventList"></div>
    `;
    const render = (kind) => {
      const rows = L.events.filter((e) => !kind || e.kind === kind);
      document.getElementById('eventList').innerHTML = rows.length ? rows.map((e) => `
        <div class="row-item"><div class="meta"><span class="badge">${esc(kindPlain(e.kind))}</span>${agentBadge(e.actor)}<span class="small">${fmtTs(e.created_at)}${e.subject_id ? ' · ' + esc(subjectPlain(e.subject_type)) + ' ' + esc(e.subject_id) : ''}</span></div>
        <div class="text">${esc(e.summary)}</div></div>`).join('')
        // Two different empty sets, two different truths (5.3,
        // Finding G): an empty STREAM holds no kinds at all, while
        // a filtered-empty set on a live stream does.
        : L.events.length === 0
          ? '<div class="empty-state"><h3>No events recorded yet</h3><p>The stream is empty — nothing has been logged in this namespace yet. Seed the demo corpus (<code class="inline">npm run seed:web</code>) or use the app, and every interaction will be recorded here.</p></div>'
          : '<div class="empty-state"><h3>No events of this kind</h3><p>The stream holds other kinds. An honest filter shows an empty set rather than padding it.</p></div>';
    };
    render('');
    document.getElementById('kindFilter').addEventListener('change', (e) => render(e.target.value));
  }

  /* ---------------- Settings ----------------
     One section per provider, all rendered by the same component
     from the masked settings view (GET /api/settings). The view
     decides nothing and calls no provider directly: testing goes
     through the settings test endpoint, and a typed key is tested
     as an unsaved candidate — it is only stored when the user
     presses Save. No full key is ever rendered: the API returns
     masked tails only, and the input is a password field. */
  const SETTINGS_PROVIDERS = [
    { id: 'meta', name: 'Meta Model API', getKey: 'Get a key at dev.meta.ai — open API keys and create a key for MemoryLoom.', unlocks: 'narration and reasoning calls' },
    { id: 'baseten', name: 'Baseten', getKey: 'Get a key in the Baseten workspace settings, under API keys.', unlocks: 'nothing yet — the Baseten lane is parked; the key is stored and can be tested here' },
    { id: 'jev', name: 'Jev (TypeSafe)', getKey: 'Get a key from TypeSafe — Jev is served by the TypeSafe API, so its key comes from TypeSafe.', unlocks: 'the decision gate that approves, rejects or escalates proposals' },
  ];
  let settingsFlash = {};
  function settingsStatus(entry) {
    // Tokens v2: standing by word + marker shape (data-state),
    // never by a colour class (the v1 ok/bad hues are gone).
    if (!entry.configured) return { state: 'pending', label: 'Not configured', source: 'Source: not configured yet' };
    if (entry.source === 'env') return { state: 'approved', label: 'Configured by environment', source: 'Source: the environment variable on this machine' };
    if (entry.source === 'store') return { state: 'approved', label: 'Configured in Settings', source: 'Source: saved in Settings on this machine' };
    return { state: 'approved', label: 'Configured', source: 'Source: configured' };
  }
  function settingsSection(def, entry) {
    const st = settingsStatus(entry);
    const flash = settingsFlash[def.id] || '';
    return `<section class="card settings-card">
      <div class="provider-head"><h3>${esc(def.name)}</h3><span class="badge" data-state="${st.state}">${esc(st.label)}</span></div>
      <div class="settings-meta">
        ${entry.configured
          ? (entry.last4
            ? `<span>Key ending <span class="masked-tail">•••• ${esc(entry.last4)}</span></span>`
            : '<span>Configured — the key tail is unavailable for a key this short.</span>')
          : '<span>No key saved.</span>'}
        <span class="small">${esc(st.source)}</span>
      </div>
      ${!entry.configured ? `<p class="small settings-hint">${esc(def.getKey)} Adding it unlocks ${esc(def.unlocks)}.</p>` : ''}
      ${entry.source === 'env' ? '<p class="small settings-hint">This key comes from the environment, so it wins over anything saved here and Settings cannot remove it. A key you save is kept for when the environment variable is not set.</p>' : ''}
      <label class="f" for="set-${def.id}-key">${entry.configured ? 'Replace the key' : 'API key'}</label>
      <input type="password" id="set-${def.id}-key" autocomplete="off" spellcheck="false" placeholder="Paste a key">
      <div class="provider-actions">
        <button class="btn primary small-btn" id="set-${def.id}-save" type="button">Save</button>
        <button class="btn small-btn" id="set-${def.id}-test" type="button">Test connection</button>
        <button class="btn small-btn" id="set-${def.id}-remove" type="button" ${entry.source === 'store' ? '' : 'disabled'}>Remove</button>
      </div>
      <div class="settings-result" id="set-${def.id}-result" aria-live="polite">${esc(flash)}</div>
    </section>`;
  }
  async function viewSettings() {
    skeleton();
    let data;
    try { data = await api('/api/settings'); } catch (e) { return errorState(e, viewSettings); }
    const providers = data.providers || {};
    const entries = SETTINGS_PROVIDERS.map((d) => [d, providers[d.id] || { configured: false, last4: null, source: null }]);
    const anyConfigured = entries.some(([, e]) => e.configured);
    main.innerHTML = `
      ${head('Settings', 'Your own keys for the hosted providers, kept on this machine and never committed. The console calls a provider only when you press Test connection, and only through the settings test endpoint.', 'Your keys stay on this machine.')}
      ${anyConfigured ? '' : `<div class="empty-state" style="margin-bottom:16px"><h3>No provider keys configured</h3><p>MemoryLoom runs locally without keys — the demo corpus, recall, the graph and time travel all work on this machine. Add a key below to unlock that provider&rsquo;s live calls: Meta Model API for narration and reasoning, and Jev for the decision gate. A Baseten key unlocks nothing yet — the Baseten lane is parked; the key is stored and can be tested here.</p></div>`}
      <div class="settings-grid">${entries.map(([d, e]) => settingsSection(d, e)).join('')}</div>
    `;
    settingsFlash = {};
    for (const [def] of entries) wireSettingsSection(def);
  }
  function wireSettingsSection(def) {
    const input = document.getElementById(`set-${def.id}-key`);
    const saveBtn = document.getElementById(`set-${def.id}-save`);
    const testBtn = document.getElementById(`set-${def.id}-test`);
    const removeBtn = document.getElementById(`set-${def.id}-remove`);
    const result = document.getElementById(`set-${def.id}-result`);
    if (!input || !saveBtn || !testBtn || !removeBtn || !result) return;
    const removeLocked = removeBtn.disabled;
    const setBusy = (busy) => {
      saveBtn.disabled = busy;
      testBtn.disabled = busy;
      removeBtn.disabled = busy || removeLocked;
    };
    const show = (msg, cls) => {
      result.textContent = msg;
      result.className = 'settings-result' + (cls ? ' ' + cls : '');
    };
    saveBtn.addEventListener('click', async () => {
      const key = input.value.trim();
      if (!key) { show('Paste a key first — there is nothing to save yet.', 'bad'); return; }
      setBusy(true);
      show('Saving…');
      try {
        const saved = await api(`/api/settings/${def.id}`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ api_key: key }),
        });
        settingsFlash = { [def.id]: saved.last4 ? `Saved — this provider's key now ends •••• ${saved.last4}.` : 'Saved.' };
        await viewSettings(); // a successful save re-reads the masked view
      } catch (e) {
        show('Save failed: ' + e.message, 'bad');
        setBusy(false);
      }
    });
    testBtn.addEventListener('click', async () => {
      const key = input.value.trim();
      setBusy(true);
      show('Testing the connection…');
      try {
        // A typed key is tested as an unsaved candidate: testing
        // never saves first, and the typed key stays in the field
        // whatever the result, so a failed test loses nothing.
        const r = await api(`/api/settings/${def.id}/test`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(key ? { api_key: key } : {}),
        });
        if (r.ok) show(`Connected — ${def.name} answered${r.latency_ms != null ? ` in ${r.latency_ms} ms` : ''}.`, 'ok');
        else show(r.error || `${def.name} did not answer.`, 'bad');
      } catch (e) {
        show(e.message, 'bad');
      }
      setBusy(false);
    });
    removeBtn.addEventListener('click', async () => {
      setBusy(true);
      show('Removing…');
      try {
        await api(`/api/settings/${def.id}`, { method: 'DELETE' });
        settingsFlash = { [def.id]: 'Key removed.' };
        await viewSettings(); // re-read the masked view after removal
      } catch (e) {
        show('Remove failed: ' + e.message, 'bad');
        setBusy(false);
      }
    });
  }

  /* ---------------- Router ---------------- */
  const routes = { loop: viewLoop, recall: () => viewRecall(), graph: viewGraph, time: viewTime, providers: viewProviders, learning: viewLearning, settings: viewSettings };
  function route() {
    const name = (location.hash.replace('#/', '') || 'loop').split('?')[0];
    const fn = routes[name] || viewLoop;
    document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === name));
    fn();
  }
  window.addEventListener('hashchange', route);
  route();
})();
