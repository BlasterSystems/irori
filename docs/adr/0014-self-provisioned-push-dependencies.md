# ADR-0014: Self-provisioned push dependencies (preflight, destination deps, transfer keys)

- **Status:** Accepted
- **Date:** 2026-10-27
- **Decision owners:** piresbruno
- **Scope:** Push dependency provisioning: agent-side push preflight, destination dependency ensure, hub-orchestrated transfer-key exchange
- **Tags:** modelctl, transfers, ssh, jobs, security, provisioning
- **Supersedes:** None
- **Superseded by:** None

## Context

A node-to-node `push` requires four things on the destination: reachable sshd, authorized key auth for the source cache user, a pinned host key, `rsync`, and `modelctl`. ADR-0011 documented two of these ("passwordless user-level ssh between sparks") as owner-ops, and ADR-0013 self-provisioned the modelctl half. The first real dgx→dgx push (2026-10-27, DGX-1 → DGX-3, 163.6 GiB) failed twice: once because the destination cache user had no modelctl, and once because the ssh hop had never been set up — both surfaced as the same ambiguous `modelctl` error ("modelctl is not installed on …", `~/Developer/modelctl/src/modelctl/remote.py:252` masks any nonzero ssh exit), took a hub-records and source-code investigation to diagnose, and ended in manual owner ops (agent update, ssh-copy-id).

The owner's expectation: the platform provisions its own dependencies. Approved scope (2026-10-27, owner): full self-healing — preflight, destination dep ensure, and hub-orchestrated key exchange.

## Decision drivers

- Private keys must never leave the node holding them; the hub (unauthenticated API by design, ADR-0002) must never store SSH credentials.
- ADR-0007 rejected SSH-assisted install because stored credentials would hand hub compromise root on every node. Any key automation must not raise the privilege floor: today the hub can already execute arbitrary jobs on every agent (ADR-0003 argv/shell jobs, run by a root systemd service), so hub compromise already implies node root. The bar is therefore: no credential persistence on the hub, no wider standing authority than the transfer design already grants.
- The transfer design already requires this ssh authority (ADR-0011: "modelctl ssh user == cache owner"; push destinations are `user@host`, setups-service.ts:751) — provisioning it completes the design.
- Jobs are one-active-per-node: destination-side provisioning must complete before the source-side push job is created.
- Failures must be actionable at 400 ms, not after a 163 GiB transfer attempt.

## Considered options

### Option 1 — Preflight + destination dep ensure + hub-orchestrated key exchange (chosen)

The push job gains an agent-side preflight that probes every target (ssh reachability/auth, host key, remote modelctl, remote rsync) and fails fast with a per-host classified message. The hub wires a link before dispatching a push: source agent generates/loads a per-cache-user ed25519 transfer key (private key node-local), destination agent authorizes the public key into the cache user's `authorized_keys` and reports its real ssh host public keys, source agent pins those host keys into the cache user's `known_hosts`, and a root `ensure-rsync` job installs rsync on the destination. Link state in a `transfer_links` table; the push stage wires missing links automatically. Benefits: push "just works" between sparks; failures self-explanatory; no hub-held credentials. Costs: three new job kinds, a migration, an ADR-superseding trust change.

### Option 2 — Preflight + dep ensure, keys manual

Everything except the key exchange; the preflight prints the exact `ssh-copy-id` command. Costs: every new node pair still needs owner ops; the owner explicitly rejected this. Rejected.

### Option 3 — Preflight only

Classify failures, change nothing else. Cheapest, leaves the root cause manual. Rejected: does not meet the owner's expectation.

## Decision

Option 1. Concretely:

