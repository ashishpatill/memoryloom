# MemoryLoom

**One shared, auditable memory brain for a team of AI agents.**

Agents that work together forget together. Each session starts cold, each
agent keeps its own notes, and nobody can say afterwards *why* the team
believed something. MemoryLoom is the shared memory layer those agents are
missing: one store every agent writes to through a review gate, one recall
path that always shows its evidence, and a history that can answer
"what did the team believe on this date?"

## The live loop

```
agent ──propose──▶ write gate ──approve──▶ truth store ──▶ recall index
                      │                                    │
                      └── escalate ──▶ human review        └── recall + receipt ──▶ agent
```

1. An agent **proposes** a memory. It never writes directly.
2. The **write gate** scores the proposal with a fixed choice —
   approve, reject, or escalate. Escalate always exists, and every
   score is kept as provenance.
3. Approved memories land in the **truth store** (append-only records
   with who proposed them, the cited evidence, and timestamps).
4. The **recall index** is derived from truth and can be rebuilt from
   it at any time. Rebuilding is routine, not an incident.
5. **Recall returns receipts.** Every recalled item dereferences to a
   truth record with its evidence, or it is dropped before the agent
   sees it. Recall proposes; truth disposes.

## What is inside

**Two-plane memory.** Plane 1 is truth: append-only records with
provenance and bi-temporal validity (valid-from / valid-to, so superseded
facts stay readable and time-travel recall works). Plane 2 is the recall
index: layered from raw episodes (L0) to atomic facts (L1), scenario
summaries (L2) and a team profile (L3), and fully rebuildable from Plane 1.

**Hybrid recall.** A keyword leg and a dense vector leg are fused with
reciprocal-rank fusion (k=60), then reranked. Recall reports its own
state honestly — `cold_start`, `thin`, or `ok` — and never invents
memories to fill a gap.

**A calibrated write gate.** Proposal classes carry fixed routing:
episodic and node-local memories auto-approve; procedural and pinned
memories always go to a human; a global claim needs at least two cited
grounding records to auto-approve, and is otherwise queued for review.

**Forgetting is a feature.** Stale memories decay deterministically,
duplicates consolidate into single entries, and nothing in the background
ever writes itself into truth — background learning stays proposal-only.

**A provider router.** Model work (consolidation, gate scoring, triage,
recall narration) goes through one router that logs which provider
handled every call, with a fallback order so a dead credit never stops
the demo. Planned roles: a core reasoner for consolidation and
narration, a high-throughput path for triage at volume, elastic batch
compute for decay and consolidation sweeps, and a low-latency path for
gate scoring and reranking.

## MCP tool surface

MemoryLoom speaks the Model Context Protocol over stdio, so any agent
harness that can run an MCP server can use it.

| Tool | What it does |
| --- | --- |
| `store` | Store a memory with provenance (staged, then indexed) |
| `recall` | Hybrid RRF recall with a cold-start contract and receipts |
| `list_namespaces` | List namespaces with live memory counts |
| `get` | Fetch one memory by id, full record incl. provenance |
| `ingest_file` | File-drop ingestion: a document becomes chunked memories |
| `propose` | Propose a memory through the write gate |
| `review_list` | List proposals waiting for a decision |
| `promote` | Approve a proposal into the truth store |
| `reject_proposal` | Reject a proposal |
| `review_decide` | One decision call for proposals and review items |

## Run it

You need Node 22+ and a Postgres 16 database with the pgvector extension.

```bash
cp .env.example .env.local   # set DATABASE_URL
npm install
npm run db:init              # apply the schema and its migrations
npm run mcp                  # stdio MCP server
```

## Provider keys — Settings

MemoryLoom runs locally with no provider keys at all: the demo
corpus, recall, the graph and time travel all work on this machine.
Hosted providers are configured the standard way, inside the app:

