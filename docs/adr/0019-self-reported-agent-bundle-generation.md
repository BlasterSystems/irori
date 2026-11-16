# ADR-0019: Self-reported agent bundle generation

- **Status:** Accepted
- **Date:** 2026-11-16
- **Decision owners:** Bruno Pires
- **Scope:** Agent identity/versioning, node registry schema, node page
- **Tags:** agent, deployment, schema, observability
- **Supersedes:** None
- **Superseded by:** None

## Context

`agentVersion` (semver) is generation-blind: a node can run a pre-fix bundle
generation while reporting the current semver. This masked the IR-251 install
catch-22 on dgx3 — the 2026-11-15 08:43 update "confirmed 0.7.0" while the
running process still threw the pre-fix error at 16:51–22:55. The only exact
check was a manual sha256 diff (hub artifact vs `/opt/irori/irori-agent.mjs`)
per the fleet-convergence runbook.

## Decision drivers

- A stale bundle must be identifiable from the hub UI without node shell access.
- The wire contract must stay additive: old agents and old hubs interoperate
  without errors (non-strict zod strips unknown fields both ways).
- Unknown must never render as a verdict — the IR-243 posture rule
  ("unknown is never behind") applies to any derived health signal.

## Considered options

### Bump the semver per bundle generation

Rejected: noisy release hygiene, and the semver is the product version, not a
build identity.

### Hub-side node probe

Rejected: the hub has no node shell access by design (ADR-0002 security
posture); an ssh fallback contradicts ADR-0003's outbound-only agent.

### Hello self-report of the running bundle's hash (selected)

The agent hashes its own bundle file; the hub hashes the artifact it serves
and diffs. Both sides already exist — no new infrastructure.

## Decision

The agent hello carries an optional `bundleSha256` (sha256 hex of `argv[1]`,
reported only when it is a deployed `.mjs` bundle — dev runs from TypeScript
sources and unreadable files send no field). The hub persists it on the node
row (nullable `nodes.bundle_sha256`, migration 0028, triple-state `markSeen`:
absent field clears, snapshot flushes never touch) and diffs it against the
mtime-cached sha256 of `deps.agentArtifacts.bundle`. Every node payload
carries `bundle: { running, expected, state }` with `state` ∈ `current` |
`behind` | `unknown`; either side missing → `unknown`. The node page's
identity meta line renders the state (behind carries truncated
running/expected prefixes).

## Consequences

### Positive

- A stale bundle is visible per node from the UI, no ssh.
- The semver-≠-generation trap that cost the dgx3 incident is closed.
- Additive on every layer: old agents → "unknown"; old hubs strip the field.

### Negative

- One nullable column (migration 0028) and one optional hello field to carry
  forever.

### Risks and mitigations

- A bundle replaced between `mv` and restart briefly reports the new hash
  while the old process runs — the window is the update flow itself, which
  restarts the agent immediately; the next hello re-anchors truth.
- The self-hash reads `argv[1]` at hello time; a relocated/renamed entry
  point simply reports "unknown" (fail-safe, not fail-wrong).

## Implementation and validation

Implemented in IR-260 (task record `tasks/IRI-146-bundle-generation.md`).
Tests across all layers: core schema + classifier, agent hello
presence/absence (fake-ws harness), hub ingest records/clears, store
triple-state + migration 0028 (db integration), route classification against
a fixture artifact, web meta-line mount tests. Full suite 1430 green,
typecheck 6× Done.

## Revisit triggers

- If agent updates move away from hub-served single-file bundles (e.g.
  signed archives), the hash source changes.
- If the fleet grows past the point where per-node payload size matters, the
  `bundle` object can move to a dedicated endpoint (the
  `GET /api/v1/nodes/:id/versions` precedent).

## References

- `tasks/research-dgx3-modelctl-clockcap-layout.md` (D3 — owner-approved design, 2026-11-16)
- `tasks/IRI-146-bundle-generation.md`, Jira IR-260
- [ADR-0007](0007-hub-served-agent-artifacts-and-updates.md) (hub-served artifacts), [ADR-0016](0016-boot-migration-convergence.md) (boot migrations), IR-243 (posture rule), IR-251 (the masked install fix)
