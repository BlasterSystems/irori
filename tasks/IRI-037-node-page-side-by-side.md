# IRI-037 — Node page: Sensors and Inference side by side

- **Ticket:** IR-111 — sprint 990
- **Status:** in progress
- **Research:** `docs/research/IRI-037-research-brief.md` (decision-complete; local evidence only)

## Objective

The node page renders the Sensors card and the LLM inference panel each at half width but in two stacked rows, leaving the right half empty (owner screenshot, DGX-1). Put them side by side in one row.

## Product manager summary

- **One-liner:** Merge the Live and Inference rows of the node page into a single two-column row.
- **User value:** No dead half-page; sensors and inference compare at a glance.
- **Business impact:** Cosmetic; operator UX polish.
- **Success metric:** Owner accepts the changed node page on DEV.
- **Dependencies & constraints:** None; frontend-only (`apps/web`).

## Acceptance criteria

- [ ] Node page renders Sensors and the inference panel(s) side by side in one `cols-2` row, each with its h2 heading above it.
- [ ] No-port nodes show the Live card beside the "no LLM ports configured" note; multi-port nodes stack panels under the Inference heading with a gap.
- [ ] ≤720px collapses back to stacked sections (existing `.cols` rule).
- [ ] All existing source pins pass; one new structural pin asserts the merged section.

## Scope

### Included

- `apps/web/src/components/NodeDetail.vue` (template merge + scoped gap rule), tests.

### Excluded

- Overview, Analytics, Serve pages; LlmPanel internals; server/agent/core.

## Plan

- [x] Understand requirements and inspect relevant code (research brief IRI-037)
- [x] Confirm architecture impact (none — view-layer only)
- [ ] Implement the smallest complete change
- [ ] Add or update tests
- [ ] Update documentation (none beyond this task)
- [ ] Run validation

## Architecture impact

- **ADR required:** No
- **Relevant ADRs:** None

## Validation evidence

- `pnpm typecheck` green across all six packages; `pnpm build` green.
- `pnpm --filter @irori/web test`: 252 passed (new IRI-037 structural pin in
  `chrome-markup.test.ts`; all ds-markup/chrome-markup pins on the old
  vocabulary unchanged).
- `.agentic/bin/validate` + `.agentic/bin/docs-check` green.
- Browser (vite dev proxied to the DEV hub, dev-0.3.0-46, live DGX-1):
  Sensors card and the :8081 TensorFold panel share one row — same `top` 206,
  570px each, `Live`/`Inference` h2s left-aligned over their columns; 1 panel
  counted in `.inference-cell`. At 640px the cells stack (panel top 494 vs
  sensors 277, full width 608).

## Deploy

- (pending — PR open, awaiting owner merge; next dev tag dev-0.3.0-47)

## Review

- Correctness:
- Security:
- Compatibility:
- Residual risks:
