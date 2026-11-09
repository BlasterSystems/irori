# Task: Hub filesystem disk metric plus seed rule (IR-201)

Jira **IR-201** (Task, High, sprint 998, assigned). Story S-A of epic
IR-200 — research: `tasks/research-disk-pressure-notifications.md`.

## Objective

The hub learns about disk pressure on the one filesystem it can see — its own
— through the existing health rules engine: a `hub_disk_pct` metric measured
once per sweep via `fs.statfs` on `HUB_DISK_PATH` (default `/`), a seeded
fleet-scoped rule "Hub disk warn" (gte 80, warn, 1 h cooldown), and the seed
threshold exposed through `GET /api/v1/health/thresholds`.

## Acceptance criteria (from the ticket)

- [ ] With a fake gauge crossing 80 the sweep opens a fleet finding and emits appear; crossing back clears it
- [ ] No statfs call per request (sweep-only); a gauge failure resolves to not-measurable and skips the rule
- [ ] Threshold editable via the health rules PUT; seed threshold lands in the thresholds endpoint

## Design (decision-complete)

- Core: `hub_disk_pct` metric id + seed rule (`scope: "fleet"`, new optional
  seed field — `ensureSeed` currently hardcodes `"node"`) +
  `hubDiskWarnPct` in `healthThresholdsSchema`/`seedThresholds()`.
  `healthFindingSchema.nodeId` widens to `uuid | ""` — the server already
  maps null → `""` in `findings()` and the SSE frame (`healthEventSchema`)
  already allows `nodeId: null`.
- Server: `HealthSinks.hubDiskPct?: () => Promise<number | null>`
  (clock-drift template, IR-189); `evaluate()` widens `nodeId` to
  `string | null` with an `isNull()` branch (drizzle `eq(col, null)` never
  matches); sweep evaluates the rule when the dep exists, skipping null
  gauges; `thresholds()` maps the seed.
- Config: `HUB_DISK_PATH` (default `/`) — in the container that is the
  container filesystem, the build-cache failure class from the 2026-11-09
  outage.
- Wiring: `index.ts` builds the gauge with `statfs(config.hubDiskPath)`
  (`(blocks − bfree)/blocks × 100`, `null` when `blocks === 0`).
- Web: `thresholds.ts`/`main.ts` carry the additive `hubDiskWarnPct` (no
  consumer yet — IR-203 renders it).

## Non-goals

- No DB migration, no new routes, no new credentials, no Prometheus gauge
  (AC says unaffected), no pg-host disk probe (deferred — epic open question).
- No UI banner (IR-203).

## Plan

- [x] Understand requirements and inspect relevant code
- [x] Confirm architecture impact — none (follows IR-160/IR-189 patterns)
- [x] Implement the smallest complete change
- [x] Add or update tests
- [x] Update documentation
- [x] Run validation

## Architecture impact

- **ADR required:** No — per the epic research decision (IR-200).

## Validation evidence

- **Full gate (typecheck → `pnpm test` with `IRORI_TEST_DATABASE_URL` → `pnpm build` → `.agentic/bin/validate` → `.agentic/bin/docs-check`)**: EXIT=0. One typecheck round caught the intended consumer rippling (`router-thresholds-ir84.test.ts` 3-field literals) — updated; docs-check heuristic then flagged the config-doc gap → `HUB_DISK_PATH` documented in `docs/CONFIGURATION.md`.
- **Tests**: new db-gated `hub disk rule (IR-201)` block — breach → fleet finding (`nodeId` wire `""`, metric `hub_disk_pct`, SSE event `nodeId: null`) → recovery clears; failed gauge asked once per sweep and skipped; absent dep doesn't throw. Seed test asserts the 4-field thresholds payload; overwrite test pins `hubDiskWarnPct`.
- **Live smoke (built server, fresh PG on 54331, real gauge over the real sweep)**: seeded rule `{metric: hub_disk_pct, scope: fleet, enabled}` (11 seeds); `GET /api/v1/health/thresholds` → `hubDiskWarnPct: 80`; `PUT threshold 0` → next sweep opened the finding `{"nodeId":"","metric":"hub_disk_pct","summary":"Hub disk warn: 94.9 ≥ 0"}` (the workstation disk is genuinely 94.9% — a truthful gauge); `PUT threshold 100` → next sweep cleared it. Teardown done.

## Review

- **Correctness:** `evaluate()` widened to `nodeId: string | null` with the IS NULL branch (drizzle `eq(col, null)` never matches — the fleet finding would otherwise re-open every sweep); `transition()` already accepted null and the core SSE frame already allows it. The gauge is sweep-only (AC: no per-request statfs) and failures resolve null → rule skipped. `healthFindingSchema.nodeId` widened to `uuid | ""` to match the wire `findings()` has always emitted.
- **Security:** no new route, secret, or surface; the gauge reads a local filesystem only; threshold edits ride the existing audited PUT.
- **Compatibility:** additive metric + additive thresholds field; the one consumer (web thresholds module) and its tests updated. `findings()` shape unchanged for existing consumers (NodeDetail filters by exact node id and never matches `""`).
- **Residual risks:** `HUB_DISK_PATH=/` inside the deployed container measures the container filesystem — it cannot see the pg host (epic open question, IR-202/infra follow-up); a >100 % or 0-block statfs resolves null (skipped) rather than alarming.
