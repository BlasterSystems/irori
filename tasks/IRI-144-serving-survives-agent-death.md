# IRI-144 — Serving survives agent death (ADR-0017 implementation)

- **Status:** In progress
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

(filled at the end)

## Residual risks

- Engines that double-fork out of every cgroup they own are out of scope —
  the scope still holds them (cgroup ≠ process group); only engines that
  escape via docker/podman self-cgrouping behave as before (they already
  survived).
- A scope-wrapped start script that fails before daemonizing leaves a
  transient unit until systemd GCs the empty scope — harmless.
