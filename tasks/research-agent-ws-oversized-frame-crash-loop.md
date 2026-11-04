# Research — Agent WS oversized frame kills the hub (30 s crash loop)

Date: 2026-11-04 · Status: root-caused, epic filed — **IR-176** (+ IR-177/178/179, sprint 998) · Incident: dev hub 10.0.10.9:3947 crash-looping since 12:36:51Z (482 restarts by 13:54Z)

## Jira target

- **Project key**: `IR` — resolved from repo rules (`AGENTS.md`, Jira project IR at blastersystems.atlassian.net)
- **Site**: `blastersystems.atlassian.net`
- **Board**: `5` ("IR board") — resolved via `jira_get_agile_boards` (never reused from memory)
- **Active sprint**: `998` "IR Sprint 3" (2026-11-02 → 11-09, state `active`) — resolved via `jira_get_sprints_from_board(board 5, active,future)`
- **Issuetypes**: Epic / Task (per repo convention used by the IR-157 epic; created via the mounted Jira MCP tools which accept issue-type names)

## Summary

The dev hub (`irori-dev` container on LXC 106, image `dev-0.3.0-66`, server 0.4.0) **exits every ~30 s**. Docker restarts it (~2 s down window); the four fleet agents reconnect and **DGX-3 re-sends a durable-buffered usage batch whose serialized WebSocket frame exceeds the hub's 64 MB `maxPayload`**. The `ws` receiver emits `WS_ERR_UNSUPPORTED_MESSAGE_LENGTH` (1009) as an `'error'` event on the socket; **the hub never registers a socket `'error'` listener, so node's default throw kills the process**. The batch is never acked, stays in the agent's sqlite buffer, and is re-sent on every reconnect — a self-sustaining poison loop (482 restarts and counting).

The browser console the operator captured is pure fallout: `/api/v1/events` SSE streams truncate mid-chunk (`ERR_INCOMPLETE_CHUNKED_ENCODING`) on every death, and fetches landing in the ~2 s down windows get `ERR_CONNECTION_REFUSED`.

**Same bug ships in the v0.5.0 release images** (the code path is identical on `main`) — the fix must land on `main` and the released images should be superseded by the next patch.

## Current state (evidence)

| Fact | Evidence |
|---|---|
| Hub down ~1–2 s every 30 s | Tight probe 13:35:19 → 13:35:49 → 13:36:19 (healthz `000`); all-200s between windows |
| Container restarts, not VM/network | During a down window: ICMP alive + sshd on 10.0.10.9 answered; `docker inspect irori-dev`: `restarts=482 oom=false started=2026-11-04T13:54:20Z` (via `pct exec 106` on the Proxmox host) |
| Crash cause | `docker logs irori-dev`: `RangeError: Max payload size exceeded` → `Emitted 'error' event on WebSocket instance` → `code: 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH', Symbol(status-code): 1009` → `Node.js v24.22.2` exit, repeating every cycle |
| No error listener | `apps/server/src/hub.ts` — only `ws.on("close")` at :468; no `on("error")` anywhere |
| Hub caps frames at 64 MB | `apps/server/src/hub.ts:142` `maxPayload: MAX_USAGE_FRAME_BYTES`; `packages/core/src/usage.ts:218` `MAX_USAGE_FRAME_BYTES = 64 * 1024 * 1024` |
| Agent batches by count only | `apps/agent/src/usage-sync.ts` `flush()` → `buffer.takeBatch(batchSize)`; `MAX_USAGE_BATCH = 500` (`packages/core/src/usage.ts:212`) — no serialized-size cap; one huge body or 500 big rows can exceed 64 MB |
| Unacked batches persist | `usage-buffer.db` (node:sqlite, WAL) in agent state dir; `sendBatch` resolves `false` on ack timeout → rows retained → resend on reconnect + every flush tick |
| 30 s cadence | `apps/agent/src/config.ts:88` `usageFlushMs` default `30_000`; post-crash all agents reconnect together and re-lock their flush grid to the crash period |
| Poisoner = DGX-3 (`7a575210…`) | Journal `?type=usage`: 40 recent events, **all** from DGX-2 (`359896b6`, healthy flow); DGX-3 has **zero** → its buffer is stuck on the poison batch; DGX-3 runs the `GLM-Flash-TP2-MIIA :8081` cluster (worker) and its `setup-event` frames appear in the boot log seconds before each death |
| Loop start 12:36:51Z | Journal depth: 489 `node-online` events in continuous ~30 s bursts back to 12:36:51; audit log empty (no config change preceded it) → a large-body request hit the DGX-3-side capture around then |
| Not graceful | Browser `ERR_INCOMPLETE_CHUNKED_ENCODING` = truncated chunked stream → hard death, not SIGTERM (shutdown() would end SSE cleanly, `index.ts:692-700`) |
| All other ingest paths guarded | Agent frame chains (`hub.ts:238,347` both `.catch`ed), health sweep (`index.ts:308-316`), usage/log `onBatch` (try/catch → false/null), journal sink (`event-journal.ts:76-89` never rejects), SSE write (try/catch, `sse.ts:42-47`) — the missing socket `'error'` handler is the **only** unguarded kill path found |

## Gap analysis

1. **Server**: a per-connection protocol violation escalates to a fleet-wide hub outage. Any agent frame > 64 MB — a single giant captured body, or 500 mid-size rows — is a remote kill switch on the whole platform (UI, agent-ws, jobs, telemetry).
2. **Agent**: the sender has no notion of frame size. `MAX_USAGE_BATCH` bounds count, not bytes; a single event with a multi-MB prompt/response body (RAG, long-context chat, file upload) cannot be delivered at all and is retried forever.
3. **No poison handling**: a redelivered-forever batch has no quarantine path (IRI-070 quarantine covers schema-rejected events at ingest, not oversize at transport).
4. **No detection**: 482 restarts produced no alert. The journal's `node-online` burst rate is a reliable signal but nothing rules on it.

