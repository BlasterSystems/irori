# IRI-039 research brief — Proxy integration surface, OTEL logs/traces in the app, and the SparkDash token-spend model

- **Date:** 2026-10-28
- **Ticket:** IRI-039 — new task [tasks/IRI-039-proxy-otel-integration.md](../../tasks/IRI-039-proxy-otel-integration.md) (not yet on Jira)
- **Goal:** Three questions the implementation depends on:
  1. What does "the proxy" refer to, and what remains to integrate it "in the app"?
  2. How can logs and traces (OpenTelemetry) be integrated in the Irori app — server, agent, proxy, and (optionally) engines?
  3. How does SparkDash know token spend, and what does that mechanism mean for Irori?

---

## 1. "The proxy" — the M8 capture proxy, and what "integrating it in the app" still means

### 1.1 What it is

`packages/proxy` is the ADR-0008 **capture proxy**: an in-agent, opt-in pass-through
listener in front of a loopback-bound engine. Purpose statement, verbatim
(`packages/proxy/src/proxy.ts:9-11`):

> *"Capture proxy (M8, ADR-0008): a raw byte pipe in front of a loopback engine
> with a passive, capped tee. The forwarding path never inspects or reinterprets
> the exchange — capture failures degrade to pass-through."*

Key properties (file:line):

| Property | Evidence |
|---|---|
| Raw byte pipe, byte-identity streaming | `proxy.ts:139` `forward()`; "Byte-identity: raw chunk out, in arrival order." (`proxy.ts:225`) |
| Only hop-by-hop headers stripped | `proxy.ts:18-30` `HOP_BY_HOP` set (verified 2026-10-28: **`traceparent` is not in the set** — it is forwarded verbatim) |
| Binds `0.0.0.0`, targets loopback engine | `proxy.ts:116` `server.listen(this.opts.listenPort, "0.0.0.0", …)`; ADR-0008 §7 |
| Selective capture: only `POST /v1/{chat/completions,completions,embeddings,responses}` | `capture.ts:112-117` `Capture.wanted()`; regex `CAPTURED_ENDPOINT_RE` at `packages/core/src/usage.ts:255` — probes (`/metrics`, `/health`) forwarded uncaptured (ADR-0008 §2: otherwise "~40 k noise rows/day/port") |
| Parse caps | `MAX_BODY_PARSE_BYTES = 64 MiB`, `MAX_RESPONSE_PARSE_BYTES = 4 MiB` (`capture.ts:529,531`), `MAX_SSE_LINE_BYTES = 1 MiB` (`capture.ts:42`) |
| Fail-open everywhere | "Fail-open: a throwing sink or parser never affects traffic." (`proxy.ts:248`) |

### 1.2 How it is already integrated end-to-end

The app wiring exists and is shipped (per ADR-0008 **Accepted** 2026-10-20;
verified against the tree 2026-10-28):

```
client → setups.port (agent CaptureProxy, 0.0.0.0) ──raw bytes──▶ 127.0.0.1:$PORT engine
                     │ tee (fail-open, capped)            (streamed back byte-identical)
                     ▼
          Capture → UsageRequest (zod) → UsageBuffer (node:sqlite WAL)
                     ▼  every 30 s / ≤500 events, 48 MiB part budget
          WS "usage-batch" → hub (serialized) → usageStore.insertBatch (ON CONFLICT DO NOTHING)
                     │                                        │ ack usage-batch-ack {ids}
                     ▼                                        ▼
          llm_requests + llm_parts/llm_request_parts + llm_request_tools
                     → usage-rollups (watermark, hourly/daily usage_buckets)
                     → 60 s loop + prune (90 d raw / 365 d buckets)
                     → /api/v1/usage/* → UsageView / ChatsView (SSE live)
```

- Setup opt-in: `apps/agent/src/setups.ts:239-280,459-463` (pre-spawn bind,
  `$PORT` injection, re-attach); server sends the `capture {proxyPort,
  retention}` frame (`apps/server/src/setups-service.ts:458-479`); wizard
  checkbox per IRI-009.
- Node buffer: `apps/agent/src/usage-buffer.ts` — `node:sqlite` WAL,
  `IRORI_USAGE_FLUSH_MS` (30 000) / `IRORI_USAGE_MAX_ROWS` (200 000) knobs
  (`config.ts:83-86`, documented `docs/DEPLOYMENT.md:74-76`).
