# Task: IRI-008 — M7 Analytics & packaging

Epic: Irori v1 ([docs/PLAN.md](../docs/PLAN.md) M7)

## Objective

The analytics section (memory/decode/power/tokens lenses, grouped/separated,
per cluster and per node) and the release engineering: multi-arch images,
agent install story, CI — plus **agent disk hygiene** (audit + armed clean +
opt-in prevention, SPEC §11.6).

## Acceptance criteria

- [ ] Disk hygiene: `cleanup-audit` job reports per-category reclaimable
      (docker build cache/images/containers, HF orphans, modelctl staging,
      compiler/pkg caches, journal/tmp/cores/snaps) with safety rationale;
      node card shows reclaimable at 80/90 % usage.
- [ ] Armed per-category clean via jobs with streamed output; protected set
      enforced (modelctl registrations, running-container images, open
      files via /proc, <24 h files outside caches); cleanup history.
- [ ] Opt-in: docker daemon.json log rotation; weekly always-safe pass.
- [ ] Placement capacity failure offers "Clean up disk — est. +N GB".
- [ ] Cleanup drawer UI per SPEC §11.6: Audit | History tabs, 8-category
      checklist (safe pre-checked, care opt-in), dry-run plan → typed
      node-name arm → staged streamed run with per-category failure handling;
      two-tier threshold chips on cards; history last 20 / 90 d.
- [ ] Analytics: four lenses over rollups — memory, decode, power, tokens
      (generated/cache/prefill); groupable by cluster and individual node;
      time ranges from hourly/daily buckets.
- [ ] Token ledger: generated/cached/prefill per model, hourly + daily.
- [ ] Power: estimated watts (GPU board + CPU model + base overhead, clamped
      to GB10 envelope), explicit coverage fields, monthly archive, Wh/token;
      labeled *estimated, not wall-metered*.
- [ ] Images: multi-arch amd64+arm64 (server + agent roles) via buildx;
      agent install script + root systemd unit shipped; CI (build, test,
      docs-check) green; semver release per RELEASING.md.
- [ ] **M7 exit:** analytics populated from real rollups; agent deployed on a
      Spark from the release artifact.

## Scope

### Included

- Temps history view; settings for cadences/retention/reserve.

### Excluded

- Prometheus export, alerts, PWA (deferred, SPEC §14).

## Plan

- [ ] Ledger + energy tracker over snapshots (server-side, headless).
- [ ] Analytics views over rollups (no raw-scan queries).
- [ ] Dockerfile/compose/CI; agent install e2e on one Spark.

## Architecture impact

- **ADR required:** No — energy estimation method documented in SPEC §9.
- **Relevant ADRs:** 0002 (retention), 0006 (rollups).
- **Proposed ADR:** None.

## Validation evidence

- (pending)

## Review

- (pending)
