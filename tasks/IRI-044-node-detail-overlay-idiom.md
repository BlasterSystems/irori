# Task: NodeDetail adopt the IRI-043 overlay idiom (confirms + job progress)

## Objective

Close the deliberate IRI-043 descope: `NodeDetail.vue` is the last surface
using the pre-IRI-043 overlay idiom (two hand-rolled stacked confirm scrims
and a page-flow "Model operation" card). Port it to the shared pattern so the
app has exactly one overlay idiom: job output as a sheet on one scrim,
destructive confirms driven by a single `ConfirmAction` machine, inline in the
hosting surface.

## Product manager summary

- **One-liner:** NodeDetail's model delete/register confirms and job progress join the drawer-native overlay pattern the Models page already uses.
- **User value:** No stacked-modals leftover; model operations stream output in the same docked sheet as everywhere else, and Cancel is guarded instead of instant.
- **Business impact:** One overlay idiom to maintain and audit instead of two.
- **Success metric:** NodeDetail renders one scrim at a time; cancel requires a confirm; markup contract pins the dedup.
- **Dependencies & constraints:** IRI-043 (PR #65) is merged; the pattern is fixed — mirror it, do not invent a second convention.

## Acceptance criteria

- [x] The two stacked `confirm-card` scrims (delete / register) are replaced by one state-driven confirm machine; exactly one `confirm-card` block remains, for host-less page actions.
- [x] Model-job output opens in a job sheet on a single scrim (kind + status chip + full output), auto-opens on dispatch, backdrop closes it.
- [x] Cancel job is guarded by an inline confirm inside the sheet (`host: "job"`), never a stacked modal, and never instant.
- [x] While the sheet is closed, a compact "Model operation" bar keeps the job reachable (Show output / Cancel) without a scrim.
- [x] Dispatch failures surface visibly (page banner), not swallowed.
- [x] Node-switch and unmount clear sheet/confirm/poll state (IRI-010 one-instance discipline).
- [x] Markup contract pins the new shape; old pins (hygiene CTA text, cols-2, formatters) untouched.

## Scope

### Included

- `apps/web/src/components/NodeDetail.vue` (script, template, scoped CSS)
- `apps/web/test/chrome-markup.test.ts` (overlay pins)
- CHANGELOG entry

### Excluded

- ModelsView's pre-existing mobile `.drawer` `is-open` quirk (logged, accepted in IRI-043)
- Any server/agent/core change; any behavior change to modelctl job dispatch
- Node-delete two-click arming (different affordance, untouched)

## Plan

- [x] Understand requirements and inspect relevant code — IRI-043 brief §4.1 row 10 (the descope record), ModelsView overlay machine (`:417-455`, `:525-565`, `:678-740`, `:860-979`, CSS `:1289-1350`), `irori.css` shared drawer chrome + `body .drawer.is-open` mobile contract, `scrim.ts` directive.
- [x] Confirm architecture impact — ADR No: local UI consistency, the durable decision (single overlay idiom) is IRI-043's.
- [ ] Implement the smallest complete change (mirror ModelsView; no new components)
- [ ] Add or update tests (chrome-markup overlay pins)
- [ ] Update documentation (CHANGELOG; this file)
- [ ] Run validation (typecheck, web tests, build, validate, docs-check, fixture-rig browser pass)

## Architecture impact

- **ADR required:** No
- **Relevant ADRs:** None
- **Proposed ADR:** None

## Validation evidence

- Configuration validation: `.agentic/bin/validate` — pass.
- Tests: `pnpm typecheck` all packages green; `pnpm test` green (core 95, web 262 — includes the new
  `chrome-markup` overlay-idiom pin, proxy 23, agent 186, server 116; db-gated server suites skipped
  locally without `DATABASE_URL`, unaffected by a web-only change); `pnpm build` green; `.agentic/bin/docs-check`
  green.
- Browser fixture rig (vite + fetch-router, schema-validated fixtures): single `.drawer-scrim` at every
  step; confirm-card → sheet swap on confirm (never stacked); sheet shows kind + status chip + streaming
  `joblog`, opbar hidden while open; cancel guard renders inline inside the sheet (`host: "job"`) and the
  backdrop press closes the confirm BEFORE the sheet (top-most rule); register confirm carries the
  secondary button + read-only hint; bar shows chip/last line with Show output + guarded Cancel, Dismiss
  clears it; jobs POSTed with exact `{kind, params}`; inventory refetch on settle; zero console/page
  errors; 390 px viewport renders the sheet `visible` via `drawer is-open` at 100% width.
- Review: correctness — state machine and z-ordering mirror ModelsView; epoch+seq guards on the poll
  (node switch/unmount/close); `openJob` returns after the first fetch so the confirm clears promptly
  while the poll continues in background. Security — no new command surfaces; same job kinds/params as
  before; cancel now guarded. Compatibility — web-only; older hubs unaffected. Residual — ModelsView's
  pre-existing mobile `.drawer` visibility quirk remains (accepted in IRI-043 review); the sheet persists
  after terminal settle until closed (ModelsView parity).

## Review

- Correctness: mirrored the shipped ModelsView machine; the only deltas are the compact bar (recoverable
  close) and the dispatch-failure page banner — both reviewed above.
- Security: no agent/server changes; destructive paths still route through the same confirm copy from
  `inventory.ts`; register stays non-destructive (secondary).
- Compatibility: no API/schema changes; chrome-markup pins updated in the same commit.
- Residual risks: none known beyond the accepted ModelsView mobile quirk.
