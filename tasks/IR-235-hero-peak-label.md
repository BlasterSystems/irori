# Task: Serving hero — peak sub-label names its bucket granularity

Jira: IR-235 (story of epic IR-233, round 9). Research: `tasks/research-ds-v14-ui-feedback-round-9.md`.

## Objective

The hero "peak" sub-label must stop contradicting the instant hero value: at the 24h range the history buckets are HOUR averages, so "peak 86" under a live 106 tok/s reads as a bug. Owner decision (gate 2026-11-14): honest bucket label, web-only — "peak hour 86" at 24h, "peak minute N" at 30m/1h/4h, "peak day N" at week/month.

## Product manager summary

- **One-liner:** The hero peak sub-label names the bucket granularity it was computed over.
- **User value:** No impossible-looking "current > peak" contradiction on the serving heroes.
- **Business impact:** Data honesty on the primary serving surface (same class as the round-8 busiest-bucket label fix, 76fe709).
- **Success metric:** Label matches the response granularity at every overview range.
- **Dependencies & constraints:** None; no server change (the granularity already ships in the llm-history response).

## Acceptance criteria

- [ ] 24h/week/month → "peak hour/day N"; 30m/1h/4h → "peak minute N"
- [ ] Label derived from the response `granularity` (never hard-coded per range)
- [ ] Unit test pins all three granularities; no API diff

## Scope

### Included

- `apps/web/src/overview.ts` (pure `peakSubLabel`), `apps/web/src/components/OverviewView.vue` (charts map carries granularity; template uses the helper), `apps/web/test/overview.test.ts`

### Excluded

- Server-side minute-bucket "true peak" (rejected at the gate: heavier, minute retention unverified) — follow-up ticket if the owner wants it later

## Plan

- [x] Inspect peakDecode/refreshCharts/history granularity map
- [x] Architecture impact: none (no ADR)
- [x] Implement helper + wiring
- [x] Unit tests
- [ ] Validate + browser-verify

## Architecture impact

- **ADR required:** No
- **Relevant ADRs:** None

## Validation evidence

- Configuration validation: pending
- Tests: pending
- Build: pending
- Documentation check: pending

## Review

- Correctness: granularity comes from `fetchLlmHistory` per node fetch; failed nodes keep their last chart+granularity
- Security: n/a (no API/permission change)
- Compatibility: response shape unchanged; purely presentational
- Residual risks: a stale copied chart entry keeps its previous granularity label until the next successful refresh (pre-existing behavior for the chart itself)
