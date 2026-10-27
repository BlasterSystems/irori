# IRI-036 — Overview feedback round 4 (section order, feed auto-scroll, per-series hero scale)

- **Ticket:** epic IR-107, stories IR-108 (section order), IR-109 (feed auto-scroll), IR-110 (per-series hero scale) — sprint 990
- **Status:** in progress
- **Research:** `docs/research/IRI-036-research-brief.md` (decision-complete; all questions answered from local sources)

## Objective

Three owner changes to the Overview page from the 2026-10-27 feedback round:

1. The Nodes section swaps places with the Power/NAS row (Nodes directly under the serving heroes).
2. The Telemetry feed always shows the latest data: auto-scroll to the bottom as new lines arrive.
3. The active-model chart scales decode and prefill independently so both stay legible (owner screenshot: prefill invisible under decode's shared scale).

## Product manager summary

- **One-liner:** Overview layout reorder, always-latest telemetry feed, and independent decode/prefill chart scales.
- **User value:** The page leads with the fleet; new telemetry events are never missed; small prefill activity is visible instead of flattened.
- **Business impact:** Small; operator UX polish on the primary landing page.
- **Success metric:** Owner accepts the changed Overview on DEV.
- **Dependencies & constraints:** None blocking; frontend-only (`apps/web`), no server/agent/core changes.

## Acceptance criteria

- [ ] Overview renders: serving heroes → Nodes → Power + NAS → Telemetry, with spacing preserved.
- [ ] Telemetry feed scrolls to the newest line whenever a line is added (unconditional, per owner ask).
- [ ] Hero chart: decode and prefill each use their own 0-floored scale; tooltips still show raw tok/s; an all-zero series renders flat at the bottom.
- [ ] No other chart changes (shared-domain default preserved for Analytics, node page, Sparkline).

## Scope

### Included

- `apps/web/src/components/OverviewView.vue` (template order, feed ref/watch), `apps/web/src/analytics.ts` (`perSeriesScale` opt, `ChartSeries.scale`), `apps/web/src/components/LensChart.vue` (hover dots on per-series scale), tests.

### Excluded

- Node-page `LlmPanel` decode/prefill charts (could adopt `perSeriesScale` later).
- Server/API/core/agent.

## Plan

- [x] Understand requirements and inspect relevant code (research brief IRI-036)
- [x] Confirm architecture impact (none — frontend view-layer only)
- [x] Implement the smallest complete change (IR-108 → IR-109 → IR-110, sequentially)
- [x] Add or update tests (`overview.test.ts` hero pin reworded; new analytics per-series tests; OverviewView source pins)
- [x] Update documentation (none needed beyond this task; no SPEC §affected)
- [x] Run validation

## Architecture impact

- **ADR required:** No
- **Relevant ADRs:** None

## Validation evidence

- `pnpm typecheck` green across all six packages; `pnpm build` green.
- `pnpm test`: core 95, web 251 (incl. the new per-series analytics tests and
  the IR-108/IR-109 OverviewView source pins), proxy 22, agent 172. One
  pre-existing agent flake (`m4.test.ts` hfToken env test) failed once under
  full-suite parallel load and passed standalone twice — web-only diff, unrelated.
- `.agentic/bin/validate` + `.agentic/bin/docs-check` green.
- Live browser pass (vite dev proxied to the DEV hub, dev-0.3.0-45, real DGX-1
  TensorFold engine serving):
  - Order measured: heroes (y 169) → Nodes h2 (501) → Power (774) → Telemetry
    (1135); fleet grid margin `20px 0 12px`.
  - Hero chart: prefill (red) spans its own scale next to spiky decode — the
    owner's scenario fixed; hover tooltip shows raw tok/s ("decode 30m 90
    tok/s · prefill 30m 76 tok/s") with each dot on its own series' geometry.
  - Feed: 14 live lines overflowing the 220px box, `scrollTop 73 ==
    scrollHeight − clientHeight` (auto-scrolled to the latest line).

## Deploy

- (pending)

## Review

- Correctness:
- Security:
- Compatibility:
- Residual risks:
