# Task: Agent telemetry must survive a wedged network mount (IR-206)

Jira **IR-206** (Bug, High, sprint 1004 "IR Sprint 4", assigned Bruno).

## Objective

A dead network mount must never blind the fleet. Today `collect()` awaits an
unbounded `statfs()` for every mount, and the model-inventory read path uses
synchronous filesystem calls against the NAS store — so one wedged CIFS mount
stops hardware telemetry entirely (and can freeze the agent main thread when an
inventory job runs). Bound both paths and make a dead mount a warning, not an
outage.

## Incident evidence (2026-11-09)

- `//nas.lan/llms` wedged on 2026-11-07 19:43; kernel logs repeat
  `CIFS: VFS: \\nas.lan\llms reconnect tcon failed rc = -11` once per second
  on dgx1, dgx2 and dgx3.
- Snapshot cadence over a 45 s window (`GET /api/v1/nodes/:id/snapshot`):
  dgx1 and dgx3 advanced **0 ms** (age 328 s / 334 s); dgx2 advanced 44 s.
- Overview showed "waiting for first snapshot" on dgx1 and dgx3; health emitted
  `telemetry_gap_s` warnings (32 s and 38 s against a 15 s threshold).
- Disk rule blind spot: dgx3 sat at 93 % (827 of 938 GiB, 64 GiB free) with no
  finding — no snapshot to evaluate.
- Direct probes of `statfs('/mnt/nas')`: EHOSTDOWN after 10.3 s on dgx2; no
  return within 40 s on dgx1.
- `transport.tick()`'s `collecting` guard confines the damage to one stuck
  statfs: the agent stays alive and keeps answering clocks requests.
- Blast radius confirmed partial: the TP-3 engine kept serving through the
  wedge; only telemetry and NAS-backed jobs were affected.

## Acceptance criteria (from the ticket)

- [ ] A `statfs` that never resolves still produces a snapshot, with the mount skipped
- [ ] A dead NAS root makes `models-inventory` return a warning within the deadline; the agent keeps answering clocks requests
- [ ] `pnpm test` stays green; new unit tests cover both paths

## Design (decision-complete)

- `apps/agent/src/collector.ts`: `readStorage()` races each `statfs` against a
  bounded timeout (1.5–2 s) and skips the mount on timeout — the existing
  `catch` handles throws only. `EXCLUDED_FS_TYPES` gains `cifs` and `nfs`
  **or** the mounts stay listed behind the bounded probe (preferred: keep them
  so a healthy NAS still reports capacity; the timeout is the isolation).
- `apps/agent/src/catalog-read.ts`: replace `readdirSync` / `readFileSync` /
  `statSync` / `lstatSync` / `existsSync` (lines 1, 86, 98, 120, 141) with
  async equivalents plus per-op timeouts.
- Job deadline: `models-inventory` gets a hard deadline so a dead mount fails
  the job with `NodeInventory.store.warning` (the schema already models it)
  instead of blocking the agent.
- Optional (only if cheap): bounded NAS-reachability probe surfaced as a health
  signal.

## Non-goals

- NAS-side SMB recovery / remount operations (owner runbook).
- Network filesystems beyond `cifs` and `nfs`.
- Changing the snapshot cadence or the hub's ring/staleness semantics.

## Plan

- [x] Understand requirements and inspect relevant code
- [x] Implement the bounded `statfs` in `readStorage()`
- [x] Make `catalog-read.ts` async and bounded; add the inventory deadline
- [x] Add tests: never-resolving `statfs` → snapshot produced; dead NAS root → warning, agent responsive
- [x] Update `docs/CONFIGURATION.md` / `API.md` if the warning surface is documented
- [x] Run validation (`.agentic/bin/validate`, `.agentic/bin/docs-check`, `pnpm test`, `pnpm build`)

## Architecture impact

- **ADR required:** No — bounded I/O inside existing modules; no new
  dependency, route, or data model. The optional NAS health probe would be an
  additive metric following the IR-201 template.

## Validation evidence

- **Full gate** (agent tests → `pnpm build` → `.agentic/bin/validate` → `.agentic/bin/docs-check`): EXIT=0; agent suite green (incl. the new `bounded storage reads (IR-206)`, `store reads on a dead mount (IR-206)` blocks in collector/inventory tests and the new `catalog-read-ir206.test.ts`).
- **Collector**: `readStorage(procRoot, rates?, {statfsImpl, timeoutMs})` — a never-resolving statfs on a wedged CIFS mount is still probed (healthy NAS keeps reporting) and skipped after the bound (test: 60 ms deadline → snapshot ships with only `/`); statfs throws skip the same as timeouts. All mounts race in parallel, so the worst case is one timeout window regardless of mount count.
- **catalog-read.ts**: every `*Sync` call (`readdirSync`/`lstatSync`/`statSync`/`readlinkSync`/`readFileSync`/`existsSync`) replaced by async equivalents raced against a 2 s `boundedOrNull` timer (null = skip) — the main thread never blocks on a wedged mount. Scan semantics preserved (broken symlinks/foreign files skipped, manifest-missing repo derivation, `no catalog.json; scanned active/` warning).
- **Inventory**: `buildInventory` races the whole store read against a 20 s hard deadline (`ctx.storeDeadlineMs`/`ctx.readStoreImpl` seams for tests) — a hanging read yields `{source: "scan", warning: "store inventory exceeded 20s deadline (possibly a dead network mount); skipped"}` and the job still resolves (test: dangling read, 60 ms deadline, job resolves well under 5 s). The catalog-freshness probe is bounded the same way.

## Review

- **Correctness:** `boundedOrNull` maps BOTH timeout and rejection to null (matches the old catch-and-skip); the deadline resolve value is a full valid store object so the schema is never violated; timers are `unref`ed and cleared in `finally`.
- **Security:** no new routes, secrets, or surfaces; bounds only reduce blocking.
- **Compatibility:** `readStorage` gained an optional third param (existing callers unaffected); `StoreRead`/`NodeInventory` shapes unchanged — a wedged mount now produces the warning the schema always modeled. One deliberate behavior change: an unreadable `catalog.json` now falls back to the scan (warning) instead of throwing out of `readStore` — strictly more graceful, still warns.
- **Residual risks:** a hung kernel statfs still occupies one libuv threadpool worker (default pool 4) until the mount is force-unmounted; the snapshot path only stops awaiting it. The dangling deadline read keeps holding its workers; acceptable per the spec.
