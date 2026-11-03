# IRI-052 research brief — engine ("server") logs never reach the Telemetry feed

- **Date:** 2026-10-31
- **Tickets:** IR-147 (S1), IR-148 (S2), IR-149 (S3), IR-150 (S4) — all on IR Sprint 2 (990); follow-up defect batch on IR-124 (Done)
- **Trigger:** Owner question: "the logs of the server starting are not on the telemetry — why?"

## Summary

The model server's startup output (weights loading, driver lines) never appears in the Telemetry surfaces — the Overview card (`OverviewView.vue`) and the always-available drawer (`TelemetryDrawer.vue`) — even with the drawer open while a serve starts. Root cause is a **web-side gap, not a hub one**: the hub broadcasts `setup-log` SSE frames on the shared stream exactly as IR-124 specified, but the live store's `ingest()` has no `case "setup-log"` and silently drops them. The renderer (`feedLines` in `overview.ts`) exists and is correct — it is unreachable dead code. IR-124 shipped Done with one of its four bullets ("the web live store ingest pushes it into the feed ring") never implemented; the web test covered only the renderer with synthetic events, so the gap passed review.

## Current state (evidence, file:line)

The full pipeline for engine output, end to end:

1. **Agent capture.** The start script is spawned with `stdio: ["ignore", "pipe", "pipe"]` (`apps/agent/src/setups.ts:351-353`); every stdout/stderr line goes through `pushLog` (`apps/agent/src/setups.ts:681-691`) into a 1 000-line ring (`LOG_RING_LINES`, `setups.ts:69`), an append file per run (`setups.ts:349`), and an agent `setup-log` frame (`apps/agent/src/main.ts:215`). Capture works from process spawn — startup lines are included.
2. **Hub fan-out.** `onDriverLog` (`apps/server/src/setups-service.ts:711-716`) validates the head node, then (a) `pushLog` stores the line in the hub's per-setup ring and writes it **raw/unthrottled** to per-setup SSE clients (`setups-service.ts:192-202`), and (b) `emitSharedSetupLog` emits a shared `setup-log` frame — throttled ≤1 frame/s per setup, identical consecutive lines skipped (`setups-service.ts:204-224`). Verified by `apps/server/test/setups.test.ts:566-586` ("streams throttled, deduped setup-log frames to the shared hub (IR-124)").
3. **Feed recording deliberately excludes it.** `FEED_EXCLUDED = { heartbeat, snapshot, llm, job-progress, setup-log }` (`apps/server/src/events-feed.ts:20-23`) — `GET /api/v1/events/recent` never contains `setup-log`; live-only was IR-124's stated tradeoff ("a freshly opened drawer waits for the next line"; backfill = `GET /api/v1/setups/:id/log`). This part is intentional.
4. **Web drops the frame.** The live store ingests `/api/v1/events` (`apps/web/src/live.ts:285-292`) and dispatches in `ingest()` (`apps/web/src/live.ts:119-238`). The switch handles `snapshot`, `node-online`/`node-offline`, `heartbeat`, `bench`, `job`, `job-progress`, `thermal`/`setup-state`/`setup-transfer` (grouped `pushEvent`), `usage` — **there is no `setup-log` case**. The frame falls through and is dropped. The only other `setup-log` reference in `apps/web/src` is the renderer case (`apps/web/src/overview.ts:425-428`), which never fires because no such event ever enters the `events` ring. Both Telemetry surfaces render from that ring (`OverviewView.vue:276`, `TelemetryDrawer.vue:59-61`).
5. **ServeView's engine log works** because it uses a different channel: `openSetupLog` (`apps/web/src/serve.ts:164-180`) → `GET /api/v1/setups/:id/log` (`app.ts:1098`; `attachLog`, `setups-service.ts:718-727`) — hub ring replay + raw live stream. This is why the Serve page's "Engine log" box shows the startup output while the Telemetry feed shows none.
6. **Wire type is fine.** `setupLogEventSchema` is in the `sseEventSchema` union (`packages/core/src/events.ts:44-48,150-160`), so the client parses it — the switch just has no arm.
7. **Why nothing caught it.** `apps/web/test/overview.test.ts:198-205` feeds synthetic `setup-log` events straight into `feedLines` — green — but no test pushes a real frame through `ingest()`. The renderer and the ingest were never tested together.

## Secondary gaps (real, but not the ask)