1. Run the app and open the console (see *Site + console* below).
2. Open **Settings**.
3. Paste your own keys, one per provider, and use **Test
   connection** to check each one before you rely on it:
   - **Meta Model API** — a key from dev.meta.ai. Unlocks live
     model calls: consolidation, narration and explanation on
     `muse-wonder-1.0`.
   - **Jev (TypeSafe)** — a TypeSafe API key. Unlocks the decision
     gate: every approve / reject / escalate verdict.
   - **Baseten** — a key from the Baseten workspace settings. The
     key is stored and can be tested here; the Baseten lane itself
     is currently parked (see *Status*), so no product path calls
     it yet.

**Security note.** Keys pasted into Settings are stored in
`.env.local` in the app folder, on your own machine only, with
file permissions 0600. They are never committed (`.env.local` is
git-ignored), never shown back in full (Settings displays only
the last four characters), and never written to any log. If you
prefer, set a key's environment variable instead
(`META_MODEL_API_KEY`, `BASETEN_API_KEY`, `TYPESAFE_API_KEY`) —
an environment variable wins over the value in Settings. Settings
can only be changed from the local app; a hosted deployment
cannot change them.

## Site + console

One web app serves the product site (the front door) and the console
(the product). Both render from the same store the agents use — the
console displays decisions; it never makes or overrides one.

```bash
DATABASE_URL=postgres://… npm run seed:web   # Project Lantern corpus + learning story + one daemon cycle
DATABASE_URL=postgres://… npm run web        # site at / · console at /console
```

The console has seven views, each designed in three states (loading,
empty, populated):

- **Live loop** — the propose inbox with the gate's verdicts and
  scores, human approve/reject for escalations, and a propose form
  that runs through the real gate.
- **Recall + receipts** — every result dereferences to its truth
  record; dropped results show why they were dropped.
- **Memory graph** — provenance trails, supersession chains and agent
  neighbourhoods, drawn from the live records.
- **Time travel** — an as-of date control answering "what did the
  team believe on this date?" from the bi-temporal data.
- **Providers** — per-memory and aggregate record of which provider
  did what work, with router spend totals. Only providers that
  actually did work appear.
- **Learning** — the learning-event stream, standing playbook lessons
  with their promotion provenance, and the before/after evidence.
- **Settings** — one section per provider (Meta Model API, Baseten,
  Jev): paste a key, test the connection, or remove the key. Only
  the masked tail of a saved key is ever shown.

Deploying: `vercel.json` + `api/index.mjs` make the repo a one-step
Vercel import — set `DATABASE_URL` (and optionally `WEB_NAMESPACE`)
in the project environment to a Postgres 16 + pgvector database
seeded with `npm run seed:web`; the build command is
`npm run build:web`, a verification pass over the web sources.

Console captures (placeholders — replace with real captures from a
running instance; nothing here is a fabricated visual):

- `[capture: site home — the living graph hero over the demo corpus]`
- `[capture: console live loop — an escalation waiting, with its gate record]`
- `[capture: console recall — a receipt under the firmware answer]`
- `[capture: console time travel — beliefs on 12 Oct vs 25 Oct]`

## Checks

The checks run against a **synthetic, fictional corpus** — no real data
is ever used for testing.

```bash
npm run check:router   # provider router + local fallback (no database)
DATABASE_URL=postgres://… npm run check:surface    # all 10 tools, write gate, review flow
DATABASE_URL=postgres://… npm run check:roundtrip  # store → recall round trip
DATABASE_URL=postgres://… npm run check:recall -- "memoryloom-test" "hybrid recall fusion"
DATABASE_URL=postgres://… npm run check:web       # site + console API, live gate flow, empty states
npm run build:web                                  # production build verification for the web app
DATABASE_URL=postgres://… node checks/eval-longmem.mjs   # LongMemEval-style recall eval (measurement, not a gate)
DATABASE_URL=postgres://… npm run rehearse -- 1          # frozen demo script, automated twin (fresh DB per run)
```

