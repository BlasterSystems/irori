# Task: IRI-174 — Store writes need a write-safe store view; no blind fallback to a mounted Spark

Jira: [IR-290](https://blastersystems.atlassian.net/browse/IR-290), story S2 of epic
[IR-288](https://blastersystems.atlassian.net/browse/IR-288). Research:
`tasks/research-store-node-ownership.md` (gap 2, phase 2). ADR: `docs/adr/0023-store-writes-need-a-safe-store-view.md`.

## Objective

Jobs that change the store run on the NAS node, or on a node that only mounts
the store when its inventory proves a clean view. Otherwise they wait and say
why.

## Product manager summary

- **One-liner:** A Spark that cannot see the store properly can no longer write it.
- **User value:** A NAS-agent outage can no longer send downloads or deletes through an SMB mount that hides the store's links.
- **Business impact:** Protects a multi-terabyte store from the kind of damage it suffered once before over SMB.
- **Success metric:** With the NAS agent stopped, queued downloads stay pending with a reason, and `GET /api/v1/store-writer` returns no node.
- **Dependencies & constraints:** Builds on IRI-173's inventory signal. Owner decision 2026-11-28: the rule is strict.

## Acceptance criteria

- [x] Core policy tests: NAS offline + Spark with an unsafe view → no store node for writes; NAS offline + Spark with a safe view → fallback works; NAS online → unchanged.
- [x] Download-queue test: entries stay pending with the reason and dispatch when the NAS node returns.
- [ ] ADR accepted and indexed in `docs/adr/README.md`. (Indexed as Proposed; acceptance is the owner's.)
- [x] Added after review: setup transfers plan no HF download onto a node that sees the store's links as directories.
- [x] `docs/API.md` and `docs/SPEC.md` describe the rule.
- [x] Depends on S1 (the store-view signal).

## Scope

### Included

- `storeViewSafeForWrites` (strict), `pickStoreNode` write predicate, `STORE_WRITE_KINDS`.
- Hub dispatch guard in the jobs service; `pickStoreWriter`; the download queue uses it.
- `GET /api/v1/store-writer`; the Models page sends store actions to that node and shows the reason.
- ADR-0023 (amends ADR-0009's fallback), docs, changelog.

### Excluded

- Changing who is the store node for display or hygiene attribution (reads keep today's pick).
- modelctl changes (IRI-175).

## Implementation plan

### Files to modify or create

- `packages/core/src/downloads.ts` - policy function, predicate parameter, kinds set, response schema.
- `apps/server/src/jobs-service.ts` - `storeWriteSafe`, `pickStoreWriter`, guard in `create`.
- `apps/server/src/download-queue-service.ts` - dispatch through `pickStoreWriter`.
- `apps/server/src/app.ts` - `GET /api/v1/store-writer`.
- `apps/web/src/models.ts`, `apps/web/src/components/ModelsView.vue` - fetch and use the hub's writer.
- `docs/adr/0023-…md`, `docs/adr/README.md`, `docs/API.md`, `docs/SPEC.md`, `CHANGELOG.md`.

### Key changes

- The guard sits in `jobsService.create`, the one function every dispatch path uses, so no route or service can bypass it.
- Unknown is not safe for writes (the opposite of the read gate in IRI-173).
- The web keeps its local pick for display and until the hub answers; the hub's guard is the enforcement.

### Test approach

- Core unit tests for the rule and the predicate.
- Db-gated tests: dispatch guard and remembered view (`job-events.test.ts`), queue waiting and fallback (`download-queue.test.ts`).
- Web unit tests for the response parsing and the hub-wins resolution.

## Plan

- [x] Run the confidence-check readiness gate
- [x] Understand requirements and inspect relevant code
- [x] Confirm architecture impact
- [x] Implement the smallest complete change
- [x] Add or update tests
- [x] Update documentation
- [x] Run validation

### Readiness gate (confidence-check, 2026-11-28)

- Requirements: clear; the one open rule (strict or tolerant) was decided by the owner.
- Impact: every job dispatch passes the new guard; three existing tests ran store deletes on a Spark fixture and now use the NAS fixture.
- Tests: planned per layer and written.
- Security: no new input; the new route is read-only and follows its neighbours' posture.
- Data isolation: not applicable (ADR-0002).
- Rollback: plain revert; no schema change.
- Deployment: hub only. ADR required: yes (ADR-0023). No red flags.

## Architecture impact

- **ADR required:** Yes.
- **Relevant ADRs:** ADR-0009 (amended), ADR-0004, ADR-0003.
- **Proposed ADR:** ADR-0023, status Proposed.

## Deployment

- **Deploy-affecting:** Yes: hub and web. No agent change.
- **Artifact invariant:** `GET /api/v1/store-writer` exists and returns `{nodeId, reason}`.
- **Functional probe:** with the NAS agent online, `nodeId` is the NAS node; a `download-queue` job posted to a Spark returns `409` naming that Spark.
- **Rollback:** revert the commit and redeploy.

## Validation evidence

- Configuration validation: ADR follows the template sections and is indexed.
- Tests: `pnpm test` with a throwaway Postgres 17: core 150, proxy 24, db 16, web 610, agent 412, server 560, all passing.
- Build: `pnpm typecheck` exit 0.
- Documentation check: route and policy changes are in `docs/API.md`, `docs/SPEC.md`, `CHANGELOG.md` and ADR-0023.

## Review

- Correctness: see adversarial review.
- Security (security-check result): no CRITICAL or WARNING. The change only adds a refusal and a read-only route.
- Data isolation and authorization: unchanged.
- Compatibility and migrations: no schema change. Behaviour change: with the NAS agent down, store writes wait instead of running on a mounted Spark.
- Tests: listed above.
- Documentation and ADRs: ADR-0023 Proposed and indexed.
- Adversarial review (`quality-review` verdict; fresh context or self-review): first pass **BLOCK**, re-check after fixes **PASS WITH FINDINGS**. Both in fresh read-only contexts (code reading only; they could not run tests).
  - BLOCK, fixed: armed store mutations bypassed the guard through kinds outside the set (`hygiene-clean` on `modelctl-staging`, `quarantine-prune`, `prune-cleanup-quarantine`). `isStoreWrite` now covers them, plus `sync-cards` and `download` on a node that mounts the store. The re-check traced every dispatch path to `create` and classified every job kind; none is left uncovered.
  - Fixed: the Models page disabled read-only checks and showed the reason only in the download dialog. Reads go to any store node again, changes to the hub's writer, and one banner shows the reason.
  - Fixed: a stale "nobody may write" answer (15 s refresh, sequence guard).
  - Fixed: an empty view counted as safe; the rule now needs at least one listed model.
  - Fixed: no age bound; a view older than 26 h is rejected, including the remembered one.
  - Fixed: ADR and docs wording (freshness, kind list, the web's local pick).
  - Re-check F1, documented in ADR-0023: a fleet with no NAS-kind node and an empty store has no writer.
  - Re-check F2, fixed: the "no route" stage of a setup transfer is `failed` with the reason, so the transfer no longer reads as succeeded.
  - Re-check F3, fixed: the core test now iterates every job kind against decided read and write lists.
  - Re-check F4, accepted (nit): the catalog row menu's Delete does nothing when nobody may write; the page banner gives the reason.
  - Unverified, left open: a node whose hub `nasRoot` is null but whose own modelctl config points at a mounted store could still `download` into it.
- Residual risks: the write-safe view is as old as the node's last report (hourly at most); modelctl's own symlink probe remains the last check.

## Completion summary

- **Technical decisions:** guard in `create`; strict rule; hub is the source of truth for the web.
- **Known limitations:** today's fleet has no write-safe fallback (Sparks are on SMB), so the NAS node is the only writer until the mounts change.
- **Deployment notes:** hub only.
- **Follow-ups:** owner acceptance of ADR-0023; IRI-175; IRI-176.
