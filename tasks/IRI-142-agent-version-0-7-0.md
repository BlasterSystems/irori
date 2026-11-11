# Task: Agent version 0.7.0 + bulk-action version gate (IR-207 follow-up)

## Objective

Make the shipped agent capabilities legible: bump the authoritative versions 0.6.0 → 0.7.0 (new agent job kinds + web features since the 0.6.0 release), record the user-visible changelog entries, and use the version to gate the bulk-delete action now that it is a reliable signal.

## Product manager summary

- **One-liner:** Agents report 0.7.0 and the UI gates bulk delete on it.
- **User value:** Fleet state is legible — you can tell a pre-batch agent from a post-batch one at a glance, and the UI stops offering actions that would fail with "unknown job kind".
- **Business impact:** Closes the version ambiguity that made IR-210's acceptance "gate on agent version" impossible at the time.
- **Success metric:** All four fleet nodes report 0.7.0 after the rollout; the bulk-delete button is disabled with a reason on a node below 0.7.0.
- **Dependencies & constraints:** None (versions bump per `docs/RELEASING.md`; `v*` publishing needs separate approval — only dev tags used here).

## Acceptance criteria

- [x] Six authoritative version fields bumped together (root + apps/{server,web,agent} + packages/{core,db})
- [x] CHANGELOG 0.7.0 section (bulk delete, staging/quarantine audit, download floor, cache self-heal)
- [x] Bulk-delete action gated on the store node's `agentVersion >= 0.7.0` (`compareVersions`), disabled with an explanatory title + hint line
- [x] Gates green; dev deploy `dev-0.7.0-1`; fleet rollout re-runs so every node reports 0.7.0

## Scope

### Included

- `package.json` (six), `CHANGELOG.md`, `apps/web/src/components/ModelsView.vue`

### Excluded

- `v0.7.0` annotated tag + release workflow (explicit approval per docs/RELEASING.md)
- modelctl upstream follow-ups

## Plan

- [x] Understand requirements and inspect relevant code
- [x] Confirm architecture impact
- [x] Implement the smallest complete change
- [x] Add or update tests (existing suites pin the versions indirectly; gate verified in the browser)
- [x] Update documentation (CHANGELOG)
- [ ] Run validation

## Architecture impact

- **ADR required:** No — version bookkeeping + a UI gate.
- **Relevant ADRs:** None

## Validation evidence

- pending

## Review

- Correctness: the gate reads the same `pickStoreNode` record the dispatch targets; `compareVersions` is the repo's semver comparator (orders pre-release suffixes correctly); a null version reads as 0 → gated
- Security: no new surfaces
- Compatibility: agents below 0.7.0 never see the action; the hub-side allowlist is unchanged
- Residual risks: none material
