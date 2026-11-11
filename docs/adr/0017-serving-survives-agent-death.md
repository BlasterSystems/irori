# ADR-0017: Serving survives agent death — per-setup scope units

- **Status:** Proposed
- **Date:** 2026-11-11
- **Decision owners:** Bruno Pires
- **Scope:** apps/agent (setups, jobs, unit), apps/server (agent-update guard), deployment
- **Tags:** serving, setups, systemd, cgroups, agent-update, availability
- **Supersedes:** None
- **Superseded by:** None

## Context

Serving setups are spawned by the agent as child processes
(`apps/agent/src/setups.ts`, `spawn(…, { detached: true })`). `detached`
gives the engine its own session and process group — which is what
`stop()` kills via the persisted pgid — but it does **not** leave the
agent's systemd cgroup. The `irori-agent` unit sets no `KillMode`, so the
systemd default `control-group` applies: any restart of the unit
(`systemctl restart irori-agent`, an agent self-update, a crash loop with
`Restart=always`) SIGKILLs every descendant process, including running
inference engines.

Consequences observed in production (2026-11-11):

- A head serving a tensor-parallel engine cannot receive an agent update:
  the hub refuses with "node has a running setup — stop it first (an agent
  restart kills it)" (`apps/server/src/app.ts:727`). Updating DGX-1 means
  stopping `GLM-Flash-TP3-MIIA`, which reloads weights on three nodes.
- An agent crash loop (any bug in the agent bundle) takes down serving on
  the node — and for a TP head, serving on the whole engine.

The self-update flow already proved the escape hatch: it runs inside its
own `systemd-run --pipe --wait` transient unit precisely so the restart it
performs cannot kill it (`apps/agent/src/jobs.ts`, ADR-0007).

## Decision drivers

- A serving engine (weights loaded, TP ranks synchronized across nodes)
  represents minutes of cold-start cost and live in-flight requests; its
  death must never be a side effect of agent lifecycle.
- `stop()` and the start guard already operate on **persisted records**
  (pgid, ports, script paths) plus driver-truth polls — not on live child
  handles. The agent restart therefore loses nothing it cannot re-derive.
- Engines started via `docker start` already survive agent restarts (the
  container lives in dockerd's cgroup); only directly spawned engines
  (tensorfold, llama.cpp servers) die with the unit. The fix must not
  depend on docker.
- The change must be fallback-safe on hosts without systemd (macOS dev,
  containers without a writable /run/systemd).

## Considered options

### Option A: `KillMode=process` on the agent unit

One line in the unit. On restart, only the agent's main process is killed;
children (engines, proxies) survive in the unit's cgroup, orphaned to
init.

- Pros: trivial; no spawn-path change.
- Cons: the cgroup stays the agent's — a `systemctl stop irori-agent`
  (intentional, or a package upgrade) still kills everything in it
  depending on unit type semantics; any future `ExecStop`/cleanup script
  sweeping the cgroup reintroduces the bug silently. Process reaping and
  cgroup membership stay implicit and invisible.

### Option B (selected): per-setup transient scope units

Spawn each setup's start/stop script wrapped in
`systemd-run --scope --unit=irori-setup-<slug>` (system manager, root
agent). The scope gives the script **and its detached engine descendants**
their own cgroup that no agent restart touches; the scope unit persists
until its last process exits, so it naturally covers the whole engine
lifetime. The unit name is recorded in the setup record; `stop()` prefers
`systemctl stop <unit>` (clean SIGTERM to the cgroup) and falls back to
the recorded pgid; on boot the agent adopts running scopes instead of
respawning (the start guard already refuses a double start).

- Pros: explicit, inspectable (`systemctl status iroori-setup-*`); scoped
  cleanup via `systemctl stop`; works for docker-spawned engines too (the
  scope holds only the short script); no agent-unit semantics change.
- Cons: requires systemd (feature-detect `systemd-run` and fall back to
  today's spawn); the record schema grows a field; stop ordering changes
  subtly (scope stop must come after the stop script so the script's own
  graceful shutdown wins).

### Option C: detach engines into the agent's own supervisor

Re-exec engines via a small supervisor daemon the agent talks to over a
socket.

- Pros: full control, works without systemd.
- Cons: a second process to ship, supervise, and version — significant
  complexity for what a scope unit already provides.

## Decision

Option B. Setups spawn inside `irori-setup-<slug>` transient scope units;
the slug is persisted in the setup record; stop prefers
`systemctl stop <unit>`; boot adopts live scopes. The hub's agent-update
guard is relaxed from a refusal to a no-guard once the agent bundle
reporting the scope behavior (agent ≥ the release that ships this ADR) is
on the node: updating an agent that serves must not require stopping the
setup. Agents older than that keep the guard (the hub compares the
node's `agentVersion`).

## Consequences

### Positive

- Agent crash loops, restarts, and self-updates no longer take serving
  down — the headline availability goal.
- DGX-1 (and any TP head) can be agent-updated while serving.
- Cleanup is explicit: `systemctl stop iroori-setup-*` reclaims a leaked
  engine without touching the agent.

### Negative

- The setup record schema grows (`scopeUnit`); older agents ignore it.
- A scope unit holds a cgroup for the engine's whole lifetime — one more
  unit to list on the node (harmless; visible under `iroori-setup-*`).
- `systemd-run` becomes a soft dependency on Linux agents (fallback
  preserves today's behavior).

### Risks and mitigations

- *Half-adopted fleet*: the hub guard keys on `agentVersion`, so old
  agents keep the refusal; no mixed-mode kill window.
- *Scope unit name collisions*: slug = setup id prefix + random suffix
  (same pattern as the self-update unit).
- *Stop ordering*: the stop script runs first (graceful, owner-provided);
  `systemctl stop <unit>` is the fallback after a timeout, never before.

## Implementation and validation

1. `setups.ts`: wrap the start/stop script spawn in the scope unit when
   `systemd-run` is available and the platform is Linux; record the unit
   name in the driver record; stop path: script → scope stop fallback.
2. Boot: adopt live scopes (record exists + unit active ⇒ running; polls
   report driver truth — existing machinery).
3. Hub: relax the agent-update guard for agents ≥ the scope release.
4. Tests: spawn-wrapper unit tests (unit name, fallback), record round-trip,
   guard version comparison.
5. Live: on a spark node, start a dummy long-running setup, restart the
   agent (and run an agent-update), assert the engine port never dropped a
   request and the scope unit is still active; then stop and clean up.

## Revisit triggers

- A hosting environment where scopes are unavailable but agent-updates
  must be zero-downtime (build the Option C supervisor then).
- systemd changes scope GC semantics in a way that reaps live engines.

## References

- `apps/agent/src/jobs.ts` — the self-update transient-unit trick this
  generalizes.
- `apps/agent/src/setups.ts` — spawn, records, start guard, polls.
- `apps/server/src/app.ts:727` — the guard this ADR relaxes.
- IR-204's live verification, which surfaced the guard's cost.
