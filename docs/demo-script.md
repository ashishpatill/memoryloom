# Demo script, frozen for rehearsals

Frozen 2026-10-30 (Block 7). Three beats from the win sheet, about
three minutes of presenter time. Nothing in this script changes
during rehearsals. A change unfreezes it and restarts the rehearsal
count. The automated twin is checks/rehearse.mjs, which runs exactly
these beats against a fresh database and records timings and spend.

## Setup (before anyone is watching)

```bash
DATABASE_URL=postgres://… npm run db:init     # once, on a fresh database
DATABASE_URL=postgres://… npm run seed:web    # Project Lantern corpus + learning story + one daemon cycle
DATABASE_URL=postgres://… npm run web         # site at / · console at /console (port 4173)
```

Cache warm, once, about ten seconds. Run one narration before the
demo starts.

```bash
DATABASE_URL=postgres://… MEMORYLOOM_ROUTER_MODE=live npm run web &   # (already running)
DATABASE_URL=postgres://… MEMORYLOOM_ROUTER_MODE=live node scripts/narrate-demo.mjs
```

If that call answers from the live model, the demo's one paid moment
is warm. If it fails, the fallback below applies and the demo still
works.

## Beat 1, propose through the gate (about 70 seconds)

Console, Live loop view. In the propose form:

1. Author `grok`, type Semantic, text:
   "The Lantern demo rig runs firmware 2.4.1 on the bench unit."
   Grounding: `demo-g2`, `demo-g3`. Submit.
   Say. The gate checks the claim against its cited evidence, not
   against the proposer's confidence. The verdict appears, approved by
   the Jev decision layer, and the memory is now in the truth store.
2. Author `moose`, type Procedural, text:
   "To reset the Lantern demo rig, hold the side button for ten
   seconds." No grounding. Submit.
   Say. Procedures never auto approve, so this escalates. It lands in
   the review queue with its gate record attached.
3. Click Approve on the escalation. It is promoted, with the human
   decision recorded as provenance.

## Beat 2, fresh session recall with a receipt (about 50 seconds)

Console, Recall view. Query: "which firmware does the bench unit
run". The answer comes back with results, and every result carries a
receipt. The receipt shows who wrote it, from which session, and on what evidence.

Click the trail for the bench log record (demo-g2). Say. The receipt
is not a label we print. It dereferences to the actual record and its
provenance chain. A recalled memory that cannot dereference is
dropped before an agent ever sees it.

Narration moment, in a terminal beside the console:

```bash
DATABASE_URL=postgres://… MEMORYLOOM_ROUTER_MODE=live node scripts/narrate-demo.mjs
```

The router narrates the same recall in words, with the same receipts,
and the Providers view shows the call.

## Beat 3, time travel, learning, providers (about 60 seconds)

1. Console, Time travel view. As of 12 Oct 2026, the team believed
   the demo would be held in Hall A. Move to 25 Oct 2026, Hall B.
   Say. The old belief was not deleted. It was superseded, and both
   states of the world stay readable.
2. Console, Learning view. The before and after strip for the
   lodge-global-claim task. Grok's uncited claim escalated, the
   corrected claim with two citations approved, the lesson promoted
   through the same gate, and moose's next claim of the same kind
   approved first try after recalling the lesson by receipt.
3. Console, Providers view. Close on the panel, which shows which provider did
   what work on which memory, and what it cost. Only providers that
   actually did work appear.

Closing line. One shared brain, every belief carrying its evidence,
and a team that gets measurably better at using it.

## Fallback plan (if a live call fails during the demo)

- Narration fails live. Rerun scripts/narrate-demo.mjs without
  MEMORYLOOM_ROUTER_MODE. The local narrator answers with the same
  receipts. The story ("receipts or it did not happen") is unchanged.
- The Jev gate is unreachable. Proposals queue as escalations by
  design (fail closed). Approve the queued item as a human in Beat 1
  step 3. The gate record shows why. Nothing can be approved by a
  failure.
- The web app is down. The same store answers over MCP stdio
  (npm run mcp). Recall and propose work from any MCP client.
- Everything is down. The rehearsal records in checks/out/
  (rehearsal-1.json to rehearsal-3.json) show the full run with real
  timings and spend, and the seeded database serves again in seconds
  with the setup commands above.

## Rehearsal record

Filled in by the Block 7 rehearsals (checks/rehearse.mjs, fresh
database per run). Presenter pacing above is the script. The numbers
below are machine time for the same beats.

| Run | Beats | Machine time (beats) | Spend delta |
| --- | --- | --- | --- |
| 1 | 8/8 | 9,871 ms (narration live call: 8,795 ms of it) | $0.0034 (1 paid call) |
| 2 | 8/8 | 1,469 ms | $0 (narration from router cache) |
| 3 | 8/8 | 1,662 ms | $0 (narration from router cache) |

Setup per run (init + seed on a fresh database) takes about 3.4 seconds.
Runs 2 and 3 are the cache warm pattern working as designed. The
first run pays for the narration once, later runs serve the identical
prompt and input from the content hash cache. Detail per run:
checks/out/rehearsal-1.json to rehearsal-3.json.