## Status — 30 Oct 2026

Working and verified locally:

- Schema v1 + migrations 002–005 apply cleanly to a fresh database.
- All 10 MCP tools pass the surface check (34/34 assertions), including
  hybrid recall where a paraphrase query hits through the vector leg
  with no keyword overlap, the full propose → review → promote/reject
  flow, and cold-start behaviour on an empty namespace.
- The provider router is **live on the Meta Model API**: the only Meta
  model used is `muse-wonder-1.0`, in two pinned tiers — Wonder Full
  (high effort: consolidation writing, contradiction explanation,
  recall narration, eval judging) and Wonder (medium effort:
  implementation passes, bulk triage). Every paid call goes through
  the router with a spend log, a content-hash cache and an 80%
  stop-loss per budget class. Router smoke check: 11/11.
- Core-reasoning calibration on a 36-item synthetic golden set:
  Wonder Full 36/36, Wonder 36/36 after the Block 7 prompt hardening
  (was 31/36 and 33/36; the failures were dropped receipt citations
  in narration and paraphrased conflicts in explanations — prompts
  tightened, and a cache bug that hid prompt edits was found and
  fixed). Records: `docs/calibration-meta-core-reasoning.md`,
  `docs/prompt-hardening-block7.md`.
- **All enumerable decisions go through the Jev API** (TypeSafe,
  jev-1.13.0): write-gate accept/reject/escalate, consolidation
  accept, decay keep/drop, learning promotion. The gate calibration
  passed 40/40 with zero unsafe approvals on its golden set, so the
  thresholds are live; the gate **fails closed** — on any Jev backend
  failure a proposal queues for a human, and no fallback ever
  approves (`docs/calibration-jev-gate.md`, `checks/jev-gate.mjs` 15/15).
  The decision backend is swappable per class in router config
  (default Jev everywhere); Baseten's decision models are built
  as challenger adapters, deferred while the probe record stands.
  A challenger may replace Jev only by beating it on every
  benchmark leg and on price.
- Two-plane memory: Plane 1 is the append-only truth store with
  provenance; Plane 2 is the derived recall index, proven rebuildable
  from Plane 1. Every recall result dereferences to a Plane-1 record
  with a provenance receipt or is dropped with a reason. Deterministic
  decay and Jev-gated consolidation run against the synthetic corpus
  (`checks/two-plane.mjs` 22/22).
- A memory graph derived from Plane 1 (memories, agents, sources,
  decisions, supersession and contradiction links) powers the console
  queries: provenance trail for any memory, an agent's neighbourhood,
  supersession chains, and bi-temporal "what did the team believe on
  this date?" An event-triggered daemon watches the store and emits
  proposals only — consolidation candidates, decay candidates,
  contradiction flags — into the review queue; it never writes truth,
  its apply path routes through the Jev-gated library functions, and
  its cycles are watermark-resumable with a run log. The synthetic
  demo corpus wires two demo agents, grok and moose, as named
  graph agents (`checks/graph-daemon.mjs` 44/44).
- A continual learning layer: every interaction — proposals, gate
  verdicts, human approvals, rejections and corrections, recall hits
  and misses, eval outcomes — is captured as an append-only,
  provenance-stamped learning event (trigger-enforced; events are
  never edited or deleted). Learning events become standing playbook
  lessons only through the Jev promotion gate; a direct write is
  refused and a forged lesson is quarantined by audit. Lessons are
  memories, so decay and recall treat them like everything else.
  In-turn correction stores a verbal reflection with its trigger
  evidence and returns the corrected directive for the same turn.
  The research patterns are verified and recorded in
  `docs/learning-research.md` (Harness², ACE, Reflexion, Voyager).
  `checks/learning.mjs` 36/36, and `checks/learning-demo.mjs` shows
  the same task class before vs after a promoted lesson — escalated
  with no citations, approved first try by a second agent after
  recalling the lesson by receipt (8/8).
