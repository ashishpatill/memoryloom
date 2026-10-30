# Learning layer — research note (verified 2026-10-30)

One page. Every entry below was checked against its arXiv listing on
2026-10-30. We adopt patterns, not claims: no performance number from
any paper is used as a MemoryLoom claim.

## Verified

**Harness² — arXiv:2610.14224**
"Harness^2: Recursive Agent Harnessing for an Open World" (Xu, Chen,
CuiZhu, Dalvi Mishra, Ming, Yu, Han, Lee, Pfister; submitted 9 Oct
2026). Two connected levels of recursion: task-level recursion refines
the current task's harness with a contrastive Propose-Probe-Compose
step that guides edits without ground-truth verifiers; harnessing-level
recursion then extracts experience from those edits into a continual
improvement harness for future tasks.
ADOPTED: the two-level split itself. Task level = our in-turn
correction (a failing signal mid-task produces a logged correction in
the same turn). Harness level = our cross-task lesson promotion,
except that where Harness² edits its harness automatically, every
MemoryLoom promotion passes the Jev decision gate — the pattern is
theirs, the gate is ours.
NOT USED: an earlier pasted summary of this paper carried an invented
method name ("Pattern C+"), an invented proxy, and invented
performance/price numbers. None of that appears anywhere in the
listing or in this build, and it must never be used.

**ACE — arXiv:2510.04618**
"Agentic Context Engineering: Evolving Contexts for Self-Improving
Language Models" (Zhang et al.; submitted 6 Oct 2025, v3 Mar 2026).
Contexts are treated as evolving playbooks that accumulate, refine and
organise strategies through generation, reflection and curation.
Structured, incremental updates prevent the brevity bias and context
collapse that iterative rewriting causes, and the playbook improves
from natural execution feedback without labelled supervision.
ADOPTED: lessons are structured playbook entries that accumulate —
never a rewritten summary of everything learned (no collapse path);
the curation step is a real decision point (our Jev promotion gate,
not an LLM rewrite); the raw material is execution feedback, which is
exactly what our learning events capture.

**Reflexion — arXiv:2303.11366**
"Reflexion: Language Agents with Verbal Reinforcement Learning"
(Shinn et al.; submitted 20 Mar 2023). Agents verbally reflect on
task feedback signals and keep the reflective text in an episodic
memory buffer, which improves decision-making in subsequent trials.
Feedback can be scalar or free-form, external or self-generated.
ADOPTED: a correction is stored as a verbal reflection plus its
trigger evidence (gate verdict, eval outcome), and it is the
reflection text — not just a score — that is recalled when the agent
retries. Our in-turn variant tightens the loop from "next trial" to
"same turn".

**Voyager — arXiv:2305.16291**
"Voyager: An Open-Ended Embodied Agent with Large Language Models"
(Wang et al.; submitted 25 May 2023). An ever-growing skill library of
retrievable, compositional entries, built by an iterative prompting
loop that incorporates environment feedback, execution errors and
self-verification.
ADOPTED: promoted lessons form a retrievable library indexed for
recall by task class (with receipts, like every MemoryLoom recall),
and a self-verification / successful-application record is part of
the evidence a promotion decision weighs.
NOT ADOPTED: the automatic curriculum and self-directed exploration —
out of scope for a gated team memory; nothing in MemoryLoom explores
or promotes on its own authority.

## Flagged unverified

Nothing else was adopted. Any technique not listed above — including
anything from the earlier paste that carried the invented Harness²
material — is treated as unverified and is not in the build.

## How the patterns land in Block 5

- Ingestion: every interaction is an append-only learning event in
  Plane 1 (ACE's execution feedback, made auditable).
- Promotion: learning event -> Jev decision -> playbook lesson stored
  as a memory, so decay and recall treat lessons like everything else
  (ACE curation + Voyager's library, behind our gate).
- In-turn correction: a gate or eval signal produces a logged verbal
  correction inside the same turn (Reflexion, tightened; Harness²'s
  task level).
- Evidence: the before/after demo shows the same task class failing,
  being corrected, and — after promotion — succeeding with the lesson
  recalled by receipt.
