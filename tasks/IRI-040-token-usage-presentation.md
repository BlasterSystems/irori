# Task: IRI-040 — Token usage macro views: fleet, per node/cluster, per model (no proxy)

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
file). The work is a macro aggregation endpoint and a dedicated page.

## Acceptance criteria

- [x] `GET /api/v1/analytics/tokens-macro?range=` returns `fleet`, `clusters`,
      `nodes`, `models` — each row carrying total, generated, input, cached,
      cacheHitPct; sums cover the **whole** ledger for the range (never the
      top-20 cap; models capped at 100 rows); `cacheHitPct = cached/input`
      (0 when input = 0); cluster rows reuse the setup membership (head +
      workers, standalone as its own row).
- [x] Tokens page `#/tokens` (nav between Analytics and Usage) with three
      sections: **Fleet** stat tiles + fleet total-tokens trend (Sparkline
      over the analytics lens), **By cluster / By node** table (grouping
      toggle, node rows carry their cluster), **By model** table; range
      selector 30m / 1h / 4h / 24h / **week** (7d) / **month** (30d) / 90d;
      DS V2.1 + mobile-first 390px (browser-verified).
- [x] Contract tests for the macro endpoint (sums, hit %, cluster folding,
      empty-ledger zeros, route 200/400/503); web tests for the helpers
      (rows, hit % formatting, range labels, trend folding) + router case.
- [x] SPEC §9 + API.md + CHANGELOG updated; validate + docs-check green.

## Scope

### Included

- Macro aggregation endpoint + Tokens page + tests + docs.

### Excluded

- Proxy-based capture (exists, M8/IR-42) — works without it.
- Pricing/cost per token (SparkDash has none; existing `token-cost` setting
  untouched).
- New tables, JSON ledger, or an all-time range.
- Per-node detail card on the node page (the By-node table is the macro view;
  add later on request).
- SparkDash component code (React) — Irori renders its own DS V2.1 Vue.

## Plan

- [ ] `analytics.ts`: `tokens-macro` endpoint (fleet/clusters/nodes/models,
      whole-ledger sums, hit %).
- [ ] Contract tests for the response shape.
- [ ] Web: Tokens page (three sections, range selector, nav item).
- [ ] Web tests; mobile-first pass.
- [ ] Docs (SPEC, CHANGELOG) + validate + docs-check.

## Architecture impact

- **ADR required:** No — read-time aggregation over the existing ledger; no
  new store, boundary, or dependency.
- **Relevant ADRs:** 0006 (telemetry pipeline/rollups), 0002 (Postgres).

## Validation evidence

- **Gates** (2026-10-28): `pnpm build` rc 0; full `pnpm -r test` with
  `IRORI_TEST_DATABASE_URL` set → core 95, proxy 22, web 259, db 5,
  agent 176, server 204 — all green (the 3 new db-gated `tokens-macro` tests
  ran against the disposable `irori-test-pg` postgres:16 container);
  `.agentic/bin/validate` rc 0; `.agentic/bin/docs-check` rc 0 (after adding
  the endpoint to `docs/API.md`).
- **Live smoke** (local): built server + test Postgres with fixture
  nodes/setup/ledger rows →
  `GET /api/v1/analytics/tokens-macro?range=24h` returned
  fleet {total 440, generated 150, input 290, cached 140, hit 48.3%}, the
  folded "GLM TP-3" cluster row, per-node rows with cluster names; browser
  check of `#/tokens` at 1280 px and 390 px (fullPage): nav item active,
  five fleet tiles match the API, week/month range tabs, By cluster ↔ By
  node toggle renders node rows with their cluster sub-line, By model table
  includes the zero-input model at 0.0% hit; no horizontal overflow.

## Review

- Correctness: _pending_.
- Security: read-only analytics surface; no new auth surface.
- Compatibility: additive endpoint; existing lenses untouched.
- Residual risks: cluster membership changes mid-range (tokens fold under the
  cluster currently owning the node — acceptable, document it); `unknown`
  model rows surface as their own model row.
