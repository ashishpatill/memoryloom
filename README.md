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
npm run db:init              # schema v1 + migrations 002–005
npm run mcp                  # stdio MCP server
```

## Checks

The checks run against a **synthetic, fictional corpus** — no real data
is ever used for testing.

```bash
npm run check:router   # provider router + local fallback (no database)
DATABASE_URL=postgres://… npm run check:surface    # all 10 tools, write gate, review flow
DATABASE_URL=postgres://… npm run check:roundtrip  # store → recall round trip
DATABASE_URL=postgres://… npm run check:recall -- "memoryloom-test" "hybrid recall fusion"
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
  Wonder Full 31/36, Wonder 33/36 (`docs/calibration-meta-core-reasoning.md`).
- **All enumerable decisions go through the Jev API** (TypeSafe,
  jev-1.13.0): write-gate accept/reject/escalate, consolidation
  accept, decay keep/drop, learning promotion. The gate calibration
  passed 40/40 with zero unsafe approvals on its golden set, so the
  thresholds are live; the gate **fails closed** — on any Jev backend
  failure a proposal queues for a human, and no fallback ever
  approves (`docs/calibration-jev-gate.md`, `checks/jev-gate.mjs` 15/15).
- Two-plane memory: Plane 1 is the append-only truth store with
  provenance; Plane 2 is the derived recall index, proven rebuildable
  from Plane 1. Every recall result dereferences to a Plane-1 record
  with a provenance receipt or is dropped with a reason. Deterministic
  decay and Jev-gated consolidation run against the synthetic corpus
  (`checks/two-plane.mjs` 22/22).
- Roundtrip and recall smoke checks pass against the synthetic corpus.

Honest limits of the above: these are small-scale local checks on a
small fictional corpus. They prove the surface, the routing, the
decision gate and the two-plane mechanics behave as designed; they do
not prove recall quality or latency at scale. Baseten is parked (its
grant key serves only Muse Spark Open, which MemoryLoom does not use;
its budget is untouched). Fireworks and Modal have no role in this
build. The console UI and the public demo are the next blocks.

## Roadmap

- Memory-layer depth: reranking, bi-temporal (as-of) recall at scale,
  the data-ingestion and continual-learning layer.
- Console: propose inbox, recall with receipts, provenance graph,
  as-of date slider for time travel, provider activity panel.
- Evals published with numbers: recall quality on a labelled set, an
  external long-memory eval as the spine, latency at demo scale.
