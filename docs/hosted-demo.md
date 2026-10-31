# Hosted demo — database and deployment checklist

Everything a hosted preview needs, prepared 2026-10-31. The only step
left is the owner's Vercel import (below).

## The demo database (already created and seeded)

- Provider: Neon. Project name: `memoryloom-demo`
  (project id `silent-hill-95614771`, region aws-us-east-1, Postgres 16).
- Branch: `main` (`br-little-heart-b8n1dbhp`). Database:
  `memoryloom_demo`, owner role `neondb_owner`.
- Contents, verified by row inspection on 2026-10-31: 14 memories,
  12 learning events, 2 proposals, 3 review items, 1 daemon run —
  all in the single namespace `memoryloom-demo`, all 14 memories
  embedded. Every text is the fictional Project Lantern demo corpus.
  No other corpus exists in this project; it shares nothing with any
  working store.
- The connection string is NOT in this repo. Fetch it from the Neon
  console (project `memoryloom-demo` → database `memoryloom_demo` →
  Connection Details) or with the Neon MCP `get_connection_string`
  tool. It goes into exactly one place: the deployment's
  `DATABASE_URL` environment variable.

### How it was seeded (2026-10-31)

The build machine used for the close-out has no direct database
egress, so the seed ran in two legs; the result is identical to the
direct path:

1. Locally: a throwaway Postgres was initialised and seeded with the
   product's own commands (stub provider endpoints, dummy keys — the
   corpus and gate story are the product's own fixtures):
   `DATABASE_URL=<local> npm run db:init` then
   `DATABASE_URL=<local> npm run seed:web`
   → 13 corpus records, promotion recorded, 12 learning events.
2. The schema files (`schema/v1.sql`, then
   `schema/migrations/002`–`007`, in the order `scripts/init-db.mjs`
   applies them) and a data-only dump (`pg_dump --data-only
   --column-inserts --exclude-table=sync_log`; `sync_log` is
   trigger-generated and regenerates on insert) were applied to the
   Neon database through Neon's MCP SQL tools, then verified by the
   row inspection quoted above.

### Re-seeding from any ordinary machine (direct path)

```bash
# DATABASE_URL = the Neon memoryloom_demo connection string
DATABASE_URL=<neon-url> npm run db:init     # schema, in order
DATABASE_URL=<neon-url> npm run seed:web    # corpus + recorded story
```

`seed:web` refuses to run against a namespace that already holds
records, so a re-seed starts from an empty database: delete the
`memoryloom_demo` database in the Neon console and recreate it (same
name), then run the two commands. With no provider keys configured,
the seed still records the corpus; the learning story records its
degraded form and says so (see the seed's NOTICE output) — the full
12-event story needs a Jev key visible to the seed process, exactly
as `docs/demo-script.md` describes for rehearsals.

## Vercel import — the owner's five minutes

1. Vercel → Add New → Project → import this repository.
   Framework preset: **Other** (the repo carries `vercel.json`:
   `api/index.mjs` is the function, `web/public` is the static root).
2. Environment variables — set exactly one for the preview:
   - `DATABASE_URL` = the Neon `memoryloom_demo` connection string.
   Nothing else is required. In particular, **no provider keys go
   into the deployment**: hosted, the console reads configuration
   from the environment only, and the demo is designed to run
   keyless — corpus, recall with receipts, graph and time travel
   all read from the seeded store, and any new proposal fails
   closed (queued for a human, never stored) because no decision
   backend is configured. Adding live provider keys to the hosted
   environment is a separate, deliberate step (Iteration 3.2 in the
   close-out plan) and has not been done.
3. Deploy. The preview serves the landing page at `/` and the
   console at `/console`, reading the seeded demo store.
4. Smoke-check on the preview URL: landing shows 14 records in the
   hero figure; console Recall answers the firmware question with a
   receipt; Time travel separates 12 Oct from 25 Oct.

## What is deliberately NOT set up

- No custom domain, no production promotion — a preview is the demo
  surface for judging.
- No provider keys in any hosted environment (above).
- The Neon project is a throwaway demo project: it can be deleted
  after judging without touching any working store.
