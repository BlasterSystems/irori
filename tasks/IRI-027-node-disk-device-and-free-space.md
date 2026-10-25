# Task: IRI-027 — Nodes: DISK row shows the device disk with free space in orange

**Jira:** [IR-98](https://blastersystems.atlassian.net/browse/IR-98) (Story, `frontend`, IR Sprint 1)
**Feedback:** owner screenshot of the Nodes section on dev-0.3.0-30, 2026-10-25.

## Objective

1. The DISK row on spark cards showed 14.2 TB / 18.1 TB on every node — the largest
   mounted volume (the NAS share), not the device disk. The `DISK 90%` chip separately
   used the max usage percent across mounts, so bar and chip disagreed.
2. Replace the percent chip: the bar renders the available space as an orange segment
   after the used fill.

## Acceptance criteria

- [x] Spark cards select the storage entry with mount `/` (device disk); mounted
      volumes are ignored (owner rule 2026-10-25).
- [x] NAS cards keep the largest-mount selection (store volume, disk row first).
- [x] Snapshots without a `/` entry fall back to the largest mount (older agents).
- [x] Disk bar shows used (ink) then available (`--thread` orange) segments summing
      to 100%; the ≥80% hot accent on the value text stays.
- [x] No `Disk N%` chip on node cards; the reclaimable audit prefetch is gone;
      `analytics.diskChipCls` deleted with its test.
- [x] SPEC §11.6 updated.

## Scope

### Included

- `apps/web/src/card-data.ts` — device-disk selection + `CardRow.freePct`.
- `apps/web/src/components/NodeCard.vue`, `NodeDetail.vue` — trailing free segment.
- `apps/web/src/assets/irori.css` — `.bar__fill--free`.
- `apps/web/src/analytics.ts` — dead `diskChipCls` removed.
- `docs/SPEC.md` §11.6.

### Excluded

- Agent/protocol: no change — `HardwareSnapshot.storage` already lists every real
  mount including `/` (`apps/agent/src/collector.ts` `readStorage`), so the web
  picks the device disk client-side; works against deployed 0.3.0 agents.
- CleanupDrawer disk chip (different surface, SPEC §11.6 drawer contract unchanged).

## Plan

- [x] Inspect collector storage capture, snapshot schema, card-data/NodeCard/NodeDetail.
- [x] Confirm architecture impact (none — frontend-only, no ADR).
- [x] Implement the smallest complete change.
- [x] Update tests (card-data device-disk + fallback, chrome-markup pin, analytics cleanup).
- [x] Update documentation (SPEC §11.6).

## Architecture impact

- **ADR required:** No — routine frontend fix, no data/deployment/integration change.
- **Relevant ADRs:** None.

## Validation evidence

- Configuration validation: `.agentic/bin/validate` green.
- Tests: `pnpm test` green (web suite 221/221; device-disk + fallback cases added).
- Build: `pnpm build` green.
- Documentation check: `.agentic/bin/docs-check` green.
- Browser: fixture smoke on the built dist, light + dark, 0 console errors.

## Review

- Correctness: device disk = statfs of `/`; identical source the agent reports.
- Security: no new surfaces; one fewer authenticated fetch from the card.
- Compatibility: fallback keeps older snapshots rendering; NAS behavior unchanged.
- Residual risks: hosts where `/` is not the big internal volume (overlay containers)
  would show the root fs — the agent's exclusion list already drops overlay/squashfs,
  and sparks report the NVMe root.
