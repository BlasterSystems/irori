# Task: IRI-066 - the driver releases a capture proxy left behind by a dead daemonized engine

Jira **IR-156**. Live during the same rollout as IRI-065: a capture-proxy setup's
daemonizing start script exited 0 ("already running"), the hub demoted the row
when the probe stopped seeing the engine, and the agent's capture proxy stayed
bound on the declared port. The recipe's own restart then died on
`port 8081 is already in use: LISTEN 0.0.0.0:8081` — the listener belonged to the
agent, so no one but the agent could free it, and the only release path was a
Stop (which released it, `capture proxy closed (:8081)`). A leaked listener also
means 502s for whoever binds next, until an agent restart.

## Change (`apps/agent/src/setups.ts`)

- `SetupDriverDeps.engineAlive?(port)`: loopback TCP-connect check, injected in
  tests; the default opens a `Socket` to `127.0.0.1:<port>` with a 1.5 s timeout
  and destroys it.
- `reclaimIfDead(setupId, record)` runs from `reportStatus()` whenever the poll
  finds the run over (no child, dead recorded group). It releases the capture
  proxy and `finish()`es the record — dropping it from `setups.json` so the port
  is free and the already-running guard no longer refuses a fresh start — pushing
  `driver: engine on :<port> is gone — releasing capture proxy :<port>`.
- Safety windows keep a legitimate daemonized engine intact: nothing happens
  while the child lives or the recorded group is alive, while a stop is in
  progress, or for a record superseded by a newer run; reclamation needs BOTH
  run age ≥ `DAEMON_ENGINE_WARMUP_MS` (60 s — the engine binds its loopback port
  only after loading weights) and run-log silence ≥ `DAEMON_LOG_IDLE_MS` (60 s —
  a loading engine keeps writing), and then still requires the engine port to
  refuse a connection. Both windows are injectable for tests. The proxy check is
  awaited, so the record is re-checked before tearing down.
- `stop()` remains the immediate path; this only covers an engine that died on
  its own, where nobody presses Stop.

## Out of scope

- Closing the proxy from the hub on demotion — the listener is agent-owned and
  the hub has no port authority (and the IR-151 grace exists precisely because
  the hub's view of the port lags).
- Non-captured setups: nothing leaks there (`proxyPort === null` returns early).

## Verification

- `apps/agent/test/setups-capture.test.ts` (3 new): a daemonized start
  (script exits 0, engine port echoed via `$PORT`) retains the proxy; repeated
  15 s-style polls with the engine refusing connections release it, clear
  `setups.json`, and a subsequent start on the same proxy port succeeds. With
  the engine answering, many polls tear down nothing, the record survives, and
  Stop still closes it. Inside the warmup window nothing is reclaimed.
  Fail-before: without the reclaim call the proxy never closes and the next
  start is refused with "setup is already running".
- Workspace: agent 203, web 313, server (db-gated) green; typecheck, build,
  `.agentic/bin/validate`, `.agentic/bin/docs-check` pass.

## Risks

- Up to two poll cycles (15 s cadence) plus the 60 s windows before a leaked
  listener is reclaimed — deliberate: reclaiming earlier would tear down the
  proxy of an engine still loading weights, breaking capture for a live setup.
- A hung-but-listening engine (accepts TCP, answers nothing) keeps its proxy,
  which is correct: traffic still reaches it and Stop is the kill path.
