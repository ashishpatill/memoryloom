# Design tokens v2, the MemoryLoom surface system

Status: adopted at Iteration 5.0. `web/public/tokens.css` is the
source of truth. `web/public/style-tile.html` is its reference render
(open `/style-tile.html` on the running app). The landing page adopts
the tokens in Iteration 5.1 and the console in 5.2. As of 5.2 every
product page is on the tokens and no page links
`web/public/styles.css` (v1) any more. The file remains in the tree
as the v1 record, styling nothing. This note
records the decisions so the migrations are mechanical, not taste
calls made twice.

## The law the tokens implement

- Monotone: ink near black on warm paper, hairline rules, one
  restrained accent used sparingly. No neon, no vibrant colour, no
  decorative gradients, no glass effects, no shadows.
- Typography carries the design. A display face for headlines, a
  text face for body, a mono face for data and numbers. A receipt
  is a record and is set in the text face. Generous line height.
  Nothing crammed.
- Motion is sophisticated or absent. It is slow, small and purposeful.
  Reduced motion is respected.
- Shapes are simple and confident. Numbered sections like an
  engineering document, ruled tables, diagrams that explain.
- Copy in plain words. No claim the product does not actually do.

## Palette

| Token | Value | Job |
| --- | --- | --- |
| `--paper` | `#F7F3EB` | Page ground, warm paper |
| `--paper-sunken` | `#EFE9DA` | Recessed ground, receipts, code |
| `--surface` | `#FDFBF6` | Raised ground, cards, diagram frames |
| `--ink` | `#1D1A15` | Text and full strength rules |
| `--ink-2` | `#5F584A` | Secondary text (AA on paper) |
| `--ink-3` | `#8A8171` | Faint marks only, never body text |
| `--line` | `#DAD1BB` | Hairline rule |
| `--line-strong` | `#A99B7D` | Rule that must be seen at a glance |
| `--accent` | `#A63D2A` | The one accent (see below) |

The accent is a muted rust. Its meaning is fixed. **A memory moved,
or a decision is live.** It appears at most once in any view, the
playhead on the graph, the gate in a diagram, the single figure
that carries a section. It never fills large areas, never colours
body text or headings, and is never one of a pair.

What v2 removed from v1, and why.

- The second and third hues (a pine green used for one demo agent
  and for "ok", an ochre used for "warn" and supersession) are
  gone from the token set. Three hues read as a palette. The law
  allows one accent. Standing is now carried by word, marker shape
  and weight (see Badges), and agents in the graph are told apart
  by label, thread position and the pair of the accent thread against
  the ink thread. The 5.2 graph migration applies this.
- Status colours (`--ok`, `--bad`, `--warn` as hues) are deleted.
  A verdict is a word (`approved`, `rejected`,
  `escalated · awaiting a human`) plus a marker, in ink.
- The woven texture with crossed hatching on figure frames (two tinted
  repeating gradients in v1) is deleted. A diagram frame is a
  hairline box with a mono header and an honest caption.
- The skeleton loading shimmer (an animated gradient sweep) is
  replaced in the console migration by a still ruled block. v2
  defines no gradient of any kind.

## Type

Three faces hosted by the project itself, all SIL Open Font License 1.1, served from
`web/public/fonts/` with their licence texts beside them. No paid
licence, no network fetch at build time or at runtime. Total 254 KB.

| Role | Face | Why this one |
| --- | --- | --- |
| Display | **Newsreader** (variable, 400–700 + italic) | A serif drawn for long reading at text and display sizes, with optical sizing and a true italic. It gives headlines the character of a bookish engineering journal without theatrics from a display face. Fallbacks: Iowan Old Style, Georgia. |
| Text | **Source Sans 3** (variable, 400–700) | A quiet humanist sans that stays legible at 14–17px in dense console views and does not compete with the serif. Fallback: the system sans stack. |
| Mono | **IBM Plex Mono** (400, 500) | Drawn for technical documents. Its letterforms make identifiers and scores read as records, not code decoration. Fallbacks: ui-monospace, SF Mono, Menlo. |

Keeping the v1 stacks as they were was rejected. The display face resolved
to a different serif on every operating system, so the "system" was
an accident per platform. Fraunces was considered for display and
rejected as too characterful. Inter was considered for text and rejected as the
unconsidered default of product pages. System stacks remain only
as named fallbacks behind the faces hosted by the project itself.

Scale (in `tokens.css`). Body 17px at 1.6 line height. Lede 20px.
Section titles 36px. Hero 52px. Card titles 26px. Captions and
detail 14px. Mono labels 12px, uppercase, 0.12em tracking. Receipt
part labels are set in the text face at 11px with a 14px line
height, and receipt part values in the text face at 14px with a
20px line height. Body copy never runs wider than 68 characters.

## Space, rules, shape

- Spacing is a 4px scale from 4 to 96px (`--space-1` … `--space-9`).
  Sections breathe at 64px. Cards pad at 16/24px.
