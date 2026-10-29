# Task: IRI-045 — Cache-user serve execution

## Objective

Make a serve run as the head node's **Model cache user** instead of the agent
user (root), and stop `set -u` start scripts from dying on the HOME-less agent
unit's env.

## Product manager summary

- **One-liner:** Serve start/stop scripts run as the node's `cacheUser` via the
  ADR-0011 runuser shape; unwrapped starts get a `HOME` fallback.
- **User value:** `ps` shows the engine as the configured cache user, matching
  the supply chain; serve starts stop crashing with
  `HOME: unbound variable` (`./scripts/config.sh:340`, DGX-1).
- **Business impact:** The serve flow on cache-user nodes (the fleet standard)
  works without owner-side script workarounds.
- **Success metric:** The DGX-1 setup starts, the engine process runs as
  `operator`, and the log shows no unbound-variable failure.
- **Dependencies & constraints:** Owner op — the cache user needs GPU device
  access and owns the model paths. Agent-only change; no server/schema work.

## Acceptance criteria

- [x] `SetupDriver` resolves a serve execution context: `cacheUser` ≠ agent
  user → both start and stop scripts spawn through the ADR-0011 `runuser` wrap
  (scrubbed `XDG_STATE_HOME`/`HF_HOME`/`HF_HUB_CACHE`, owner `HOME`, plus
  `USER`/`LOGNAME` and the ambient `PATH`); no cache user → unchanged agent-user
  spawn.
- [x] A configured cache user without a passwd entry refuses the start with an
  actionable error before anything binds or persists — never a silent root
  fallback.
- [x] The resolved run context (`runUser`/`runHome`) persists on the driver
  record; a stop after an agent restart — or a mid-run `cacheUser` edit — runs
  the stop script in the starting context.
- [x] Unwrapped starts/stops get `HOME` defaulted to the agent user's passwd
  home when neither the ambient nor the setup env has one (HOME-less systemd
  unit); wrapped runs get their `HOME` from the wrap argv.
- [x] The ADR-0011 argv shape exists once: `apps/agent/src/cache-user.ts`
  (`runuserWrap`), adopted by `modelctl.ts` and `inventory.ts`; transfer/
  local-op/inventory argv byte-identical (existing argv tests untouched).
- [x] `pnpm test`, `pnpm build`, `.agentic/bin/validate`,
  `.agentic/bin/docs-check` green.

## Scope

### Included

- `apps/agent/src/cache-user.ts` (new shared wrap), `modelctl.ts`,
  `inventory.ts` (`resolveCacheHome` passwd-only resolver + refactor),
  `setups.ts` (wrap resolution, `serveSpawnArgv`, record fields, stop wrap,
  HOME fallback), `main.ts` (wiring).
- `apps/web/src/components/NodeModal.vue`: cache-user field hint.
- Docs: ADR-0015, CHANGELOG, `docs/API.md` setups section.

### Excluded

- Server-side changes (dispatch contract unchanged).
- modelctl changes (external repo).
- Per-setup (vs per-node) execution users (ADR-0015 revisit trigger).

## Plan

- [x] Extract `runuserWrap` from the four inline ADR-0011 argv copies.
- [x] `setups.ts`: `resolveServeWrap` + `serveSpawnArgv` + record persistence +
  stop-script wrap + HOME fallback; log `driver: serving as cache user …`.
- [x] `inventory.ts`: passwd-only `resolveCacheHome` (serve needs no per-user
  modelctl); `main.ts` wiring.
- [x] Tests: pure wrap argv, passwd refusal, wrapped start/stop execution
  (runuser test double), run-context persistence, unwrapped HOME fallback;
  IR-120 refusal harness extended with `resolveCacheHome`.
- [x] Web hint + docs (ADR-0015, CHANGELOG, API.md).

## Architecture impact

- **ADR required:** Yes — extends the accepted ADR-0011 posture to serving
  (execution-user change, security-sensitive spawn surface).
- **Relevant ADRs:** ADR-0011 (extended), ADR-0003 (privileged agent),
  ADR-0008 §7 (`$PORT` contract unchanged), ADR-0013 (per-user modelctl).
- **Proposed ADR:** [ADR-0015](../docs/adr/0015-cache-user-serve-execution.md)
  (Accepted 2026-10-29).

## Validation evidence

- Tests: full `pnpm test` — agent 14/14 files, web 25/25, core 11/11, proxy
  4/4, server 13 passed + 10 skipped (db-gated by design). New:
  `apps/agent/test/setups.test.ts` — wrap argv shape, passwd refusal (nothing
  persisted), wrapped start+stop execution through a runuser test double
  (env reaches the script, root `HF_HOME` scrubbed, `runUser` persisted), and
  unwrapped HOME fallback.
- Build: `pnpm build` — server (tsc), agent (esbuild bundle 3.1 MB), web
  (vite) green.
- Gates: `.agentic/bin/validate` — passed; `.agentic/bin/docs-check` — 9
  changed files, no heuristic gaps (2026-10-29).
- Live smoke: owner-gated — requires the agent bundle to reach DGX-1
  (agent-update via the hub) and a real serve start. Verification:
  `ps -o user= -p <engine pid>` → `operator`; setup log shows
  `driver: serving as cache user operator (HOME=/home/operator)`; no
  `HOME: unbound variable`.

## Notes

- Engine permission failures after this change are real prerequisites, not
  regressions: the cache user needs GPU device access (e.g. `video`/`render`
  groups) and read access to the model paths — the HF cache is theirs.
- Pre-IRI-045 driver records (no `runUser`/`runHome` fields) keep the old
  unwrapped stop behavior plus the HOME fallback; `typeof` guards handle the
  absent fields.
