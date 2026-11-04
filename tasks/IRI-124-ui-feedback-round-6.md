# Task: UI feedback round 6 — node header, clock-cap selects, CPU underclock, chart temperatures, network rows (IR-180 / IRI-124)

## Objective

Close the five owner complaints shipped in IR-180 (children IR-181..IR-186):

1. The node page title collapsed to one glyph per line and the action row painted past the card.
2. The GPU SM clock cap was a free-text input and must be a preset selection (1800/2000/2200/3000 MHz).
3. CPU underclocking (specified in SPEC §10, never implemented) must exist, with the same control idiom and the owner's presets (1400/2000/2800 MHz).
4. The CPU and GPU history charts must show temperature next to utilization.
5. The Network card's interface rows must wrap inside the card.

Research brief with file:line evidence and live DGX-1 probes:
`docs/research/IRI-124-ui-feedback-round-6-research-brief.md`.

## Product manager summary

- **One-liner:** The node page gets a readable header, preset clock caps for GPU *and* CPU, temperature overlays on the history charts, and network rows that stay inside their card.
- **User value:** Clock control is now a two-click choice instead of typed MHz guesswork; CPU thermals/noise become tunable from the UI; the node page is legible at laptop widths.
- **Business impact:** Keeps the "operator console, not a config file" promise that the fleet management surface is sold on; closes a spec'd-but-missing capability (CPU cap).
- **Success metric:** A node can be capped on GPU and CPU from the page, cleared, and the caps survive a reboot; history cards show °C alongside %; the DGX-1 header renders "DGX-1" on one line at 1280 px.
- **Dependencies & constraints:** CPU control needs the IRI-124 agent on the node (`agent-update` restarts the agent and kills supervised serving → maintenance window). Persistence is a boot-time oneshot; SPEC's "re-apply on every online transition" remains unimplemented.

## Acceptance criteria

- [x] Header: chips/actions wrap, the h1 never collapses, nothing paints outside the container at 1440/1280/1080/820 px.
- [x] GPU cap select offers 1800/2000/2200/3000 MHz plus the currently stored non-preset value plus Clear.
- [x] CPU card offers 1400/2000/2800 MHz, Clear, keep-after-reboot, and shows the effective per-cluster MHz after apply.
- [x] An agent without CPU clock support shows "agent too old for CPU caps" and no dead control.
- [x] CPU and GPU history charts draw a dashed temperature line on its own scale with a two-row tooltip and a legend.
- [x] Network interface rows wrap inside the card (verified with five IPv6 addresses).
- [x] `PUT /clock-cap` moves GPU and CPU caps independently; absent = untouched, null = clear; a persistent clear drops the boot unit.
- [x] DB migration adds `nodes.cpu_clock_cap_mhz` / `cpu_clock_cap_persistent`; the node DTO exposes all four cap fields.

## Scope

### Included

- `apps/web`: NodeDetail header/network/CPU/GPU template + scoped CSS, `irori.css` (`.barrow--net`, `.chart-legend`), `Sparkline` second series, `detail-data` presets + `tempSeries`, `api` clocks wrapper/types.
- `packages/core`: node cap fields, clocks wire schemas (`cpu` block, optional per-side caps).
- `apps/agent`: `cpu-clocks.ts` (read/apply/persist), main + transport wiring, GPU persistence on clear.
- `packages/db`: schema columns, store setter/projection, migration `0023_thick_dust.sql`.
- `apps/server`: `hub.setClocks(caps)`, `PUT /clock-cap` both caps, `POST /clocks` cpuMaxMHz, `GET /clocks` cpu block, audit summary, DTO cap projection (previously missing → the control never re-seeded).
- Docs: SPEC §10, API.md clocks/power sections, this task file, research brief.

### Excluded

- Fleet-wide apply and re-apply on online transitions (SPEC promise, still open — recorded in SPEC as not implemented).
- Agent rollout itself (separate maintenance window, owner-scheduled).
- Re-asserting a cap when another DGX OS component rewrites `scaling_max_freq` (risk recorded in the brief).

## Plan

- [x] Understand requirements and inspect relevant code
- [x] Confirm architecture impact
- [x] Implement the smallest complete change
- [x] Add or update tests
- [x] Update documentation
- [x] Run validation

## Architecture impact

- **ADR required:** No — this implements the clock-control design already recorded in SPEC §10 (accepted) and reuses the IRI-067/IRI-068 wire + persistence idioms; no new dependency or deployment boundary.
- **Relevant ADRs:** none directly (0003 privileged agent applies — the CPU cap runs through the same root agent).
- **Proposed ADR:** none.

## Validation evidence

- Configuration validation:
- Tests:
- Build:
- Documentation check:

## Review

- Correctness:
- Security: the agent writes root-owned sysfs only through integer values derived from validated input (`min/max` clamps, no shell interpolation); the boot script bakes an integer literal.
- Compatibility: `clocks-get-result.cpu` and `clocks-set.cpuMaxMHz` are optional, so old agents/hubs still parse; an old agent simply has no CPU control and the UI says so.
- Residual risks: a DGX OS component rewrites `scaling_max_freq` after boot (observed mtime drift) — the cap can be silently reverted until a re-assert path exists.