- **Agent restart while an engine lives:** the stdout pipes die with the previous agent process; "log capture resumes on the next start" (`apps/agent/src/setups.ts:183-188`). A surviving engine's output is invisible on every surface until it is restarted — even the Serve page engine-log panel. The per-run file (`setup-logs/<setupId>-<runId>.log`) is durable but nothing tails it on re-attach.
- **Hub/agent restart clears rings:** hub `logRings` are in-memory (`setups-service.ts:192`); the agent ring too (`setups.ts:164`). After a hub restart the engine-log panel backfills empty until new lines arrive. The file is the durable copy.
- **Pre-spawn failure = no logs:** if `start()` fails before spawn (the known MODEL_PATH case, setup 69916930) there is no engine output at all — the feed shows only the `setup-state` → `failed` transition. A plain start also pushes no `driver: starting …` marker line (unlike stop's `driver: running stop script`, `setups.ts:470`); `start()` logs driver lines only for the cache-user and capture-proxy cases (`setups.ts:374-380`).
- **Engines not started by the agent** (detected-unmanaged rows from the driver-truth poll) have no pipes — no output exists to stream.
- **Feed ring pressure once wired:** ≤1 line/s per running setup against the web ring cap 300 (`live.ts:241-246`) — three chatty setups rotate the feed in ~5 min. Acceptable for a homelab surface, worth knowing.

## Root cause

IR-124's acceptance was implemented hub-side and schema-side, but the web ingest arm was never written. The FEED_EXCLUDED comment ("the web client streams those lines itself") describes behavior that does not exist.

## Proposed design

Decision: honor IR-124's original contract — the fix is client-side and one arm long. No server change is required for the core defect.

### Phase 1 — wire `setup-log` into the live store (the fix)

- `apps/web/src/live.ts` `ingest()`: add `case "setup-log":` to the existing grouped `pushEvent` arm (with `thermal`/`setup-state`/`setup-transfer`).
- Web test: push a raw `setup-log` SSE frame through `ingest()` and assert it lands in `events` and renders via `feedLines` — closing the renderer/ingest seam that let this slip.
- Acceptance: starting a serve with the drawer (or Overview card) open streams engine lines as `${node} · ${setupName}: ${line}`; a drawer opened mid-load shows the next throttled line (live-only, per IR-124's explicit non-goal on backfill).
- Scope note: no hub change, no schema change; older agents that never emit `setup-log` are a no-op.

### Phase 2 — startup burst fidelity (optional, owner call)

While the driver state is `starting`, relax the shared-feed throttle (e.g. ≤10 frames/s) or bypass it entirely; resume ≤1/s once `running`. Weight-load output collapses to 1 line/s today — the interesting phase is the least visible. Server-side only (`emitSharedSetupLog` + row state). Tradeoff: chattier feed; keep the dedup.

### Phase 3 — resume capture on re-attach (optional, separate ticket)

On agent re-attach to a surviving engine (`setups.ts:186`), open a read stream at the end of `record.logPath` and feed it through `pushLog`, so output resumes without restarting the engine. Moderate scope; the file already exists and is per-run.

### Phase 4 — start marker + pre-spawn failure line (tiny)

Push `driver: starting ${scriptStart}` in `start()` before spawn and a `driver: …` line on resolution failure, so the feed shows the attempt even when the engine never prints a line (MODEL_PATH case). Symmetric with the stop-script marker.

### Rejected alternatives

- **Record `setup-log` in the server feed ring** — would evict real events from the 500-cap ring; IR-124 chose live-only deliberately, and `job-progress` follows the same rule.
- **Drawer polls the per-setup log endpoint** for each running setup — duplicates the SSE machinery for a worse result (no cross-setup merge, extra REST churn).
- **Drop the hub throttle, dedupe client-side** — floods the shared SSE for every connected client; the throttle is the right place.

## Risks & open questions

- Feed rotation speed with several running setups (1 line/s each) — owner call whether to cap per-source or accept rotation.
- Engine output is streamed continuously, not only during load — vLLM/tensorfold request logs make the feed chatty. Owner may prefer `starting`-only visibility; the 1/s throttle keeps it bounded either way.
- Phase 2/3/4 are independent; only Phase 1 closes the reported defect.

## Jira overlap

- IR-124 ("Telemetry drawer: stream serve engine output into the shared feed") is **Done** — this is a missed-acceptance defect on it, not a duplicate feature.
- Filed 2026-10-31 after owner approval (full batch): **IR-147** (S1 ingest fix), **IR-148** (S2 starting throttle), **IR-149** (S3 re-attach tail), **IR-150** (S4 start markers) — all on IR Sprint 2 (990), To Do, unassigned. Research brief posted as evidence comment on IR-147; the others reference it.