- Roundtrip and recall smoke checks pass against the synthetic corpus.
- A LongMemEval-style recall evaluation (Block 7): a 120-memory
  synthetic haystack (Project Kestrel, six dated sessions) with 42
  questions in the five LongMemEval families, scored deterministically
  (needle rank, answer terms in the recalled text, believed-at set
  membership, near-miss absence; no model judge). Results:
  recall@1 0.586, recall@5 0.931, recall@10 1.000; single-session
  8/8, multi-session 8/8, temporal 8/8, knowledge-update 6/10,
  abstention 3/8. The two weak spots are measured, not hidden:
  recall ranking has no recency preference, so on four of eight
  current-value questions the superseded record outranked its
  replacement by one place (the believed-at path answers those
  correctly as-of a date); and the vector leg returns nearest
  neighbours for unanswerable questions, so near-miss records land in
  the top-10 — abstention lives in the receipt and narration layer,
  which this eval does not score (`docs/eval-longmem.md`).
- The demo is packaged and rehearsed (Block 7): `docs/demo-script.md`
  freezes the three beats with the exact seeded data and a fallback
  plan; its automated twin ran three full rehearsals on fresh
  databases, 8/8 beats each. Total rehearsal spend was $0.0034 (one
  live narration call in run 1; runs 2–3 served the identical prompt
  from the router cache, as the fallback plan intends).
- Final clean-room pass (Block 7): every check suite re-run on fresh
  databases — surface 34/34, router 11/11, Jev gate 15/15, two-plane
  22/22, graph + daemon 44/44, learning 36/36, learning demo 8/8,
  web 29/29 — and the documented run path (db:init, seed:web, web,
  MCP over stdio) verified from a clean shell.
- Spend, cumulative in the router log: Meta $0.3749 of the $150
  credit (calibration $0.3595 of $22.50, evals $0 of $52.50 — the
  recall eval is fully deterministic — demo and final runs $0.0153
  of $60, reserve untouched). Jev decisions $0.0012. Baseten,
  Fireworks and Modal: $0.

Honest limits of the above: these are small-scale local checks on a
small fictional corpus. They prove the surface, the routing, the
decision gate and the two-plane mechanics behave as designed; the
recall eval is a first measurement at small scale (its own doc states
the caveats), not evidence of recall quality or latency at scale. **Baseten is closed**:
the ordered probe (2026-10-30) proved the grant key refuses all
non-Spark inference (HTTP 403 on DeepSeek, GLM and Kimi alike), so
the DeepSeek triage lane was not built, the challenger runs are
deferred with Jev standing alone, and the Baseten budget is
untouched (`docs/baseten-probe-and-challengers.md`). Fireworks and
Modal have no role in this build.
- The console UI and product site are built (Block 6): one buildless
  Node web app (`web/`) serving an animated product site whose hero
  graph renders live from the seeded demo corpus, and the seven-view
  console described above. The site's scroll story — problem, live
  loop, two planes, forgetting and time travel, the learning layer,
  checked numbers — is diagram-led, and every figure is captioned
  with what it proves and what it does not prove. The web check
  (`checks/web.mjs`, 29 assertions) exercises the whole API on a
  fresh database, including a live propose through the gate, a human
  decision, recall receipts, both sides of the Hall A → Hall B
  supersession, and the API-level empty states. Deployment is
  prepared (`vercel.json`, `api/index.mjs`) but not performed: no
  Vercel CLI auth exists on the build machine.

## Roadmap

- Memory-layer depth: reranking and bi-temporal (as-of) recall at
  scale. Two measured weak spots from the recall eval come first: a
  recency-aware tie-break for near-identical supersession pairs, and
  abstention handling in the narration layer for unanswerable
  questions.
- Deploy the site + console to Vercel against a hosted demo database,
  and replace the capture placeholders with real screenshots.
- Grow the eval: more questions per family, larger haystacks, and
  latency numbers at demo scale.
