# IRI-043 — Push job default, drawer-native secondary layers, telemetry transfer labels

## Goal

Three owner asks from 2026-10-28, made against the placement drawer and the Overview Telemetry feed:

1. DGX↔DGX pushes use 4 concurrent transfer jobs by default (already true on every live path — residual: agent-side default when params omit `jobs`).
2. Clicking Push/Delete inside the placement drawer must not stack a modal on a modal — secondary layers become drawer-native (owner pick pending: inline / replace / side sheet).
3. Telemetry feed lines name the model being transferred (currently node + kind only).

## Plan

- Research: `docs/research/IRI-043-research-brief.md` — evidence, live-hub verification, option tables for §2.
- Mockup: `mockups/IRI-043-overlay-options.html` — options A/B/C side by side + the telemetry label fix; light/dark browser-verified, inline confirm demoed. → **Owner picked C (side sheet)**, 2026-10-28; NodeDetail descoped.
- [owner] pick the secondary-layer shape (brief §2.3 A/B/C) and NodeDetail include/desc. → **C (side sheet)**; NodeDetail descoped (owner, 2026-10-28).
- [owner addendum, 2026-10-28] In-depth review of ALL overlay use cases (the pattern must cover the app, not just ModelsView) + global always-available resizable telemetry drawer with a nav-bar/footer CTA (see brief §4 addendum).
- Agent: push `jobs` defaults to 4 when the param is absent (brief §1.5).
- Core + server: SSE `job` frames carry `params` (`jobEventSchema`, both emit sites, `JobSettledEvent` threading; brief §3.3).
- Web: `live.ts` stores frame params; `feedLines` labels progress + lifecycle lines with the model name (brief §3.3).
- Web: secondary-layer refactor per owner pick; confirm-card survives only for drawer-less contexts (brief §2.3).

## Acceptance

- A push dispatched without a `jobs` param runs 4 streams (job output line: "with 4 rsync streams").
- Feed lines read `DGX-3 · sync-local <model>: …` including jobs started mid-session, on both progress and started/finished lines.
- No stacked scrims (or explicit side-by-side per pick); placement flow browser-verified.
- `pnpm typecheck` + `pnpm test` + `pnpm build` + `.agentic/bin/validate` + `.agentic/bin/docs-check` green.

## Notes

- `sync-local --jobs` is queue-level (modelctl rejects `--jobs` without `--queue`) — out of scope; downloads already default 4 via `packages/core/src/downloads.ts`.
- modelctl clamps push streams to file count; the 94+95-item Ablit model is unaffected.
- Version bump rides its own PR (owner rule).