- Sync + exactly-once ingest: `apps/agent/src/usage-sync.ts` (one batch in
  flight, 15 s ack deadline); hub acks only after insert
  (`apps/server/src/index.ts:317-322` — *"no ack — the agent's durable buffer
  redelivers"*); `usage-store.ts:292-408` validates, `onConflictDoNothing()`
  inserts, and applies parts/tools/refcounts only for `insertedIds`.
- Retention: 90 d raw / 1 y buckets (`index.ts:176-178`), `startPruneLoop`
  (`index.ts:446`), refcounted part sweep (`usage-store.ts:866-869`).
- API/UI: `GET /api/v1/usage/{overview,requests,errors,models,agents,tools,clients,chats}`
  (`apps/server/src/app.ts:509-642`); `UsageView.vue`, `ChatsView.vue`.
- Phase 2 (ADR-0010: body retention IR-52, chats IR-53, tools IR-54, client
  identity IR-55) is implemented in-tree (migrations 0012–0014,
  `phase2-smoke.test.ts`, CHANGELOG `[Unreleased] — Usage phase 2`) and IR-52..55
  are **Done** on Jira (checked 2026-10-28). Doc debt: `docs/adr/0010-…`
  still reads `Status: Proposed` while its own Implementation section records
  the shipped PRs — worth a status flip in the ADR.

### 1.3 What "integrating the proxy" still means

Nothing structural in-repo. The remaining integration is **operational**:

1. **Fleet rollout** of the current agent bundle (DGX-1/DGX-3 run
   dev-0.3.0-48; DGX-2 and the NAS agent are on older bundles without the
   capture proxy).
2. **Flag the live setup** (`captureProxy: true`) so the GLM TP-3 cluster's
   port binds to loopback and traffic flows through the proxy — un-proxied
   setups capture nothing.
3. Optionally surface proxy state (attached/detached, capture counts) on the
   node page — nice-to-have, not blocking.

**Conclusion:** "integrate the proxy in the app" = ship the built thing to the
fleet and turn it on. New engineering scope lives in §2 (OTEL), not here.

---

## 2. Logs and traces (OTEL) in the app

### 2.1 Current state: no OTEL, no logger

Verified 2026-10-28 by grep over **all seven** workspace `package.json` files
for `opentelemetry|pino|winston|jaeger|tempo|zipkin`: **zero matches**. Logging
is bare `console.log`/`console.error` with string prefixes; there is no logger
module, no spans, no trace context anywhere in server/agent/proxy. Irori's
"telemetry" today means its own metrics pipeline (ADR-0006) — not distributed
tracing.

### 2.2 What the ecosystem does (evidence, not conclusions)

**vLLM — native OTLP traces.** OpenTelemetry core packages ship *bundled* with
vLLM (`docs.vllm.ai/en/v0.27.0/examples/observability/opentelemetry/`):

> *"The core OpenTelemetry packages (`opentelemetry-sdk`, `opentelemetry-api`,
> `opentelemetry-exporter-otlp`, `opentelemetry-semantic-conventions-ai`) are
> bundled with vLLM."*

Enabled with one flag + env; gRPC default, `http/protobuf` switchable:

```shell
export OTEL_SERVICE_NAME="vllm-server"
export OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://$COLLECTOR:4318/v1/traces
vllm serve … --otlp-traces-endpoint="$OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"
```

The example shows **one trace per request** and span attributes following the
GenAI conventions: `vllm/tracing` defines `SpanAttributes` incl.
`gen_ai.usage.prompt_tokens` / `gen_ai.usage.completion_tokens` (renamed
`gen_ai.usage.input_tokens`/`output_tokens` in current semconv)
(`docs.vllm.ai/en/stable/api/vllm/tracing`). A client that injects
`traceparent` produces a client span + vLLM span in the same trace (the
bundled `dummy_client.py` does exactly this via `TraceContextTextMapPropagator`).

**LiteLLM proxy — OTel v2 as design precedent.**
(`docs.litellm.ai/docs/observability/opentelemetry_v2`) — opt-in
(`LITELLM_OTEL_V2=true`), one trace per request spanning HTTP → auth → LLM
call → DB write; *"every LLM-call span carries `gen_ai.*` attributes: model,
provider, token usage, cost, finish reasons"*; **prompts/responses are not
captured unless explicitly opted in**
(`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=span_only`); and:

> *"Distributed tracing — if your client sends a `traceparent` header,
> LiteLLM's spans nest inside your existing trace."*

