# Task: Clock-cap drift must not warn on unreportable GPUs (IR-259 / IRI-145)

## Objective

The IR-189 `clock_cap_drift` rule counts a structurally unreportable GPU cap
read-back as drift. On DGX Spark (GB10) the driver rejects
`clocks.applications.sm`, so the agent's GPU `smCapMHz` is always `null`;
`null ≠ stored 2200` then increments the drift streak on every 30 s sweep and
every spark node warns forever (live 2026-11-16: DGX-1/2/3 all `400 ≥ 4`,
identical `since` — one sweep tick apart). Fix the comparison contract and
derive the durable display window from the finding's `since`.

## Product manager summary

- **One-liner:** spark nodes stop warning forever about a GPU cap the driver cannot even report.
- **User value:** health banners tell the truth; real drift (CPU side, or a readable GPU) still warns.
- **Business impact:** removes a permanently open false warning that trains operators to ignore health banners.
- **Success metric:** the three spark-node `clock_cap_drift` findings close on the next sweep after deploy and stay closed.
- **Dependencies & constraints:** none. Research: `tasks/research-dgx3-modelctl-clockcap-layout.md` (D2, owner-approved 2026-11-16). Live-hardware check (`nvidia-smi -q -d CLOCK` on a spark node) is unobservable from this workstation — rides the next dev tag.

## Acceptance criteria

- [ ] `clockDrift`: stored GPU cap + all-null `smCapMHz` read-back → no drift; the comparison stays on when ≥1 card reports a real ceiling (one reverted card still drifts — mixed case unchanged).
- [ ] Service: all-null read-back → `driftStreak` 0 and `reassert` applies nothing.
- [ ] `findings()` derives the "~N min" window from the finding's `since` (wall time); the appear/journal summary keeps the streak-derived window (IR-254 contract).
- [ ] Tests: pure comparison (all-null, mixed, real revert), service (no re-apply, no streak), db integration (fresh finding ~1 min; backdated `since` shows the true window).

## Scope

### Included

- `apps/server/src/clock-caps.ts` — GPU guard keys on "cannot express the side" (all-null), mirroring the CPU guard.
- `apps/server/src/health.ts` — `findings()` rebuild uses `clockDriftSinceSuffix(f.since, now())`; appear summary unchanged.
- Tests in `apps/server/test/clock-caps-ir189.test.ts` + `apps/server/test/health-ir69.test.ts`.

### Excluded

- Node-side `nvidia-smi -q -d CLOCK` probing (needs node shell; recorded as follow-up evidence).
- Automatic mid-session re-apply (rejected in round 14 — the hub cannot distinguish intentional operator changes).
- Removing the rule or changing thresholds.

## Plan

- [x] Understand requirements and inspect relevant code
- [x] Confirm architecture impact
- [x] Implement the smallest complete change
- [x] Add or update tests
- [x] Update documentation
- [x] Run validation

## Architecture impact

- **ADR required:** No — local rule semantics; no schema, deployment, or boundary change.

## Validation evidence

- Configuration validation: `.agentic/bin/validate` — passed
- Tests: `IRORI_TEST_DATABASE_URL=…54329 pnpm -r test` — 1420 passed, 0 failed (server 427 incl. updated `clock-caps-ir189` + `health-ir69`; web 525; agent 318; core 111; proxy 24; db 15). `pnpm -r typecheck` — 6× Done.
- Build: `pnpm -r build` — green
- Documentation check: `.agentic/bin/docs-check` — no gaps (API.md §clocks + SPEC §10 now name the all-null read-back as unmeasurable)

## Review

- Correctness: the guard keys on "cannot express the side" (all-null), mirroring the CPU guard; the mixed case (one real reading + one null) still compares, so a genuinely reverted card warns. Durable summary derives from `since`; the appear/journal summary keeps the streak-derived IR-254 contract (both pinned by tests).
- Security: no surface change (server-internal rule only).
- Compatibility: findings created by the old code close on the next sweep — the sweep evaluates value 0 → not a breach → `clearedAt` set.
- Residual risks: whether the 2200 MHz GPU cap is actually enforced on GB10 remains unobservable through the hub API; the node-side `nvidia-smi -q -d CLOCK` check rides the next dev tag.
