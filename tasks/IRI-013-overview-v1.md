# Task: Overview v1 — fleet landing page (IRI-013 / IR-59)

## Objective

Implement `mockups/overview.html` (round 3, 2026-10-20) as the app's landing
page. Today the Overview is still the M2-era flat `NodeCard` grid in
`App.vue`; the mockup contract is: lens selector (default **Cluster**),
head hero with the six serving stats + 24h decode/prefill spark, power
card, NAS store card, all-in-one telemetry feed, worker PKG row, and a
disk-warn chip linking to cleanup. Usage KPIs intentionally stay in M8
(IR-42) — no M8 prerequisite.

## Acceptance criteria

- [ ] Lens segment: `Cluster · <model>` (default) / All fleet / per-node /
      nas — controls which cards render; per-node lens drills into detail.
- [ ] Head hero: decode (+peak), prefill (+cache hit), queue (running ·
      waiting), KV cache bar, TTFT p95 (+E2E), ITL p95 from existing
      `/api/v1/nodes/:id/llm` + `/llm/history`; 24h decode/prefill spark.
      ctx/MTP chips only if engineMeta/model metadata carries them — cut
      otherwise, no invented capture.
- [ ] Power card: fleet now, per-node W bars, coverage, Wh/1k output
      tokens — from the M7 analytics power lens.
- [ ] NAS card: model count, store bar (largest NAS mount), catalog
      freshness, modelctl version.
- [ ] Telemetry feed: all event classes in ONE feed (owner decision) —
      merge `GET /api/v1/events/recent` + live SSE; new `job` and `thermal`
      SSE event types; server keeps a bounded ring so reloads have history.
- [ ] Worker cards gain the PKG row (sparks: GPU→CPU→MEM→PKG→DISK).
- [ ] Head/overview card shows disk-warn chip → node cleanup drawer when
      reclaimable > 0.
- [ ] Empty states: no head / no NAS / no events render gracefully.
- [ ] Tests: pure view models (no DOM), SSE schema parse, ring bound,
      endpoint shape; source-text pins per chrome-markup convention.

## Scope

### Included

- core: `job` + `thermal` SSE event schemas (packages/core/src/events.ts).
- server: bounded recent-events ring, `job-done` emission on job settle,
  thermal-transition emission from snapshot diffs, `GET /api/v1/events/recent`.
- web: `OverviewView.vue` (extracted from App.vue fleet branch), hero/power/
  NAS/feed view models, `card-data.ts` PKG row, live.ts frame handling.
- docs: SPEC §8 (overview) amendment if needed, PLAN.md epic row.

### Excluded

- Usage KPIs (M8 / IR-42 land on this page later).
- Serve start dialog, Settings page, events/annotations for decode drops,
  benchmark run-detail card (deferred per PM review).
- New capture for MTP accept / ctx unless already present via engineMeta.

## Plan

- [x] Inspect app.ts SSE wiring, events.ts union, llm-data, card-data,
      analytics power lens, jobs-service settle path.
- [x] Confirm architecture impact → none new (SSE contract extension is an
      additive enum case; ADR-0006 validated contracts already cover the
      pattern).
- [x] Implement core schemas → server ring + emitters + endpoint.
- [x] Implement web OverviewView + view models + card-data PKG.
- [x] Tests alongside behavior (server integration + web view models).
- [x] Update docs; run validation.

## Architecture impact

- **ADR required:** No — additive contract extension following ADR-0006's
  validated zod union pattern; no data-model, deployment, or trust-boundary
  change. The ring is in-memory and bounded (no new persistence).
- **Relevant ADRs:** 0006 (validated contracts), 0003 (privileged agent —
  untouched; thermal transitions are computed server-side from existing
  snapshots, no new agent surface).

## Validation evidence

- Configuration validation: `.agentic/bin/validate` — passed.
- Tests: `pnpm test` green — web 171 passed (new: `overview.test.ts` 15 —
  hero/primary-port/spark/power/NAS/feed view models + OverviewView source
  pins; `analytics.test.ts` +1 valueKeys; `card-data.test.ts` updated for
  PKG/DISK rows; `ds-markup.test.ts` App pin split, Overview vocabulary pin
  added). Server: `events-feed.test.ts` 8/8 (ring, cap, recent route,
  thermalTransitions) + `job-events.test.ts` 3/3 and `agent-update.test.ts`
  3/3 (IRI-012 regression) against a disposable Postgres 16 container
  (IRORI_TEST_DATABASE_URL); the default `pnpm test` run skips DB-gated
  suites when the URL is unset, same convention as m7/bench.
- Build: `pnpm build` green; `pnpm typecheck` green (includes test/).
- Documentation check: `.agentic/bin/docs-check` — passed (heuristic
  WARNING about API files is a false positive: the endpoint is documented
  in SPEC §13 + ARCHITECTURE.md Browser link).
- Live smoke (vite dev + TCP forwarder to dev hub 10.20.30.9:3947, TP-3
  data): overview renders the cluster lens by default with the DGX-1 hero
  (GLM-5.3-Flash-EXL3 · TENSORFOLD :8081, KV 36%, 24h decode+prefill spark
  with peak), Power card (fleet now 232 W, per-node bars, DGX-1/2/3/NAS),
  NAS card (130 models, 11.6/18.1 TB store, newest 1d ago), worker cards
  with GPU0/CPU/MEM/DISK, all-fleet + NAS lenses switch, telemetry feed
  card, Add node… primary. Zero console errors. On the old server the feed
  shows "waiting for events…" and `/events/recent` 404s are swallowed by
  design — job/thermal frames appear once the new server deploys.
- Fixed during smoke: OverviewView mounted before App's live.init() seeded
  the registry, so the spark missed the first 60 s — added a headNode
  watcher; removed the unreachable `lens === "nas"` variant (the mockup's
  NAS button is the NAS node's per-node lens) and derived the section
  title from the lensed node.

## Review

- Correctness: feed is one ring for all event classes (owner decision);
  hero speaks about the primary serving port; `ctx`/`MTP accept` chips cut
  (no capture exists — engineMeta rows would need EXL3 to publish them).
- Security: no new agent surface; SSE/REST read-only behind the same
  server (homelab no-auth boundary unchanged); ring is size-bounded and
  in-memory.
- Compatibility: new SSE cases are additive; old web bundles
  safeParse-drop unknown frames, so mixed-version rolling is safe. Old
  servers simply answer 404 on /events/recent and the client degrades.
- Residual risks: power/NAS/model-count cards poll on a 60 s interval (fine
  for homelab cadence); the Setups strip from mockup round 3 is not in
  this scope (needs setups view model + armed actions — candidate for a
  follow-up ticket); Wh/1k tokens cut (energy archive has no route).
