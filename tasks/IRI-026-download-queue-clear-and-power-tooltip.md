# IRI-026 — Feedback round 4: download queue auto-clear, power bar tooltips

- **Tickets:** IR-96, IR-97 (sprint 985, label `frontend`)
- **Status:** PR open
- **Research:** none — internal UI behavior; every surface mapped in-repo (scout pass over agent/server/web)

## Goal

Owner feedback on the deployed dev-0.3.0-29 (2026-10-25, two screenshots):

1. Models — Download queue: recently downloaded models keep growing the table, and once the batch bar reaches 100% it stays there ("100% · 836.0 GiB / 836.0 GiB").
2. Overview — fleet draw histogram: no hover feedback; owner expected the time slot and the energy spent per bar in a tooltip.

## Decisions

- Owner picked **auto-clear finished** (2026-10-25, via options auto-clear / clear-button / collapse): succeeded rows auto-delete ~60 s after the batch settles, stale succeeded rows are pruned on page load, failed/canceled rows stay, batch strip shows only while something is pending/running. Frontend-only — uses the existing `DELETE /api/v1/downloads/:id`.
- Tooltip: per-bar `.charttip` with slot + energy; bars already carry avg watts; add per-bar energy + covered span to `binFleetPower`.
- No stale "2.5 min at 30m" bucket text in the power card info tip (actual minute buckets are 60 s) — dropped since the tooltip states the exact slot.
- ADR: **No** (routine UI behavior; no durable cross-cutting/data/deployment change).

## Plan

1. **IR-96 (frontend)** — `models.ts` pure stale/prune rule + ModelsView wiring (grace timer after settle, on-load prune of stale succeeded rows, strip only while active).
2. **IR-97 (frontend)** — `overview.ts` `binFleetPower` emits per-bar `wh` + span; OverviewView power bar svg gets pointermove/leave with a `.charttip` (Sparkline/LensChart pattern), hovered-bar highlight, `fmtEnergy` helper.

## Validation

- `pnpm test` green (web 222/222 — +6: stale-rule boundary tests, per-bar
  energy/span, `fmtEnergy`, `powerBarSlot`; full suite exit 0).
- `pnpm build` green; `.agentic/bin/validate` passed; `.agentic/bin/docs-check`
  passed (SPEC §7 updated with the auto-clear contract).
- Fixture browser smoke (built dist + fetch-router init script, light + dark):
  - Overview: 30 bars, hover → `.charttip` "14:07 – 14:08 · energy 2.6 Wh",
    29 siblings dimmed (hover highlight), cleared on pointerleave; month
    range → day-granularity slots ("Oct 11 – Oct 12") + "3.70 kWh";
    0 console errors. Stale "2.5 min at 30m" tip text removed (minute buckets
    are 60 s; the tooltip states the exact slot).
  - Models: stale succeeded row pruned on load with exactly one DELETE (never
    rendered); fresh succeeded row DELETEd once ~60 s later (deadline-based
    timer, verified on the rebuilt bundle); failed row survives both waves;
    batch strip hidden while idle; 0 console errors.
- Self-review fix: the first cut gated the clear timer on an idle queue, so
  rows from a settled batch would linger (and pollute the strip %) if a new
  batch started within the grace window — replaced with absolute-deadline
  scheduling (`updatedAt + grace`), re-verified.

## Deploy

- PR open (see close-out comment on IR-96/IR-97); next dev tag after merge:
  dev-0.3.0-30.