1. **Preflight** — the agent's push job script probes each `host` before invoking `modelctl push`: one `ssh -o BatchMode=yes` call per host running a probe that reports (a) ssh outcome — classified from returncode/stderr into `auth-failed` / `host-key` / `unreachable` — (b) remote modelctl presence at the ADR-0011 candidate paths, (c) remote `rsync` presence. Any gap fails the job immediately with per-host remediation lines streamed to the job output.
2. **Destination deps** — before creating a push job, the hub dispatches a root `ensure-rsync` job to each destination agent (idempotent `apt-get install -y rsync`; no params, no arbitrary packages). Destination modelctl is already covered by ADR-0013 auto-dispatch.
3. **Transfer keys** — hub-orchestrated **reactively**: a push job whose preflight reports an ssh trust gap fails with an `IRORI_PUSH_BLOCKED=` marker; the hub's push-settle hook parses it, runs the wire, and re-creates the push once (guarded by a `_remediated` param — no loop, no persisted link state). This covers every push entry point (UI and setup stages) with zero schema change:
   - `transfer-key-ensure {user}` (source): as the cache user, generate `~/.ssh/id_ed25519` (empty passphrase) if absent; print the public key behind an `IRORI_TRANSFER_PUBKEY=` marker.
   - `transfer-key-authorize {user, publicKey}` (destination): as the cache user, append the key (comment-tagged `irori-transfer`) to `authorized_keys` (deduplicated), and print the machine's `/etc/ssh/ssh_host_*.pub` lines behind `IRORI_HOSTKEY=` markers.
   - `transfer-hostkey-pin {user, host, hostKeys}` (source): as root, append the destination's host keys to the cache user's `known_hosts` (idempotent) — verified keys via the hub, never TOFU keyscan.
   - Private keys are generated on and never leave the source node; the hub relays public material only.

## Consequences

### Positive

- A push between sparks works on the first click; every dependency is provisioned or explained in one streamed preflight.
- New nodes/pairs need no owner SSH ceremony; modelctl stays pinned via ADR-0013.
- Failures are classified (`auth-failed` / `host-key` / `unreachable` / `modelctl missing` / `rsync missing`) instead of the modelctl catch-all.

### Negative

- Three new job kinds; the push settle gains a remediation hook that must respect one-active-per-node sequencing (retry with backoff, single guarded re-push).
- Standing credentials: once wired, a pair stays passwordless-ssh-capable independent of the hub.

### Risks and mitigations

- *Hub compromise could authorize an attacker-controlled key on a cache user.* Mitigation: the hub's job authority already implies node root (ADR-0003), so this adds no privilege floor; keys are comment-tagged `irori-transfer` so they are identifiable and removable, and the wire flow is idempotent/re-runnable.
- *Key exchange against a destination that is busy* (one-active-per-node). Mitigation: the orchestrator retries `JobBusyError` with backoff before starting the push; preflight failures name the busy node.
- *Host key drift* (node reimaged). Mitigation: ssh failure classified as `host-key` names the mismatch; re-running the wire replaces the pinned key.
- *Stale pins after `uv tool install` puts modelctl outside candidate paths.* Mitigation: the preflight uses the same candidate list as `remote.py` and reports the resolved path.

## Implementation and validation

- Slices (sequential): IR-113 preflight; IR-114 `ensure-rsync` + the push-settle remediation hook; IR-115 key exchange job kinds + hub wire flow. Task `tasks/IRI-038-push-self-healing.md`.
- Validation: agent tests for the preflight/provisioning scripts (arg shapes, marker parsing, classification); server tests for the push-stage orchestration and link state; db-gated suite for the migration; live end-to-end push DGX-1 → DGX-3.

## Revisit triggers

- Multi-user caches needing per-pair isolation beyond the cache-user model.
- Fleet leaves the LAN/tailnet (ssh over untrusted networks → consider host-key CA or WireGuard-only transfers).
- The owner revisits ADR-0007 (hub-held credentials) — the relay could then collapse into a single provisioning path.

## References

- Tasks: `tasks/IRI-038-push-self-healing.md`; research `docs/research/IRI-038-research-brief.md`
- ADR-0003 (privileged agent, job surface), ADR-0007 (no hub-held SSH credentials), ADR-0011 (cache-user transfers — this decision automates ADR-0011's "Operating prerequisites" owner ops: the modelctl install via ADR-0013 and the user-level ssh exchange; the runuser cache-user pattern itself stands), ADR-0013 (modelctl convergence)
- `~/Developer/modelctl/src/modelctl/remote.py:227-256` (ambiguous discovery error), SPEC §3 (transfer prerequisites)
