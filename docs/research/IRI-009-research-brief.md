# IRI-009 research brief — OMP-style LLM usage telemetry via Irori capture proxy

- **Date:** 2026-10-17
- **Ticket:** IRI-009 (M8) — Jira epics [IR-42](https://blastersystems.atlassian.net/browse/IR-42) (v1), [IR-51](https://blastersystems.atlassian.net/browse/IR-51) (phase 2, deferred)
- **Goal:** Can an Irori LLM proxy collect OMP-stats-grade usage telemetry for local engines, and what exactly should v1 capture?

## 1. How OMP stats works (verified against the live instance)

`http://127.0.0.1:3847/#/overview` ("omp stats") is a bun-served SPA (PID 12573, `lsof -nP -iTCP:3847 -sTCP:LISTEN`). The **client harness is the sensor**:

```
OMP agent ──writes──> ~/.omp/agent/sessions/<project-slug>/*.jsonl
        │              (every LLM request: full payload, usage, TTFT, duration,
        │               stopReason, errorMessage, agentType, retryRecovery)
        ▼  tail-scanner (file_offsets: per-file byte offset + parser_state)
~/.omp/stats.db (SQLite): messages, user_messages, tool_calls
        + message_rollup (bucket × model × provider × folder × agent_type),
          tool_rollup, session_rollup, frustration_verdicts, dirty flags
        ▼  /api/stats/* read endpoints (aggregate on read)
        ▼  /api/events — SSE: {"version":137,"sync":{"phase":"idle",…}}
SPA: 11 pages, range 1h/24h/7d/30d/90d/All in URL, light/dark
```

Per-request record (verbatim shape from `/api/stats/errors?range=24h&limit=1`):

```json
{
  "id": 30836, "sessionFile": "/Users/…/sessions/-Developer-irori/….jsonl", "entryId": "05dd648a",
  "folder": "-Developer-irori", "model": "GLM-5.3-Flash-EXL3", "provider": "DGX",
  "api": "openai-completions", "timestamp": 1792247476123, "duration": 301159.43,
  "ttft": null, "stopReason": "error",
  "errorMessage": "OpenAI completions stream timed out while waiting for the first event",
  "usage": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0,
             "premiumRequests": 0, "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0 } },
  "agentType": "main", "serviceTier": null, "costUnpriced": false
}
```

`folder` (project), `agentType` (main/subagent), `stopReason`, retry lineage (`retryRecovery: {kind:"auto-retry", status:"recovered", attempt, supersededBy:{responseId,…}}`) all come from **harness-side knowledge** — OMP writes the session files itself.

## 2. OMP stats API + page inventory (extracted from `index.js`, 610 KB bundle)

API paths: `/api/stats/overview|model-dashboard|costs|recent|errors|frustration|folders|gain|tools|providers|provider-windows`, `/api/request/:id`, `/api/sessions`, `/api/session/trace?file=`, `/api/session/entry?file=&id=`, `/api/frustration/{estimate,judge,cancel}`, `/api/sync` (POST), `/api/events` (SSE).

| Page | Content | Notes |
|---|---|---|
| Overview | KPI cards + sparklines (cost, requests, tokens, cache rate, error rate, uncached input, cache read, TTFT, tok/s, premium), hourly activity chart, token mix by component + main/subagent, latest requests | range + live SSE age |
| Models | Per-model aggregates + `modelSeries` + `modelPerformanceSeries` (TTFT/tok/s per bucket) | |
| Providers | Burn by provider (stacked hourly), totals, **peak burn hours by local hour-of-day** | owner cut (localAI focus) |
| Requests | Latest-500 log, filters, status chips; row → full payload | median + p95 duration/TTFT |
| Errors | **Normalized-message signature groups**, affected models, failure list → payload | |
| Traces | Per-session wall/model/tool/idle time, turns, agents, background | reconstructed from JSONL |
| Tools | Calls, errors, args/result chars, token share per tool × model | |
| Costs / Frustration / Gain | API-equivalent pricing, LLM-judged sentiment (job runner), snapcompact savings | **owner cut** |

## 3. Wire-capture verification (the decisive test)

Probe: `POST http://dgx1.as267.com:8081/v1/chat/completions` (TensorFold/EXL3 behind OMP's "DGX" provider, `~/.omp/agent/config.yml`: `baseUrl: http://dgx1.as267.com:8081`, `api: openai-completions`), streaming with `stream_options: {include_usage: true}`. Final chunk (verbatim, 2026-10-17):

```json
{
  "tensorfold": { "prefill_s": 0.7778, "decode_s": 0.4541, "rounds": 2, "drafts": true,
                  "cached": 0, "drafted": 2, "accepted": 1, "sha256": "08bd3d4e9c76c1ca",
                  "tokens_per_round": 1.5, "parallel": 8, "policy": "auto", "token_sha": "2230a47c324b" },
  "usage": { "prompt_tokens": 1221, "completion_tokens": 4, "total_tokens": 1225,
             "prompt_tokens_details": { "cached_tokens": 0 },
             "completion_tokens_details": { "reasoning_tokens": 4 } }
}
```

**Conclusion:** a proxy sees everything OMP's stats shows minus harness-side fields — and *more*: the `tensorfold` block (prefill/decode split, speculative-decoding drafted/accepted, prompt hash) is engine-internal and invisible to client-side harnesses. TTFT/duration/tok-s come from stream timing; stop reasons and errors from the stream/status. **The proxy is a better sensor for the fleet** (all clients, no cooperation) and joins naturally with M3 probes + node telemetry (GPU power/temp, KV%, queue at request time).

## 4. What the wire does *not* carry (caveats → phase 2)

| OMP feature | Proxy visibility | Resolution |
|---|---|---|
| Project/folder | Source IP / API key only | Phase 2: per-client keys / `X-Irori-Project` header |
| main vs subagent | Invisible | Phase 2: `X-Irori-Agent-Type` header |
| Tool calls + results | Derivable (tool_call deltas; `role:"tool"` in next request) | Phase 2: payload parsing + correlation |
| Traces / idle time | Approximable (client request gaps); no true user-think time | Phase 2 |
| Retry lineage | Client-side retries invisible | Phase 2: `X-Irori-Retry` contract |
| Costs, premium requests | N/A locally (subscription concept) | Owner cut |

## 5. Session/chat reconstruction feasibility (phase-2 groundwork)

Every OpenAI-compatible request body **is a full conversation snapshot** (`messages[]` = system/user/assistant/tool history). Reconstruction needs no merging across requests: take the last request of a session + its final response stream. Images arrive as base64 data URLs (byte-exact, OMP sends vision to DGX — config `vision: DGX/GLM-5.3-Flash-EXL3`); file contents arrive verbatim inside `role:"tool"` results. Grouping: same client + append-only prefix chaining (request N+1 ⊇ request N), with `tensorfold.sha256`/`token_sha` for prefix identity; context compaction breaks prefix chaining (detectable: large input drop + hash mismatch → mark "compacted"). Limits: yields exactly what the model saw — harness-side truncation is visible as such, original binaries are not recoverable. **Requires body retention** (phase 2, default off): gzipped bodies + sha256 content-addressed dedupe (every turn re-sends the same attachments).

## 6. Owner decisions (2026-10-17)

1. Scope: **no Costs, Gain, Frustration, Providers** — localAI focus.
2. Retention: **90 days** raw (OMP parity); hourly/daily rollups 1 y.
3. Node-local **SQLite WAL buffer** (durable) + in-memory ring → **batched WS sync** to Postgres (30–60 s / 500 events, UUID `ON CONFLICT DO NOTHING`) — protects pgsql (ADR-0002 pattern).
4. Caveat-tied features **deferred** → phase-2 epic IR-51.
5. Proxy lives **in the agent as extractable `packages/proxy`** (modelctl-style boundary, but TS-native — no separate repo until nodes without agents need it); opt-in per setup; not a gateway (no routing/fallbacks/auth).

## Summary of findings

- Yes — an in-agent pass-through proxy collects all in-scope OMP-stats functionality natively; the DGX engine already reports cached/reasoning tokens and richer engine metrics per request (§3).
- OMP's architecture (client-harness logging + scanner + SQLite + read-time aggregation) transfers to Irori as (network capture + SQLite node buffer + batched WS + Postgres raw/rollups); retention 90 d raw / 1 y rollups.
- v1 = native wire fields only (IR-42); attribution/reconstruction/tools deferred to IR-51 with the phase-2 plan in §4–§5.
