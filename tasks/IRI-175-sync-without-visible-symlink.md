# Task: IRI-175 — modelctl sync-local without a client-visible symlink; Irori follows the pin

Jira: [IR-291](https://blastersystems.atlassian.net/browse/IR-291), story S3 of epic
[IR-288](https://blastersystems.atlassian.net/browse/IR-288). Research:
`tasks/research-store-node-ownership.md` (option F1, phase 3).

## Objective

Syncing from the store no longer depends on how the network protocol presents
symlinks to the client, and Irori stops blocking the sync once the fleet's
modelctl can do that.

## Product manager summary

- **One-liner:** Sync from the NAS works over SMB again with modelctl 0.25.1.
- **User value:** No mount change is needed to get models onto Sparks.
- **Business impact:** Removes the fleet-wide sync failure without touching the NAS share.
- **Success metric:** With the hub pin at 0.25.1, a Spark on SMB syncs a store model successfully.
- **Dependencies & constraints:** modelctl 0.25.1 must be published before the hub pin is raised. IRI-173 provides the gate this relaxes.

## Acceptance criteria

- [x] modelctl tests: symlink present (unchanged path); directory entry with a valid journal (sync from the canonical object); journal written under another mount path; missing journal (actionable error); directory that differs from the journaled object (refused); journal object outside `models/` (refused).
- [ ] On the dev fleet, a Spark still mounted over SMB syncs a store model successfully. (Needs the modelctl release and a deploy.)
- [ ] Irori pin bump merged. (Deferred: the agent's fallback default cannot be raised until the tag exists on GitHub.)
- [x] S1 gating updated and tested for both pin sides.

## Scope

### Included

- modelctl (`~/source/modelctl`, branch `feat/sync-local-journal-reference`): journal-based resolution in `_active_store_object`, progress line, tests, changelog, README, release commit and tag `v0.25.1` (local).
- Irori: `MODELCTL_SYNC_WITHOUT_SYMLINK`, `syncNeedsVisibleLink(version)`; placement and setup transfers skip the link gate for a node whose reported modelctl is 0.25.1+; the hub adds `linkOptional` to the `sync-local` params at dispatch and the agent pre-check honours it.

### Excluded

- Raising the agent's fallback pin default (`0.24.0`) and the dev hub's pin: release steps after the tag is published.
- `modelctl list` and repository-id resolution on a mount that hides symlinks (still need visible links).

## Implementation plan

### Files to modify or create

- modelctl `src/modelctl/hf_cache.py`, `tests/test_operations.py`, `CHANGELOG.md`, `README.md`, `src/modelctl/__init__.py`.
- `packages/core/src/modelctl-pin.ts` - constant and rule.
- `apps/agent/src/sync-preflight.ts`, `apps/agent/src/jobs.ts` - `linkOptional` from the job params.
- `apps/server/src/jobs-service.ts` - `syncModelctlVersion`, remembered across the inventory reset; sets `linkOptional` in `create`.
- `apps/server/src/app.ts`, `apps/server/src/setups-service.ts`, `apps/server/src/index.ts` - version-aware gate.

### Key changes

- modelctl reuses its own `_journal_object`; when the journal records the store host's path and no manifest can rebuild it, the part below `models/` is re-rooted onto the local mount. The result must be inside `models/`, validate for the journaled commit, and match the metadata the directory shows.
- Irori decides per node from the modelctl version that node reports for the user the sync runs as. Unknown means the link is still needed. The hub pin rolls the version out but is not the signal: a node can stay below the pin.

### Test approach

- modelctl: pytest with temp stores that turn the symlink into a directory copy, as an SMB client sees it.
- Irori: core unit test for the rule (including malformed versions); agent pre-check and job tests with and without the hub's flag; db-gated tests for the dispatch flag, the remembered version and the setups transfer on both sides.

## Plan

- [x] Run the confidence-check readiness gate
- [x] Understand requirements and inspect relevant code
- [x] Confirm architecture impact
- [x] Implement the smallest complete change
- [x] Add or update tests
- [x] Update documentation
- [x] Run validation

### Readiness gate (confidence-check, 2026-11-28)

- Requirements: clear. Impact: one resolver function in modelctl; a version switch in Irori.
- Tests: planned and written. Security: the resolved path is confined to `models/` and validated; the directory is never the source.
- Rollback: revert; an older modelctl keeps the IRI-173 gate. No red flags.

## Architecture impact

- **ADR required:** No. modelctl keeps its invariant (a directory in `active/` is never trusted as a reference); Irori follows an existing pin mechanism (ADR-0013).
- **Relevant ADRs:** ADR-0004, ADR-0013.
- **Proposed ADR:** None.

## Deployment

- **Deploy-affecting:** Yes: agent bundle and hub; then a modelctl release and a hub pin change.
- **Artifact invariant:** `modelctl --version` on each node's cache user prints `0.25.1` or newer after the pin is raised.
- **Functional probe:** with the pin at `0.25.1` and the node's inventory reporting it, `GET /api/v1/placement?model=<store model>` shows `sync` for a Spark on SMB, and that sync succeeds with a first line naming the journaled object.
- **Rollback:** revert the commit; modelctl 0.25.1 is backward compatible.

## Validation evidence

- Tests: modelctl `python -m pytest`: all passing, 16 new cases. Irori `pnpm test` with a throwaway Postgres 17: core 152, proxy 24, db 16, web 610, agent 412, server 561, all passing.
- Build: `pnpm typecheck` exit 0.
- Documentation check: `CHANGELOG.md`, `docs/API.md`, `docs/DEPLOYMENT.md`; modelctl `CHANGELOG.md` and `README.md`.

## Review

- Correctness: see adversarial review.
- Security (security-check result): no CRITICAL or WARNING.
- Data isolation and authorization: unchanged.
- Compatibility and migrations: none; older modelctl and older agents keep the gate.
- Tests: listed above.
- Documentation and ADRs: updated; no ADR.
- Adversarial review (`quality-review` verdict; fresh context or self-review): **PASS WITH FINDINGS**, fresh read-only context covering both repositories (code reading only). It could not make modelctl copy from outside `models/`, from the `active/` directory, from another model, or from a commit other than the active one.
  - F1 (fix before merge), fixed: the relaxation was keyed on the hub pin, so a node that never reached the pin was offered a sync that failed with modelctl's old message. It is now keyed on the node's reported modelctl version; the agent acts only on the hub's `linkOptional` flag.
  - F2 (fix before merge), fixed: modelctl tests now cover traversal in the journal path, no `models` component, a relative path, a symlink under `models/` leading outside, and a journal behind the active object. Removing the `relative_to` check fails the symlink test. The `..` check is redundant with it (removing it alone leaves the tests green) and stays as defence in depth.
  - F3 (fix before merge), fixed: `register-local` on a directory entry is tested and prints the same line.
  - F4, fixed: the "no successful activation" error now names the remedy; README and `docs/DEPLOYMENT.md` note the limit.
  - F5, fixed: re-rooting tries every `models` component (a repository may be called `models`); tested.
  - F6, fixed: unexpected exception types in the journal and metadata reads give the plain message.
  - F7, noted: a resume with a repository id still needs visible symlinks (modelctl README says so).
- Residual risks: after a hub restart, or before a node's first inventory, its modelctl version is unknown and the link is required again until the next report. Models whose journal has no successful activation cannot sync through a hidden link.

## Completion summary

- **Technical decisions:** decide per node from its reported modelctl version; re-root journal paths instead of requiring a manifest.
- **Known limitations:** the release is prepared locally and not published; the pin default bump is deferred.
- **Deployment notes:** publish modelctl 0.25.1, deploy Irori, then set the hub pin to 0.25.1.
- **Follow-ups:** raise `IRORI_MODELCTL_PIN` default after the release; IRI-176.
