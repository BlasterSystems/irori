# Task: IRI-061 - engine log capture survives agent restart

Jira **IR-149**. S3 of IRI-052 (engine log telemetry feed). When an engine
survived an agent restart, its stdout/stderr died with the old agent process:
the run log file (`stateDir/setup-logs/<setupId>-<runId>.log`) was written by
the agent-relayed pipe, so it never grew again and nothing tailed it — a live
engine's output was invisible on every surface (ServeView panel and, via
IR-124/IR-147, the Telemetry feed) until the next start.

## Change (`apps/agent/src/setups.ts`)

- **Inherited-fd spawn:** `start()` opens `logPath` (`openSync "a"`) and spawns
  with `stdio: ["ignore", fd, fd]` (fd closed in the parent after spawn). The
  engine's output flows into the durable file through its own fd — it keeps
  growing while the agent is dead. `openSync` failure falls back to the old
  pipe capture (agent-local only), logged.
- **Tailer:** `startTailer/drainTailer/stopTailer` — a 250 ms unref'd interval
  (plus sync drain at run end) reads appended bytes, splits `/\r\n|\r|\n/`
  (progress `\r` streaming preserved), carries a partial trailing line, and
  feeds `pushLog` → ring + `setup-log` frames. Handles truncation (offset
  reset) and is fail-open on read errors. The file is written only by the
  engine, so no re-ingestion loop; driver/stop/proxy lines keep going straight
  to ring + frames (they no longer land in the durable file — the file is the
  engine's stdout/stderr, the hub ring stays the superset).
- **Re-attach (init):** a live-pgid record now seeds `seqs` from the persisted
  `nextSeq` and starts the tailer from **EOF** (ticket wording — the backlog
  written while the agent was down stays in the durable file; `GET
  /api/v1/setups/:id/log` remains the backfill for hub history).
- **Monotonic seq:** `nextSeq` is a new `DriverRecord` field stamped from the
  live counter at every `persist()`; re-attach falls back to 0 for pre-IR-149
  records. ServeView's seq-keyed panel never renumbers within a run.

## Out of scope

- Stop-script output still pipes through the agent (`stop:` prefix) — the stop
  script is agent-spawned, its output is not the engine run log.
- Hub/web untouched: frames ride the existing `setup-log` wire schema.

## Verification

- `apps/agent/test/setups.test.ts`: new test — beat-emitting fake engine,
  fresh driver over the same state dir (simulated agent restart) re-attaches,
  new beats arrive as `onLog` frames, and seq strictly continues past the
  first process's seq. Existing spawn/re-attach/capture tests unchanged
  (file-exists and \r-progress assertions still hold).
- Full workspace: 856 green (core 100, proxy 24, web 299, db 5, agent 198,
  server 230); build, typecheck, validate, docs-check pass.
- Manual/live: restart the agent under a running engine; new output appears in
  the ServeView panel and the Telemetry feed (rides the next dev tag).

## Risks

- Seq duplicates only within one 250 ms drain window at a restart boundary
  (lines emitted after the last persist) — bounded, panel keys are unique
  enough and ordering is preserved by seq+ts.
- `setInterval` tailer is unref'd: a quitting agent is never held open by it.
- Pre-IR-149 records (upgraded agents) seed seq at 0; their ring was empty
  anyway, so no renumbering surface exists.
