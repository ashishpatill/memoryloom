# Design tokens v2 — the MemoryLoom surface system

Status: adopted at Iteration 5.0. `web/public/tokens.css` is the
source of truth; `web/public/style-tile.html` is its reference render
(open `/style-tile.html` on the running app). The landing page adopts
the tokens in Iteration 5.1 and the console in 5.2; as of 5.2 every
product page is on the tokens and no page links
`web/public/styles.css` (v1) any more — the file remains in the tree
as the v1 record, styling nothing. This note
records the decisions so the migrations are mechanical, not taste
calls made twice.

## The law the tokens implement

- Monotone: ink near-black on warm paper, hairline rules, one
  restrained accent used sparingly. No neon, no vibrant colour, no
  decorative gradients, no glass effects, no shadows.
- Typography carries the design: a display face for headlines, a
  text face for body, a mono face for data, receipts and numbers.
  Generous line height; nothing crammed.
- Motion is sophisticated or absent: slow, small, purposeful;
  reduced motion respected.
- Shapes are simple and confident: numbered sections like an
  engineering document, ruled tables, diagrams that explain.
- Copy in plain words; no claim the product does not actually do.

## Palette

| Token | Value | Job |
| --- | --- | --- |
| `--paper` | `#F7F3EB` | Page ground — warm paper |
| `--paper-sunken` | `#EFE9DA` | Recessed ground — receipts, code |
| `--surface` | `#FDFBF6` | Raised ground — cards, diagram frames |
| `--ink` | `#1D1A15` | Text and full-strength rules |
| `--ink-2` | `#5F584A` | Secondary text (AA on paper) |
| `--ink-3` | `#8A8171` | Faint marks only — never body text |
| `--line` | `#DAD1BB` | Hairline rule |
| `--line-strong` | `#A99B7D` | Rule that must be seen at a glance |
| `--accent` | `#A63D2A` | The one accent (see below) |

The accent is a muted rust. Its meaning is fixed: **a memory moved,
or a decision is live.** It appears at most once in any view — the
playhead on the graph, the gate in a diagram, the single figure
that carries a section. It never fills large areas, never colours
body text or headings, and is never one of a pair.

What v2 removed from v1, and why:

- The second and third hues (a pine green used for one demo agent
  and for "ok", an ochre used for "warn" and supersession) are
  gone from the token set. Three hues read as a palette; the law
  allows one accent. Standing is now carried by word, marker shape
  and weight (see Badges), and agents in the graph are told apart
  by label, thread position and the accent-vs-ink thread pair —
  the 5.2 graph migration applies this.
- Status colours (`--ok`, `--bad`, `--warn` as hues) are deleted.
  A verdict is a word (`approved`, `rejected`,
  `escalated · awaiting a human`) plus a marker, in ink.
- The woven cross-hatch texture on figure frames (two tinted
  repeating gradients in v1) is deleted. A diagram frame is a
  hairline box with a mono header and an honest caption.
- The skeleton loading shimmer (an animated gradient sweep) is
  replaced in the console migration by a still ruled block; v2
  defines no gradient of any kind.

## Type

Three self-hosted faces, all SIL Open Font License 1.1, served from
`web/public/fonts/` with their licence texts beside them. No paid
licence, no build-time or runtime network fetch; total 254 KB.

| Role | Face | Why this one |
| --- | --- | --- |
| Display | **Newsreader** (variable, 400–700 + italic) | A serif drawn for long reading at text and display sizes, with optical sizing and a true italic. It gives headlines a bookish, engineering-journal character without display-face theatrics. Fallbacks: Iowan Old Style, Georgia. |
| Text | **Source Sans 3** (variable, 400–700) | A quiet humanist sans that stays legible at 14–17px in dense console views and does not compete with the serif. Fallback: the system sans stack. |
| Mono | **IBM Plex Mono** (400, 500) | Drawn for technical documents; its letterforms make receipts, identifiers and scores read as records, not code decoration. Fallbacks: ui-monospace, SF Mono, Menlo. |

Rejected: keeping the v1 stacks as-is — the display face resolved
to a different serif on every operating system, so the "system" was
an accident per platform. Fraunces was considered for display and
rejected as too characterful; Inter for text and rejected as the
unconsidered default of product pages. System stacks remain only
as named fallbacks behind the self-hosted faces.

Scale (in `tokens.css`): body 17px at 1.6 line height; lede 20px;
section titles 36px; hero 52px; card titles 26px; captions and
detail 14px; mono labels 12px, uppercase, 0.12em tracking. Body
copy never runs wider than 68 characters.

## Space, rules, shape

- Spacing is a 4px scale from 4 to 96px (`--space-1` … `--space-9`).
  Sections breathe at 64px; cards pad at 16/24px.
