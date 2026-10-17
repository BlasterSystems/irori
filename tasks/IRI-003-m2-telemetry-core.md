# Task: IRI-003 — M2 Telemetry core

Epic: Irori v1 ([docs/PLAN.md](../docs/PLAN.md) M2)

## Objective

Telemetry as first-class: full agent collectors, versioned snapshot ingest,
ring buffers, minute→hour→day rollups with retention, SSE fan-out, and the
live UI (worker/head card split per SPEC §5).

## Acceptance criteria

- [ ] Collectors: GPU per-card (usage/temp/power/VRAM/clocks/throttle reasons/
      processes) via `nvidia-smi`; CPU usage/temp/**package power**/clock;
      memory (GB10 unified split on Sparks; RAM vs VRAM on discrete hosts);
      storage; network.
- [ ] Two nodes stream concurrently; live charts update via SSE; headless
      collection continues with no browser attached.
- [ ] Rollups + prune: bounded tables; restart-safe; watermark/idempotency
      tests; clock-jump handling per ADR-0006.
- [ ] Worker card = memory, CPU/GPU usage+temp, package power. Head card
      placeholder populated in M3.
- [ ] SSH fallback transport produces identical snapshot shapes.

## Scope

### Included

- Snapshot `schemaVersion` negotiation; resume cursor on agent reconnect.
- History API `GET /api/v1/nodes/:id/history?range=`.

### Excluded

- LLM probes (M3), model ops (M4), energy estimates (M7 — needs token ledger).

## Plan

- [ ] Research brief: GB10 `nvidia-smi` query set + rapl package power on the
      SoC (fixture outputs from a real Spark).
- [ ] Implement collector → ingest → store → SSE → UI in that order.
- [ ] Fake-timer rollup tests; two-node soak; kill -9 restart smoke.

## Architecture impact

- **ADR required:** No — implements ADR-0006 (and 0002 for retention).
- **Relevant ADRs:** 0002, 0003, 0006.
- **Proposed ADR:** None.

## Validation evidence

- 2026-10-17: full build green; tests: core 9/9, agent 34/34 (GPU query-set
  parse fixtures incl. `[N/A]`/throttle-mask variants, hwmon/rapl/cpufreq
  fixture trees, unified-memory rule, mount/net filters), server 47/47
  **db-backed** (bucket boundaries, GPU/net folds, idempotent recompute,
  watermark advance, open-bucket skip, clock-jump via server-time-only
  bucketing, retention, history API), web 61/61 (sparkline math, history
  parse, detail data, router, DS markup guards). Research brief:
  `docs/research/IRI-003-research-brief.md` (query set + GB10 semantics from
  sparkControl production code; dgx1 SSH unreachable from here — real-Spark
  verify deferred to LAN soak).
- Two-node soak (this Mac + irori:agent-amd64 container on the docker VM
  10.0.10.9), server against the real Proxmox dev DB (10.0.10.136): both
  nodes `online:true` concurrently; VM agent streamed v2 fields live
  (cpuTemp 44 °C via hwmon, per-core clocks, swap, storage, network; gpu []
  tolerated on a GPU-less host); rollups advanced on the 60 s loop and
  `GET /api/v1/nodes/:id/history?range=1h` served minute buckets
  (29 samples/bucket). Headless (no browser attached).
- v1-agent backward compat found & fixed mid-slice: `uuid`/`powerLimitW`/
  `smClockMHz`/`smClockMaxMHz` are `.nullable().default(null)` so M1 agents'
  snapshots still parse at ingest.
- SSH fallback: snapshot shapes are transport-independent by construction
  (`packages/core`; `transport: "ws" | "ssh"`); SSH exec wiring itself is
  out of M2 scope per the task file.
- `.agentic/bin/validate` + `.agentic/bin/docs-check` green; CI green on
  push.

## Review

- (pending)
