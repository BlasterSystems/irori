# Task: IRI-040 — Token macro views in the Analytics tokens lens (fleet, per cluster/node, per model; no proxy)

> **Rework 2026-10-28 (owner):** reuse the existing Analytics section instead
> of a standalone page. The macro views live inside the tokens lens
> (`#/analytics` → tokens); the `tokens-macro` endpoint, Tokens page, and nav
> item from the first iteration were removed before merge. Same endpoint
> (`GET /api/v1/analytics/tokens`), additively extended.

Epic: Irori v1 ([docs/PLAN.md](../docs/PLAN.md)) · Jira: [IR-118](https://blastersystems.atlassian.net/browse/IR-118) (IR Sprint 2 · 990) · Prior art: [IRI-039 research brief §3](../docs/research/IRI-039-research-brief.md) (SparkDash mechanism, verified line-level)

## Objective

Three **macro** token-usage views — fleet, per node/cluster, per model — over
the app-standard range selector, sourced **only from engine lifetime counters
via the agent probes** (M7 `token_ledger`). The capture proxy (M8) is never
required: direct engine traffic lands in `llm_snapshots` and the ledger diffs
it. Metrics everywhere:

| metric | definition |
|---|---|
| total | generated + input |
| generated | ledger `generated_tokens` |
| input (prompt) | ledger `prompt_tokens` |
| cache (cached) | ledger `cached_tokens` |
| cache hit % | cached / input × 100 (0 when input = 0) |

Ranges: the app-standard selector `30m 1h 4h 24h 7d(week) 30d(month) 90d`
(`ANALYTICS_RANGES`) — no new ranges. SparkDash's information architecture is
the inspiration; the rendering is Irori's own DS V2.1 Vue.

## Current state (verified 2026-10-28 — do not rebuild)

| Layer | What exists | Where |
|---|---|---|
| Storage | `token_ledger` in Postgres: per `(node, port, model)` × minute/hour/day buckets; **restart-safe** (`delta()`: counter regression → re-baseline, credit nothing); `unknown` model fallback; crash-safe state advance; retention prune | `apps/server/src/ledger.ts:60-67,107-153` |
| API | `GET /api/v1/analytics/tokens?range=&by=` — `groupBy` **cluster \| node** with cluster folding of member nodes; per-node series + top-20 models | `apps/server/src/analytics.ts:27,79,229,291` |
| Ranges | `ANALYTICS_RANGES = 30m/1h/4h/24h/7d/30d/90d` | `packages/core/src/analytics.ts:19` |
| UI | Analytics tokens lens (range-bound table + per-node series); Overview fleet token sum | `AnalyticsView.vue:231`, `OverviewView.vue:159,179` |

Storage is SparkDash-equivalent (better: Postgres + retention vs a 30 s JSON
file). The work is presentation inside the existing Analytics tokens lens.

## Acceptance criteria

- [x] `GET /api/v1/analytics/tokens` (unchanged route) additively carries
      `fleet` (the five macro metrics summed over the series scope — filters
      applied; `null` for other lenses) and macro `models[]` rows
      (`total`, `cacheHitPct`; whole-ledger sums, never the top-20 subset,
      capped at 100 rows, sorted by total).
- [x] Analytics tokens lens renders: fleet stat tiles, the existing
      cluster/node series chart, a By-cluster/node totals table folded from
      the series, and the per-model table with total/generated/input/cache/
      cache-hit columns. No new page, nav item, or route.
- [x] Contract tests for the lens extension (fleet sums, hit %, cluster
      folding, empty-ledger zeros); web helper tests (series totals, tiles,
      hit % formatting).
- [x] SPEC §9 + API.md + CHANGELOG updated; validate + docs-check green.

## Scope

### Included

- Additive tokens-lens fields (fleet + macro models) + AnalyticsView sections
  + tests + docs.

### Excluded

- Proxy-based capture (exists, M8/IR-42) — works without it.
- Pricing/cost per token (SparkDash has none; existing `token-cost` setting
  untouched).
- New tables, JSON ledger, an all-time range, or a new endpoint/page.
- SparkDash component code (React) — Irori renders its own DS V2.1 Vue.

## Plan

- [x] Core: additive lens response fields (`fleet`, macro `models[]`).
- [x] Server: whole-ledger model totals + fleet sums in the tokens lens.
- [x] Web: AnalyticsView tokens lens (tiles, group totals table, model table).
- [x] Tests: db-gated lens contract tests + web helper tests.
- [x] Docs (SPEC, API.md, CHANGELOG) + validate + docs-check.

## Architecture impact

- **ADR required:** No — read-time aggregation over the existing ledger; no
  new store, boundary, endpoint, or dependency.
- **Relevant ADRs:** 0006 (telemetry pipeline/rollups), 0002 (Postgres).

## Validation evidence

- **Gates** (2026-10-28, after the reuse rework): `pnpm build` rc 0; full
  workspace tests with `IRORI_TEST_DATABASE_URL` set green (3 db-gated
  tokens-lens tests vs the disposable `irori-test-pg` container: fleet sums,
  hit %, cluster folding, unknown-node fallback, empty-ledger zeros; web
  helper tests); `.agentic/bin/validate` rc 0; `.agentic/bin/docs-check` rc 0.
- **Live smoke** (first iteration, superseded visuals): tokens-macro endpoint
  + `#/tokens` page verified in-browser at 1280/390 px. After the rework the
  macro surfaces render inside `#/analytics` tokens; the endpoint contract
  tests above cover the data path (fixtures identical to the earlier live
  smoke: fleet {445, 145, 300, 142, 47.3%}, folded "GLM TP-3" cluster).
- **First-iteration artifacts removed before merge:** `tokens-macro` endpoint
  + service, Tokens page/route/nav item, `fetchTokenMacro` client.

## Review

- Correctness: _pending_.
- Security: read-only analytics surface; no new auth surface.
- Compatibility: additive response fields; existing consumers unaffected.
- Residual risks: cluster membership changes mid-range (tokens fold under the
  cluster currently owning the node — acceptable, documented); `unknown`
  model rows surface as their own model row; `fleet` follows the lens
  filters (setupId/nodeId), `models[]` is fleet-wide by design.
