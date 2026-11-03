# Architecture

MemoryLoom is built in three layers. A layer is one part of the system with its own job, kept separate from the others. The layers may only talk to each other in two named ways, set out below. A check, an automated test that looks at the code and fails if a rule is broken, at `checks/architecture.mjs` enforces this on every verification run, every time the full set of checks is run before work is accepted, so the structure cannot quietly rot.

## 1. Frontend, `web/`

The frontend is the part people see. It renders, draws on screen, the site and the console, the operator control screen, and it calls the backend HTTP APIs. An HTTP API is a named web address the backend answers, where one part of a system asks another for something and gets a reply. The frontend never imports router or provider code. An import is when one piece of code pulls another in to run it directly. A provider is a company that runs a model, a program that reads and writes language, for us. The frontend never holds a provider key, the secret password that proves we may use a provider, and never decides anything.

| Owns | What that means |
| --- | --- |
| Site and console | The pages and screens, and how they look |
| Calls to the backend | Asking the backend web addresses for data and actions, and showing the replies |

One honest wrinkle is that two server files, `web/api.mjs` and `web/server.mjs`, live under `web/` but are not browser code, code that runs in a person web browser. They are the backend HTTP layer, the part that answers those web addresses, housed here. The browser code is `web/public/`.

## 2. Backend, `lib/`, `mcp/`, `schema/`, `api/`

The backend is the part that holds memory truth, what MemoryLoom actually believes and remembers. It owns two planes. Plane 1 is the truth itself. Its records carry who proposed them and the cited evidence they rest on, and valid from and valid to dates that say when each record held. Plane 2 is the recall index state, held in the same memories table as the embedding and index status fields. An embedding is a list of numbers that captures what a text means, so similar texts sit near each other. The rebuild function wipes that index state and regenerates it from Plane 1, and that rebuild is routine operation, not an emergency path. Only the learning events table is append only, which means rows are added and never changed, and a database trigger from migration 007 enforces that. There are no L0 to L3 layers anywhere in this design.

| Owns | What that means |
| --- | --- |
| The two planes | The truth records themselves, and the recall index state that is rebuilt from them |
| The write gate | The single path that decides what becomes truth, and nothing becomes truth any other way |
| Storage and migrations | Keeping the data, and migrations, planned changes that move stored data from an old shape to a new one |
| The MCP surface | MCP is a shared rulebook for connecting outside programs, and this is the surface other agents, programs acting on behalf of someone, connect through |
| Settings and configuration service | The service that holds settings, including provider keys |

When the backend needs model work, work done by a language model, such as judging or summarising, it asks the AI layer, the third layer below, through the router interface, one doorway. An interface is the fixed set of requests one part may make of another. The router is the part that chooses which model does a piece of work. The backend asks the AI layer for model work through the router interface, with three named exceptions listed later in this document.

## 3. AI layer, `router/`

The AI layer owns all contact with providers. Its centre is the tiered cascade, a chain of models ordered from cheapest to strongest, where work starts low and moves up, escalation, only when a lower tier is not good enough. An enumerable decision is a decision whose possible answers can be listed in advance.

| Tier | Model | Used for |
| --- | --- | --- |
| Tier 0 | Muse Spark Open, hosted on Baseten (a service that runs models for others) | Operations volume, the large amount of everyday work. The tier is calibrated and ready. Card S10 of the frozen master plan wires it into the product paths, so today it does measured work on test sets only |
| Decision | Jev | Every enumerable decision |
| Escalation | Wonder medium | Work a lower tier could not settle |
| Most critical | Wonder Full | The most critical work |

| Also owns | What that means |
| --- | --- |
| Calibration | Checking whether a model stated confidence, how sure it says it is, matches how often it is actually right |
| Spend log | The record of what each model call cost |
| Content hash cache | Saved answers, reused when the exact same content comes again, and a content hash is a fingerprint computed from the content itself |
| Provider configuration | Which providers are used, and how each is set up |

Providers can be swapped, exchanged for another provider, inside this layer without touching the backend or frontend.

## The two allowed crossings

A crossing is one layer reaching into another. Only these two are allowed.

| Crossing | How | Rule |
| --- | --- | --- |
| Frontend → backend | HTTP APIs | The frontend asks only through the backend named web addresses |
| Backend → AI layer | The router interface, `router/router.mjs` | The backend asks only through this one doorway |

The shared spend ledger, `router/spend.mjs`, is data, not a crossing. A ledger is a shared record book. It calls no provider and holds no key. Three named files import named functions from it, one list per file, and the architecture check holds each list to exactly the functions that file imports today. A file that is not named there may not import the ledger at all.

## Named exceptions

An exception is a known place where the code crosses a boundary outside the two allowed ways. These are debt, known untidiness carried knowingly, and each is owned, so someone is responsible for its fix.

| File | What it does | Why it exists | Owner and review |
| --- | --- | --- | --- |
| `lib/jev.mjs` | The Jev decision client, the code that asks Jev for a decision, calls the decision provider directly | The decision layer predates, was built before, the router interface | Project owner. Card S3b renewed this entry with a dated retirement task, move the client behind the router interface or renew the entry again with fresh evidence. Review by 2026-12-15 |
| `lib/decisions.mjs` | The decision backend challenger adapters call the Baseten decision endpoint directly. An adapter is a small piece of code that lets one part connect to another. A challenger is a contender being tested against the current choice. An endpoint is the specific web address a provider answers. They are spend logged, their cost is written to the spend log, and probe gated, allowed to run only after a small test call, a probe, passes | The challengers must reach the decision endpoint to be tested fairly | Project owner. Card S3b renewed this entry with a dated retirement task, move the decision backends behind the router interface with the decisions path or renew the entry again with fresh evidence. Review by 2026-12-15 |
| `lib/config.mjs` | The configuration service test probe makes one harmless models list read per provider, a request that only asks which models a provider offers, so the Settings screen can test a key | The configuration service is the sanctioned, officially approved, owner of reachability tests, checks that a provider can be reached at all. It never returns a key or a provider body, the provider raw reply | Project owner. No relocation planned, because the exception is the design. Renewed by card S3b. Review by 2026-12-15 |
| `web/api.mjs` | Reads the spend log and router configuration to render the providers view, the screen showing provider status | Rendering that screen needs that data. It holds no key and calls no provider | Project owner. A read of data, named here so the boundary stays explicit. Renewed by card S3b. Review by 2026-12-15 |

## Adding a new crossing

A new crossing is not forbidden forever. It must be named in `checks/architecture.mjs`, with a reason, an owner, an owning iteration and a review date, before it lands. The check also fails on stale exceptions, exceptions listed there that no longer exist in the code, and on an entry whose review date has passed, so this list stays true.
