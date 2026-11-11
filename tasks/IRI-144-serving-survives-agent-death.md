# IRI-144 — Serving survives agent death (ADR-0017 implementation)

- **Status:** Done (implemented + live-verified 2026-11-11, dev-0.7.0-13)
- **Type:** Feature
- **Priority:** High
- **Jira:** IR-147-adjacent availability work (ADR-0017)
- **ADR:** [ADR-0017](../docs/adr/0017-serving-survives-agent-death.md) (Accepted 2026-11-11)

## Problem

Setups spawn `detached` but stay inside the `irori-agent` systemd unit's
cgroup; the unit sets no `KillMode`, so the `control-group` default SIGKILLs
every descendant on restart — agent updates, crash loops, and
`systemctl restart irori-agent` all kill running engines. This is why the
hub refuses agent updates while a setup runs (`app.ts` 409), blocking
DGX-1 updates while the TP engine serves.

## Spec (ADR-0017 decision)

1. When host systemd can host transient units, the start script spawns
   inside `iroori-setup-<slug>.scope` (`systemd-run --scope`). The unit
   name is persisted in the driver record (`scopeUnit`).
2. `stop()` prefers `systemctl stop <unit>` AFTER the stop script (graceful
   wins), with the pgid TERM→KILL drain as the fallback.
3. Boot (`init()`) probes dead-group records with an active scope once and
   re-attaches them like live groups (covers daemonizing engines).
4. The start guard refuses when the recorded scope is still active.
5. The `agent-update` job refuses at dispatch while any running setup is
   unscooped (ground truth); the hub's 409 relaxes for agents ≥
   `SCOPE_CAPABLE_AGENT_VERSION` (0.8.0; the agent bumps to 0.8.0).
6. Non-systemd hosts (macOS dev, containers): `scope.available()` false →
   today's behavior byte-for-byte.

## Acceptance

- [ ] Scope argv + record round-trip unit-tested; fallback paths tested.
- [ ] Boot adoption + start-guard scope probe tested with a fake surface.
- [ ] Agent-update refusal (agent side) tested.
- [ ] Full gate: `pnpm test`, `pnpm build`, validate, docs-check.
- [ ] Live: a dummy setup on a spark node survives `agent-update` (scope
  active through the restart, port never drops, driver re-attaches), then
  cleans up.

## Validation

- Full gate green: `pnpm test` (core 12 / db / proxy 4 / web 59 / agent 26 /
  server 28 files), `pnpm build`, `.agentic/bin/validate`, `.agentic/bin/docs-check`;
  CI verify green on the shipped commits.
- Live (DGX-3, 2026-11-11):
  - Dummy setup (`python3 -m http.server 8099`) spawned inside
    `irori-setup-70e79b02-1d82.scope` — the scope CGroup holds the
    runuser-wrapped script and the engine; the ADR-0011 cache-user wrap
    nests inside the scope.
  - Driver `stop()` stopped the scope: unit gone, port closed, engine gone.
  - **The headline proof**: `agent-update` dispatched while the setup ran
    (the pre-ADR hub 409'd the same request), the agent restarted, and the
    engine answered 40/40 loopback polls with 0 misses across the restart;
    the scope kept the original pids and the driver re-adopted the run.
  - The TP-3 engine (head DGX-1, worker DGX-3) served live traffic
    (88 tok/s, KV 56%) straight through both DGX-3 agent restarts.
- Settle fix: a stale agent-update row (expected 0.7.0, agent 0.8.0) that
  the exact-match rule left running forever settled `succeeded` on the
  next hello after dev-0.7.0-13 ("update confirmed: agent reports 0.8.0").

## Residual risks

- Engines that double-fork out of every cgroup they own are out of scope —
  the scope still holds them (cgroup ≠ process group); only engines that
  escape via docker/podman self-cgrouping behave as before (they already
  survived).
- A scope-wrapped start script that fails before daemonizing leaves a
  transient unit until systemd GCs the empty scope — harmless.
