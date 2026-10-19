# Task: IRI-005 — M4 Model supply chain (NAS + modelctl)

Epic: Irori v1 ([docs/PLAN.md](../docs/PLAN.md) M4)

## Objective

NAS-backed model management with full modelctl compatibility: search/download/
delete on the NAS, sync NAS→node, push node→node over CX7, placement planning,
HF metadata for recipe creation.

## Acceptance criteria

- [ ] NAS node kind (same agent) with `nasRoot`; models page reads
      `catalog.json` (schema 3) with live-scan fallback; **no store writes
      outside modelctl** (ADR-0004).
- [ ] Download/queue to NAS: form-built YAML (raw YAML rejected), full
      preflight, resumable staging, GGUF quantization + mmproj/MTP companions;
      delete dry-run → armed `--apply --yes`.
- [ ] `sync-local` NAS→node; `push` node→node with `--jobs` parallel streams
      and repeated `--host` round-robin over CX7 links.
- [ ] HF metadata join per model (repo, revision, quantization, companions,
      cards) cached; `path`/`serve-command` surfaced copy-only.
- [ ] `doctor`/`repair-active`/`catalog refresh` with two-click armed apply;
      modelctl presence/version check + install/upgrade job.
- [ ] Placement planner: model×node → present/sync/push/unavailable + capacity
      math (free − needs − reserve).
- [ ] **M4 exit e2e:** download on NAS → sync to head → push to worker over
      CX7, all from the UI with streamed job logs.

## Scope

### Included

- Jobs subsystem (one active per node, 409 otherwise, output ring, cancel).

### Excluded

- Serving (M5); benchmark model pickers reuse placement in M6.

## Plan

- [ ] Research brief: modelctl command surface + JSON outputs (golden
      fixtures from `~/Developer/modelctl` tests).
- [ ] `packages/core` catalog reader + placement planner (pure, tested).
- [ ] Agent modelctl wrappers → jobs → API → UI.

## Architecture impact

- **ADR required:** No — implements ADR-0004.
- **Relevant ADRs:** 0003, 0004.
- **Proposed ADR:** None.

- Consolidated 2026-10-19 (process audit; milestone shipped in 5e4b534 +
  46e3751 + 0b333e6). E2E verified live: NAS → dgx1 push (preconditions
  discovered and documented: sync-local cache registration, ssh client/keys,
  --cache-dir alignment, --ssh path); job runner verbs vs modelctl 0.20.x;
  placement planner capacity/offline behavior keeps push sources.
- modelctl CLI shapes re-verified live on dgx1 2026-10-19 (staging-audit
  --json, list --local --json, path --local) — feeding the M7 hygiene work.

## Review

- catalog.json stays read-only (ADR-0004); destructive verbs run
  dry-run → armed. Residual: unreferenced-object gc remains a manual job
  (gc-objects) — not part of the M7 hygiene automation by design.