## Proposed design

**Decision**: fix at both ends, in one PR (server + agent + core), because either half alone leaves a broken system:

- Server-side `ws.on("error")` alone → hub survives but DGX-3 reconnect-loops forever (buffer never drains, its usage telemetry is lost).
- Agent-side chunking alone → this batch drains, but the next oversized frame (any agent, any time) kills the hub again.

**Server** (`apps/server/src/hub.ts`): attach `ws.on("error", …)` to every agent socket. On `WS_ERR_UNSUPPORTED_MESSAGE_LENGTH` / code 1009: log once per node (rate-limited) with the node id and frame-size hint, close the socket with 1009, and let the reconnect happen — **never rethrow**. Also send a `{type: "error", code: "frame-too-large"}` frame when possible so well-behaved agents can react.

**Agent** (`apps/agent/src/usage-sync.ts`, `apps/agent/src/usage-buffer.ts`, `packages/core/src/usage.ts`):
- Bound batches by serialized size, not just count: target ≤ 24 MB per frame (safe margin under 64 MB; JSON.stringify overhead + gzip parts variance). Split greedily; keep count cap 500.
- A **single event** whose serialized size exceeds the hard cap (say 56 MB) can never be sent: quarantine it (write to the existing quarantine path/flow from IRI-070 with reason `oversized`, keep the metadata row, drop/truncate the body parts) instead of looping forever.
- On receiving close code 1009 (or the `frame-too-large` error frame), halve the current batch and retry — degrades gracefully if the hub runs an older cap.

**Process hardening** (`apps/server/src/index.ts`): register `process.on("unhandledRejection")` + `uncaughtException` handlers that log structured diagnostics (the 5xx-diagnostics pattern from `c997f54`) and **log-and-continue for rejections / log-and-continue for non-fatal exceptions**. Tradeoff noted: swallowing can mask bugs — mitigated by logging + a counter exported on `/metrics`. Alternative rejected: exit-after-log (same outage, just instrumented).

**Detection** (health rules, IRI-069 surface): new rule — reconnect-storm: ≥ N `node-online` journal events per node per 5 min → warn/critical; webhook alert fires to the configured channel. This is observable server-side and would have paged within one cycle.

**Rejected alternatives**:
- Raise `MAX_USAGE_FRAME_BYTES` (e.g. 256 MB): moves the cliff, doesn't remove it; big frames also stall the event loop during parse.
- Drop oversized events silently at the agent without quarantine: loses the audit trail; quarantine keeps the metadata visible.
- Agent-side gzip of the whole frame: bodies are already gzipped per-part; the variance is count × size, not compression.

## Phased delivery plan

**Epic**: "Hub survives oversized agent frames; agents size-bound their batches" — one epic, three stories, all in **IR Sprint 3 (998)**. Stories 1+2 ship together as the incident fix (`dev-0.3.0-67`); story 3 may follow in the same sprint.

1. **Story A (P0, blocker) — Hub never dies on a bad agent frame**
   - `ws.on("error")` on agent sockets; 1009 → log + close, node identified; rate-limited.
   - Acceptance: simulated agent sends a >64 MB frame → hub stays serving, logs one warning, socket closed with 1009, other agents unaffected; regression test with an in-process ws client.
2. **Story B (P0) — Agent size-bounded batching + oversize quarantine**
   - Size-capped split (≤ 24 MB), single-event hard-cap quarantine (reason `oversized`), halve-and-retry on 1009.
   - Acceptance: buffer with a 70 MB event → event quarantined, rest drains; a 30 MB batch → split frames each under cap; unit + db-gated tests; DGX-3's stuck buffer would have drained.
3. **Story C (P1) — Restart-storm detection + process guards**
   - Health rule on per-node `node-online` rate → webhook alert; `unhandledRejection`/`uncaughtException` log-and-continue with `/metrics` counters.
   - Acceptance: simulating reconnect bursts trips the rule and fires the webhook; a forced rejection in a dev build logs and survives.

**Post-fix ops**: deploy `dev-0.3.0-67`; DGX-3's buffer drains on its own (batch splits); verify zero restarts over 15 min; supersede v0.5.0 images with the next patch release so GHCR consumers get the fix.

## Risks & open questions

- **Data loss on quarantine**: the oversized event's body parts are dropped (metadata kept). The owner should confirm the poison request on DGX-3 is expendable telemetry. `[INFERENCE]` the triggering request is a large MIIA/RAG call.
- **Why a body is that large**: open question — worth pulling the quarantined event's metadata after the fix (model, prompt-token count) to see if capture should pre-truncate pathological bodies at a smaller bound.
- **v0.5.0 exposure**: released GHCR images contain the bug; no fleet node runs them yet (agents self-host the bundle), but the next consumer will hit it under load.
- **Immediate mitigation (no code)**: on DGX-3, as root: `sqlite3 /root/.local/state/irori-agent/usage-buffer.db "delete from pending where length(payload) > 8000000;"` — stops the loop instantly at the cost of the stuck events (they are buffered telemetry only). Owner's call; the code fix makes it unnecessary.

## Jira overlap findings

- `project = IR AND (summary ~ "websocket" OR "payload" OR "oversize" OR "crash" OR "frame") AND statusCategory != Done` → **0 results** (2026-11-04). No existing ticket covers this; the only other open item is IR-51 (deferred usage phase 2, unrelated).
