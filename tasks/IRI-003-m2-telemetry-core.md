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

- (pending)

## Review

- (pending)
