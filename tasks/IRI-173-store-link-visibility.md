# Task: IRI-173 — Detect store links a node can't see; gate Sync and pre-check sync-local

Jira: [IR-289](https://blastersystems.atlassian.net/browse/IR-289), story S1 of epic
[IR-288](https://blastersystems.atlassian.net/browse/IR-288). Research:
`tasks/research-sync-local-smb-symlinks.md` and `tasks/research-store-node-ownership.md`.

## Objective

Irori knows whether each node can read the store's `active/` links as symlinks,
stops offering a NAS sync that cannot work, and explains a failing sync in plain
words before modelctl starts.

## Product manager summary

- **One-liner:** A NAS sync that cannot work is no longer offered, and a failed one says why.
- **User value:** No more "has no active NAS reference" with no explanation; the node page says what is wrong with the mount.
- **Business impact:** Removes a silent, fleet-wide failure of the model supply chain on SMB mounts.
- **Success metric:** On a Spark mounted over SMB, the Models page shows the reason in place of **Sync**; a forced `sync-local` fails in under 5 s with a plain message and no modelctl process.
- **Dependencies & constraints:** None. S2 (IRI-174) builds on the inventory signal added here.

## Acceptance criteria

- [x] Agent tests cover entry kinds (symlink, directory, missing) and the inventory's unlinked list and warning.
- [x] `planPlacement` tests cover store-visible true, false and unknown; a `setups-service` test shows no sync stage for a node that sees a directory entry.
- [x] Agent tests show each pre-check failure case fails without spawning modelctl.
- [ ] On the dev hub, a Spark still mounted over SMB shows the reason instead of **Sync** for a store model. (Needs a dev deploy; not run from this task.)
- [x] No schema change. Deploy-affecting: new agent bundle and hub. Rollback is a plain revert.

## Scope

### Included

- Inventory field `store.unlinkedActive` and a store warning.
- Placement and setup-transfer gating on the node's own store view.
- Agent pre-check before `sync-local`.
- Models page reason without the disk-cleanup link; node page store warning on Sparks.
- `docs/API.md`, `docs/SPEC.md`, `docs/DEPLOYMENT.md`, `CHANGELOG.md`.

### Excluded

- Store-write fallback policy (IRI-174).
- modelctl resolving the object without a symlink (IRI-175).
- The NFS export itself (operations step on the QNAP).

## Implementation plan

### Files to modify or create

- `packages/core/src/inventory.ts` - `unlinkedActive` on the store schema; `storeLinkVisible()` helper.
- `packages/core/src/catalog.ts` - `PlacementNode.storeLinkVisible`; `STORE_LINK_HIDDEN_REASON`; sync gate in `planPlacement`.
- `apps/agent/src/catalog-read.ts` - `listUnlinkedActive()`.
- `apps/agent/src/inventory.ts` - report the list; `unlinkedActiveWarning()`.
- `apps/agent/src/sync-preflight.ts` - new: `syncLocalPreflight()`.
- `apps/agent/src/jobs.ts` - run the pre-check before spawning `sync-local`; spawn extracted to a method.
- `apps/server/src/app.ts` - placement route reads the node's inventory store view.
- `apps/server/src/setups-service.ts`, `apps/server/src/index.ts` - `getStoreView` dependency; skip sync stages for hidden links.
- `apps/web/src/components/ModelsView.vue`, `NodeDetail.vue` - reason and warning.

### Key changes

- The inventory lists names, not a count, so placement can decide per model. The count is the list's length.
- A model the node doesn't list yet (still downloading) is judged by the rest of the view: if every listed entry is hidden, the new one will be too.
- Unknown (no report, older agent) keeps today's `sync`; the agent pre-check is the backstop.
- The pre-check is async and time-bounded (IR-206 rule), so the job holds the node's active slot while it runs and spawns modelctl only when it passes.

### Test approach

- Core: `planPlacement` and `storeLinkVisible` unit tests.
- Agent: real temp-dir stores (symlink, directory, hidden file), an injected hanging `lstat`, and `JobManager` with a fake modelctl that logs its calls.
- Server: db-gated `setups-service` transfer test with per-node store views.

## Plan

- [x] Run the confidence-check readiness gate
- [x] Understand requirements and inspect relevant code
- [x] Confirm architecture impact
- [x] Implement the smallest complete change
- [x] Add or update tests
- [x] Update documentation
- [x] Run validation

### Readiness gate (confidence-check, 2026-11-28)

- Requirements: clear, from the ticket and the two research documents.
- Impact: files listed above; the agent job start path is the riskiest edit.
- Tests: planned and written per layer.
- Security: read-only stats on a path built from job params; the target name is not used when it contains `/`.
- Data isolation: not applicable (single-operator homelab, ADR-0002).
- Rollback: plain revert; the new report field is optional.
- Deployment: see below. No red flags.

## Architecture impact

- **ADR required:** No. Hardens existing behaviour inside ADR-0004 and ADR-0009.
- **Relevant ADRs:** ADR-0004, ADR-0009.
- **Proposed ADR:** None (IRI-174 carries the ADR for the write fallback).

## Deployment

- **Deploy-affecting:** Yes: new agent bundle and hub.
- **Artifact invariant:** the served agent bundle contains the string `is not visible as a symlink on this node's mount`.
- **Functional probe:** `POST /api/v1/nodes/<spark>/models/refresh`, then `GET /api/v1/nodes/<spark>/models` returns `report.store.unlinkedActive` as an array.
- **Rollback:** revert the commit and redeploy; older agents simply omit the field.

## Validation evidence

- Configuration validation: process-check items reviewed for the touched docs (no provider-specific text added).
- Tests: `pnpm test` with `IRORI_TEST_DATABASE_URL` set to a throwaway Postgres 17 container: core 143, proxy 24, db 16, web 606, agent 410, server 556, all passing.
- Build: `pnpm typecheck` (build + typecheck of every workspace) exit 0.
- Documentation check: route and agent changes are covered in `docs/API.md`, `docs/SPEC.md`, `docs/DEPLOYMENT.md` and `CHANGELOG.md`.

## Review

- Correctness: see adversarial review.
- Security (security-check result): no CRITICAL or WARNING. The pre-check adds read-only `lstat` calls under the node's configured store root; a target containing `/` is not joined into a path; messages contain paths and host names only.
- Data isolation and authorization: unchanged.
- Compatibility and migrations: optional report field, no schema change; older agents and hubs interoperate.
- Tests: listed above.
- Documentation and ADRs: updated; no ADR.
- Adversarial review (`quality-review` verdict; fresh context or self-review): **PASS WITH FINDINGS**, fresh read-only context (it read code only; it could not run tests). No BLOCK finding.
  - F1 (fix before merge), fixed: the link listing ran inside the 20 s store deadline, so a slow mount could cost the whole store view. It now uses one `readdir` with entry kinds and has its own 5 s budget; overrun drops only the optional field (test added).
  - F2 (fix before merge), fixed: a job settle drops the inventory row, and the gate's own fall-through (an HF download) is such a job. The hub now remembers the dropped report's store view in memory until the next report (`lastStoreView`, test added); documented in `docs/API.md`.
  - F3 (low), fixed: the "model not listed yet" rule compared unrelated counts; it now counts listed models only.
  - F4 (low), accepted: a hidden-link target whose model is not in the store yet gets `HF → NAS` plus `HF → target`, the same pair a target without a store mount already gets.
  - F5 (low), fixed: messages no longer blame SMB for a plain file or on the store host; `.` and `..` are left to modelctl.
  - F6 (low), fixed: job-level tests for unmounted share, missing entry, cancel during the check, a second start, and a throwing check; the setups test cleans up in `finally`.
  - Unverified suspicion acted on: a root agent on a root-squashed NFS export could get `EACCES` where modelctl (cache user) succeeds. The pre-check now blocks only on proof (missing, directory, timeout) and lets modelctl decide on any other error.
  - Unverified, left open: timed-out `lstat` calls stay on a libuv worker (pattern predates this change, IR-206).
- Residual risks: the remembered store view is in memory, so after a hub restart the view is unknown until the next report and the agent pre-check is the only gate. After a mount is fixed, a remembered hidden link persists until the node's inventory is refreshed (hourly sweep at the latest).

## Completion summary

- **Technical decisions:** names instead of a count in the report; pre-check in the job manager rather than a separate job kind.
- **Known limitations:** the dev-hub acceptance check needs a deploy; `DEPLOYMENT.md` names NFS as the expected fix but it is not verified on the fleet yet.
- **Deployment notes:** deploy hub and agents together; no ordering constraint.
- **Follow-ups:** IRI-174, IRI-175, IRI-176.