**GenAI semantic conventions — the attribute vocabulary** (`opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai`;
canonical source now [semantic-conventions-genai](https://github.com/open-telemetry/semantic-conventions-genai)). The attributes that map 1:1 onto what the Irori capture proxy **already parses** per request:

| OTEL attribute | Irori `UsageRequest` field (already captured) |
|---|---|
| `gen_ai.operation.name` = `chat` | endpoint class from `CAPTURED_ENDPOINT_RE` |
| `gen_ai.request.model` / `gen_ai.response.model` | `model` / response model |
| `gen_ai.usage.input_tokens` | `usage.promptTokens` |
| `gen_ai.usage.output_tokens` | `usage.completionTokens` |
| `gen_ai.usage.cache_read.input_tokens` | `usage.cachedTokens` |
| `gen_ai.usage.reasoning.output_tokens` | `usage.reasoningTokens` |
| `gen_ai.response.time_to_first_chunk` (s) | `ttft` (proxy-measured) |
| `gen_ai.response.finish_reasons` | `finishReason` |
| `gen_ai.response.id` | response id from stream |
| `server.address` / `client.address` | engine loopback target / `source addr` |
| `gen_ai.provider.name` | engine backend (vLLM/TensorFold/…; custom value allowed) |

I.e. **the proxy is already a complete gen_ai span source** — emission is a
mechanical mapping, no new parsing.

**Node SDK state.** `@opentelemetry/sdk-logs` was just marked **stable**
(`opentelemetry-js` `experimental/CHANGELOG.md`, `0.300.0-rc.0`: *"feat(sdk-logs):
mark `@opentelemetry/sdk-logs` as stable"*). For pino there is an official
bridge, `pinojs/pino-opentelemetry-transport` — *"Outputs logs in the OpenTelemetry
Log Data Model and sends them to an OTLP logs collector"*, configured via
`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`. The contrib `@opentelemetry/instrumentation-pino`
path has open friction (issue #3292, "does not export logs to collector,
multiple approaches tested") — prefer the pino transport.

**Collector options for the homelab.** Jaeger all-in-one (single docker
container, OTLP :4317/:4318 — the exact backend in vLLM's POC) or Grafana
Alloy (*"an OpenTelemetry Collector distribution"* — OTLP receiver →
Loki/Tempo/Mimir or anything else). Both run fine on the existing Proxmox
docker VM (10.0.10.9) where uptime-monitoring already lives.

### 2.3 Options

| Option | What it is | Pros | Cons |
|---|---|---|---|
| **A. Env-gated OTLP export from Irori components** | `packages/proxy` emits one `gen_ai.*` span (+ optional log record) per captured request; `apps/server`/`apps/agent` get `@opentelemetry/sdk-node` spans + pino → `pino-opentelemetry-transport` logs; all export OTLP/HTTP to a user-run collector (Jaeger/Alloy) | Standards-based; correlates client ↔ proxy ↔ engine in one trace (vLLM continues it); reuses captured data (no double parse); zero effect when env unset; fits the fail-open proxy rule | New deps in the agent esbuild bundle (size/attack surface — must stay opt-in + dynamic); external backend is a new (tiny) ops surface |
| **B. Irori server as OTLP receiver** | Implement an OTLP/HTTP ingest endpoint in `apps/server`; store spans/logs in Postgres; render a trace view in web; vLLM points `--otlp-traces-endpoint` at Irori | Self-contained; "first-class telemetry" pitch; no external infra | New subsystem: protobuf/OTLP-JSON parsing, span storage + retention + query API + UI; big surface for a homelab; overlaps ADR-0002 degrade-gracefully concerns |
| **C. Sidecar collector only, doc recipes** | No repo code: run Alloy/Jaeger on the docker VM; point engines (vLLM) and later the proxy at it | Zero repo deps | Irori app itself has no logs/traces story; proxy currently emits nothing, so nothing to point *at* the collector |
| **D. Status quo** | Native capture + M2/M7 pipeline only | Zero cost | Doesn't answer the ask; no correlation; no standard logs |

### 2.4 Recommendation (decision-ready, owner may overrule)

**Stage 1 — Option A, env-gated (recommended):**

1. **Traces from the proxy**: one span per captured request with the §2.2
   attribute mapping; `traceparent` from the client is already forwarded
   verbatim (`proxy.ts:18-30`), and vLLM continues the trace natively — so
   client → Irori proxy → vLLM becomes **one trace** with zero protocol work.
   Must obey the fail-open rule: exporter errors are ignored; exporter loaded
   lazily only when `OTEL_EXPORTER_OTLP_ENDPOINT`/`IRORI_OTEL_*` is set.
2. **Logs**: adopt pino in server + agent (replacing raw `console.log`),
   bridge to OTLP via the official `pino-opentelemetry-transport`
   (env-gated; console transport remains when unset).
3. **Server spans**: `@opentelemetry/sdk-node` + `instrumentation-express`,
   env-gated; job/agent lifecycles get spans later if wanted.
4. Docs: `DEPLOYMENT.md` env table; SPEC §14 note (OTEL is an export surface;
   native capture stays the source of truth).

**Stage 2 — Option B deferred** (only if the owner wants Irori itself to be
the backend): OTLP receiver + `llm_spans` table. Not recommended now — the
same data is already queryable via `llm_requests`/usage API.

**Stage 0 (no code):** stand up Jaeger all-in-one on 10.0.10.9 to prove the
vLLM-side half today: `vllm serve … --otlp-traces-endpoint=http://10.0.10.9:4318/v1/traces`
+ a `traceparent`-injecting client. This validates the trace chain before any
Irori change.

### 2.5 Unknowns and how to measure

- **TensorFold / EXL3 / q27 / ds4-server OTEL support**: unknown (only vLLM is
  documented). Measure: check TensorFold's flag surface
  (`--help` / config schema) for `otlp`/`tracing`; if absent, the proxy span
  is the only trace hop — acceptable (client + proxy + nothing else).
- **Does OMP (harness) propagate `traceparent` to the DGX provider?**
  Measure: run the capture proxy against a flagged test setup, send an OMP
  request, grep captured request headers for `traceparent` (the tee sees raw
  bytes; the IR-52 body store can hold headers if added). LiteLLM's docs show
  harnesses commonly do.

---

## 3. How SparkDash knows token spend

### 3.1 TL;DR

SparkDash has **no cost/pricing model and no OpenTelemetry** — "token spend" is
pure **token counting** by **polling the engines' own lifetime counters** and
diffing them per `(spark, port)` series. Per-request capture exists only in
the sibling `sparkControl` proxy (opt-in, SQLite, 7 d retention). Evidence per
hop:

### 3.2 Hop 1 — raw sources: engine lifetime counters (`server/collectors/LlmProbe.js`)

Per-backend cumulative counters, verbatim field reads:

| Backend | Source | Fields | Ref |
|---|---|---|---|
| vLLM | Prometheus `/metrics` | `prompt_tokens_total`, `generation_tokens_total`, `prefix_cache_hits_total` | LlmProbe.js:1470-1486 |
| SGLang | Prometheus `/metrics` (+ `/get_server_info` fallback) | `sglang:prompt_tokens_total`, `sglang:generation_tokens_total`, `sglang:cached_tokens_total{cache_source="device"}` | LlmProbe.js:1883-1904, 1957-1963, 1628-1632 |
| EXL3 | `/health` | `prompt_tokens_total`, `completion_tokens_total` | LlmProbe.js:1151-1153 |
| TensorFold | `/health` | `prompt_tokens_total`, `completion_tokens_total`, `cached_tokens_total` | LlmProbe.js:1305-1324 |
| llama.cpp | `/slots` | per-slot `n_decoded`, `n_prompt_tokens_processed`, `n_prompt_tokens_cache` | LlmProbe.js:1671-1684, 2073-2076 |
| ds4 / q27 | Prometheus | computed-only prefill counter (`computed + cached`) | LlmProbe.js:968-978, 1074-1084 |

Exposed on the probe object (LlmProbe.js:148-157) and stamped into every
snapshot (`LlmProbe.js:2415-2418`): `totalOutputTokens`,
`totalPromptTokens`, `totalCachedTokens`.

### 3.3 Hop 2 — snapshot → poll loop

`server/sparks/SparkMonitor.js:1128-1134`: on the `llm` probe result each
`metrics.llm[i]` is recorded per `(spark.id, port)`. A parallel consumer,
`server/energy/FleetEnergyTracker.js:357-359` `_recordTokens()`, turns the
same counters into Wh/token efficiency.

### 3.4 Hop 3 — the ledger: diff counters, credit deltas

`server/llmtokens/LlmTokenLedger.js:2-8` (verbatim):

> *"How it works: LlmProbe already reports cumulative server counters in every
> snapshot (`totalOutputTokens`, and `totalPromptTokens` added locally). This
> ledger diffs consecutive observations per (sparkId, port) series and credits
> the delta to the model the server reported at that moment. Counters that go
> backwards mean the engine restarted — the baseline is re-seeded without
> crediting anything."*

- Sampling cadence independent of probes: `TOKEN_SAMPLE_INTERVAL_MS = 15_000`
  (`LlmTokenRuntime.js:10-11`; wired `server/index.js:500-501`).
- `extractTokenObservations` (`LlmTokenLedger.js:143-176`) pairs
  `snap.metrics.llm[i]` with `snap.llmPorts[i]`.
- `record()` (`LlmTokenLedger.js:306-380`): seeds baseline; credits
  `dOut>0 → completionTokens`, `dIn>0 → promptTokens` to
  `obs.modelId ?? series.lastModelId ?? UNKNOWN`; restart on `dOut < 0` or
  `dOut > 1e9`; daily/hourly buckets for ranges.
- Storage: `config/llm-token-totals.json` (gitignored; `server/config.js:21-23`),
  atomic flush 30 s, 35 daily / 72 hourly buckets, 200 series × 100 models
  (`LlmTokenLedger.js:14-33`).

### 3.5 Hop 4/5 — API and UI

- `GET /api/llm-token-totals?range=all|today|6h|1h|7d|14d|30d`,
  `/history`, `DELETE /api/llm-token-totals`
  (`server/llmtokens/LlmTokenRuntime.js:27-34`).
- Response per series: `totals {promptTokens, completionTokens, cachedTokens}`
  + per-model breakdown (`src/api/llmTokenTypes.ts:16-31`).
- UI: Tokens page (`TokensPage.tsx:70`), Overview KPI "Tokens in last 24
  hours" (`FleetKpis.tsx:104`), fleet token card 60 s poll
  (`FleetTokenTotals.tsx:80,:15`), per-spark panel
  (`SparkPage/LlmTokenTotals.tsx:32`). `computed = prompt − cached`
  (`tokenStats.ts:70-75`).

### 3.6 What SparkDash does **not** do

- **No OpenTelemetry**: only OTEL hit is an optional peer dep of a dev tool
  (`package-lock.json:3847` `"@opentelemetry/api": "optional"`).
- **No pricing / $ per token**: only electricity cost
  (`EnergyPage/energyStats.ts:267-268`) and a VultrHunter agent's `costUsd`.
  "Spend" = tokens, never currency.
- It *exports* its own Prometheus re-exposures
  `sparkdash_llm_{generated,prompt,cached_prompt}_tokens_total`
  (README.md:525-528, "The engine's own lifetime counters").
- **LiteLLM** appears only as an example gateway for optional per-port Bearer
  keys (CHANGELOG.md:478) — never queried.

### 3.7 The sibling path: sparkControl's per-request proxy

`sparkControl` (~/Developer/sparkControl) runs an OpenAI-compatible gateway:

- `app.use("/llm", createLlmProxy(...))` with routes
  `/llm/:sparkId/:port/*splat` + cluster gateway `/llm/cluster/:servedName/*splat`
  (`server/index.js:461-472`, `server/serving/deployments.js:1045`).
- Per-request extraction (`server/proxy/llmProxy.js:527-539`):

  ```js
  if (lastUsage) {
    promptTokens = Number.isFinite(lastUsage.prompt_tokens) ? lastUsage.prompt_tokens : null;
    completionTokens = Number.isFinite(lastUsage.completion_tokens) ? lastUsage.completion_tokens : null;
    const oai = lastUsage.prompt_tokens_details?.cached_tokens;
    const ant = lastUsage.cache_read_input_tokens;   // Anthropic-style
  } else if (stream) { // Usage absent on a streamed completion → estimate from deltas.
    completionTokens = deltaCount > 0 ? deltaCount : …; tokensEstimated = true; }
  ```

- Stored per request in SQLite `traces` (`server/collectors/TraceStore.js:27-56`
  — `promptTokens, completionTokens, tokensEstimated, cachedTokens`, 7-day
  retention); aggregated `SUM(...)` + `byModel`/`byClient`/`byHour` in
  `stats()` (`TraceStore.js:363-409`, served at `server/index.js:682-686`).
- sparkDash ↔ sparkControl link is **opt-in env-only** and carries **no token
  counts** (`InferenceActivity.js:92-133` — `active`/`recent` shapes only).

### 3.8 What this means for Irori

Irori already has **both SparkDash mechanisms, in stronger form**:

| SparkDash | Irori equivalent | Delta |
|---|---|---|
| `LlmProbe` counter sampling | `apps/agent/src/llm-probe.ts` already samples the same counters — vLLM `vllm:prompt_tokens_total` / `vllm:generation_tokens_total` / `vllm:gpu_prefix_cache_hits_total` → `out.tokens {generated, prompt, cached}` (llm-probe.ts:553-563); EXL3 `/health` (`:789-792`); TensorFold `/health` + `tensorfold:*` `/metrics` fallback (`:813-816`, `:853-867`) | Irori computes *rates* (prefill/decode tok/s) from the same samples; SparkDash stores raw counters |
| `LlmTokenLedger` counter-diff credit | `apps/server/src/ledger.ts` — `token_ledger` upsert of `dGen/dPrompt/dCached` deltas from `llm_snapshots`, per `(node, port, model, granularity, bucket)` (ledger.ts:152-165); M7 token ledger (generated/cache/prefill) | Same algorithm; Irori persists in Postgres with minute/hour/day retention prune (ledger.ts:184-188) vs SparkDash's JSON file |
| sparkControl `traces` per-request capture | `llm_requests` via the capture proxy (M8, §1.2) — richer (TTFT, tok/s, finish reasons, engine `tensorfold` block, parts/tools/identity) | Irori's is per-request-accurate incl. cached/reasoning split; sparkControl estimates streamed completion tokens when usage is absent |

**Takeaway:** SparkDash cannot tell *which request* consumed tokens (counter
diffs attribute to "the model the server reported at that moment"), while
Irori's proxy capture is per-request. The counter-diff ledger is, however, the
only way to see spend for **traffic that bypasses the proxy** (direct engine
hits) — Irori already covers that via M7. Nothing in SparkDash suggests a new
mechanism to copy; it confirms the dual-stream design Irori already has.

---

## Summary of Findings

1. **Proxy integration**: "the proxy" = the M8 capture proxy
   (`packages/proxy`, ADR-0008, Accepted). It is integrated end-to-end in the
   app (wizard opt-in → loopback bind → tee → SQLite buffer → WS → Postgres →
   4 usage pages). Remaining integration is operational: roll the current
   agent bundle to DGX-2 + NAS and flag the live GLM setup
   (`captureProxy: true`). Also flip ADR-0010 status to Accepted/ship-note —
   its implementation is merged and IR-52..55 are Done while the header still
   says Proposed.
2. **OTEL**: greenfield — zero OTEL deps repo-wide, `console.log` logging
   only. Recommended: **env-gated Option A** — proxy emits one `gen_ai.*`
   span per captured request (mechanical mapping from already-parsed fields;
   `traceparent` already passes through the proxy verbatim, and vLLM
   continues traces natively), server/agent adopt pino + official
   `pino-opentelemetry-transport` for OTLP logs, `@opentelemetry/sdk-node`
   for server spans. Destination: Jaeger all-in-one or Grafana Alloy on the
   docker VM. Option B (Irori as OTLP receiver) is a large new subsystem —
   defer. Native capture + M7 pipeline remain the source of truth; OTEL is an
   export surface. Stage-0 proof: point vLLM at a collector on 10.0.10.9 and
   inject `traceparent` from a client — no Irori code needed.
3. **SparkDash token spend**: engines' own lifetime counters (vLLM/SGLang
   Prometheus, EXL3/TensorFold `/health`, llama.cpp `/slots`) → 15 s counter-diff
   ledger (`LlmTokenLedger`) credited per model → JSON file → `/api/llm-token-totals`
   → UI. No OTEL, no pricing; per-request capture exists only in sparkControl's
   `/llm` proxy (SQLite, 7 d). Irori already has both mechanisms (M7
   `token_ledger` + M8 `llm_requests`), strictly stronger. Nothing to copy.

**Open (needs owner decision / measurement):**

- Which OTEL backend (Jaeger all-in-one vs Grafana Alloy vs LGTM) — affects
  only deployment docs, not code.
- Whether Stage 2 (OTLP receiver in `apps/server`) is ever wanted.
- TensorFold/EXL3 OTEL support — measure per §2.5 (flag surface check).
- OMP `traceparent` propagation — measure per §2.5 via captured headers.
- Jira epic/ticket for Stage 1 to be minted when the owner green-lights.