- Structure is drawn with rules, not shadows: a 1px hairline
  (`--line`), a stronger 1px rule (`--line-strong`), and a 2px ink
  rule that opens sections and closes the page. `--shadow` does
  not exist.
- One radius, 4px, everywhere. V1's pill buttons and 10px cards
  read as consumer software; the rectangular button and the ruled
  card read as an instrument. The migrations adopt this.

## Motion

Three durations only: 120ms (hover/focus feedback), 240ms (state
change), 600ms (a reveal that happens once), one easing curve.
Motion is a status channel: the graph playhead sweeps the real
corpus timeline; a reveal marks content arriving. Nothing loops
for decoration, nothing autoplays. `prefers-reduced-motion`
disables transitions and reveals in the tokens themselves, and
animated figures must offer pause and a settled end state.

## Component inventory

All defined in `tokens.css`, all rendered once on the style tile:

- **Nav** — wordmark left (serif, second word in secondary ink),
  plain links right with hairline underlines, closed by a 2px ink
  rule. The console nav keeps its sidebar shape and adopts the
  same wordmark, type and rule weights in 5.2.
- **Hero** — one headline, one lede paragraph, one row of buttons.
  The figure (live graph) follows the claim; it is never the
  background of the claim.
- **Section header** — numbered in mono (`01 — Memory`), title in
  display serif, one standfirst paragraph in secondary ink, the
  whole head opened by the 2px ink rule.
- **Ruled table** — hairline row rules, mono uppercase header in
  secondary ink, mono numerals, no zebra fill, no outer box except
  the card it may sit in. Inside `.table-wrap` it scrolls sideways
  on a narrow screen rather than widening the page (found by the
  5.0 tile's 360px capture, fixed in the tokens, not the page).
- **Diagram frame** — hairline-strong border, mono figure head
  (`Fig. 1 — …`), the diagram in ink with the accent at most once,
  and a caption that states what the figure proves and what it
  does not prove.
- **Receipt card** — mono text on the sunken ground, hairline
  border, the verdict as a word with its marker, never coloured.
- **Badges** — word plus marker shape in ink on the surface
  ground: ● approved, ○ pending, ◐ escalated, ✕ rejected,
  ◌ superseded.
- **Buttons** — primary is filled ink; secondary is an ink
  hairline; disabled fades. Hover deepens the ground one step;
  nothing turns colour. Focus is a 2px ink outline.
- **Footer** — a sentence or two in secondary ink over the 2px
  ink rule: where data lives, the safety posture, the licence.
  Not a sitemap.

## Migration notes for 5.1 and 5.2

- `styles.css` keeps v1 tokens until each page migrates; do not
  mix both stylesheets on one page. When a page migrates, it links
  `tokens.css` and drops `styles.css`, and its v1-only classes are
  re-expressed with the inventory above.
- Known v1 law debts the migrations must close: the woven figure
  texture, the skeleton gradient sweep, pill buttons, the three
  badge/agent hues in `styles.css` and the hard-coded agent colours
  in `web/public/graph.js` (accent thread vs ink thread, supersession
  as a dashed ink arc, contradiction as a dotted ink arc), and the
  gold source diamonds in the graph (ink diamonds; shape already
  carries the meaning).
- The console's working conventions carry over unchanged: skeleton
  loading (restyled, not removed), designed empty states, the
  shared error component, three states per view.

## Migration record (5.2, closing the notes above)

- All seven console views plus the sidebar shell are on tokens.css
  alone; the console's page-level helpers re-express its own
  components (rows, receipts, forms, state blocks) in token values.
  The v1 debts are closed: skeleton shimmer → still ruled blocks,
  badge/agent hues → `data-state` word + marker badges (agents are
  named, never coloured), pill buttons → the tokens' 4px buttons,
  woven texture → plain figure frame.
- The graph has ONE renderer: `web/public/graph.js` is the v2
  renderer (three ink threads — grok, moose, and the learning
  promotion — told apart by position and label), shared by the
  landing weave and the console graph. The landing spends the one
  accent on its animated playhead; the console's static graph
  spends none, consciously: no console view marks a live decision
  with the accent, because verdicts there are records.
- `.site-head nav` wraps, in the tokens (5.2 decision): the landing
  page's 5.1 page-level workaround was promoted into the component
  after the console work confirmed any top-nav reuse hits the same
  360px overflow. Page-level rules keep only per-page spacing.
- One console-specific layout law, learned at 360px: a grid column
  holding ruled tables needs `min-width: 0`, or the table's
  min-content blows the column out past the viewport and
  `.table-wrap` never gets to scroll.
