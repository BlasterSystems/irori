# Research — Overview: drop the thermal alert row; label the "hottest" token GPU/CPU

Date: 2026-11-27 · Repo: `main` @ 771fe22 · Surface: `apps/web` (Overview page only) · Trigger: owner request 2026-11-27 — "remove the thermal warning, and the 'hottest' should show if is CPU or GPU" (screenshot: page head `hottest 75.8°C DGX-1` + bordered row `THERMAL 70°C DGX-3 … ≥ 70 °C warn tier`).

## Tracker target

Project key **`IR`** · site https://blastersystems.atlassian.net · board 5 — per `docs/DEVELOPMENT_PROCESS.md` §9, the `IR-xxx / IRI-xxx` pairs in recent commit subjects (`771fe22`, `79bb856`), and `tasks/research-overview-rail-scope.md` "Tracker target". No tracker named in this conversation.

## Summary

Two small Overview changes, one ticket:

1. **Remove the IRI-159 degraded-only thermal alert row** (`.thermal-alert`). It duplicates the page-head `hottest` token and the per-node temps on node cards, and as the screenshot shows it **disagrees with the token**: the alert is GPU-only while the token is `max(GPU, CPU)`, so the page shows "hottest 75.8 °C DGX-1" and, right below it, a warning that names only DGX-3 at 70 °C.
2. **Make the `hottest` token say which sensor it is**: carry the source axis out of `fleetTemps()` and render it between the node and the value: `hottest DGX-1 CPU 75.8°C`; on a GPU = CPU tie, both: `hottest DGX-1 GPU/CPU 75.8°C` (owner decision, 2026-11-27).

Pure web/UI change: no API, schema, agent, or deploy-config impact.

## Current state (evidence)

| Fact | Evidence |
|---|---|
| Alert row markup (head `thermal`, nodes text, `≥ 70 °C warn tier`) | `apps/web/src/components/OverviewView.vue:611-617` |
| Alert computeds — GPU-only filter at ≥ `TEMP_WARN_C` | `OverviewView.vue:64-74` (`thermalAlertNodes`, `thermalAlertText`; comment "gpu-only per the approved spec") |
| Alert CSS | `OverviewView.vue:1025-1047` (`.thermal-alert`, `__head`, `.faint`) |
| Page-head token: `hottest <span :class="{hot: …}">{{tempC}}°C {{name}}</span>` — no axis | `OverviewView.vue:598` |
| `fleetTemps()` computes per-item `gpu`, `cpu`, `max = max(gpu, cpu)`; `hottest` returns only `{ name, tempC }` — the axis is dropped | `apps/web/src/overview.ts:331-368` (`FleetTemps.hottest` type at `:348`, return at `:366-367`) |
| Token vs alert mismatch in the screenshot: DGX-1 is "hottest" at 75.8 °C but absent from the GPU-only alert, so DGX-1's 75.8 °C must be its **CPU** reading | [INFERENCE] from `:69-71` filter vs `:366` `max` — consistent with the screenshot, not checked against live data |
| Tests pinning the alert | `apps/web/test/overview-main-rail-iri159.test.ts:122-138` (mount test, `.thermal-alert` present at 72 °C / absent at 60 °C); `apps/web/test/overview.test.ts:391` (source pin `class="thermal-alert"`) |
| Tests pinning the token / `hottest` shape | `apps/web/test/overview.test.ts:382` (`"hottest <span"`), `:455-473` (`r.hottest` toEqual `{ name, tempC }`) |
| Other `hottest` uses — not part of this change | `AnalyticsView.vue:263-265` ("hottest first" captions only); `OverviewView.vue:625` (temps-card caption) |
| Mockup still draws the alert row | `mockups/overview-adaptive.html:58` (CSS comment "thermal alert row — degraded-only") and `:146` (token) |
| SPEC does not describe the alert row (no doc change needed there) | `docs/SPEC.md:437-442` covers the Analytics temps strip only; `grep "thermal alert"` in `docs/` → no hits |

## Gap analysis

| Want | Have | Gap |
|---|---|---|
| No thermal warning row | Row shown whenever any online spark GPU ≥ 70 °C | Delete markup, computeds, CSS, tests |
| Token says GPU or CPU (both on a tie) | `hottest` = `{ name, tempC }` | Add `source: "gpu" \| "cpu" \| "both"` to `FleetTemps.hottest`; render it before the value |

## Proposed design

