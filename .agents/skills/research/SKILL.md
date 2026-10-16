---
name: research
description: Use when a task has material unknowns — external behavior, store formats, hardware/driver quirks, protocols — to produce an evidence-backed research brief before implementing.
---

# Research for an IRI task

1. Trigger: the implement plan cannot be decision-complete because behavior
   outside this repository is unknown (modelctl output shapes, `nvidia-smi`
   fields on GB10, engine `/metrics` counters, DS token values, HF metadata).
   Trivial unknowns do not need a brief — inspect and proceed.
2. Write `docs/research/IRI-NNN-research-brief.md` with the header:

   ```markdown
   # IRI-NNN research brief — <topic>

   - **Date:** YYYY-MM-DD
   - **Ticket:** IRI-NNN
   - **Goal:** <the question the implementation depends on>
   ```

3. Numbered sections, one per question, each containing **evidence, not
   conclusions**: file paths with line references, verbatim quotes, command
   transcripts, tables of options A/B/C with tradeoffs. Cite local primary
   sources first (`~/Developer/modelctl`, `~/Developer/sparkControl`,
   `~/Developer/sparkDash`, `~/Developer/uptime-monitoring`,
   `Design System.dc.html`), then web sources with links.
4. End with `## Summary of Findings` — the decision-ready answer per question
   and what remains open. If something cannot be determined from available
   evidence, say exactly what is missing and how it would be measured.
5. Link the brief from the task file (`## Plan` → research item) and proceed
   with the implement plan; do not restate brief content in the task file.
6. Keep briefs immutable once the task completes — corrections go in a new
   dated section, never by rewriting evidence.
