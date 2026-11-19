---
name: implement
description: Use when executing an IRI task or milestone end to end — task record, research handoff, decision-complete plan, smallest coherent change, tests, review, validation.
---

# Implement an IRI task

1. Extract the `IRI-[0-9]+` task ID (or milestone from `docs/PLAN.md`) and read
   the task file in `tasks/`. Do not modify files outside its scope; do not
   commit or push unless the user explicitly included that action.
2. Inspect the working tree, relevant code, tests, task history, and approved
   documentation before changing state. Read `docs/adr/README.md` when the task
   touches architecture.
3. If the task has material unknowns (external behavior, store formats,
   hardware/driver quirks, protocol details), run the `research` skill first
   and link the brief from the task file before planning further.
4. Create a decision-complete implementation plan covering behavior, affected
   layers, security impact (the agent is privileged — treat its command and job
   surfaces as security-sensitive), tests, and environment constraints.
   Obtain user approval when requirements or tradeoffs remain material.
5. An ADR is required when the change is durable, cross-cutting,
   security-sensitive, data-model, deployment, or integration work — follow
   `architecture-decision`; otherwise record "No" in the task file.
6. Implement the smallest coherent change and update tests alongside behavior.
   Keep one writer for overlapping files when subagents are used; use
   read-only subagents for domain analysis and review, keep edits with the
   primary agent.
7. Validate: `pnpm test`, `pnpm build`, `.agentic/bin/validate`,
   `.agentic/bin/docs-check` — plus a live smoke of the changed path (run the
   thing; observe the result). Never hide failures by weakening tests or
   security controls.
8. Update the task file with validation evidence and residual risks; review
   the final diff for scope and generated drift (e.g. scaffold-owned files).
9. Report the outcome and verification: summary of changes, validation
   results, remaining risks. Commit only when explicitly requested.

## Context

- Milestone epic and exits: `docs/PLAN.md`. Product truth: `docs/SPEC.md`.
- Task records: `tasks/IRI-NNN-*.md` from `tasks/task-template.md`.
- Research briefs: `docs/research/IRI-NNN-research-brief.md`.
- Scaffold-owned files (`.agentic/`, `AGENTS.md`, `docs/*.md` from the
  scaffold) are manifest-tracked; update deliberately, never casually.
