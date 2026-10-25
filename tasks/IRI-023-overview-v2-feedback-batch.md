# Task: Overview v2, telemetry UX and setup-flow fixes (feedback round 2026-10-24)

## Objective

Implement the owner's feedback batch on the live Overview/serve UX, ticketized
under Jira epic **IR-78** (stories IR-79–IR-86, pushed to IR Sprint 1 = 985).
Research: `docs/research/IRI-023-research-brief.md` (live API probes +
driven-browser measurements on dev-0.3.0-26).

## Stories

| Jira | Slice | Area |
|---|---|---|
| IR-79 | One hero card per serving process; Nodes section incl. heads, no NAS; lens filter removed; 30m charts + height; "60m window" label fix | frontend + tiny server range |
| IR-80 | Footer: update interval + fleet watts; GPU watts on node cards | frontend + version payload |
| IR-81 | Layout & smoothing: `.page` padding fix, section rhythm, `.bar__fill` transition | frontend |
| IR-82 | Setup start pre-flight for MODEL_PATH + onDriverEvent change-dedupe | backend |
| IR-83 | Wizard `in`-operator bug fix, NAS excluded as worker, server-side nodes validation | full-stack |
| IR-84 | Direct NAS delete behind confirmation (dry-run/arm flow removed) | frontend |
| IR-85 | Scrim press-guard: close only when the press started on the backdrop (7 surfaces) | frontend |
| IR-86 | UI copy sweep: no ticket/milestone/ADR references in user-visible strings | frontend |
| IR-87 | User-adjustable hub snapshot cadence (CADENCE_MS default, persisted, live-pushed) | full-stack |

## Acceptance criteria (epic-level)

- [ ] Overview shows one card per serving process (single or cluster) with 30m, readable charts
- [ ] Nodes section lists all sparks including heads; NAS only in its own card; no lens filter
- [ ] Footer shows the update interval and current fleet draw; node cards show GPU watts
- [ ] Sections keep side margins at ~1000px; no zero-gap stacked sections; bars animate
- [ ] No repeated identical setup-state events; start without the model on the head fails fast
- [ ] Wizard cannot produce duplicate/NAS workers; server rejects them
- [ ] Delete-from-NAS is confirm-then-applied in one step
- [ ] Press-inside/release-on-backdrop keeps every modal open
- [ ] Built UI contains no visible ticket/ADR references
- [ ] Cadence adjustable in hub settings; persists across restarts; connected agents apply it live

## Plan

Implementation order (independent → overlapping files last; one writer):

1. IR-85 scrim press-guard (shared helper, 7 surfaces)
2. IR-81 layout & smoothing (CSS only)
3. IR-83 wizard/server nodes validation
4. IR-82 backend: announce dedupe + start pre-flight
5. IR-79 Overview structure + 30m range + chart height
6. IR-80 footer interval + watts (+ GPU watts on cards)
7. IR-84 direct NAS delete
8. IR-86 copy sweep (last — after all new copy exists)

**Decisions (owner, 2026-10-24):**

- Implement everything now, in the order above.
- Start pre-flight: **refuse fast** with an actionable error; no auto-staging of
  187 GB on a click (staging stays the explicit "Stage transfers" action).
- Multiple simultaneous serving processes: **two-column hero grid** in setup
  order; detected-but-unmanaged ports get a minimal card.
- Cadence: **user-adjustable** (IR-87) — settings-table persistence with
  CADENCE_MS env default, hub settings modal field, live push via
  config-update; footer shows the active value.

## Scope

### Included

- Everything in the nine stories above (frontend, server, tests, copy).

### Excluded

- Hub-side rolling p95 windows (label fix only).
- The disk-hygiene dry-run flow (different feature, unchanged).
- ADR work.

## Architecture impact

- **ADR required:** No (additive version payload, input validation, UI behavior; no data-model, deployment, or integration boundary changes)
- **Relevant ADRs:** ADR-0004 (modelctl-only NAS writes — preserved by IR-84), ADR-0008 (capture proxy — untouched)

## Validation evidence

- Configuration validation: `.agentic/bin/validate` — passed
- Tests: `pnpm test` — 624 passing (core 74, proxy 22, web 211, agent 140, server 96; server db-gated files run separately against a disposable Postgres 16 container: **179/179 passed**, including the new setup-validation / start-pre-flight / announce-dedupe suites). Fixed one stale pin (`card-data.test.ts` GPU row now carries watts — intended behavior change).
- Build: `pnpm build` — exit 0 (core → db → proxy → server → agent → web)
- Documentation check: `.agentic/bin/docs-check` — no heuristic gaps (CONFIGURATION.md gained `CADENCE_MS`; API.md gained the cadence routes, 30m range, version `cadenceMs`, setup validation/dedupe/preflight contracts)
- Live smoke (built stack on a disposable PG, driven Chromium):
  - Overview: no lens filter; two-column hero grid; ghost "nothing serving"; "Nodes" heading; container padding 24px (was 0); Workers→Telemetry gap 20px (was 0); footer `Irori 0.3.0 · updates every N s`; watts hidden until snapshots exist
  - Per-process hero card rendered from a forced-running setup (title = setup name, declared-port fallback, six stats, "1 serving" in the pagehead)
  - Scrim guard on the real node modal: press-inside/release-on-backdrop stays open; press+release on backdrop closes (the IR-85 repro)
  - Hub settings modal: cadence prefilled from the setting, save 8 s → footer "updates every 8 s" immediately + `GET /api/v1/version` reports 8000 (persisted, boot-loaded after restart)
  - API: NAS worker → 400 with reason; duplicate/self workers → 400; `llm/history?range=30m` → 200 minute granularity; out-of-bounds cadence → 400 zod issue

## Review

- Correctness: server behavior covered by new unit tests (validation, pre-flight, dedupe); client changes verified in the live smoke. `heroDataForPort` is a pure extraction — `computeHeroData` keeps its contract.
- Security: no new privileged surfaces; setup worker validation tightens an unvalidated write path; the cadence route mirrors the audited HF-token settings pattern (503 degraded, zod bounds, no secrets).
- Compatibility: version payload and history ranges are additive (old hubs/clients unaffected); setup-node validation rejects previously-accepted corrupt rows by design (the live DEV row with DGX-3 ×4 + NAS ×2 must be re-saved or deleted by the owner — the server now refuses such shapes).
- Residual risks:
  - The corrupt DEV setup row (`69916930`, glm-5.3-flash-exl3-q4) still exists; editing it in the wizard now cleans workers, or delete it — owner call.
  - `nas-delete` dry-run job kind removed from the UI path; the agent still supports the kind (harmless legacy rows).
  - Stat-number tweening skipped (bars + spacing were the visible offenders).
  - The hero for a running setup whose probe has not answered yet renders "unknown :port" + "starting" until the first LLM probe lands.
