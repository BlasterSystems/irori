# ADR-0004: modelctl remains the model supply-chain engine

- **Status:** Proposed
- **Date:** 2026-10-16
- **Decision owners:** operator
- **Scope:** Model store compatibility, transfer engine, HF integration
- **Tags:** modelctl, nas, hf, subprocess, storage
- **Supersedes:** None
- **Superseded by:** None

## Context

The NAS model store is managed by `modelctl` (Python CLI): manifests, immutable
objects `models/ORG/REPO/COMMIT--SELECTION`, atomic `active/NAME` symlinks,
resumable `.staging/`, state journals, derived `catalog.json`, cards. It also
implements the hard parts — resumable rsync transfers with HF ETag validation
(Git SHA-1 / LFS Xet SHA-256), CX7 fan-out push with remote handshake/commit,
queue preflight. The requirement: **maintain compatibility with the modelctl
file and folder organization so nothing on the NAS migrates**, and the agent
must "sync models from NAS" and "sync models between DGXs".

## Decision drivers

- Zero NAS migration; the store must stay modelctl-manageable forever.
- Resumable, integrity-checked transfers are already solved there; bugs in a
  reimplementation would corrupt multi-GB artifacts.
- The agent is TypeScript; hf_xet/ETag semantics are non-trivial to port.
- The UI still needs search, HF metadata, placement, and job streaming.

## Considered options

### Option 1: Agent shells out to modelctl (chosen)

The agent requires `modelctl` on model-ops nodes (NAS + Sparks), pinned to a
minimum version, with an install/upgrade job. **Provisioning** (supervised
job, streamed output): check `uv` (install via the standalone installer if
missing) → `uv tool install --force` from the pinned **GitHub release tag**
(`piresbruno/modelctl`) → verify `modelctl --version` ≥ pin. Offline /
private-repo fallback: the release wheel ships **inside the agent bundle**
and installs from local file. `uv tool list`-style upgrades re-run the same
job with a new pin. All mutations
run as supervised jobs with streamed output: `download`, `queue`, `sync-local`,
`push`, `delete`, `doctor`, `repair-active`, `catalog refresh`. Reads prefer
`catalog.json` (schema 3) with a live-scan fallback implemented natively in
`packages/core` (read-only contract), so listings never require modelctl and
never rewrite the shared catalog.

### Option 2: Reimplement store logic natively in the agent

One runtime, but re-solving atomic publish, journals, ETag validation, and
push handshake — the highest-risk code in the system — with immediate store
compatibility debt.

### Option 3: Serve model ops from the server container (sparkControl model)

Keeps nodes thin but routes multi-GB transfers through the server host and
assumes the server can reach the NAS/NFS — wrong place for the work.

## Decision

Option 1. Contract invariants (enforced in `packages/core` + tests):

- Irori **never mutates** the store except through modelctl commands.
- `catalog.json` is read-only for Irori; stale/dirty → live scan + warning.
- Destructive ops (delete, gc, repair) are dry-run first, then armed
  (`--apply --yes`) via explicit UI confirmation.
- `serve-command` output is surfaced for copy; never executed by Irori.
- Model list joins HF metadata (repo, revision, quantization, companions,
  cards) cached per model for search/recipe creation.

## Consequences

### Positive

- NAS compatibility is guaranteed by construction; modelctl keeps evolving.
- Battle-tested resumable transfers and validation for free.

### Negative

- Python dependency on model-ops nodes (install/upgrade job mitigates).
- Job output is CLI text — progress parsing is best-effort (structured
  `--json` where modelctl provides it).

### Risks and mitigations

- modelctl missing/broken on a node → `doctor` check on enroll + install job;
  ops blocked with actionable error, not partial writes.
- CLI output drift across versions → pin minimum version; golden-output tests.

## Implementation and validation

M4 implements wrappers + catalog reader + placement planner. Validation:
integration test against a fixture store (golden `catalog.json`), and one live
end-to-end: download on NAS → sync-local → push over CX7 (PLAN M4 exit).

## Revisit triggers

- modelctl store format change (schema bump) → update `packages/core` reader.
- A node class that cannot install modelctl but needs model ops.

## References

- SPEC §6; PLAN M4; ADR-0003 (agent jobs); `~/Developer/modelctl/README.md`
  (store layout, command semantics).
