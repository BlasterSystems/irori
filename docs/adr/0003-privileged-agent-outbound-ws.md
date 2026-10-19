# ADR-0003: Privileged per-node agent with outbound WebSocket

- **Status:** Accepted
- **Accepted:** 2026-10-19 — owner approval after M1–M7 shipped on these decisions
- **Date:** 2026-10-16
- **Decision owners:** piresbruno
- **Scope:** Node-side runtime, transport topology, privilege model, bootstrap
- **Tags:** agent, websocket, systemd, security, transport
- **Supersedes:** None
- **Superseded by:** None

## Context

Every node (DGX Spark, GPU host, NAS) must run clock control, hardware
collectors, model sync, inference probes, and serving supervision. The source
projects used SSH pull collectors plus an optional outbound-WS daemon
(sparkControl) — SSH needed sudo dances for every privileged op (clocks, sysfs,
modelctl), while the agent proved push telemetry with identical snapshot
shapes. Nodes sit behind NAT/tailnet; the server may run on any LAN computer.

## Decision drivers

- No inbound ports on nodes; server reachable from nodes is enough.
- Runtime privilege without sudo prompts (user requirement: "installing them
  as privileged service, so there is no problems with sudo").
- Real-time telemetry is first-class → push beats poll.
- Homelab trust model, but the agent executes server commands — the channel
  must be authenticated and revocable.

## Considered options

### Option 1: Privileged agent + outbound WS; SSH bootstrap/fallback (chosen)

`irori-agent` runs as a **root systemd system service**, connects out to
`wss?://server/agent-ws` with a per-node token, pushes snapshots, executes
jobs, supervises serving, runs modelctl. Install: server UI generates a
one-liner or SSH-pushes the bundle + config + unit using stored SSH
credentials; install succeeds only when the WS hello lands. SSH is kept only
for bootstrap and as a fallback transport (same snapshot shapes).

### Option 2: Agentless SSH collectors (sparkDash model)

No node software, but every privileged op needs passwordless-sudo setup, poll
cycles miss bursty serving state, and model/serving supervision is fragile
over SSH sessions.

### Option 3: Agent as container on every node

Consistent, but Docker-on-Spark adds layers to GPU access (device mounts) and
the NAS may not run Docker; bare-metal systemd is the honest primary path.

## Decision

Option 1. Details:

- **Privilege:** root system unit by design — the agent needs `nvidia-smi -lgc`
  resets, `scaling_max_freq` writes (no helper/sudoers dance, replacing
  sparkControl's `spark-clock` helper), rapl reads, and modelctl as the
  store's owner. Documented as the homelab trust boundary (SPEC §12).
- **Channel:** outbound WS, token per node, rotatable via `config-update`;
  disconnected agents re-bootstrap. Jobs: argv or shell mode, output ring,
  one active job per node.
- **Snapshot parity:** agent push and SSH fallback produce identical
  `packages/core` shapes; `transport` + `agentVersion` in every snapshot.
- **Reconcile:** desired clocks re-applied on every offline→online transition
  (survives node reboots without a node-side timer).

## Consequences

### Positive

- All privileged ops are ordinary code paths; no sudoers/sudo -t flows.
- Live push telemetry over NAT/tailnet; serving logs stream without polling.
- One daemon concentrates node functionality (user requirement #11).

### Negative

- Root daemon is a high-value target — mitigations below.
- Agents must be bootstrapped once per node (scripted, UI-assisted).

### Risks and mitigations

- Compromised server ⇒ root on nodes → LAN trust boundary, token revocation,
  jobs allowlist (argv vs shell modes), no server-pushed file writes outside
  managed dirs.
- Stale agent versions → version in every hello/snapshot; upgrade = re-run
  install; server refuses agents older than min-supported.

## Implementation and validation

M1: hello/token handshake + first snapshot push; M2: collectors at cadence;
M4: modelctl jobs; M5: serving supervision; M7: install script + systemd unit
shipped in the release. Validation: contract tests on snapshot shapes;
kill/relaunch agent → reconnect + clock reconcile test; revoke-token test.

## Revisit triggers

- A node type that cannot run a root service (none known).
- Multi-tenant exposure of the server (would force auth + agent ACLs first).

## References

- SPEC §2, §11, §12; PLAN M1/M2/M7; ADR-0001, ADR-0004.
- sparkControl `server/agent/` + `SparkMonitor` online-reconcile precedent.
