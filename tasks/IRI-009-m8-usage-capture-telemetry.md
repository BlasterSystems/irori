# Task: IRI-009 — M8 LLM usage capture & telemetry

Epic: Irori v1 ([docs/PLAN.md](../docs/PLAN.md) M8) · Jira: [IR-42](https://blastersystems.atlassian.net/browse/IR-42) (phase 2 deferred: [IR-51](https://blastersystems.atlassian.net/browse/IR-51))

## Objective

Irori becomes the capture point between LLM clients and local engines: an
opt-in pass-through proxy (`packages/proxy`, inside the agent) records
per-request usage — tokens (incl. cached/reasoning), TTFT, tok/s, finish
reasons, errors, engine metrics — for **every** client with zero cooperation,
stored via a node-local buffer and batched WS sync into Postgres, surfaced in
a Usage UI section (Overview, Requests, Errors, Models). Rescopes the deferred
SPEC §14 "inference gateway" to capture-only. Research:
[IRI-009 research brief](../docs/research/IRI-009-research-brief.md).

## Acceptance criteria

- [x] `packages/proxy`: pass-through OpenAI-compat reverse proxy; streaming
      byte-identical vs direct engine call; per-request capture event
      (TTFT, duration, tok/s, finish reason, errors, prompt/completion/
      cached/reasoning tokens, TensorFold block, payload sizes, source addr);
      capture failure never affects traffic; mock-engine fixture tests.
- [x] Agent: proxy listener in the esbuild bundle; SQLite WAL buffer
      (90 d, bounded) + server-side feed ring; batched WS upload (30 s
      default / 500 events) with exactly-once replay (`ON CONFLICT DO
      NOTHING`); prune.
- [x] WS-outage + agent-restart replay: zero loss, zero duplicates.
- [x] Setup opt-in: flagged setups bind engine to loopback, expose the LAN
      port via the proxy; wizard checkbox + review; validation; health
      checks probe through the proxy; unflagged setups unchanged.
- [x] Server: `llm_requests` table + indexes (Drizzle), batched inserts,
      hourly/daily rollups (dirty-flag refresh), retention 90 d raw /
      1 y rollups + prune job, live ring + SSE fan-out.
- [x] API: `/api/v1/usage/overview|requests|errors|models?range=` with
      filters + pagination; contract tests; SPEC §13 updated.
- [x] Web Usage section: range selector (URL state) + live SSE indicator;
      Overview (KPIs/sparklines, activity chart, token mix), Requests
      (filters + drawer), Errors (signature groups), Models (TTFT/tok/s
      series); DS V2.1 + mobile-first 390px.
- [x] ADR: capture-proxy architecture (in-agent vs gateway vs harness
      logging), buffer/sync/retention decisions — accepted + indexed
      (ADR-0008, Accepted 2026-10-20 after adversarial review).
- [x] Docs: SPEC §13/§14 updated; M8 exit: live traffic through a flagged
      setup populates all four pages; validate + docs-check green.

## Scope

### Included

- v1 native wire capture only; node as a filter dimension (no Providers page).

### Excluded

- Costs, frustration, gain metrics (owner cut); providers dimension.
- Phase 2 (IR-51): body retention + chats reconstruction, tool attribution,
  client identity (`X-Irori-*` / per-client keys), retry lineage.

## Plan

- [ ] Research: IRI-009 brief (OMP stats architecture, wire probe, caveats).
- [ ] ADR first (architecture-reviewer), then proxy package, agent, server, web.

## Architecture impact

- **ADR required:** Yes — agent gains a network listener; new tables; data
  path decision (in-agent buffer + batched sync vs central gateway).
- **Relevant ADRs:** 0002 (Postgres storage, degrade-gracefully),
  0003 (privileged agent, outbound WS — new listener must fit the trust
  model), 0006 (telemetry pipeline, rollups).
- **Proposed ADR:** `00NN-capture-proxy-usage-telemetry.md`.

## Validation evidence

- **Unit/contract suites** (2026-10-20): `pnpm test` — core 54, proxy 8,
  web 182, agent 132, server 72+48 db-gated (all green). New suites:
  `packages/proxy/test/proxy.test.ts` (byte-identity, TensorFold/usage
  extraction, error signatures, fail-open sink, client-abort, upstream-down),
  `packages/core/test/usage.test.ts`, `apps/agent/test/usage.test.ts`
  (buffer durability/dedup, batch ack/replay, prune), 
  `apps/agent/test/setups-capture.test.ts` (proxy bind before spawn, $PORT
  injection, bind-failure refusal, agent-restart re-attach),
  `apps/server/test/usage.test.ts` (hub batch/ack/SSE routing + API
  contract), `apps/server/test/usage-rollups.test.ts` (db-gated: UUID dedup
  across redelivery, watermark rollups, four endpoints on real Postgres,
  retention), `apps/web/test/usage.test.ts` + ds-markup pins.
- **Gates**: `pnpm build` ✅, `.agentic/bin/validate` ✅, `.agentic/bin/docs-check` ✅
  (db-gated suites ran against a disposable `postgres:16-alpine`).
- **Live e2e smoke** (local, real components): built server (dist, Postgres)
  + built agent bundle + mock OpenAI engine spawned through a flagged setup
  (`captureProxy: true`, port 18081). Verified end to end: engine answers
  through the proxy; health probes detect `mock-glm` → setup `healthy`;
  streaming + non-streaming + 400 traffic captured with full fidelity
  (TTFT 23 ms, decodeTps, cached/reasoning tokens, TensorFold block,
  setupId, source addr); all four API pages populated; live SSE `usage`
  frames in the events feed; UI (built SPA, served by the server) renders
  all four tabs with live data at 1280 px and 390 px (no page overflow);
  **WS-outage replay**: server killed, 2 requests captured offline, server
  restarted → agent replayed → 6/6 unique ids, zero dupes, zero loss.
- **Errors page** got its live data via a real 400 from the mock engine
  (signature `Model 'nope' not found (req U, attempt N)`); the
  upstream-unreachable path is fixture-tested (the proxy correctly closes
  with the dying engine).

## Review

- ADR-0008 drafted → adversarial review (blocking findings: rollups must key
  on **server ingest time** or replayed rows are silently lost; `$PORT`
  handoff is impossible server-side — agent injects the loopback engine port,
  `MODEL_PATH` precedent) → all 9 findings applied → **Accepted** in-session
  (owner, 2026-10-20) + indexed.
- Post-implementation fixes found by the live smoke: KPI aggregation must run
  **after** the open-bucket merge (else Overview shows zeros for the live
  hour); buckets only compute when complete → overview/models fold the open
  bucket's raw rows in on read; mobile: `.container` auto margins disabled
  cross-axis stretch in the `#app` column flex (token-mix table's mobile
  `min-width: 640px` widened the whole page) → mobile `.container { margin: 0 }`.
- Residual risks: `node:sqlite` is flagged experimental (stability 1.2 RC on
  Node 24 — warning logged once); fleet rollout is the next step (dev tag →
  dgx1 + workers, then flag the live GLM setup) — not done in this session
  per owner scope decision; the overview merges the open bucket on read, so
  percentiles for it are request-weighted approximations until the bucket
  computes.
