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

- Configuration validation: `.agentic/bin/validate` → "Configuration validation passed" (needs python ≥3.11 for `tomllib`; the workstation's default `python3` is 3.9 — run via `python3.13`).
- Tests: full `pnpm test` green — core 12 files, db 3, proxy 4, web 56, agent 21, server 46. DB-gated suites green against a disposable Postgres (`IRORI_TEST_DATABASE_URL`): server 368/368, db 13/13, including a drop-schema → re-migrate round trip. New tests: agent `cpu-clocks-ir124` (13), web `clocks-ir124` (8) + `node-detail-clocks-ir124` (3), core `clocks-ir124` (8), db `journal-ir124` (2), server `power-ir68` extended.
- Build: `pnpm build` green (all six workspaces).
- Documentation check: green after adding the clock-control section to `docs/ARCHITECTURE.md` — the heuristic fails CI when architecture-significant paths change without an architecture doc; SPEC/API alone did not satisfy it.
- Live REST smoke of the CPU cap path (local hub on the test DB + the real agent bundle on the workstation, 2026-11-04): `PUT /clock-cap {cpuCapMHz: 1400}` reaches the agent and returns its typed refusal (`cpu: no cpufreq policies — CPU clock control unavailable` — macOS has no `/sys/…/cpufreq`); the persistent clear also exercises the unit-removal path (`cpu persist: spawn systemctl ENOENT`); `{}` → 400, `{cpuCapMHz: "fast"}` → 400; `GET /api/v1/audit` shows `node.clock-cap.put` with `cpuCapMHz` in the summary and the 502 outcome. The sysfs write itself is covered by the 16 agent tests over a fake GB10 cpufreq tree and still needs a real Spark node after the agent rollout.
- Browser smoke (local server + seeded DB + vite, 1440/1280/1080/820 px): h1 "DGX-1" on one line (31.2 px) with chips wrapping to a second row; no card paints outside `.container`; CPU/GPU cards show the dashed temp line + legend; GPU select lists 1800/2000/2200/3000 + `2400 MHz (current)`; the `enP7s7` IPv6 list wraps inside its card (3 lines at 1440, 5 at 1080). CPU select correctly hidden with no live agent.

## Review

- Correctness: ceiling semantics verified per policy (2800 caps the 2,808 cluster and the 3,900 cluster; 3000 caps 2,808 but not 3,900; below-min clamps to `cpuinfo_min_freq`); clear restores per-cluster maxima; a persistent clear now reaches the agent and removes the boot unit (previously a 400, leaving a stale oneshot); the node DTO projects cap fields (it did not — the UI could never re-seed a stored cap).
- Security: the agent writes root-owned sysfs only through integer values derived from validated input (`min/max` clamps, no shell interpolation); the boot script bakes an integer literal; no new auth surface (same agent WS + audited REST route).
- Compatibility: `clocks-get-result.cpu` and `clocks-set.cpuMaxMHz` are optional, so old agents/hubs still parse; an old agent simply has no CPU control and the UI says so. The migration-watermark heal is idempotent and no-ops on healthy databases.
- Residual risks: a DGX OS component rewrites `scaling_max_freq` after boot (observed mtime drift) — the cap can be silently reverted until a re-assert path exists; SPEC §10's online-transition re-apply and fleet-wide apply remain unimplemented; CPU caps need the IRI-124 agent (per-node maintenance window).

## Independent review round (PR #94)

An independent adversarial review of the diff produced 2 blocking + 6 should-fix findings; all were addressed in the same PR:

1. **Blocking — the 2800 preset claim was false.** A cap is a uniform ceiling, so 2800 limits the 3,900 MHz cluster too (the agent test already asserted it). Fixed every shipped claim (detail-data comment, brief, SPEC, task file, PR body) and added a `title` on the select stating the semantics; per-cluster caps would be a separate design change.
2. **Blocking — an out-of-range cap 500'd `GET /api/v1/nodes`.** `parseCapField` had no bounds while the node DTO re-parses 300–4000 MHz. Now bounded at the route (same range as `nodeInfoSchema`), with a regression test that stores the boundary value and then lists nodes.
3. **Persistence ran after a failed live apply** — now gated per side via `shouldPersist(value, persist, applied)` (3 unit tests): a failed apply never touches the unit, a clear always removes it.
4. **`POST /clocks` forwarded `persist` without recording it** — no longer forwarded (matches the doc sentence); regression test asserts the agent never sees persistence from that route.
5. **A mixed GPU+CPU frame against an old agent stored a CPU cap that was never applied** — the routes now apply one frame per side, so the CPU half reports offline and is not stored.
6. **Partial failure was reported as total failure and the landed half was not stored** — each side stores independently; `502`/`504` responses carry a per-side `results` array and the registry values read back.
7. **`loadClocks` had no node-switch guard** — epoch counter like the sibling loaders.
8. **`GET /clocks` collapsed "no cpufreq" (null) into "old agent" (absent)** — absence now survives server + client parsing, with distinct copy: "no cpufreq on this node — CPU caps unavailable" vs "agent too old for CPU caps".
9. Nits fixed: journal test bound tightened to the heal's own ±60 s; the watermark heal now logs what it rewrote and why it failed; unit removal disables the unit before deleting its files.

Verification after the review pass: `pnpm test` green (core 12, db 3, proxy 4, web 56, agent 21, server 27 files), DB-gated server 373/373, db 13/13, `pnpm build` ✓, `validate` ✓, `docs-check --base main --strict` ✓.
