/* MemoryLoom console, eight views over the real backend. Chat
   is the primary surface; the other seven are the proof layer.
   Three states everywhere: a still skeleton while loading, a
   designed empty state when there is nothing to show, and the
   populated view. The console displays decisions; it never makes
   or overrides one.
   Design tokens v2 (Iteration 5.2): the console wears the same
   type, spacing, rules and motion as the landing page. Standing
   is carried by word + marker shape in ink (the tokens' badges,
   via data-state), never by colour; agents are told apart by
   their name, never by a hue; the accent is spent nowhere in the
   console, because no console view marks a live decision with it
  , the gate's verdicts here are records, and records are ink. */
(function () {
  const main = document.getElementById('main');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Not recorded';
  const fmtTs = (d) => d ? new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Not recorded';
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
  /* Decisions on the hosted site are guarded by the owner word,
     the same word that guards the agent address. The word lives
     only in this tab's session storage, is sent only with a
     decision call, and is never shown or stored anywhere else. */
  let ownerWord = '';
  try { ownerWord = sessionStorage.getItem('ml-owner-word') || ''; } catch {}
  async function decideCall(id, decision) {
    const headers = { 'content-type': 'application/json' };
    if (ownerWord) headers.authorization = 'Bearer ' + ownerWord;
    return api(`/api/proposals/${encodeURIComponent(id)}/decide`, {
      method: 'POST', headers, body: JSON.stringify({ decision }),
    });
  }
  function skeleton(count = 4) {
    main.innerHTML = `<div class="skeleton" role="status"><span class="sr-only">Loading…</span>${'<div class="sk"></div>'.repeat(count)}</div>`;
  }
  function errorState(title, err, retry) {
    main.innerHTML = `<h1 class="view-title" tabindex="-1">${esc(title)}</h1>
      <div class="empty-state error-state"><h2>The store did not answer</h2>
      <p>${esc(err.message || err)}</p>
      <p class="small">The console reads the store it is connected to.</p>
      <button class="btn" id="retryBtn" type="button">Try again</button></div>`;
    document.getElementById('retryBtn').addEventListener('click', retry);
  }
  function head(title, sub, pull) {
    // View titles match the nav labels word for word (5.2 friction
    // fix: the two used to differ on five of seven views). The
    // italic pull line is the view's one-sentence promise, set in
    // Newsreader italic, the console is where that face is used.
    // The title is the page h1 (card S8, Section 6): route()
    // moves focus to it on navigation, so it carries tabindex -1.
    return `<h1 class="view-title" tabindex="-1">${esc(title)}</h1>${pull ? `<p class="pull-line">${pull}</p>` : ''}<p class="view-sub">${sub}</p>`;
  }
  function verdictBadge(d) {
    // Standing by word + marker shape, in ink (tokens v2). The
    // escalated badge keeps its full form, "escalated · awaiting
    // a human", wherever a status first appears: it is the
    // in-place gloss for the word (5.1 stranger-read lesson).
    if (d === 'approve' || d === 'approved' || d === 'auto_approved') return '<span class="badge" data-state="approved">approved</span>';
    if (d === 'reject' || d === 'rejected') return '<span class="badge" data-state="rejected">rejected</span>';
    if (d === 'escalate' || d === 'queued_for_review' || d === 'pending') return '<span class="badge" data-state="escalated">escalated · awaiting a human</span>';
    return `<span class="badge">${esc(d || 'None')}</span>`;
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
    'grounding_ids>=2': 'grounding rule, at least two cited records resolved in the store',
    'low-evidence': 'low evidence, fewer than two cited records resolved in the store',
    'procedural-human-always': 'procedural, always decided by a human',
    'pinned-human-always': 'pinned, always decided by a human',
    'jev-escalate': 'the gate escalated this to a human',
    'jev-unavailable-fail-closed': 'the gate was unavailable. It failed closed to a human',
    'ingest-file-queued': 'a file held for a human, with its chunks shown in file order below',
    'episodic-or-node_local': 'episodic or node-local, approved by rule',
  };
  const routePlain = (r) => ROUTE_PLAIN[r] || kindPlain(r || 'None');
  /* The propose banner speaks plain words too (5.3 re-review: it
     printed the raw decision and route strings, "queued_for_review
    , jev-unavailable-fail-closed", directly over the row that
     translated them properly). */
  const DECISION_PLAIN = {
    auto_approved: 'approved by the gate',
    rejected: 'rejected by the gate',
    queued_for_review: 'sent to a human',
  };
  const decisionPlain = (d) => DECISION_PLAIN[d] || kindPlain(d || 'None');
  /* Subject types on learning rows and record origins on receipts:
     stored as machine strings, rendered as what they mean. */
  const SUBJECT_PLAIN = { memory: 'record', learning_event: 'learning event', proposal: 'proposal' };
  const subjectPlain = (s) => SUBJECT_PLAIN[s] || kindPlain(s || '');
  const ORIGIN_PLAIN = {
    propose: 'a proposal', 'propose-auto': 'an automatic proposal', 'propose-jev': 'a gated proposal',
    ingest_file: 'a file import', consolidation: 'consolidation', 'mcp-store': 'a direct store', seed: 'the seed',
  };
  const originPlain = (o) => ORIGIN_PLAIN[o] || kindPlain(o || 'None');
  /* The record component (5.4 defect round): one fact per labelled
     part, never one cramped mono string. facts: [label, valueHTML,
     wide?] */
  function recordHTML(facts, label) {
    const items = facts.filter(Boolean).map(([l, v, wide]) =>
      `<div class="record-fact${wide ? ' wide' : ''}"><dt class="record-label">${esc(l)}</dt><dd class="record-value">${v}</dd></div>`).join('');
    return `<aside class="record" aria-label="${esc(label || 'Record details')}"><dl class="record-list">${items}</dl></aside>`;
  }
  /* A link that opens the record it names, in the memory graph.
     The graph view takes the id from pendingTrailId (or from the
     landing page handoff in session storage) and opens that
     record's provenance trail. The link text is the record id
     itself, so the link names its record. */
  let pendingTrailId = '';
  function recordLink(id) {
    return `<a href="#/graph" data-record-link="${esc(id)}" aria-label="Open the record ${esc(id)} in the memory graph">${esc(id)}</a>`;
  }
  window.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-record-link]');
    if (!a) return;
    pendingTrailId = a.dataset.recordLink;
    if (location.hash === '#/graph') route();
  });
  /* The receipt (card S5, Section 6.5 of the master plan): a small
     readable record in the text face with seven separate labelled
     parts, one fact per part, on every surface where it renders.
     The grounding ids in a receipt arrive already dereferenced by
     the recall path, so every id named here resolves in the store.
     When a record rests on nothing, Rests on says so in words,
     with no link and no wording that presents it as grounded. The
     card form carries the receipt card border and sunken ground.
     The plain form, used for near misses, carries the same seven
     parts with neither, so a near miss never wears the receipt
     card. The sources a record cites are not a receipt part: they
     stand on the record's provenance trail in the graph view, one
     follow through the Record link. */
  function receiptHTML(r, form) {
    const facts = [
      ['Record', recordLink(r.memory_id)],
      ['Written by', esc(r.author)],
      ['How it arrived', 'Through ' + esc(originPlain(r.origin))],
      ['Recorded', fmtDate(r.record_created_at)],
      ['Valid from', fmtDate(r.valid_from)],
      ['Valid to', r.valid_to ? fmtDate(r.valid_to) : 'Still held'],
      ['Rests on', (r.grounding_ids && r.grounding_ids.length)
        ? r.grounding_ids.map((g) => `<a class="record-id" href="#/graph" data-record-link="${esc(g)}" aria-label="Open the record ${esc(g)} in the memory graph">${esc(g)}</a>`).join('')
        : 'No grounding record', true],
    ];
    const items = facts.map(([l, v, wide]) =>
      `<div class="record-fact${wide ? ' wide' : ''}"><dt class="record-label">${esc(l)}</dt><dd class="record-value">${v}</dd></div>`).join('');
    if (form === 'plain') return `<div class="receipt receipt-plain"><dl class="record-list">${items}</dl></div>`;
    return `<aside class="record receipt" aria-label="Receipt"><dl class="record-list">${items}</dl></aside>`;
  }
  /* The gate's stored reason is a machine string. Some reasons
     recorded earlier carry internal error text, a server path, a
     file name, or a variable name. None of that is shown. The
     display sentence says what happened in plain words, and the
     stored record itself is never changed. */
  function displayReason(jev) {
    const r = String(jev.reason || '');
    if (jev.failed === true || jev.fail_closed === true || /EROFS|read-only|no API key configured|unavailable/i.test(r)) {
      return 'The decision service could not be reached at that moment, so the gate approved nothing and sent this to a person.';
    }
    if (r.includes('human-required wins')) return 'A claim like this needs a human decision, so the gate sent it to a person.';
    if (r.includes('policy-approve wins')) return 'The gate approved this under its standing rules.';
    if (r.includes('policy-reject wins')) return 'The gate turned this away under its standing rules.';
    const clean = plainReason(r.replace(/^jev:\s*/i, ''));
    return clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : 'The gate recorded its decision on this proposal.';
  }
  function jevDetail(jev) {
    if (!jev) return '';
    const facts = [];
    if (jev.decision) facts.push(['Decision', esc(jev.decision)]);
    if (jev.model) facts.push(['Model', esc(jev.model)]);
    if (jev.probability !== undefined) facts.push(['Calibrated score', Number(jev.probability).toFixed(2)]);
    if (jev.raw_probability !== undefined) facts.push(['Raw score', Number(jev.raw_probability).toFixed(2)]);
    if (jev.reason) facts.push(['Reason', esc(displayReason(jev)), true]);
    return recordHTML(facts, 'Gate record');
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
    const about = ids.length ? ids.join(', ') : 'the store';
    // The specific daemon_kind in the payload outranks the generic
    // review-item kind ("resolution" covers decay candidates too —
    // the first 5.2 capture summarised a decay candidate as a
    // generic resolution, which is why the order below matters).
    const kind = `${p.daemon_kind || ''} ${item.kind || ''}`;
    if (kind.includes('contradiction') || p.detector) return `Contradiction flagged between ${about}${p.detector ? ` (detector: ${p.detector})` : ''}. A human settles which belief stands.`;
    if (kind.includes('decay')) return `Decay candidate: ${about}. It was recorded and has not been used recently. The gate decides keep or drop.`;
    if (kind.includes('consolidation')) return `Consolidation candidate: ${about} may say the same thing more than once.`;
    if (kind.includes('resolution')) return `Resolution proposed for ${about}.`;
    return `Daemon proposal about ${about}.`;
  }

  /* ---------------- Live loop ---------------- */
  async function viewLoop() {
    // The form renders at once and the counts and lists load into
    // still skeleton blocks beneath it (Section 6.4 states: the
    // loading state keeps the form rendered, with skeleton blocks
    // in place of the stream). The propose action needs nothing
    // from the lists, so it is live while they load.
    const flash = loopFlash; loopFlash = '';
    main.innerHTML = `
      ${head('Live loop', 'Agents propose; the gate decides; humans settle what the gate escalates. Propose something yourself and watch the real gate answer.', 'Nothing enters memory unexamined.')}
      ${flash ? `<div class="flash" role="status"><span class="flash-label">Last gate answer</span>${esc(flash)}</div>` : ''}
      <div class="kv" id="loopCounts"><div class="skeleton" role="status"><span class="sr-only">Loading the counts…</span><div class="sk"></div></div></div>
      <div class="card" style="margin-bottom:20px">
        <h2>Propose a memory</h2>
        <div class="toolbar" style="margin-bottom:0">
          <div><label class="f" for="pAuthor">Your name, or your agent's name</label>
            <input type="text" id="pAuthor" value="you"></div>
          <div><label class="f" for="pType">Type</label>
            <select id="pType"><option value="semantic">semantic (a fact)</option><option value="episodic">episodic (an event)</option><option value="procedural">procedural (a how-to)</option></select></div>
          <div><label class="f" for="pGround">Grounding record ids (comma-separated, optional)</label>
            <input type="text" id="pGround" placeholder="Record ids, separated by commas"></div>
        </div>
        <label class="f" for="pText">The memory</label>
        <textarea id="pText" placeholder="Write one clear fact, in plain words."></textarea>
        <div style="margin-top:12px;display:flex;gap:10px;align-items:center">
          <button class="btn primary" id="pSend" type="button">Send through the gate</button>
          <span id="pResult" class="small" aria-live="polite"></span>
        </div>
      </div>
      <div id="pRefusal"></div>
      <h2 id="pendingHead">Waiting for a human</h2>
      <div id="pendingList"><div class="skeleton"><div class="sk"></div><div class="sk"></div></div></div>
      <h2 id="decidedHead" style="margin-top:22px">Decided</h2>
      <div id="decidedList"><div class="skeleton"><div class="sk"></div><div class="sk"></div></div></div>
      <div id="daemonBlock"></div>
    `;
    document.getElementById('pSend').addEventListener('click', async () => {
      const btn = document.getElementById('pSend');
      const out = document.getElementById('pResult');
      const refusal = document.getElementById('pRefusal');
      btn.disabled = true; out.textContent = 'The gate is deciding…';
      if (refusal) refusal.innerHTML = '';
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
        loopFlash = `Gate: ${decisionPlain(r.decision)}, ${routePlain(r.reason)}`;
        out.innerHTML = `Gate: <b>${esc(decisionPlain(r.decision))}</b>, ${esc(routePlain(r.reason))}. Reloading the loop…`;
        setTimeout(viewLoop, 900);
      } catch (e) {
        // Section 6.11 failure row for the gate decision call:
        // the words, the returned error string under them in a
        // sunken mono block, kept as a row in place, role alert
        // on the row, and focus stays on the submit control —
        // nothing here moves it, and the view is not re-rendered.
        if (refusal) refusal.innerHTML = `<div class="row-item" role="alert"><p style="margin:0"><strong>The decision could not be made now.</strong></p><pre class="sunken-mono">${esc(e.message)}</pre></div>`;
        out.textContent = '';
        btn.disabled = false;
        // Disabling the button mid call dropped focus to the
        // body; the rule is that focus stays on the submit
        // control, so it is put back explicitly.
        btn.focus();
      }
    });
    let ov, props;
    try {
      [ov, props] = await Promise.all([api('/api/overview'), api('/api/proposals')]);
    } catch (e) { return errorState('Live loop', e, viewLoop); }
    const pending = props.proposals.filter((p) => p.status === 'pending');
    const decided = props.proposals.filter((p) => p.status !== 'pending');
    const memCount = ov.memories_by_type.reduce((a, r) => a + r.n, 0);
    document.getElementById('loopCounts').innerHTML = `
        <div class="card"><div class="big">${memCount}</div><div class="small">memories in truth</div></div>
        <div class="card"><div class="big">${pending.length}</div><div class="small">proposals awaiting a human</div></div>
        <div class="card"><div class="big">${ov.lessons}</div><div class="small">playbook lessons standing</div></div>
        <div class="card"><div class="big">${ov.learning_events}</div><div class="small">learning events on record</div></div>`;
    document.getElementById('pendingHead').textContent = `Waiting for a human (${pending.length})`;
    document.getElementById('decidedHead').textContent = `Decided (${decided.length})`;
    const pendingList = document.getElementById('pendingList');
    pendingList.innerHTML = pending.length ? '' : '<div class="empty-state"><h3>The inbox is clear</h3><p>Nothing is escalated right now. Propose a procedural memory, or a fact with no grounding, and the gate will send it here.</p></div>';
    for (const p of pending) pendingList.appendChild(proposalRow(p, true));
    const decidedList = document.getElementById('decidedList');
    decidedList.innerHTML = decided.length ? '' : '<div class="empty-state"><h3>No decisions yet</h3><p>Decided proposals will appear here with who decided them and why.</p></div>';
    for (const p of decided) decidedList.appendChild(proposalRow(p, false));
    if (props.daemon_review_items.length) {
      document.getElementById('daemonBlock').innerHTML = `<h2 style="margin-top:22px">Daemon proposals (${props.daemon_review_items.length})</h2>
        <p class="small">The background daemon may only propose. These items wait for the same human decision as everything else.</p>
        <div>${props.daemon_review_items.map((i) => `<div class="row-item"><div class="meta"><span class="badge">${esc(daemonBadge(i))}</span><span class="small">${fmtTs(i.created_at)}</span></div><div class="text">${esc(daemonSummary(i))}</div></div>`).join('')}</div>`;
    }
  }
  function fileChunksHtml(p) {
    if (!p.source_file_name) return '';
    // The chunks render in chunk index order. The view sorts them
    // itself, so the file reads in order even when a payload
    // arrives out of order (card S3b).
    const chunks = [...(p.chunks || [])].sort((a, b) => a.chunk_index - b.chunk_index);
    const total = p.chunk_count ?? chunks.length;
    const parts = [`<div class="detail">file: ${esc(p.source_file_name)} · ${total} chunks, shown in file order</div>`];
    for (const c of chunks) {
      parts.push(`<div class="detail">chunk ${c.chunk_index + 1} of ${total}</div><div class="text">${esc(c.text)}</div>`);
    }
    return parts.join('');
  }
  function proposalRow(p, actionable) {
    const div = document.createElement('div');
    div.className = 'row-item';
    const prov = p.provenance || {};
    div.innerHTML = `
      <div class="meta">${agentBadge(prov.author)}<span class="badge">${esc(p.type)}</span>${verdictBadge(p.status === 'pending' ? 'pending' : p.status)}
        <span class="small">${fmtTs(p.created_at)} · route: ${esc(routePlain(p.route_reason))}</span></div>
      <div class="text">${esc(p.text)}</div>
      ${fileChunksHtml(p)}
      ${p.grounding_ids?.length ? `<div class="detail">cites: ${p.grounding_ids.map((g) => `<code class="inline">${esc(g)}</code>`).join(' ')}</div>` : (prov.unresolved_citations?.length ? `<div class="detail">cites: nothing that resolves in this store (${prov.unresolved_citations.length} cited, none found)</div>` : '<div class="detail">cites: nothing</div>')}
      ${jevDetail(prov.jev)}
      ${p.status !== 'pending' ? `<div class="detail">decided by ${esc(p.decided_by || 'None')}${p.promoted_id ? ` · became memory ${recordLink(p.promoted_id)}` : ''}</div>` : ''}
      ${actionable ? `<div class="actions"><button class="btn small-btn" data-act="approve" type="button" aria-label="Approve proposal ${esc(p.id)} into truth">Approve into truth</button><button class="btn small-btn" data-act="reject" type="button" aria-label="Reject proposal ${esc(p.id)}">Reject</button><span class="small act-msg"></span></div>` : ''}
    `;
    if (actionable) {
      div.querySelectorAll('button[data-act]').forEach((b) => b.addEventListener('click', async () => {
        const msg = div.querySelector('.act-msg');
        const act = b.dataset.act;
        const showUnlock = () => {
          if (div.querySelector('.owner-unlock')) return;
          const box = document.createElement('div');
          box.className = 'owner-unlock';
          box.style.marginTop = '8px';
          box.innerHTML = `<p class="small">Decisions on this hosted site need the owner word, the same word that guards the agent address. It stays in this tab only and is never shown.</p>
            <input type="password" class="owner-word" autocomplete="off" placeholder="Owner word" aria-label="Owner word">
            <button class="btn small-btn" type="button">Unlock and record my decision</button>`;
          div.querySelector('.actions').appendChild(box);
          box.querySelector('button').addEventListener('click', async () => {
            const v = box.querySelector('.owner-word').value.trim();
            if (!v) return;
            ownerWord = v;
            try { sessionStorage.setItem('ml-owner-word', v); } catch {}
            box.remove();
            await run();
          });
        };
        const run = async () => {
          div.querySelectorAll('button').forEach((x) => (x.disabled = true));
          msg.textContent = 'Recording your decision…';
          try {
            await decideCall(p.id, act);
            loopFlash = `Your decision was recorded: ${act === 'approve' ? 'approved into truth' : 'rejected'}.`;
            msg.textContent = 'Decided. Reloading…';
            setTimeout(viewLoop, 700);
          } catch (e) {
            div.querySelectorAll('button').forEach((x) => (x.disabled = false));
            if (e.message === 'FORBIDDEN') {
              msg.textContent = ownerWord ? 'That owner word was not accepted.' : 'This decision needs the owner word.';
              showUnlock();
            } else {
              msg.textContent = 'Failed: ' + e.message;
            }
          }
        };
        await run();
      }));
    }
    return div;
  }

  /* ---------------- Recall ---------------- */
  async function viewRecall(prefill) {
    main.innerHTML = `
      ${head('Recall + receipts', 'Ask the store a question. Every answer carries its receipt. The receipt names the record it came from, who wrote it, and what it rests on. Anything that cannot produce a receipt is dropped, and the drop is shown too.', 'No receipt, no answer.')}
      <div class="toolbar">
        <div><label class="f" for="q">Question</label>
          <input type="text" id="q" placeholder="e.g. what firmware does the rig run?"></div>
        <button class="btn primary" id="ask" type="button">Recall</button>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
        ${['what firmware does the rig run?', 'where is the demo held?', 'when does the venue open?', 'what is the wifi password?'].map((q) => `<button class="btn small-btn chip" data-q="${esc(q)}" type="button">${esc(q)}</button>`).join('')}
      </div>
      <div id="recallOut" aria-live="polite"><div class="empty-state"><h2>Nothing recalled yet</h2><p>Ask a question above. If the memory holds no answer, this view says so in plain words. It then lists the closest records and marks them as records that do not answer. Each one shows its score. A record with no receipt is dropped, and the drop is shown.</p></div></div>
    `;
    const ask = async () => {
      const q = document.getElementById('q').value.trim();
      const out = document.getElementById('recallOut');
      if (!q) return;
      out.innerHTML = '<div class="skeleton" role="status"><span class="sr-only">Recalling…</span><div class="sk"></div><div class="sk"></div><div class="sk"></div></div>';
      try {
        const r = await api('/api/recall?q=' + encodeURIComponent(q) + '&k=8');
        if (!r.results.length && !r.dropped.length) {
          out.innerHTML = '<h2>Recall result</h2><div class="empty-state"><h3>No receipts, no answer</h3><p>The store holds nothing that answers this. It says so instead of inventing an answer. That refusal is the feature.</p></div>';
          return;
        }
        // No-answer state (Iteration 5.3, Finding B): when the API
        // marks the answer `no_answer`, the near misses are NOT an
        // answer. They are listed below the refusal, labelled as
        // the closest records that do not answer, with their scores
        // shown. (5.4: the view used to re-derive the threshold
        // from a typed copy of the number, a readout that could
        // drift from the backend rule. The API marks the state;
        // the view renders it.)
        const topScore = Math.max(...r.results.map((res) => res.rrf ?? 0));
        const noAnswer = r.no_answer === true;
        if (noAnswer) {
          out.innerHTML =
            '<h2>Recall result</h2>' +
            '<div class="empty-state"><h3>No receipts, no answer</h3><p>The store holds nothing that answers this, and says so, instead of inventing one. The best match scored ' + topScore.toFixed(3) + ', below the answer threshold. Both search legs must agree before a record counts as an answer.</p></div>' +
            '<h3 style="margin-top:18px">Closest records, and they do not answer the question (' + r.results.length + ')</h3>' +
            r.results.map((res) => `
            <div class="row-item">
              <div class="meta"><span class="badge">closest record, not an answer</span><span class="badge">${esc(res.type)}</span>${res.rrf != null ? `<span class="small">fusion score ${Number(res.rrf).toFixed(3)}</span>` : ''}</div>
              <div class="text">${esc(res.text)}</div>
              ${receiptHTML(res.receipt, 'plain')}
            </div>`).join('') +
            (r.dropped.length ? `<h3 style="margin-top:18px">Dropped before the agent could see them (${r.dropped.length})</h3>` +
              r.dropped.map((d) => `<div class="row-item"><div class="meta"><span class="badge" data-state="rejected">dropped</span><code class="inline">${esc(d.id)}</code></div><div class="detail">${esc(d.why)}</div></div>`).join('') : '');
          return;
        }
        out.innerHTML =
          '<h2>Recall result</h2>' +
          r.results.map((res) => `
            <div class="row-item">
              <div class="meta"><span class="badge">receipt</span><span class="badge">${esc(res.type)}</span>${res.rrf != null ? `<span class="small">fusion score ${Number(res.rrf).toFixed(3)}</span>` : ''}</div>
              <div class="text">${esc(res.text)}</div>
              ${receiptHTML(res.receipt, 'card')}
            </div>`).join('') +
          (r.dropped.length ? `<h3 style="margin-top:18px">Dropped before the agent could see them (${r.dropped.length})</h3>` +
            r.dropped.map((d) => `<div class="row-item"><div class="meta"><span class="badge" data-state="rejected">dropped</span><code class="inline">${esc(d.id)}</code></div><div class="detail">${esc(d.why)}</div></div>`).join('') : '');
      } catch (e) {
        // Section 6.11 failure row for the recall call: the words
        // in a role alert above the results, the returned error
        // under them, the typed question left in place above and
        // focus left where it was.
        out.innerHTML = `<h2>Recall result</h2><p class="view-alert" role="alert">Recall could not be completed.</p><pre class="sunken-mono">${esc(e.message)}</pre>`;
      }
    };
    document.getElementById('ask').addEventListener('click', ask);
    document.getElementById('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') ask(); });
    document.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => { document.getElementById('q').value = c.dataset.q; ask(); }));
    if (prefill) { document.getElementById('q').value = prefill; ask(); }
  }

  /* ---------------- Graph ---------------- */
  let lastGraph = null;
  async function viewGraph() {
    // Loading (Section 6.6 states): one still sunken block inside
    // the frame and still lines in the detail panel, rendered
    // before the graph call answers.
    main.innerHTML = `
      ${head('Memory graph', 'Truth, drawn. Threads show authorship. Arcs show grounding, supersession and contradiction. Click any knot for its provenance trail, the full answer to why this record exists.', 'Every belief, drawn from the record.')}
      <figure class="fig">
        <div class="fig-head"><span>loading the graph…</span><span></span></div>
        <div class="fig-body"><div class="skeleton" role="status" style="padding:6px"><span class="sr-only">Loading the graph…</span><div class="sk" style="height:280px"></div></div></div>
      </figure>
      <div id="trailOut" style="margin-top:16px"><div class="skeleton"><div class="sk" style="height:18px"></div><div class="sk" style="height:18px"></div><div class="sk" style="height:18px"></div></div></div>
    `;
    let graph;
    try { graph = await api('/api/graph'); } catch (e) {
      // Section 6.11 failure row for the graph call: the words
      // inside the frame area with role alert, the last good graph
      // kept in place where one exists, focus unchanged.
      if (lastGraph) {
        renderGraphView(lastGraph);
        const fb = main.querySelector('figure.fig .fig-body');
        if (fb) fb.insertAdjacentHTML('afterbegin', '<p class="view-alert" role="alert" style="margin:6px">The memory graph could not be loaded.</p>');
      } else {
        main.innerHTML = `
          ${head('Memory graph', 'Truth, drawn. Threads show authorship. Arcs show grounding, supersession and contradiction. Click any knot for its provenance trail, the full answer to why this record exists.', 'Every belief, drawn from the record.')}
          <figure class="fig">
            <div class="fig-head"><span>graph</span><span></span></div>
            <div class="fig-body"><p class="view-alert" role="alert" style="margin:6px">The memory graph could not be loaded.</p></div>
          </figure>
        `;
      }
      return;
    }
    lastGraph = graph;
    renderGraphView(graph);
  }
  function renderGraphView(graph) {
    const records = graph.nodes.filter((n) => n.kind === 'memory' || n.kind === 'proposal');
    if (!records.length) {
      // Designed empty state (5.2 fix: an empty corpus used to draw
      // a blank figure captioned "0 nodes · 0 edges" and nothing else).
      main.innerHTML = `
        ${head('Memory graph', 'Truth, drawn. Threads show authorship. Arcs show grounding, supersession and contradiction. Click any knot for its provenance trail, the full answer to why this record exists.', 'Every belief, drawn from the record.')}
        <div class="empty-state"><h2>The graph is empty</h2><p>This store holds no records yet, so there is nothing to draw. Approved proposals will appear here as knots. Approve a proposal in the Live loop and the weave appears here.</p></div>
      `;
      return;
    }
    main.innerHTML = `
      ${head('Memory graph', 'Truth, drawn. Threads show authorship. Arcs show grounding, supersession and contradiction. Click any knot for its provenance trail, the full answer to why this record exists.', 'Every belief, drawn from the record.')}
      <figure class="fig">
        <div class="fig-head"><span>${graph.nodes.length} nodes · ${graph.edges.length} edges</span><span>namespace ${esc(graph.namespace || '')}</span></div>
        <div class="fig-body"><svg id="graphSvg" class="graph-svg" role="img" aria-label="The live store as a graph"></svg></div>
        <figcaption><b>Reading it.</b> Threads run top to bottom in the order the authors first appear. Position and label tell them apart, never colour. Solid knots are memories. Hollow dashed knots are proposals. Crossed knots are superseded. Ink diamonds are cited sources. The knot you clicked wears an ink ring. Dates run in order along the bottom axis. The spacing shows the order of the dates, not the time between them. A long stretch with no records is drawn as a labelled break. This view spends no accent. Nothing here is a live decision. <b>Limit.</b> A derived view. It shows only what the truth plane holds.</figcaption>
      </figure>
      <div id="trailOut" style="margin-top:16px"></div>
    `;
    const svg = document.getElementById('graphSvg');
    MemoryLoomGraph.renderGraph(svg, graph, {
      onSelect: (n) => {
        if (n.kind === 'memory') return showTrail(n.id);
        showKnotNote(n, graph);
      },
    });
    // The frame label is built from the returned thread and knot
    // counts as drawn (card S8, Section 6.6).
    svg.setAttribute('aria-label', `The live store as a graph. ${svg.dataset.threadCount} threads and ${svg.dataset.knotCount} knots.`);
    // A receipt link names the record it opens (card S5): the id
    // arrives from the click in this page, or from the landing
    // page through session storage, and that record opens here as
    // if its knot had been clicked.
    let openId = pendingTrailId;
    pendingTrailId = '';
    if (!openId) {
      try { openId = sessionStorage.getItem('ml-open-record') || ''; sessionStorage.removeItem('ml-open-record'); } catch { openId = ''; }
    }
    if (openId) {
      const node = graph.nodes.find((n) => n.id === openId);
      if (node && node.kind === 'memory') showTrail(openId);
      else if (node) showKnotNote(node, graph);
      return;
    }
    // Until a knot is selected the detail panel shows the first
    // returned knot in returned order (Section 6.6), so the panel
    // is never a dead instruction box. The activation goes
    // through the knot's own click handler, so the ring and the
    // panel agree. An SVG group has no click() method in this
    // browser, so the event is dispatched.
    const firstKnot = graph.nodes.find((n) => n.kind === 'memory' || n.kind === 'proposal') || graph.nodes[0];
    if (firstKnot) {
      const g = svg.querySelector(`g[data-node-id="${firstKnot.node_id}"]`);
      if (g) g.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
  }
  function showKnotNote(n, graph) {
    // Every knot answers a click (5.2 fix: proposals, sources and
    // agent heads used to be silent dead ends, only memories
    // responded). Each note says what the knot is and where the
    // reader acts on it.
    const out = document.getElementById('trailOut');
    if (!out) return;
    if (n.kind === 'proposal') {
      out.innerHTML = `<div class="card"><h2>A proposal, still waiting</h2><p style="margin:0">This hollow knot is a proposal that has not entered truth. Proposals are decided in the <a href="#/loop">Live loop</a>, approved by the gate or settled by a human there, never from the graph.</p></div>`;
    } else if (n.kind === 'source') {
      out.innerHTML = `<div class="card"><h2>A cited source, <code class="inline">${esc(n.id)}</code></h2><p style="margin:0">Sources are the evidence records memories rest on. A source appears in the receipt of every memory that cites it, ask in <a href="#/recall">Recall + receipts</a> and read it there.</p></div>`;
    } else if (n.kind === 'agent') {
      const label = n.id === 'memoryloom-learning' ? 'learning' : n.id.split(' ')[0];
      // Raw graph nodes carry no author field, authorship lives in
      // the authored_by / proposed_by edges (the same source the
      // renderer lays out from).
      const mine = graph.edges.filter((e) => (e.type === 'authored_by' || e.type === 'proposed_by') && e.to === 'agent:' + n.id).length;
      out.innerHTML = `<div class="card"><h2>The ${esc(label)} thread</h2><p style="margin:0">Every knot on this thread was authored by ${esc(label)}${n.id === 'memoryloom-learning' ? ', the name the standing lesson was promoted under' : ''}. ${mine} record${mine === 1 ? '' : 's'} sit${mine === 1 ? 's' : ''} on it. Click any knot on the thread for its trail.</p></div>`;
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
          <h2>Provenance trail for <code class="inline">${esc(id)}</code></h2>
          <div class="row-item"><div class="meta">${agentBadge(trail.author)}<span class="badge">${esc(trail.memory.type)}</span><span class="small">via ${esc(originPlain(trail.origin))} · recorded ${fmtDate(trail.memory.recorded_at)}</span></div>
          <div class="text">${esc(trail.memory.text)}</div>
          ${trail.sources?.length ? `<div class="detail">cited sources: ${trail.sources.map((s) => `<code class="inline">${esc(s)}</code>`).join(' ')}</div>` : ''}</div>
          ${trail.grounding?.length ? `<h3 style="margin-top:14px">It rests on (${trail.grounding.length})</h3>` + trail.grounding.map((g) => `<div class="row-item"><div class="meta">${agentBadge(g.author)}<code class="inline">${esc(g.id)}</code></div><div class="text">${esc(g.text)}</div></div>`).join('') : ''}
          ${trail.decisions?.length ? `<h3 style="margin-top:14px">Decisions on its path (${trail.decisions.length})</h3>` + trail.decisions.map((d) => `<div class="row-item"><div class="meta"><span class="badge">${esc(kindPlain(d.kind))}</span><span class="small">${esc(d.status || '')} ${d.decided_by ? '· by ' + esc(d.decided_by) : ''} ${d.route_reason ? '· ' + esc(routePlain(d.route_reason)) : ''}</span></div>${d.proposal_id ? `<div class="detail">proposal <code class="inline">${esc(d.proposal_id)}</code></div>` : ''}${jevDetail(d.kind === 'consolidation' ? d : null)}</div>`).join('') : ''}
          ${trail.superseded_by ? `<div class="detail" style="margin-top:10px">Superseded by <code class="inline">${esc(trail.superseded_by.id)}</code>, ${esc(trail.superseded_by.text)}</div>` : ''}
          <h3 style="margin-top:16px">Supersession chain</h3>
          ${chainRows.length > 1 ? `<div class="timeline-strip">${chainRows.map((c, i) => `${i ? '<div class="arrow">→</div>' : ''}<div class="step"><b>${esc(c.id)}</b><br>${esc(c.text || '')}<br><span class="small">${fmtDate(c.valid_from)}${c.valid_to ? ' to ' + fmtDate(c.valid_to) : ', held now'}</span></div>`).join('')}</div>` : '<p class="small">This belief has never been superseded.</p>'}
        </div>`;
    } catch (e) {
      out.innerHTML = `<div class="empty-state error-state"><h2>Trail failed</h2><p>${esc(e.message)}</p></div>`;
    }
  }

  /* ---------------- Time travel ---------------- */
  async function viewTime() {
    skeleton();
    let ov;
    try { ov = await api('/api/overview'); } catch (e) { return errorState('Time travel', e, viewTime); }
    if (!ov.earliest_date || !ov.latest_date) {
      // Designed empty state (5.2 fix: an empty store used to bind
      // the slider to 1 Jan 1970, new Date(null), and sit on a
      // permanent skeleton while it queried beliefs at the epoch).
      main.innerHTML = `
        ${head('Time travel', 'Every fact carries the dates it was believed between. Drag the date and ask the store what the team believed then. The answer comes from the record, not from what is true now.', 'What did the team believe on this date, and on what evidence?')}
        <div class="empty-state"><h2>There is no past to travel to yet</h2><p>Nothing has been recorded in this store yet, so no date has beliefs attached to it. When records land, the slider covers their dates.</p></div>
      `;
      return;
    }
    // The control (5.4 defect round, rebuilt by card S6). The 5.4
    // round fixed the slider's own grid: whole days in UTC, a
    // sequence token on loads, one paint path. Card S6 found the
    // deeper root cause of D3: the control kept no date of its
    // own. It held a millisecond timestamp scraped from record
    // timestamps and formatted that instant in the browser's local
    // timezone, so west of UTC the readout, the aria value text,
    // the track ends and the list heading all named the day before
    // the handle's day. There was no date input, so a date outside
    // the returned range could not be selected at all, and a
    // failed request replaced the list the user was reading. The
    // control now holds one selected date, a date string. Its step
    // range is the earliest_date and latest_date the overview
    // returns (card S6, Section 6.7), its readout formats the date
    // string in UTC, and the selected date string passes back to
    // the believed at endpoint unchanged. The frontend never
    // computes a belief: the endpoint answers the belief in force.
    const DAY = 86400000;
    const earliest = ov.earliest_date, latest = ov.latest_date;
    const dayMs = (s) => Date.parse(`${s}T00:00:00Z`);
    const dateStrOfMs = (ms) => new Date(ms).toISOString().slice(0, 10);
    const fmtDay = (s) => new Date(dayMs(s)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    const minDay = dayMs(earliest), maxDay = dayMs(latest);
    // Marks: one per date that holds at least one record, read
    // from the graph the console already trusts for dates.
    let markDays = [];
    try {
      const g = await api('/api/graph');
      markDays = [...new Set((g.nodes || []).filter((n) => n.valid_from).map((n) => dateStrOfMs(new Date(n.valid_from).getTime())))].sort();
    } catch { markDays = []; }
    const span = Math.max(1, maxDay - minDay);
    const marks = markDays.map((s) => `<span class="time-mark" style="left:${(((dayMs(s) - minDay) / span) * 100).toFixed(2)}%"></span>`).join('');
    main.innerHTML = `
      ${head('Time travel', 'Every fact carries the dates it was believed between. Drag the date and ask the store what the team believed then. The answer comes from the record, not from what is true now.', 'What did the team believe on this date, and on what evidence?')}
      <section class="time-travel">
        <p class="time-help">Move the handle or type a date to see what was believed on another day. The date can sit outside the returned range, and the handle then rests at the nearest end while the answer follows the rule for that side.</p>
        <div class="time-field">
          <label class="time-label" for="asofDate">Believed at date</label>
          <input type="date" id="asofDate" name="believed-at-date" value="${latest}">
        </div>
        <div class="time-readout">
          <label class="time-label" for="asof">Believed at date slider</label>
          <output class="time-date" id="asofLabel">${fmtDay(latest)}</output>
          <span class="time-status"><span class="time-status-marker"></span><span id="asofStatus">Latest recorded day</span></span>
        </div>
        <div class="time-track-wrap">
          <input type="range" id="asof" name="believed-at-date-slider" min="${minDay}" max="${maxDay}" step="${DAY}" value="${maxDay}" aria-valuetext="${latest}">
          <div class="time-marks" aria-hidden="true">${marks}</div>
        </div>
        <div class="time-ends">
          <span class="time-end"><span class="time-end-label">First returned</span><span class="time-end-date">${fmtDay(earliest)}</span></span>
          <span class="time-end time-end-last"><span class="time-end-label">Last returned</span><span class="time-end-date">${fmtDay(latest)}</span></span>
        </div>
      </section>
      <div id="believedAlert"></div>
      <div id="believedOut" style="margin-top:16px" aria-live="polite"></div>
    `;
    const slider = document.getElementById('asof');
    const dateInput = document.getElementById('asofDate');
    const label = document.getElementById('asofLabel');
    const status = document.getElementById('asofStatus');
    const out = document.getElementById('believedOut');
    const alertBox = document.getElementById('believedAlert');
    // One selected date, held as a date string. The slider is a
    // clamped presentation of it: a selection outside the returned
    // range rests the handle at the nearest end while the readout,
    // the date input and the request all keep the selected date.
    let selected = latest;
    let lastLoaded = null;
    let loadSeq = 0;
    const clampDay = (s) => (s < earliest ? earliest : s > latest ? latest : s);
    const paint = (source) => {
      if (source !== dateInput) dateInput.value = selected;
      if (source !== slider) slider.value = String(dayMs(clampDay(selected)));
      label.textContent = fmtDay(selected);
      slider.setAttribute('aria-valuetext', selected);
      status.textContent = selected > latest
        ? 'After the last returned record'
        : selected < earliest
          ? 'Before the first returned record'
          : selected === latest ? 'Latest recorded day' : 'Earlier day';
    };
    const rowHTML = (b) => `
          <div class="row-item"><div class="meta">${agentBadge(b.author)}<span class="badge">${esc(b.type)}</span><span class="small">valid from ${fmtDate(b.valid_from)}${b.valid_to ? ' to ' + fmtDate(b.valid_to) : ', still held'}</span></div>
          <div class="text">${esc(b.text)}</div></div>`;
    const load = async () => {
      const seq = ++loadSeq;
      const forDate = selected;
      if (!out.innerHTML) out.innerHTML = '<div class="skeleton"><div class="sk"></div><div class="sk"></div><div class="sk"></div></div>';
      try {
        const rows = await api('/api/believed?at=' + encodeURIComponent(forDate));
        if (seq !== loadSeq) return; // a newer selection owns the view now
        const list = Array.isArray(rows) ? rows : rows.beliefs || [];
        alertBox.innerHTML = '';
        lastLoaded = forDate;
        if (forDate < earliest) {
          // Before the first returned record (Section 6.7): state
          // that no belief was recorded in force on this date,
          // present nothing as current, and name the first
          // returned date.
          out.innerHTML = `<div class="empty-state"><h2>No belief was recorded in force on ${fmtDay(forDate)}</h2><p>The first returned record is dated ${fmtDay(earliest)}. Nothing is shown as believed before that date.</p></div>`;
          return;
        }
        if (!list.length) {
          out.innerHTML = `<div class="empty-state"><h2>Nothing was believed in force on ${fmtDay(forDate)}</h2><p>No record in the returned range was in force on this date. An empty answer is a truthful one.</p></div>`;
          return;
        }
        const note = forDate > latest
          ? `<p class="time-note">No later returned record exists in the returned range. The beliefs below are the latest returned beliefs, standing as the belief in force on ${fmtDay(forDate)}.</p>`
          : '';
        out.innerHTML = note + `<p class="small">${list.length} beliefs held on ${fmtDay(forDate)}:</p>` + list.map(rowHTML).join('');
      } catch (e) {
        if (seq !== loadSeq) return;
        // A failed request (Section 6.7 and the Section 6.11
        // failure row) opens with the table's words, is announced
        // with role alert and leaves the previous list and the
        // selected date in place. The list is never replaced by
        // the error.
        alertBox.innerHTML = `<div class="time-alert" role="alert">Beliefs for this date could not be loaded. ${lastLoaded ? `The list still shows ${fmtDay(lastLoaded)}.` : 'No list has loaded yet.'} (${esc(e.message)})</div>`;
      }
    };
    // Debounced (5.2): a drag fires input continuously; the view
    // used to flash its skeleton and re-query on every tick. The
    // readout still paints on every input, so handle and readout
    // move together; only the query waits.
    let loadTimer = null;
    const queueLoad = () => { clearTimeout(loadTimer); loadTimer = setTimeout(load, 140); };
    slider.addEventListener('input', () => {
      selected = dateStrOfMs(Number(slider.value));
      paint(slider);
      queueLoad();
    });
    const commitDateInput = () => {
      const v = dateInput.value;
      // A date input holds a full date string or nothing. Only a
      // real calendar date commits, and a commit that changes
      // nothing does not reload.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || dateStrOfMs(dayMs(v)) !== v || v === selected) return;
      selected = v;
      paint(dateInput);
      queueLoad();
    };
    dateInput.addEventListener('input', commitDateInput);
    dateInput.addEventListener('change', commitDateInput);
    paint();
    load();
  }

  /* ---------------- Providers ----------------
     Grouped by cascade part, in decision order (card S7, Section
     6.8 of the master plan). Each part's claim sits directly above
     its own records, and every value in the tables comes from the
     spend response. No endpoint returns a tier roster, a decides
     field or a refuses field, so a row's part is read from its
     returned tier and provider values, the refuses sentences are
     behaviour claims checked against the routing code, and a part
     with no returned rows does not render. The budget card renders
     only when the response returns the figure. Escalation rows
     come from the learning record: gate verdict events whose
     returned decision is escalate, sitting under the tables. */
  const SPEND_PARTS = [
    { id: 'tier0', name: 'Tier 0', claim: 'First-pass work. Its lean is a draft, never a decision.', refuses: 'Approving an item into truth, or dropping an item on its own', match: (r) => r.tier === 'tier0' },
    { id: 'gate', name: 'The gate', claim: 'Every enumerable decision in the product is made here, and nowhere else.', refuses: 'Approving on a backend failure. A failure fails closed and the item queues for a human', match: (r) => r.provider === 'jev' },
    { id: 'tier1', name: 'Tier 1', claim: 'Escalations, implementation-grade writing and narration. It drafts and explains, and changes no outcome.', refuses: 'Changing an enumerable outcome the gate has made', match: (r) => r.tier === 'wonder' },
    { id: 'tier2', name: 'Tier 2', claim: 'The most critical writing. It writes the standing text where a judged outcome changes the record.', refuses: 'Making the decision it writes the account of', match: (r) => r.tier === 'wonder-full' },
  ];
  const SPEND_TASK_PLAIN = { prescreen: 'pre-screening', triage: 'triage', consolidate: 'consolidation', narrate: 'narration', explain: 'explanation', gate_decision: 'the write gate', consolidation_accept: 'consolidation acceptance', decay_drop: 'decay keep or drop', learning_promotion: 'lesson promotion' };
  const SPEND_CLASS_PLAIN = { calibration: 'calibration', demo_final: 'demo final', decisions: 'decisions', product: 'product', gate_calibration: 'gate calibration' };
  let lastSpend = null;
  async function viewProviders() {
    skeleton();
    let s;
    try { s = await api('/api/spend'); } catch (e) {
      // Section 6.11 failure row for the spend call: the words in
      // a role alert above the table, the last populated table
      // kept in place where one exists, focus unchanged.
      if (lastSpend) { renderProviders(lastSpend.s, lastSpend.escalations, true); return; }
      main.innerHTML = `
        ${head('Providers', 'Only providers that actually did work appear here. Every paid call went through the router. Each one is logged, cached, and refused past the 80 percent stop loss. Decisions are not model calls. The gate record is below.', 'Who did the work, and what did it cost?')}
        <p class="view-alert" role="alert">Provider records could not be loaded.</p>`;
      return;
    }
    let escalations = null;
    try {
      const L = await api('/api/learning');
      escalations = (L.events || []).filter((e) => e.kind === 'gate_verdict' && e.evidence?.decision?.decision === 'escalate');
    } catch { escalations = null; }
    lastSpend = { s, escalations };
    renderProviders(s, escalations, false);
  }
  function renderProviders(s, escalations, failed) {
    const totalCost = s.router.reduce((a, r) => a + r.est_cost_usd, 0);
    const totalCalls = s.router.reduce((a, r) => a + r.calls, 0);
    const metaBudget = s.budgets_usd?.meta?.total;
    const matched = new Set();
    const partBlock = (name, claim, refuses, rs) => `
      <h2 style="margin-top:22px">${esc(name)}</h2>
      <p class="small" style="margin-bottom:8px">${esc(claim)}</p>
      <div class="card" style="padding:6px 14px"><div class="table-wrap" tabindex="0" role="region" aria-label="${esc(name)} records table"><table class="data">
        <thead><tr><th scope="col">Work</th><th scope="col">Run on</th><th scope="col">Calls</th><th scope="col">Cached (free)</th><th scope="col">Tokens in / out</th><th scope="col">Est. cost</th><th scope="col">Refuses</th></tr></thead>
        <tbody>${rs.map((r) => `<tr><th scope="row">${esc((SPEND_TASK_PLAIN[r.task] || String(r.task || '').replace(/_/g, ' ')) + ' · ' + (SPEND_CLASS_PLAIN[r.spend_class] || String(r.spend_class || '').replace(/_/g, ' ')) + ' class')}</th><td>${esc(r.provider)} · ${esc(r.model)}</td><td class="num">${r.calls}</td><td class="num">${r.cached}</td><td class="num">${r.input_tokens.toLocaleString()} / ${r.output_tokens.toLocaleString()}</td><td class="num">${fmtUsd(r.est_cost_usd)}</td><td>${esc(refuses)}</td></tr>`).join('')}</tbody></table></div><p class="small table-cue">This table is wider than the screen. Scroll it sideways to read every column.</p></div>`;
    const blocks = [];
    for (const part of SPEND_PARTS) {
      const rs = s.router.filter((r) => part.match(r));
      rs.forEach((r) => matched.add(r));
      if (rs.length) blocks.push(partBlock(part.name, part.claim, part.refuses, rs));
    }
    const rest = s.router.filter((r) => !matched.has(r));
    if (rest.length) blocks.push(partBlock('Further recorded work', 'Work the router logged outside the four cascade parts, shown under its returned names.', 'No refusal recorded for this group', rest));
    const escBlock = `
      <h2 style="margin-top:16px">Escalations</h2>
      ${escalations === null ? '<p class="small">Escalation records could not be loaded.</p>'
      : escalations.length ? `<ol class="esc-list">${escalations.map((e) => `<li class="row-item"><div class="meta">${verdictBadge('escalate')}<span class="small">${fmtTs(e.created_at)} · ${esc(subjectPlain(e.subject_type))} ${esc(e.subject_id)}</span></div><div class="text">${e.evidence.decision.reason ? 'Reason given. ' + esc(e.evidence.decision.reason) : 'No reason was returned.'}</div></li>`).join('')}</ol>`
      : '<p class="small">No tier movements have been recorded yet.</p>'}`;
    main.innerHTML = `
      ${head('Providers', 'Only providers that actually did work appear here. Every paid call went through the router. Each one is logged, cached, and refused past the 80 percent stop loss. Decisions are not model calls. The gate record is below.', 'Who did the work, and what did it cost?')}
      ${failed ? '<p class="view-alert" role="alert">Provider records could not be loaded.</p>' : ''}
      <div class="kv">
        <div class="card"><div class="big">${totalCalls}</div><div class="small">paid router calls (uncached)</div></div>
        <div class="card"><div class="big">$${totalCost.toFixed(2)}</div><div class="small">estimated router spend, all time</div></div>
        ${metaBudget != null ? `<div class="card"><div class="big">$${metaBudget}</div><div class="small">Meta credit budget · stop-loss at 80%</div></div>` : ''}
        <div class="card"><div class="big">${s.jev_decisions_in_namespace}</div><div class="small">gate verdicts recorded in this namespace</div></div>
      </div>
      ${s.router.length ? blocks.join('') + escBlock
      : '<div class="empty-state"><h2>No paid calls yet</h2><p>The router has logged no spend. Calibration and evaluation runs will appear here when they happen.</p></div>'}
      <h2 style="margin-top:24px">Per-memory work</h2>
      ${s.per_memory.length ? s.per_memory.map((w) => `<div class="row-item"><div class="meta"><span class="badge">${esc(w.provider)}</span><span class="small">${esc(w.work)} · ${fmtTs(w.at)}</span></div><div class="text">memory <code class="inline">${esc(w.memory_id)}</code></div>${jevDetail(w.decision)}</div>`).join('')
      : '<div class="empty-state"><h3>No per-memory provider work recorded</h3><p>When the gate decides a proposal from this console, its verdict lands here against the memory it created.</p></div>'}
      <p class="small" style="margin-top:14px">A note on absence. Two further sponsor providers were evaluated for this build and did no work. One was selected but its credit was never redeemed. The other never confirmed a balance. They are not listed, because a provider panel that credits work nobody did would be decoration, not evidence.</p>
    `;
  }

  /* ---------------- Learning ---------------- */
  let lastLearning = null;
  async function viewLearning() {
    skeleton();
    let L;
    try { L = await api('/api/learning'); } catch (e) {
      // Section 6.11 failure row for the learning call: the words
      // in a role alert above the view content, the last good
      // lessons and stream kept in place where they exist, focus
      // unchanged.
      if (lastLearning) { renderLearning(lastLearning, true); return; }
      main.innerHTML = `
        ${head('Learning', 'Every interaction is recorded as a learning event, and the record is never rewritten. A lesson stands only because the gate promoted it. Its verdict travels with it. Forged lessons are flagged by audit. A forged lesson is a lesson shaped record with no gate verdict.', 'Improvement is shown event by event. It is not asserted.')}
        <p class="view-alert" role="alert">Learning records could not be loaded.</p>`;
      return;
    }
    lastLearning = L;
    renderLearning(L, false);
  }
  function renderLearning(L, failed) {
    // The filter offers the full kind vocabulary, not only the
    // kinds present in this stream (5.3 re-review: options built
    // from the stream alone made the filtered-empty state
    // unreachable, a state the product renders but no user could
    // ever see is a claim, not a feature).
    const kinds = [...new Set([...Object.keys(KIND_PLAIN), ...L.events.map((e) => e.kind)])];
    const verdicts = L.before_after.verdicts;
    main.innerHTML = `
      ${head('Learning', 'Every interaction is recorded as a learning event, and the record is never rewritten. A lesson stands only because the gate promoted it. Its verdict travels with it. Forged lessons are flagged by audit. A forged lesson is a lesson shaped record with no gate verdict.', 'Improvement is shown event by event. It is not asserted.')}
      ${failed ? '<p class="view-alert" role="alert">Learning records could not be loaded.</p>' : ''}
      <h2>Before and after, one task class</h2>
      ${verdicts.length ? `<div class="timeline-strip">${verdicts.map((v, i, a) => `${i ? '<div class="arrow">→</div>' : ''}<div class="step">${v.decision ? verdictBadge(v.decision.decision) : ''}<br>${esc(v.summary)}<br><span class="small">${fmtTs(v.at)}</span></div>`).join('')}</div>
        <p class="small">The task is to lodge a global factual claim so the gate approves it. Before the lesson, claims escalated for want of citations. After it, the second agent approved first try, with no correction of its own. The full event trail is in the stream below.</p>`
      : '<div class="empty-state"><h3>No before and after story yet</h3><p>No lesson has been promoted in this store yet, so there is no story to show.</p></div>'}
      <h2 style="margin-top:22px">Playbook lessons (${L.lessons.length})</h2>
      ${L.lessons.length ? L.lessons.map((l) => {
        // Claim and record card (card S7, Section 6.9): the lesson
        // text first, its gate record line next, the evidence block
        // after, and nothing between the text and its gate record.
        // The gate record is the one the API joined to this lesson
        // server side, never a pairing made here. A lesson that
        // arrives without one gets a plain line saying so and never
        // reads as approved.
        const forged = L.audit.forged_lesson_ids.includes(l.id);
        const gateRecord = l.jev ? jevDetail({ decision: l.jev.promote ? 'promote' : 'decline', model: l.jev.model, probability: l.jev.calibrated?.promote, raw_probability: l.jev.raw?.promote, reason: l.jev.reason }) : '';
        const gateLine = l.jev
          ? `<div class="meta" style="margin-top:8px">${l.jev.promote ? '<span class="badge" data-state="approved">promoted by the gate</span>' : '<span class="badge" data-state="rejected">declined by the gate</span>'}<span class="small">the gate record returned with this lesson</span></div>${gateRecord}`
          : `<div class="meta" style="margin-top:8px">${forged ? '<span class="badge" data-state="rejected">audit found no verdict, forged</span>' : ''}<span class="small">No gate record was returned for this lesson.</span></div>`;
        const evidence = `<p class="small" style="margin-top:8px">${l.learning_event_id ? 'Learned from learning event <code class="inline">' + esc(l.learning_event_id) + '</code> · ' : ''}Lesson recorded ${fmtDate(l.created_at)}.</p>`;
        return `<article class="card" style="margin-bottom:12px"><h3 class="record-text lesson-text" style="margin:0">${esc(l.text)}</h3>${gateLine}${evidence}</article>`;
      }).join('')
      : '<div class="empty-state"><h3>No lessons standing</h3><p>No event has been promoted yet. Promotion is the gate&rsquo;s decision, not a button here.</p></div>'}
      ${L.audit ? `<div class="row-item"><div class="meta"><span class="badge">lesson audit</span><span class="small">read from the same response</span></div><div class="text">${L.audit.checked} lesson(s) checked, ${L.audit.forged_lesson_ids.length} forged. A lesson with no gate verdict in its record is forged by definition and is quarantined.</div></div>` : ''}
      <h2 style="margin-top:22px">Event stream (${L.events.length})</h2>
      <div class="toolbar"><div><label class="f" for="kindFilter">Filter by kind</label>
        <select id="kindFilter"><option value="">all kinds</option>${kinds.map((k) => `<option value="${esc(k)}">${esc(kindPlain(k))}</option>`).join('')}</select></div></div>
      <div id="eventList"></div>
    `;
    const render = (kind) => {
      const rows = L.events.filter((e) => !kind || e.kind === kind);
      document.getElementById('eventList').innerHTML = rows.length ? `<ol class="stream-list">${rows.map((e) => `
        <li class="row-item"><div class="meta"><span class="badge">${esc(kindPlain(e.kind))}</span>${agentBadge(e.actor)}<span class="small"><time datetime="${esc(e.created_at)}">${fmtTs(e.created_at)}</time>${e.subject_id ? ' · ' + esc(subjectPlain(e.subject_type)) + ' ' + esc(e.subject_id) : ''}</span></div>
        <div class="text">${esc(e.summary)}</div></li>`).join('')}</ol>`
        // Two different empty sets, two different truths (5.3,
        // Finding G): an empty STREAM holds no kinds at all, while
        // a filtered-empty set on a live stream does.
        : L.events.length === 0
          ? '<div class="empty-state"><h3>No events recorded yet</h3><p>The stream is empty. Nothing has been logged in this store yet. Use the app and every interaction will be recorded here.</p></div>'
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
     as an unsaved candidate, it is only stored when the user
     presses Save. No full key is ever rendered: the API returns
     masked tails only, and the input is a password field. */
  const SETTINGS_PROVIDERS = [
    { id: 'meta', name: 'Meta Model API', getKey: 'Get a key at dev.meta.ai. Open API keys and create a key for MemoryLoom.', unlocks: 'narration and reasoning calls' },
    { id: 'baseten', name: 'Baseten', getKey: 'Get a key in the Baseten workspace settings, under API keys.', unlocks: 'the fast screening calls. This build does not spend on Baseten, so a key saved here is not used yet' },
    { id: 'jev', name: 'Jev (TypeSafe)', getKey: 'Get a key from TypeSafe. Jev is served by the TypeSafe API, so its key comes from TypeSafe.', unlocks: 'the decision gate that approves, rejects or escalates proposals' },
  ];
  let settingsFlash = {};
  function settingsStatus(entry) {
    // Tokens v2: standing by word + marker shape (data-state),
    // never by a colour class (the v1 ok/bad hues are gone).
    if (!entry.configured) return { state: 'pending', label: 'Not configured', source: 'Source: not configured yet' };
    if (entry.source === 'env') return { state: 'approved', label: 'Set by the owner', source: 'Source: set by the owner for this site' };
    if (entry.source === 'store') return { state: 'approved', label: 'Configured in Settings', source: 'Source: saved in Settings on this machine' };
    return { state: 'approved', label: 'Configured', source: 'Source: not returned by the settings response' };
  }
  function settingsSection(def, entry) {
    const st = settingsStatus(entry);
    const flash = settingsFlash[def.id] || '';
    // The input is described by the status line, the masked line
    // and the where to get a key line (Section 6.10), each under
    // its own id so the description is programmatic, not visual.
    const describedBy = [`set-${def.id}-status`, `set-${def.id}-masked`];
    if (!entry.configured) describedBy.push(`set-${def.id}-getkey`);
    if (entry.source === 'env') describedBy.push(`set-${def.id}-envnote`);
    const removeReasonId = entry.source === 'env' ? `set-${def.id}-envnote` : `set-${def.id}-remove-reason`;
    return `<section class="card settings-card">
      <div class="provider-head"><h2>${esc(def.name)}</h2><span class="badge" id="set-${def.id}-status" tabindex="-1" data-state="${st.state}">${esc(st.label)}</span></div>
      <div class="settings-meta">
        ${entry.configured
          ? (entry.last4
            ? `<span id="set-${def.id}-masked">Key ending <span class="masked-tail">•••• ${esc(entry.last4)}</span></span>`
            : `<span id="set-${def.id}-masked">Configured, the key tail is unavailable for a key this short.</span>`)
          : `<span id="set-${def.id}-masked">No key saved.</span>`}
        <span class="small">${esc(st.source)}</span>
      </div>
      ${!entry.configured && def.getKey ? `<p class="small settings-hint" id="set-${def.id}-getkey">${esc(def.getKey)} Adding it unlocks ${esc(def.unlocks)}.</p>` : ''}
      ${entry.source === 'env' ? `<p class="small settings-hint" id="set-${def.id}-envnote">The owner set this key for the site itself, so it is the one in use, and it cannot be removed from this page.</p>` : ''}
      ${!entry.configured ? `<p class="small settings-hint" id="set-${def.id}-remove-reason">There is no saved key to remove.</p>` : ''}
      <label class="f" for="set-${def.id}-key">${entry.configured ? `Replace the ${esc(def.name)} key` : `${esc(def.name)} key`}</label>
      <input type="password" id="set-${def.id}-key" autocomplete="off" spellcheck="false" placeholder="Paste a key" aria-describedby="${describedBy.join(' ')}">
      <div class="provider-actions">
        <button class="btn primary small-btn" id="set-${def.id}-save" type="button" aria-label="Save the ${esc(def.name)} key">Save</button>
        <button class="btn small-btn" id="set-${def.id}-test" type="button" aria-label="Test the ${esc(def.name)} connection">Test connection</button>
        <button class="btn small-btn" id="set-${def.id}-remove" type="button" aria-label="Remove the ${esc(def.name)} key" ${entry.source === 'store' ? '' : `disabled aria-describedby="${removeReasonId}"`}>Remove</button>
      </div>
      <div class="settings-result" id="set-${def.id}-result" aria-live="polite" tabindex="-1">${esc(flash)}</div>
    </section>`;
  }
  async function viewSettings(focusIntent) {
    skeleton(3);
    let data;
    try { data = await api('/api/settings'); } catch (e) {
      // Section 6.11 failure row for the settings call: the words
      // in a role alert line at the head of the view, and no
      // provider rows guessed.
      main.innerHTML = `
        ${head('Settings', 'Keys for the services MemoryLoom can call. A key is only used when you press Test connection, or when the service is called for real work. Keys are never shown in full.', 'Your keys stay yours.')}
        <p class="view-alert" role="alert">Settings could not be loaded. No key was changed.</p>`;
      return;
    }
    const providers = data.providers || {};
    // Sections render in the order the settings response returns
    // them (card S7): the typed list supplies only the label and
    // hint text for a returned id, and a provider the response does
    // not return gets no section, rather than a fabricated
    // not-configured one.
    const defsById = Object.fromEntries(SETTINGS_PROVIDERS.map((d) => [d.id, d]));
    const entries = Object.entries(providers).map(([id, entry]) => [defsById[id] || { id, name: id, getKey: '', unlocks: '' }, entry]);
    const anyConfigured = entries.some(([, e]) => e.configured);
    main.innerHTML = `
      ${head('Settings', 'Keys for the services MemoryLoom can call. A key is only used when you press Test connection, or when the service is called for real work. Keys are never shown in full.', 'Your keys stay yours.')}
      ${entries.length === 0
        ? '<div class="empty-state"><h2>Nothing to configure</h2><p>There is nothing to configure here. The settings service returned no providers.</p></div>'
        : `${anyConfigured ? '' : `<div class="empty-state" style="margin-bottom:16px"><h2>No provider keys configured</h2><p>MemoryLoom can run on your own machine without keys. Recall, the graph and time travel still work. Add a key below to switch on live calls for that provider. The Meta Model API covers narration and reasoning. Jev covers the decision gate. Each key is stored here and can be tested here.</p></div>`}
      <div class="settings-grid">${entries.map(([d, e]) => settingsSection(d, e)).join('')}</div>`}
    `;
    settingsFlash = {};
    for (const [def] of entries) wireSettingsSection(def);
    // The Section 6.10 focus rules after a save or a remove: the
    // re-render above destroyed the control the reader was on, so
    // focus is placed where the rule names, on the fresh element.
    if (focusIntent && focusIntent.result) {
      const el = document.getElementById(`set-${focusIntent.result}-result`);
      if (el) el.focus({ preventScroll: true });
    }
    if (focusIntent && focusIntent.status) {
      const el = document.getElementById(`set-${focusIntent.status}-status`);
      if (el) el.focus({ preventScroll: true });
    }
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
      if (!key) { show('Paste a key first. There is nothing to save yet.', 'bad'); input.focus(); return; }
      setBusy(true);
      show('Saving…');
      try {
        const saved = await api(`/api/settings/${def.id}`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ api_key: key }),
        });
        settingsFlash = { [def.id]: saved.last4 ? `Saved. The ${def.name} key now ends •••• ${saved.last4}.` : `Saved. The ${def.name} key is saved.` };
        // A successful save re-reads the masked view, and focus
        // moves to this provider's result line (Section 6.10).
        await viewSettings({ result: def.id });
      } catch (e) {
        // A failed save leaves focus in the password field.
        show('Save failed: ' + e.message, 'bad');
        setBusy(false);
        input.focus();
      }
    });
    testBtn.addEventListener('click', async () => {
      const key = input.value.trim();
      setBusy(true);
      show('Testing the connection…');
      let ok = false;
      try {
        // A typed key is tested as an unsaved candidate: testing
        // never saves first, and the typed key stays in the field
        // whatever the result, so a failed test loses nothing.
        const r = await api(`/api/settings/${def.id}/test`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(key ? { api_key: key } : {}),
        });
        if (r.ok) { show(`Connected. ${def.name} answered${r.latency_ms != null ? ` in ${r.latency_ms} ms` : ''}.`, 'ok'); ok = true; }
        else show(r.error || `${def.name} did not answer.`, 'bad');
      } catch (e) {
        show(e.message, 'bad');
      }
      setBusy(false);
      // A successful test leaves focus on the Test button. The
      // button was disabled while the call ran, which drops focus
      // to the body, so a success puts it back. A failed test
      // puts focus in the password field instead (Section 6.10).
      if (ok) testBtn.focus();
      else input.focus();
    });
    removeBtn.addEventListener('click', async () => {
      setBusy(true);
      show('Removing…');
      try {
        await api(`/api/settings/${def.id}`, { method: 'DELETE' });
        settingsFlash = { [def.id]: `Key removed. The ${def.name} key is no longer saved.` };
        // A successful remove re-reads the masked view, and focus
        // moves to this provider's status line (Section 6.10).
        await viewSettings({ status: def.id });
      } catch (e) {
        show('Remove failed: ' + e.message, 'bad');
        setBusy(false);
      }
    });
  }

  /* ---------------- Chat ----------------
     The chat surface, shaped like a real chat app (step D2). Three
     parts on one screen. On the left, the chats list, built from
     the running store only, one workspace conversation for the
     whole namespace and one conversation per author the store
     holds. In the middle, the conversation itself. The workspace
     conversation is the working one and keeps the mechanics this
     view has always had, a question routed to recall with its
     receipts, a fact routed to propose through the gate, a named
     past date routed to believed. The other conversations are
     readable histories of what that author stored and asked. On
     the right, the engine panel, a live feed of the learning
     events and record changes in this namespace, polled every few
     seconds, over the knowledge graph drawn by the shared
     renderer from the graph endpoint. Nothing here is scripted.
     Every row traces to a real event, proposal or memory row, and
     the feed says plainly when nothing new has happened. */
  let chatEntries = [];
  let chatBusy = false;
  let chatPeer = 'workspace';
  let chatData = null;
  let chatDataKey = '';
  let chatGraphKey = '';
  let chatPollTimer = null;
  let chatPollFailed = false;
  const CHAT_HUMAN_AUTHORS = new Set(['Chat user', 'human (console)']);
  const fmtClock = (d) => d ? new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'Not recorded';
  const peerKeyOf = (author) => {
    if (!author) return '';
    return (CHAT_HUMAN_AUTHORS.has(author) || author === 'console') ? 'you' : 'agent:' + author;
  };
  function displayActor(a) {
    if (!a) return 'Unknown';
    if (CHAT_HUMAN_AUTHORS.has(a)) return 'This console';
    if (a === 'console') return 'This console';
    if (a === 'mcp') return 'A connected agent';
    if (a === 'jev') return 'The gate';
    return a;
  }
  function plainReason(r) {
    return (typeof r === 'string' && r.length <= 220 && !/(jev|api|backend|key|token|http|_)/i.test(r)) ? r : '';
  }
  const CHAT_MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  function chatISODate(y, m, d) {
    const dt = new Date(Date.UTC(y, m, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m || dt.getUTCDate() !== d) return null;
    return dt.toISOString().slice(0, 10);
  }
  function chatParseDate(t) {
    let m = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    if (m) return chatISODate(+m[1], +m[2] - 1, +m[3]);
    m = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{4})\b/i);
    if (m) return chatISODate(+m[3], CHAT_MONTHS[m[2].toLowerCase()], +m[1]);
    m = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i);
    if (m) return chatISODate(+m[3], CHAT_MONTHS[m[1].toLowerCase()], +m[2]);
    return null;
  }
  /* The routing tests, in the order the design states. A named
     past date with belief words goes to believed. A leading
     remember word goes to propose, with the word itself stripped
     so the stored text is the claim. A question shape goes to
     recall. A plain statement of fact goes to propose. Greetings
     and fragments go nowhere and get the two paths reply. */
  function chatRouteText(raw) {
    const t = raw.trim();
    if (!t) return { kind: 'none' };
    const at = chatParseDate(t);
    if (at && /(believ|held|thought)/i.test(t)) return { kind: 'believed', at };
    const rem = t.match(/^(remember|keep|note|save)\b[:,]?\s+(that\s+)?/i);
    if (rem) return { kind: 'propose', text: t.slice(rem[0].length).trim() || t };
    if (/^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|bye)\b/i.test(t) && t.split(/\s+/).length <= 4) return { kind: 'none' };
    if (/\?\s*$/.test(t) || /^(what|where|when|who|why|how|is|are|was|were|do|does|did|can|could|which|has|have)\b/i.test(t)) return { kind: 'recall', text: t };
    if (at && /\?\s*$/.test(t)) return { kind: 'believed', at };
    if (t.split(/\s+/).length >= 4 || /\b(is|are|was|were|runs|run|opens|closes|sits|stands|uses|has|have|moved|changed|holds|held)\b/i.test(t)) return { kind: 'propose', text: t };
    return { kind: 'none' };
  }
  function chatReceiptBlock(receipt, form) {
    return `<div class="chat-receipt"><button class="btn small-btn" type="button" data-receipt-toggle aria-expanded="false">Show receipt</button><div class="chat-receipt-body" hidden>${receiptHTML(receipt, form)}</div></div>`;
  }
  function chatEntryHTML(e) {
    if (e.kind === 'user') return `<div class="chat-msg"><div class="chat-who">You</div><div class="text">${esc(e.text)}</div></div>`;
    if (e.kind === 'note') return `<div class="chat-msg"><div class="chat-who">MemoryLoom</div>${e.title ? `<h3>${esc(e.title)}</h3>` : ''}${e.lines.map((l) => `<p>${esc(l)}</p>`).join('')}</div>`;
    if (e.kind === 'answer') {
      const f = e.first;
      return `<div class="chat-msg"><div class="chat-who">MemoryLoom</div>
        <div class="row-item"><div class="meta"><span class="badge" data-state="approved">Answer</span><span class="badge">${esc(f.type)}</span></div>
        <div class="text">${esc(f.text)}</div>
        ${f.receipt ? chatReceiptBlock(f.receipt, 'card') : ''}
        ${f.receipt ? `<p class="small" style="margin-top:8px">See this record in the graph, ${recordLink(f.receipt.memory_id)}</p>` : ''}
        ${e.dropped.length ? `<p class="small" style="margin-top:8px">${e.dropped.length} result${e.dropped.length === 1 ? ' was' : 's were'} left out because no receipt could be made for ${e.dropped.length === 1 ? 'it' : 'them'}.</p>` : ''}</div>
        ${e.more.length ? `<h3 style="margin-top:14px">More records on this</h3>` + e.more.map((res) => `<div class="row-item"><div class="meta"><span class="badge">${esc(res.type)}</span></div><div class="text">${esc(res.text)}</div>${res.receipt ? chatReceiptBlock(res.receipt, 'plain') : ''}</div>`).join('') : ''}</div>`;
    }
    if (e.kind === 'noanswer') {
      return `<div class="chat-msg"><div class="chat-who">MemoryLoom</div>
        <div class="empty-state"><h3>No answer found</h3><p>I do not have an answer for that in the shared memory. Nothing came back that can be shown with proof. You can ask in other words or give a fact to remember.</p></div>
        ${e.results.length ? `<h3 style="margin-top:14px">Closest records, and they do not answer the question (${e.results.length})</h3>` + e.results.map((res) => `<div class="row-item"><div class="meta"><span class="badge">closest record, not an answer</span><span class="badge">${esc(res.type)}</span></div><div class="text">${esc(res.text)}</div>${res.receipt ? chatReceiptBlock(res.receipt, 'plain') : ''}</div>`).join('') : ''}
        ${e.dropped.length ? `<p class="small" style="margin-top:8px">${e.dropped.length} result${e.dropped.length === 1 ? ' was' : 's were'} left out because no receipt could be made for ${e.dropped.length === 1 ? 'it' : 'them'}.</p>` : ''}</div>`;
    }
    if (e.kind === 'outcome') {
      if (e.decision === 'auto_approved') return `<div class="chat-msg"><div class="chat-who">MemoryLoom</div>
        <div class="row-item"><div class="meta"><span class="badge" data-state="approved">Approved and remembered</span></div>
        <div class="text">This is now part of the shared memory. Every agent you run can use it from now on.</div>
        ${e.id ? `<p class="small" style="margin-top:8px"><a href="#/graph" data-record-link="${esc(e.id)}">See the new record</a></p>` : ''}</div></div>`;
      if (e.decision === 'rejected') {
        const plain = typeof e.reason === 'string' && e.reason.length <= 160 && !/(jev|api|backend|key|token|http|_)/i.test(e.reason);
        return `<div class="chat-msg"><div class="chat-who">MemoryLoom</div>
        <div class="row-item"><div class="meta"><span class="badge" data-state="rejected">Not accepted</span></div>
        <div class="text">This will not be remembered. ${plain ? 'The check said this. ' + esc(e.reason) : 'The check did not accept it as a fact the team can stand on.'} You can say it again in other words.</div></div></div>`;
      }
      if (e.decision === 'queued_for_review') return `<div class="chat-msg"><div class="chat-who">MemoryLoom</div>
        <div class="row-item"><div class="meta"><span class="badge" data-state="escalated">Sent to a human</span></div>
        <div class="text">A person will decide whether this is remembered. It is not part of the shared memory yet.${e.reason === 'jev-unavailable-fail-closed' ? ' The automatic check could not be reached, so a person will decide instead.' : ''}</div>
        <p class="small" style="margin-top:8px"><a href="#/loop">Watch it in Waiting for a human</a></p></div></div>`;
      return `<div class="chat-msg"><div class="chat-who">MemoryLoom</div><div class="row-item"><div class="text">The gate answered in a way this chat does not know yet. Nothing was decided here. You can check the outcome in the live loop.</div></div></div>`;
    }
    if (e.kind === 'believed') {
      const rows = e.list.map((b) => `<div class="row-item"><div class="meta">${agentBadge(b.author)}<span class="badge">${esc(b.type)}</span><span class="small">valid from ${fmtDate(b.valid_from)}${b.valid_to ? ' to ' + fmtDate(b.valid_to) : ', still held'}</span></div><div class="text">${esc(b.text)}</div></div>`).join('');
      return `<div class="chat-msg"><div class="chat-who">MemoryLoom</div>
        <h3>What the team believed on ${fmtDate(e.at)}</h3>
        ${e.list.length ? `<p>On the date you named the team believed this.</p>${rows}` : `<p>Nothing in the store was believed on that date.</p>`}
        <p class="small"><a href="#/time">See ${fmtDate(e.at)} in Time travel</a></p></div>`;
    }
    return '';
  }
  function chatEmptyHTML() {
    return `<div class="empty-state chat-welcome"><h2>Welcome to MemoryLoom chat</h2>
      <p>Ask a question and the answer will show where it came from. Give a fact and it will be checked before it is remembered.</p></div>`;
  }
  async function chatRefreshStrip() {
    const el = document.getElementById('chatStrip');
    if (!el) return;
    try {
      const [ov, L] = await Promise.all([api('/api/overview'), api('/api/learning')]);
      const mem = (ov.memories_by_type || []).reduce((a, r) => a + r.n, 0);
      const pend = ((ov.proposals_by_status || []).find((r) => r.status === 'pending') || {}).n || 0;
      const verdicts = (L.before_after && L.before_after.verdicts) || [];
      let story = '';
      if (verdicts.length >= 2) story = `<span>Learning on record. Before. ${esc(verdicts[0].summary)} After. ${esc(verdicts[verdicts.length - 1].summary)}</span>`;
      else if ((L.lessons || []).length) story = `<span>Lessons standing, ${L.lessons.length}, from ${ov.learning_events} learning events on record.</span>`;
      else story = '<span>No lessons are standing yet. Lessons appear here when the team has learned from its work.</span>';
      el.innerHTML = `<span>The shared memory holds ${mem} ${mem === 1 ? 'memory' : 'memories'}. ${pend} ${pend === 1 ? 'proposal is' : 'proposals are'} waiting for a person.</span>${story}`;
    } catch { el.innerHTML = ''; }
  }

  /* ---- The three parts, all fed by the running store ---- */
  async function chatLoadData() {
    const [ov, mem, prop, ev, graph] = await Promise.all([
      api('/api/overview'), api('/api/memories'), api('/api/proposals'), api('/api/events'), api('/api/graph'),
    ]);
    return {
      overview: ov,
      memories: mem.memories || [],
      proposals: prop.proposals || [],
      events: ev.events || [],
      eventsTotal: typeof ev.total === 'number' ? ev.total : (ev.events || []).length,
      graph,
    };
  }
  function chatDataFingerprint(data) {
    return JSON.stringify([
      data.memories.map((m) => m.id + '|' + m.approval + '|' + (m.superseded_by || '') + '|' + (m.valid_to || '') + '|' + (m.text ? m.text.length : 0)),
      data.proposals.map((p) => p.id + '|' + p.status + '|' + (p.decided_by || '')),
      data.events.map((e) => e.id),
      data.overview.agents,
    ]);
  }
  /* The chats list. The workspace entry counts every record in
     the namespace. A person or agent entry appears only when the
     store holds a memory or a proposal under that exact author
     string, and its count and last activity come from those rows
     and from the events that author acted in. */
  function chatPeers(data) {
    const map = new Map();
    const touch = (author, at) => {
      if (!author) return;
      const key = peerKeyOf(author);
      let p = map.get(key);
      if (!p) {
        p = { key, label: CHAT_HUMAN_AUTHORS.has(author) ? 'This console' : (author === 'console' ? 'This console' : displayActor(author)), count: 0, lastAt: null };
        map.set(key, p);
      }
      p.count += 1;
      if (at && (!p.lastAt || new Date(at) > new Date(p.lastAt))) p.lastAt = at;
    };
    const touchEvent = (author, at) => {
      if (!author) {
        // An event with no actor still belongs to the workspace and
        // does not invent a named chat entry.
        return;
      }
      const key = peerKeyOf(author);
      let p = map.get(key);
      if (!p) {
        p = { key, label: CHAT_HUMAN_AUTHORS.has(author) ? 'This console' : (author === 'console' ? 'This console' : displayActor(author)), count: 0, lastAt: null };
        map.set(key, p);
      }
      p.count += 1;
      if (at && (!p.lastAt || new Date(at) > new Date(p.lastAt))) p.lastAt = at;
    };
    for (const m of data.memories) touch(m.provenance?.author, m.created_at);
    for (const p of data.proposals) touch(p.provenance?.author, p.created_at);
    for (const e of data.events) touchEvent(e.actor, e.created_at);
    let lastAt = null;
    for (const r of [...data.memories, ...data.proposals, ...data.events]) {
      if (r.created_at && (!lastAt || new Date(r.created_at) > new Date(lastAt))) lastAt = r.created_at;
    }
    const workspace = {
      key: 'workspace', label: 'Workspace',
      count: data.memories.length + data.proposals.length + data.events.length,
      lastAt,
    };
    const rest = [...map.values()].sort((a, b) => {
      const at = a.lastAt ? new Date(a.lastAt).getTime() : 0;
      const bt = b.lastAt ? new Date(b.lastAt).getTime() : 0;
      if (bt !== at) return bt - at;
      return String(a.label).localeCompare(String(b.label));
    });
    return [workspace, ...rest];
  }
  function chatRenderPeers() {
    const box = document.getElementById('chatPeers');
    if (!box || !chatData) return;
    box.innerHTML = chatPeers(chatData).map((p) => `<button type="button" class="chat-peer${p.key === chatPeer ? ' active' : ''}" data-chat-peer="${esc(p.key)}" aria-pressed="${p.key === chatPeer}">
      <span class="chat-peer-name">${esc(p.label)}</span>
      <span class="chat-peer-meta">${p.count} ${p.count === 1 ? 'record' : 'records'}</span>
      <span class="chat-peer-meta">Last activity ${p.lastAt ? fmtTs(p.lastAt) : 'none yet'}</span>
    </button>`).join('');
  }
  /* One conversation, in time order. A workspace conversation
     holds every record. A person or agent conversation holds
     only what that author proposed, stored or did. */
  function historyMemoryHTML(m) {
    const author = m.provenance?.author;
    const state = m.superseded_by
      ? '<span class="badge" data-state="superseded">replaced</span>'
      : m.approval === 'live'
        ? '<span class="badge" data-state="approved">remembered</span>'
        : `<span class="badge">${esc(m.approval || 'record')}</span>`;
    return `<div class="row-item"><div class="meta">${state}<span class="badge">${esc(m.type)}</span>${agentBadge(author)}<span class="small">${fmtClock(m.created_at)}</span></div>
      <div class="text">${esc(m.text)}</div>
      ${m.superseded_by ? '<div class="detail">A newer memory replaced this one.</div>' : ''}</div>`;
  }
  function historyProposalHTML(p) {
    const author = p.provenance?.author;
    return `<div class="row-item"><div class="meta"><span class="badge">proposal</span>${verdictBadge(p.status)}${agentBadge(author)}<span class="small">${fmtClock(p.created_at)}</span></div>
      <div class="text">${esc(p.text)}</div>
      ${p.status === 'pending' ? '<div class="detail">Waiting for a person to decide.</div>' : ''}
      ${p.decided_by ? `<div class="detail">Decided by ${esc(displayActor(p.decided_by))}.</div>` : ''}</div>`;
  }
  function chatTimeline(data, key) {
    const match = (author) => key === 'workspace' || peerKeyOf(author) === key;
    const items = [];
    for (const m of data.memories) if (match(m.provenance?.author)) items.push({ at: m.created_at, html: historyMemoryHTML(m) });
    for (const p of data.proposals) if (match(p.provenance?.author)) items.push({ at: p.created_at, html: historyProposalHTML(p) });
    items.sort((a, b) => new Date(a.at) - new Date(b.at) || 0);
    return items;
  }
  function chatRenderHistory() {
    const box = document.getElementById('chatHistory');
    if (!box || !chatData) return;
    const peer = chatPeers(chatData).find((p) => p.key === chatPeer) || chatPeers(chatData)[0];
    const title = document.getElementById('chatConvTitle');
    if (title) title.textContent = peer.key === 'workspace' ? 'Workspace' : peer.label;
    const items = chatTimeline(chatData, peer.key);
    let html = '';
    if (peer.key !== 'workspace') {
      html += `<p class="small" style="margin-bottom:12px">This is what ${esc(peer.label)} stored and asked, in the order it happened. You can read it here. New messages go in the workspace chat.</p>`;
    }
    html += items.length
      ? items.map((i) => i.html).join('')
      : `<div class="empty-state"><h3>Nothing here yet</h3><p>${peer.key === 'workspace' ? 'This workspace holds no records yet. Ask a question or give a fact below and the first records will appear here.' : 'This conversation has no messages yet. When something is stored or asked under this name, it will appear here.'}</p></div>`;
    box.innerHTML = html;
    const log = document.getElementById('chatLog');
    if (log) {
      log.style.display = peer.key === 'workspace' ? '' : 'none';
      if (peer.key === 'workspace') log.innerHTML = chatEntries.length ? chatEntries.map(chatEntryHTML).join('') : (items.length ? '' : chatEmptyHTML());
    }
    const form = document.getElementById('chatForm');
    if (form) form.style.display = peer.key === 'workspace' ? '' : 'none';
    const strip = document.getElementById('chatStrip');
    if (strip) strip.style.display = peer.key === 'workspace' ? '' : 'none';
  }
  /* The engine feed. Every row is written from one real event
     row, or from a real proposal or memory row that no event
     covers, and every row carries that row's time. The words are
     plain descriptions of what the row records. */
  function chatFeedText(e) {
    const actor = displayActor(e.actor);
    const d = (e.evidence && e.evidence.decision) || {};
    const reason = plainReason(d.reason);
    switch (e.kind) {
      case 'proposal':
        return e.subject_type === 'memory'
          ? `${actor} proposed a fact and the gate approved it, so it was stored as a memory.`
          : `${actor} proposed a new memory. It went to the gate for a decision.`;
      case 'gate_verdict':
        if (d.failed === true || d.fail_closed === true) return 'The decision service could not be reached and the proposal went to a person to decide.';
        if (d.decision === 'approve') return `The gate approved the proposal.${reason ? ' The gate said this. ' + reason : ''}`;
        if (d.decision === 'reject') return `The gate did not accept the proposal, so nothing was stored.${reason ? ' The gate said this. ' + reason : ''}`;
        if (d.decision === 'escalate') return 'The gate sent the proposal to a person to decide.';
        return 'The gate gave its verdict on a proposal.';
      case 'human_approval':
        return `${actor} approved a proposal, and it was stored as a memory.`;
      case 'human_rejection':
        return `${actor} did not approve a proposal, so it was not stored.`;
      case 'human_correction':
        return `${actor} corrected a record in the shared memory.`;
      case 'recall_hit': {
        const ev = e.evidence || {};
        const hits = Array.isArray(ev.hits) ? ev.hits.length : (typeof ev.count === 'number' ? ev.count : null);
        const q = ev.query ? String(ev.query) : '';
        if (hits != null && q) return `${actor} asked a question and ${hits} matching ${hits === 1 ? 'memory' : 'memories'} came back, and the question was "${q}".`;
        if (hits != null) return `${actor} asked a question and ${hits} matching ${hits === 1 ? 'memory' : 'memories'} came back.`;
        if (q) return `${actor} asked a question and matching memories came back, and the question was "${q}".`;
        return `${actor} asked a question and matching memories came back.`;
      }
      case 'recall_miss': {
        const ev = e.evidence || {};
        const q = ev.query ? String(ev.query) : '';
        return q
          ? `${actor} asked a question and nothing in the memory matched it, and the question was "${q}".`
          : `${actor} asked a question and nothing in the memory matched it.`;
      }
      case 'promotion_decision':
        return 'The gate decided whether a lesson would stand in the memory.';
      case 'lesson_applied':
        return 'A standing lesson was used in the work.';
      case 'eval_outcome':
        return 'A check on the memory finished and its result was recorded.';
      case 'in_turn_correction':
        return `${actor} was corrected while working, and the correction was recorded.`;
      default:
        return `${kindPlain(e.kind)} recorded by ${actor}.`;
    }
  }
  function chatFeedRows(data) {
    const rows = [];
    for (const e of data.events) {
      rows.push({ at: e.created_at, kind: e.kind, text: chatFeedText(e), isEvent: true });
    }
    const covered = new Set(data.events.filter((e) => e.kind === 'proposal' && e.subject_id).map((e) => e.subject_id));
    for (const p of data.proposals) {
      if (p.status === 'pending' && !covered.has(p.id)) {
        rows.push({ at: p.created_at, kind: 'proposal', text: `${displayActor(p.provenance?.author)} proposed a memory. It is waiting for a decision.` });
      }
    }
    for (const m of data.memories) {
      if (m.superseded_by) {
        rows.push({ at: m.valid_to || m.created_at, kind: 'superseded', text: `A memory from ${displayActor(m.provenance?.author)} was replaced by a newer memory.` });
      }
    }
    rows.sort((a, b) => new Date(b.at) - new Date(a.at));
    return rows.slice(0, 40);
  }
  function chatRenderFeed() {
    const box = document.getElementById('chatFeed');
    if (!box || !chatData) return;
    const rows = chatFeedRows(chatData);
    if (!rows.length) {
      box.innerHTML = chatPollFailed
        ? '<p class="feed-idle">This panel could not check just now and is showing the last activity it received.</p>'
        : '<p class="feed-idle">Nothing has happened in this workspace yet.</p>';
      return;
    }
    const latestEventAt = (chatData.events || []).reduce((acc, e) => (e.created_at && (!acc || new Date(e.created_at) > new Date(acc)) ? e.created_at : acc), null);
    const shownEvents = rows.filter((r) => r.isEvent).length;
    const totalEvents = typeof chatData.eventsTotal === 'number' ? chatData.eventsTotal : (chatData.events || []).length;
    const header = chatPollFailed
      ? '<p class="feed-idle">This panel could not check just now and is showing the last activity it received.</p>'
      : (latestEventAt ? `<p class="feed-idle">Latest activity ${fmtClock(latestEventAt)}.</p>` : '');
    const foot = totalEvents > shownEvents
      ? `<p class="feed-idle">Showing ${shownEvents} of ${totalEvents} events in this feed.</p>`
      : '';
    box.innerHTML = `${header}
      <ul class="feed-list">${rows.map((r) => `<li class="feed-row"><div class="meta"><span class="badge">${esc(kindPlain(r.kind))}</span><span class="small">${fmtClock(r.at)}</span></div><p class="feed-text">${esc(r.text)}</p></li>`).join('')}</ul>${foot}`;
  }
  /* The counts under the feed, built from the graph endpoint.
     The full drawing lives in the Memory graph view, which is
     linked from this section. The counts update only when the
     graph key changes, and the key covers edge endpoints so a
     changed link cannot sit under a stale count. */
  function chatRenderGraph() {
    if (!chatData) return;
    const g = chatData.graph || {};
    const counts = g.counts || {};
    const badge = document.getElementById('chatLiveBadge');
    if (badge) badge.textContent = chatPollFailed ? 'paused' : 'live';
    const key = JSON.stringify((g.nodes || []).map((n) => n.node_id + '|' + (n.recorded_at || n.created_at || '') + '|' + (n.status || ''))) + '|' + JSON.stringify((g.edges || []).map((e) => (e.from || '') + '>' + (e.to || '') + '|' + (e.type || ''))) + '|' + (counts.memory || 0) + '|' + (counts.proposal || 0) + '|' + (chatPollFailed ? 'paused' : 'live');
    if (key === chatGraphKey) return;
    chatGraphKey = key;
    const countsEl = document.getElementById('chatGraphCounts');
    if (countsEl) {
      countsEl.textContent = `The memory holds ${counts.memory || 0} ${(counts.memory || 0) === 1 ? 'memory' : 'memories'} and ${counts.proposal || 0} ${(counts.proposal || 0) === 1 ? 'proposal' : 'proposals'}.`;
    }
  }
  async function chatPoll() {
    if (!document.getElementById('chatLayout') || !chatData) return;
    let data;
    try { data = await chatLoadData(); } catch {
      chatPollFailed = true;
      chatRenderFeed();
      chatRenderGraph();
      return;
    }
    const wasFailed = chatPollFailed;
    chatPollFailed = false;
    chatData = data;
    const fp = chatDataFingerprint(data);
    if (fp !== chatDataKey || wasFailed) {
      chatDataKey = fp;
      if (!chatPeers(data).some((p) => p.key === chatPeer)) chatPeer = 'workspace';
      chatRenderPeers();
      chatRenderHistory();
      chatRenderFeed();
      chatRefreshStrip();
    }
    chatRenderGraph();
  }
  async function viewChat() {
    if (chatPollTimer) { clearInterval(chatPollTimer); chatPollTimer = null; }
    skeleton(3);
    let data;
    try { data = await chatLoadData(); } catch (e) { return errorState('Chat', e, viewChat); }
    chatData = data;
    chatDataKey = chatDataFingerprint(data);
    chatGraphKey = '';
    if (!chatPeers(data).some((p) => p.key === chatPeer)) chatPeer = 'workspace';
    main.innerHTML = `
      ${head('Chat', 'Talk to the shared memory here. Ask a question and the answer shows where it came from. Give a fact and it is checked before it is remembered. The live engine panel shows the memory working as it happens.', 'Ask, and see the proof.')}
      <div class="chat-tabs" role="group" aria-label="Chat panels">
        <button class="btn small-btn" type="button" id="chatTabTalk" aria-pressed="true">Conversation</button>
        <button class="btn small-btn" type="button" id="chatTabEngine" aria-pressed="false">Live engine</button>
      </div>
      <div class="chat-layout" id="chatLayout" data-panel="talk">
        <section class="chat-peers-panel" aria-label="Chats">
          <h2 class="chat-panel-title">Chats</h2>
          <p class="small">One chat for each name that has stored, asked or decided something here.</p>
          <div class="chat-peers" id="chatPeers"></div>
        </section>
        <section class="chat-main-panel" aria-label="Conversation">
          <h2 class="chat-panel-title" id="chatConvTitle">Workspace</h2>
          <div id="chatHistory"></div>
          <div class="chat-log" id="chatLog" aria-live="polite"></div>
          <div class="chat-strip" id="chatStrip"></div>
          <form class="chat-composer" id="chatForm">
            <label class="f" for="chatInput">Your message</label>
            <div class="chat-composer-row">
              <input type="text" id="chatInput" placeholder="Ask a question, or start with remember and state a fact" autocomplete="off">
              <button class="btn primary" type="submit" id="chatSend">Send</button>
            </div>
          </form>
        </section>
        <aside class="chat-engine" aria-label="Live engine">
          <h2 class="chat-panel-title">Happening now</h2>
          <div id="chatFeed" aria-live="polite"></div>
          <h2 class="chat-panel-title chat-engine-graph-title">What the memory holds</h2>
          <p class="small"><span class="badge" id="chatLiveBadge">live</span></p>
          <p class="small" id="chatGraphCounts" style="margin-top:8px"></p>
          <p class="small"><a href="#/graph">See the full memory graph</a></p>
        </aside>
      </div>`;
    const layout = document.getElementById('chatLayout');
    const log = document.getElementById('chatLog');
    const input = document.getElementById('chatInput');
    const sendBtn = document.getElementById('chatSend');
    const tabTalk = document.getElementById('chatTabTalk');
    const tabEngine = document.getElementById('chatTabEngine');
    const setPanel = (panel) => {
      layout.dataset.panel = panel;
      tabTalk.setAttribute('aria-pressed', String(panel === 'talk'));
      tabEngine.setAttribute('aria-pressed', String(panel === 'engine'));
    };
    tabTalk.addEventListener('click', () => setPanel('talk'));
    tabEngine.addEventListener('click', () => setPanel('engine'));
    document.getElementById('chatPeers').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-chat-peer]');
      if (!b) return;
      chatPeer = b.dataset.chatPeer;
      chatRenderPeers();
      chatRenderHistory();
      if (chatPeer === 'workspace' && input) input.focus();
    });
    const append = (html) => {
      const welcome = log.querySelector('.chat-welcome');
      if (welcome) welcome.remove();
      log.insertAdjacentHTML('beforeend', html);
    };
    log.addEventListener('click', (ev) => {
      const t = ev.target.closest('[data-receipt-toggle]');
      if (t) {
        const body = t.parentElement.querySelector('.chat-receipt-body');
        const open = body && !body.hidden;
        if (body) body.hidden = open;
        t.textContent = open ? 'Show receipt' : 'Hide receipt';
        t.setAttribute('aria-expanded', String(!open));
      }
    });
    async function sendMessage(raw) {
      const text = (raw != null ? raw : input.value).trim();
      if (!text || chatBusy) return;
      input.value = '';
      const route = chatRouteText(text);
      const userEntry = { kind: 'user', text };
      chatEntries.push(userEntry);
      append(chatEntryHTML(userEntry));
      if (route.kind === 'none') {
        const note = { kind: 'note', title: '', lines: ['I can do two things here. Ask a question and I will answer from the shared memory, with the proof under the answer. Or give me a fact to remember. Start with the word remember and state the fact, and it will be checked before it is kept.'] };
        chatEntries.push(note);
        append(chatEntryHTML(note));
        input.focus();
        return;
      }
      chatBusy = true; sendBtn.disabled = true;
      const thinking = document.createElement('div');
      thinking.className = 'chat-msg';
      thinking.setAttribute('role', 'status');
      thinking.innerHTML = `<div class="chat-who">MemoryLoom</div><p>Thinking. ${route.kind === 'propose' ? 'Asking for a decision on this.' : 'Looking in the shared memory.'}</p>`;
      log.appendChild(thinking);
      try {
        let entry;
        if (route.kind === 'recall') {
          const r = await api('/api/recall?q=' + encodeURIComponent(route.text) + '&k=8');
          const results = r.results || [];
          const dropped = r.dropped || [];
          entry = (r.no_answer || !results.length)
            ? { kind: 'noanswer', results, dropped }
            : { kind: 'answer', first: results[0], more: results.slice(1), dropped };
        } else if (route.kind === 'propose') {
          const r = await api('/api/propose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ author: 'Chat user', type: 'semantic', text: route.text, grounding_ids: [] }) });
          entry = { kind: 'outcome', decision: r.decision, reason: r.reason, id: r.id || r.proposal_id || '' };
        } else {
          const rows = await api('/api/believed?at=' + encodeURIComponent(route.at));
          entry = { kind: 'believed', at: route.at, list: Array.isArray(rows) ? rows : rows.beliefs || [] };
        }
        thinking.remove();
        chatEntries.push(entry);
        append(chatEntryHTML(entry));
        if (route.kind === 'propose') { chatRefreshStrip(); chatPoll(); }
      } catch (err) {
        thinking.remove();
        const note = { kind: 'note', title: 'MemoryLoom cannot be reached', lines: ['The service cannot be reached right now. Your message has not been sent anywhere. Please try again in a little while.'] };
        chatEntries.push(note);
        append(chatEntryHTML(note));
      } finally {
        chatBusy = false; sendBtn.disabled = false;
        input.focus();
      }
    }
    document.getElementById('chatForm').addEventListener('submit', (ev) => { ev.preventDefault(); sendMessage(); });
    chatRenderPeers();
    chatRenderHistory();
    chatRenderFeed();
    chatRenderGraph();
    chatRefreshStrip();
    chatPollTimer = setInterval(chatPoll, 4000);
    input.focus();
  }

  /* The shell namespace label, read from the overview response. */
  let namespaceLabelDone = false;
  async function updateNamespaceLabel() {
    if (namespaceLabelDone) return;
    namespaceLabelDone = true;
    const el = document.getElementById('consoleNs');
    if (!el) return;
    try {
      const ov = await api('/api/overview');
      if (ov && ov.namespace) el.textContent = 'console \u00b7 ' + ov.namespace;
    } catch { /* the plain console label stays */ }
  }

  /* ---------------- Router ---------------- */
  const routes = { chat: viewChat, loop: viewLoop, recall: () => viewRecall(), graph: viewGraph, time: viewTime, providers: viewProviders, learning: viewLearning, settings: viewSettings };
  // Navigations are serialised (card S8). A view renders in
  // stages around its fetches, so two routes running at once
  // interleave: the slower earlier view can land its body after
  // the newer view has rendered, leaving the title and the nav
  // naming one view while the body shows another. One route runs
  // at a time; a navigation asked for during a route is kept and
  // run when the current one settles.
  let routeBusy = false;
  let routeQueued = false;
  async function route() {
    if (routeBusy) { routeQueued = true; return; }
    routeBusy = true;
    try { await routeOnce(); } finally {
      routeBusy = false;
      if (routeQueued) { routeQueued = false; route(); }
    }
  }
  async function routeOnce() {
    const name = (location.hash.replace('#/', '') || 'chat').split('?')[0];
    // Leaving the chat view stops its engine panel polling, and
    // the wide three part layout belongs to the chat view alone.
    if (chatPollTimer) { clearInterval(chatPollTimer); chatPollTimer = null; }
    if (main.classList) main.classList.toggle('chat-wide', name === 'chat');
    updateNamespaceLabel();
    const fn = routes[name] || viewChat;
    document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === name));
    await fn();
    // Focus moves to the destination view heading on navigation
    // (card S8, Section 6.3). Views that re-render themselves
    // after an action do not pass through here, so an action's
    // own focus rule is never overridden by this move.
    const title = main.querySelector('h1.view-title');
    if (title) title.focus({ preventScroll: true });
  }
  window.addEventListener('hashchange', () => {
    // Only view routes route. A fragment that names an element,
    // the skip link's #main above all, is the browser's own
    // business: answering it here would load the default view
    // over the current one and strand the reader (card S8).
    if (location.hash.startsWith('#/')) route();
  });
  route();
})();
