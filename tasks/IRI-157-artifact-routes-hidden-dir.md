# Task: IRI-157 — Hub serves agent artifacts from a path with a hidden directory

Ticket: Jira IR key pending (creation blocked in the implementing session; see the PR).

## Objective

`GET /install-agent.sh`, `/irori-agent.service` and `/agent/irori-agent.mjs` answer 200 with the file
whatever the hub's install path is, including paths that contain a dot-directory.

## Product manager summary

- **One-liner:** Add-node download links work no matter where the hub is installed.
- **User value:** The copy-paste install block in the Add-node modal doesn't fail with a 404 on hubs installed under a hidden directory.
- **Business impact:** Onboarding reliability; also unblocks `pnpm test` in worktrees under `~/.herdr/`.
- **Success metric:** `apps/server/test/onboarding.test.ts` passes from a dot-directory checkout; the new regression test passes from any checkout.
- **Dependencies & constraints:** None.

## Acceptance criteria

- [x] The three artifact routes return 200 and the exact file bytes when the configured artifact path contains a dot-segment.
- [x] Headers (Content-Type, Content-Disposition, Cache-Control) and the 503 fallback are unchanged.
- [x] A regression test reproduces the dot-directory case from any checkout location.

## Scope

### Included

- `serveArtifact` in `apps/server/src/app.ts`.
- The SPA `index.html` fallback in the same file (same mechanism; quality-review F1).

### Excluded

- `express.static` (takes a root already and is unaffected).
- Hub-driven modelctl provisioning on first connect (separate follow-up discussed in the same session).

## Implementation plan

### Files to modify or create

- `apps/server/src/app.ts` — `res.sendFile(basename(path), { root: dirname(path) })`.
- `apps/server/test/onboarding.test.ts` — regression test with artifacts copied under `<tmp>/.hidden/agent/`.
- `CHANGELOG.md` — Unreleased / Fixed entry.

### Key changes

- `send` applies its `dotfiles: "ignore"` default to every segment of a root-less absolute path, but only to the part after `root` when one is given. Splitting the configured path into root and file name confines the check to the file name, which is always a fixed, non-dot name.

### Test approach

- New test fails on `main` (4 failures from a `~/.herdr/` worktree, 1 from a normal checkout) and passes with the fix.

## Plan

- [x] Run the confidence-check readiness gate
- [x] Understand requirements and inspect relevant code
- [x] Confirm architecture impact
- [x] Implement the smallest complete change
- [x] Add or update tests
- [x] Update documentation
- [x] Run validation

## Architecture impact

- **ADR required:** No
- **Relevant ADRs:** ADR-0007 (agent update fetches the bundle from the hub route)
- **Proposed ADR:** None

## Deployment

- **Deploy-affecting:** No (container hub paths contain no dot-directory; behaviour there is identical)
- **Artifact invariant:** None
- **Functional probe:** `curl -fsSI http://HUB:3947/install-agent.sh` → 200
- **Rollback:** Revert the commit.

## Validation evidence

- Tests: `pnpm test` — see Review.
- Build: `pnpm build` green.
- Documentation check: CHANGELOG updated; no public behaviour or config change beyond the fix.

## Review

- Correctness: paths come only from `deps.agentArtifacts` (server config), never from the request.
- Security (security-check result): see PR.
- Data isolation and authorization: unchanged; routes were and stay unauthenticated, no secrets in artifacts.
- Compatibility and migrations: none.
- Tests: regression test added.
- Documentation and ADRs: CHANGELOG.
- Adversarial review (`quality-review` verdict; fresh context or self-review): PASS WITH FINDINGS, fresh read-only context. F1 SPA fallback had the same bug: fixed and tested. F2 old status was 404, not 500: wording fixed. F3 test leaked its temp dir: fixed.
- Residual risks: none known.

## Completion summary

- **Technical decisions:** root + basename instead of `dotfiles: "allow"`, so a dot-named artifact file would still be refused.
- **Known limitations:** None.
- **Deployment notes:** None.
- **Follow-ups:** Dispatch `models-inventory` on an agent's first hello so modelctl is provisioned immediately (separate ticket).
