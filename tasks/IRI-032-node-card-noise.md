# Task: Node cards — no ONLINE chip, prominent OFFLINE, name fits

## Objective

Nodes-grid noise reduction (owner): drop the ONLINE chip on healthy cards,
make OFFLINE unmistakable (error border + full-width strip + dimmed stale
metrics), and stop the node name from wrapping mid-name ("DGX-2" →
"DGX- / 2").

## Acceptance criteria

- [x] No status chip on online cards; role/kind/Agent chips unchanged.
- [x] Offline cards: error border, full-width OFFLINE strip above the header,
  dimmed body (metrics are stale when offline).
- [x] Name renders on one line (ellipsis only as the last resort).
- [x] card-data fields unchanged (statusText/dotClass still feed NodeDetail).
- [x] Source pin test + suite green.

## Scope

### Included

- apps/web: NodeCard.vue (template + scoped styles), test pin.

### Excluded

- NodeDetail header (keeps its status chip — the drill-down is dense already).
- Server, card-data contract.

## Plan

- [x] Implement
- [x] Tests
- [x] Validation + browser check on DEV

## Architecture impact

- **ADR required:** No — local presentation change within the existing DS.
- **Relevant ADRs:** 0005 (design system)
- **Proposed ADR:** None

## Validation evidence

- Configuration validation: `.agentic/bin/validate` — pass
- Tests: web suite green (source pin added)
- Build: `pnpm build` green
- Documentation check: `.agentic/bin/docs-check` — pass
- Live: DEV nodes grid renders names on one line, no ONLINE chips, offline
  treatment verified by DOM probe (forced offline) and screenshot.

## Review

- Correctness: offline state derives from `card.online` (the same source the
  chip used); no data contract change.
- Security: none.
- Compatibility: card-data untouched; NodeDetail unaffected.
- Residual risks: very long names ellipsize instead of wrapping (intended).