- Structure is drawn with rules, not shadows. A 1px hairline
  (`--line`), a stronger 1px rule (`--line-strong`), and a 2px ink
  rule that opens sections and closes the page. `--shadow` does
  not exist.
- One radius, 4px, everywhere. V1's pill buttons and 10px cards
  read as consumer software. The rectangular button and the ruled
  card read as an instrument. The migrations adopt this.

## Motion

Three durations only. 120ms (hover/focus feedback), 240ms (state
change), 600ms (a reveal that happens once), one easing curve.
Motion is a status channel. The graph playhead sweeps the real
corpus timeline. A reveal marks content arriving. Nothing loops
for decoration, nothing autoplays. `prefers-reduced-motion`
disables transitions and reveals in the tokens themselves, and
animated figures must offer pause and a settled end state.

## Component inventory

All defined in `tokens.css`, all rendered once on the style tile:

- **Nav**, wordmark left (serif, second word in secondary ink),
  plain links right with hairline underlines, closed by a 2px ink
  rule. The console nav keeps its sidebar shape and adopts the
  same wordmark, type and rule weights in 5.2.
- **Hero**, one headline, one lede paragraph, one row of buttons.
  The figure (live graph) follows the claim. It is never the
  background of the claim.
- **Section header**, numbered in mono (`01, Memory`), title in
  display serif, one standfirst paragraph in secondary ink, the
  whole head opened by the 2px ink rule.
- **Ruled table**, hairline row rules, mono uppercase header in
  secondary ink, mono numerals, no zebra fill, no outer box except
  the card it may sit in. Inside `.table-wrap` it scrolls sideways
  on a narrow screen rather than widening the page (found by the
  5.0 tile's 360px capture, fixed in the tokens, not the page).
- **Diagram frame**, border with a strong hairline, mono figure head
  (`Fig. 1, …`), the diagram in ink with the accent at most once,
  and a caption that states what the figure proves and what it
  does not prove.
- **Receipt card**, a small readable record in the text face on
  the sunken ground, hairline border. Seven labelled parts, one
  fact per part, named Record, Written by, How it arrived,
  Recorded, Valid from, Valid to and Rests on. Part labels in the
  text face at 11px with a 14px line height, part values in the
  text face at 14px with a 20px line height. A record that rests
  on nothing shows the words No grounding record in its Rests on
  part, with no link. The near miss form carries the same seven
  parts without the card border and without the sunken ground.
- **Badges**, word plus marker shape in ink on the surface
  ground. ● approved, ○ pending, ◐ escalated, ✕ rejected,
  ◌ superseded.
- **Buttons**, primary is filled ink. Secondary is an ink
  hairline. Disabled fades. Hover deepens the ground one step.
  Nothing turns colour. Focus is a 2px ink outline.
- **Footer**, a sentence or two in secondary ink over the 2px
  ink rule. It states where data lives, the safety posture, the licence.
  Not a sitemap.

## Migration notes for 5.1 and 5.2

- `styles.css` keeps v1 tokens until each page migrates. Do not
  mix both stylesheets on one page. When a page migrates, it links
  `tokens.css` and drops `styles.css`, and its classes that existed only in v1 are
  expressed again with the inventory above.
- The migrations must close the known v1 law debts. They are the woven figure
  texture, the skeleton gradient sweep, pill buttons, the three
  hues for badges and agents in `styles.css` and the agent colours written directly
  in `web/public/graph.js` (accent thread against ink thread, supersession
  as a dashed ink arc, contradiction as a dotted ink arc), and the
  gold source diamonds in the graph (ink diamonds, shape already
  carries the meaning).
- The working conventions of the console carry over unchanged. They are skeleton
  loading (restyled, not removed), designed empty states, the
  shared error component, three states per view.

## Migration record (5.2, closing the notes above)

- All seven console views plus the sidebar shell are on tokens.css
  alone. The helpers for the console at page level express its own
  components again (rows, receipts, forms, state blocks) in token values.
  The v1 debts are closed. Skeleton shimmer → still ruled blocks,
  hues for badges and agents → `data-state` word + marker badges (agents are
  named, never coloured), pill buttons → the tokens' 4px buttons,
  woven texture → plain figure frame.
- The graph has ONE renderer. `web/public/graph.js` is the v2
  renderer (three ink threads, grok, moose, and the learning
  promotion, told apart by position and label), shared by the
  landing weave and the console graph. The landing spends the one
  accent on its animated playhead. The console's static graph
  spends none, consciously. No console view marks a live decision
  with the accent, because verdicts there are records.
- `.site-head nav` wraps, in the tokens (5.2 decision). The landing
  page's 5.1 workaround at page level was promoted into the component
  after the console work confirmed that any reuse of a top nav hits the same
  360px overflow. Rules at page level keep only spacing for each page.
- One layout law specific to the console, learned at 360px. A grid column
  holding ruled tables needs `min-width: 0`, or the table cannot shrink
  below the width of its content and pushes the column out past the viewport and
  `.table-wrap` never gets to scroll.