**Data (`overview.ts`):** extend `FleetTemps.hottest` to `{ name, tempC, source: "gpu" | "cpu" | "both" }`. In `fleetTemps()`, derive `source` from the winning item: `gpu === cpu` → `"both"`, otherwise whichever axis equals `max`. **Tie → both** (owner decision, 2026-11-27). Item ordering and `max` stay as they are. Equality is exact on the reported values (no tolerance): agent readings are already rounded to 0.1 °C [INFERENCE: matches the screenshot's 75.8; verify against the snapshot producer].

**View (`OverviewView.vue`):**
- Token: `hottest <span :class="{hot}">{{name}} {{label}} {{tempC}}°C</span>`, where label = `GPU` / `CPU` / `GPU/CPU` → `hottest DGX-1 CPU 75.8°C`. Keep the literal `hottest <span` so the existing source pin (`overview.test.ts:382`) still holds. The `hot` tint stays at ≥ `TEMP_WARN_C`, so a warm fleet is still visible in the page head once the row is gone.
- Delete `thermalAlertNodes`, `thermalAlertText`, the `.thermal-alert` block and its CSS. Drop the `TEMP_WARN_C` import only if nothing else uses it (the token still does → keep it).

**Tests:** delete the mount test at `overview-main-rail-iri159.test.ts:122-138` and the `:391` source pin (or flip it to `not.toContain`); update `overview.test.ts:455-473` to expect `source`, and add cases for GPU-wins, CPU-wins, and a GPU = CPU tie (`source: "both"`).

**Docs/mockups:** remove the alert row from `mockups/overview-adaptive.html` (`:58` CSS and its markup) and update the `:146` token, so the mockup no longer shows a rejected element. Optional.

**Rejected alternatives**
- *Keep the alert but make it max(GPU,CPU)*: that fixes the mismatch, but the owner asked to remove it, and it would still repeat the token and the node cards.
- *Show both axes in the token* (`GPU 70 / CPU 75.8`): noisier, and the token answers "what is hottest", not "all temps". The node cards and the small-tier temps card already show both.
- *Suffix form* (`hottest 75.8°C DGX-1 CPU`): proposed first; the owner chose `node axis value` instead.

No ADR needed: this is a local UI change and reverses nothing durable.

## Phased delivery plan

One ticket (Story/Task, not an epic):

**[IR-287](https://blastersystems.atlassian.net/browse/IR-287) — Overview: remove the thermal alert row; hottest token names its sensor (GPU/CPU)** · Story · Priority: Medium · IR Sprint 6
Acceptance criteria:
1. The Overview renders no `.thermal-alert` row at any temperature or tier; its computeds and CSS are gone.
2. `fleetTemps().hottest` includes `source: "gpu" | "cpu" | "both"`; a GPU = CPU tie gives `both`; it stays `null` when nothing reads.
3. The page-head token reads `hottest <node> <GPU|CPU|GPU/CPU> <t>°C` (e.g. `hottest DGX-1 CPU 75.8°C`) and keeps the `hot` tint at ≥ 70 °C.
4. Unit tests cover GPU-wins, CPU-wins, and a tie. The mount and source tests no longer expect the alert row. `pnpm test` and `pnpm build` are green.
5. The mockup `overview-adaptive.html` no longer shows the alert row (optional, may ship in the same PR).

Rollout: ordinary dev deploy. Rollback: revert the PR. There are no data or migration effects.

## Risks and open questions

1. ~~Token format~~ — **decided**: `hottest DGX-1 CPU 75.8°C`.
2. ~~Tie rule~~ — **decided**: show both (`GPU/CPU`).
3. **Mobile/small tier** shares the same page-head token (`overview.test.ts:382` "page-head token on every tier"), so the label lands on every tier and the head line gets ~4 characters longer (~8 on a tie). [INFERENCE] It still fits on one line on mobile. Check it at a 390 px width during implementation.
4. Removing the row reverses part of IRI-159's approved composition (the "degraded-only alert row"). Add a comment to IR-282/IRI-159 so the history is clear.

## Overlap findings

- In-repo: no open task or research file proposes changing the alert or the token (`grep -ril "thermal-alert\|hottest" tasks/` hits only `tasks/IR-282.md` and `tasks/IRI-046-overview-density-tiers.md`, both shipped work that introduced these elements).
- Jira (checked 2026-11-27): no open IR issue matches `text ~ "thermal" OR text ~ "hottest"`. Created IR-287.
