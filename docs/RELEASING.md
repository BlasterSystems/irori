# Releasing

Use the `semantic-versioning` skill for version bumps, releases, and Git tags.

## Release contract

- Versions follow Semantic Versioning: `MAJOR.MINOR.PATCH`.
- Release tags are annotated and use `vMAJOR.MINOR.PATCH`.
- The changelog records user-visible changes.
- Tests and configured validators must pass before tagging.
- Publishing commits, tags, or packages requires separate explicit approval.

## Repository configuration

1. **Authoritative version files:** seven `package.json` `version` fields — root,
   `apps/{server,web,agent}`, and `packages/{core,db}` are bumped together;
   `packages/proxy` is versioned independently (currently `0.3.0`). The server
   reports its own version at `/healthz`.
2. **Derived references:** none generated — versions are read from the package
   files at build/boot time. Update `CHANGELOG.md` by hand.
3. **Required commands before tagging:** `pnpm typecheck`,
   `IRORI_TEST_DATABASE_URL=… pnpm -r test` (real Postgres),
   `pnpm build`, `.agentic/bin/validate`, `.agentic/bin/docs-check --strict`.
4. **Release branch:** `main` with linear history (rebase merges); tags are cut
   only from commits whose CI (`verify` + `docs-check`) is green on the PR. No
   protected-branch rules are configured (homelab, single operator) — green CI is
   the gate by convention.
5. **Registry/deploy in a release:** a `v*` tag triggers
   `.github/workflows/release.yml` — amd64-only GHCR images for the server and
   agent roles plus the agent bundle, installer, systemd unit, and SHA256SUMS
   release artifacts, built on the self-hosted runner (LXC 110; GitHub-hosted
   minutes are exhausted). Arm64 was dropped 2026-10-31 — the hub runs on x86,
   agents consume the arch-independent bundle via the hub, and no arm64 consumer
   exists; re-add `docker/setup-qemu-action` + `platforms: linux/amd64,linux/arm64`
   if an arm64 target appears. The dev VM deploy is a separate tag-gated `dev-*`
   pipeline (see `DEPLOYMENT.md`); production is not deployed yet (IR-10 epic).

Keep this file focused and link to detailed deployment documentation rather than duplicating it.

## Release checklist

1. Start from a clean Git worktree.
2. Review changes since the latest `v*` tag.
3. Propose and confirm the SemVer bump.
4. Update authoritative version sources and `CHANGELOG.md`.
5. Refresh generated artifacts.
6. Run all documented validation.
7. Review and confirm the release diff.
8. Create `chore(release): vX.Y.Z`.
9. Create annotated tag `vX.Y.Z`.
10. Verify the tagged version; push or publish only when explicitly requested.
