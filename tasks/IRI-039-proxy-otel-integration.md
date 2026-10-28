# Task: IRI-039 — OTEL logs & traces for the app (env-gated export; proxy gen_ai spans)

Jira: [IR-116](https://blastersystems.atlassian.net/browse/IR-116) (traces),
[IR-117](https://blastersystems.atlassian.net/browse/IR-117) (logs) — both in
IR Sprint 2 (990). Research:
[IRI-039 research brief](../docs/research/IRI-039-research-brief.md).

## Objective

Give the Irori app a standards-based logs-and-traces surface without touching
the native capture pipeline: when an OTLP endpoint is configured, the capture
proxy emits one OpenTelemetry GenAI span per captured request, the hub emits
low-cardinality request spans, and both processes bridge pino logs to OTLP;
when unset, behavior is exactly today's. Irori's own pipeline
(`llm_requests`, `token_ledger`, ADR-0006 rollups) remains the source of
truth — OTEL is an export surface, not a new store. Token spend is counted
the same way as before (owner decision 2026-10-28): the dual-stream M7
counter-diff ledger + M8 per-request capture; no pricing model.

## Acceptance criteria

- [x] `traceparent`/`tracestate` forwarded upstream verbatim and attached to
      the emitted event; regression test pins the behavior
      (`packages/proxy/test/proxy.test.ts`, real-socket mock engine).
- [x] Span mapping unit-tested via `InMemorySpanExporter` (attributes, remote
      parent from W3C context, kind, explicit start/end from the capture
      timestamps) — `apps/agent/test/otel.test.ts`.
- [x] Server request spans: env-gated middleware, `/healthz` skipped,
      UUID/numeric path segments normalized to `:id`, 5xx → ERROR status —
      `apps/server/test/otel.test.ts`.
- [x] Fail-open: no-throw contracts everywhere (garbage trace context, unset
      env, sink errors); `shutdownOtel()` flushes the batching window on
      SIGTERM in both processes.
- [x] Unset env = no-op (`initOtel` returns false, `otelLogBridge` null, no
      provider); agent bundle delta measured and recorded below.
- [x] pino JSON logs in server + agent; all `console.*` call sites migrated
      (server 30, agent 2); job/setup log streams untouched; OTLP log bridge
      env-gated and unit-tested via `InMemoryLogRecordExporter`.
- [x] Docs: `DEPLOYMENT.md` (OTEL section), `SPEC.md` §1 non-goals + §14,
      `CHANGELOG.md`.
- [x] `pnpm build` + `pnpm test` + `.agentic/bin/validate` (rc 0) +
      `.agentic/bin/docs-check` (rc 0, 13 changed files, no gaps) green.

## Implemented deviations from the draft ACs

- **Emission lives in the agent, not `packages/proxy`**: `packages/prox`y
  stays dependency-light (extractable per ADR-0008); `apps/agent/src/otel.ts`
  maps the captured `UsageRequest` → GenAI span. `packages/proxy` only gained
  the two optional wire fields' capture (`packages/core/src/usage.ts`) — a
  mechanical header attach in `emit()`.
- **Hub spans are manual middleware, not `@opentelemetry/sdk-node` +
  `instrumentation-express`**: the server is ESM and require-in-the-middle
  patching is not reliable there; ~40 env-gated lines beat a loader dep.
- **pino without worker transports**: `pino.multistream` in-process
  (stdout + OTLP bridge `Writable`) — bundle-safe for the single-file agent;
  `pino-opentelemetry-transport` needs a worker module path that a bundled
  agent cannot resolve. The agent keeps its `log(message)` call convention
  via a thin wrapper (pino v10 logger instances are not callable).
- **No global OTel registration**: tracer comes from the local
  `BasicTracerProvider`; W3C extraction uses an explicit
  `W3CTraceContextPropagator` (the API global propagator is a no-op unless
  registered).

## Validation evidence

- **Typecheck** green: core, proxy, server, agent (after rebuilding `core`/
  `db` dists — the tree's `packages/db` node_modules needed a root
  `pnpm install` after the dependency add).
- **Tests** (2026-10-28): proxy 23/23 (incl. the new trace-context
  forwarding + event-attach case), agent 181/181 (incl. 5 new otel tests),
  server 116 passed / 89 db-gated skipped (incl. 4 new otel tests); full
  `pnpm test` rc 0.
- **Build**: `pnpm build` rc 0. Agent bundle `dist/irori-agent.mjs`
  3,197,719 B vs 2,476,478 B pre-change local dist → **≤ +721 KB (+29%)**
  upper bound (otel SDK/exporters + protobuf + pino bundled; the baseline
  dist predates the latest phase-2 code, so the true otel delta is smaller).
  Acceptable for a systemd-loaded bundle; recorded per AC.
- **Live smoke** (2026-10-28, local): built server (degraded mode, no
  `DATABASE_URL`) + throwaway OTLP/HTTP sink on :14318, env
  `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:14318`,
  `OTEL_SERVICE_NAME=irori-server-smoke`:
  `curl /healthz` → 200, `curl /api/v1/nodes` → 503 (expected degraded);
  sink received **`/v1/traces` 1 request / 970 B protobuf** (healthz span
  skipped, nodes span exported) and **`/v1/logs` 1 request / 1186 B** after
  the SIGTERM flush; boot logs render as pino JSON
  (`{"level":30,...,"service":"irori-server","msg":"otel trace export enabled → …"}`).
  Backend choice (Jaeger vs Alloy) intentionally not made — the sink proves
  the wire; the AC's Jaeger recipe is documented in `DEPLOYMENT.md` once the
  owner picks.
- Gates: `.agentic/bin/validate` rc 0; `.agentic/bin/docs-check` rc 0.
  PR #61 CI green (verify 1m35s + docs-check).

## Scope

### Included

- Stage 1 only (Option A in the brief §2.3): export from Irori components to
  a user-run OTLP backend.

### Excluded

- Option B: OTLP receiver/storage/UI in `apps/server` (deferred, brief §2.4).
- Sidecar collector packaging/CD (deployment recipe only, backend TBD).
- Costs/pricing, vendor presets (Langfuse etc.).
- Capturing prompt/response content on spans (content stays in IR-52's
  opt-in body store).
- Token-spend changes (owner: "counter token spend the same way").

## Plan

- [x] Research: [IRI-039 research brief](../docs/research/IRI-039-research-brief.md).
- [x] Tickets IR-116/IR-117 minted in IR Sprint 2 (990), Relates-linked.
- [x] `packages/core` wire fields + `packages/proxy` header capture + tests.
- [x] `apps/agent` OTEL module + wiring + tests.
- [x] `apps/server` OTEL middleware + init/shutdown + tests.
- [x] pino migration + OTLP logs bridge (both apps).
- [x] Docs + live smoke.
- [ ] PR, CI, Jira evidence.

## Architecture impact

- **ADR required:** No — export-only, env-gated, no new store or boundary
  (brief §2.3/§2.4). Revisit if Stage 2 (OTLP receiver) is ever proposed.
- **Relevant ADRs:** 0008 (capture proxy — exporter obeys its fail-open rule),
  0006 (telemetry pipeline remains source of truth), 0003 (agent trust model —
  no new inbound surface; OTLP is outbound).
