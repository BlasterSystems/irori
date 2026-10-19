# Releasing

Use the `semantic-versioning` skill for version bumps, releases, and Git tags.

## Release contract

- Versions follow Semantic Versioning: `MAJOR.MINOR.PATCH`.
- Release tags are annotated and use `vMAJOR.MINOR.PATCH`.
- The changelog records user-visible changes.
- Tests and configured validators must pass before tagging.
- Publishing commits, tags, or packages requires separate explicit approval.

## Repository configuration

1. **Authoritative version files:** the six `package.json` `version` fields
   (root, `apps/{server,web,agent}`, `packages/{core,db}`) — bumped together;
   the server reports its own at `/healthz`.
2. **Derived references:** none generated — versions are read from the
   package files at build/boot time. Update `CHANGELOG.md` by hand.
3. **Required commands before tagging:** `pnpm typecheck`, 
   `IRORI_TEST_DATABASE_URL=… pnpm -r test` (real Postgres),
   `pnpm build`, `.agentic/bin/validate`, `.agentic/bin/docs-check --strict`.
4. **Release branch:** `main` with linear history (rebase merges); tags are
   cut only from commits whose CI (`verify` + `docs-check`) is green on the
   PR. No protected-branch rules are configured (homelab, single operator) —
   green CI is the gate by convention.
5. **Registry/deploy in a release:** a `v*` tag triggers
   `.github/workflows/release.yml` — multi-arch GHCR images for the server and
   agent roles plus the agent bundle/install-script/systemd-unit release
   artifacts. The DEV VM deploy is a separate, tag-gated `dev-*` pipeline
   (see `DEPLOYMENT.md`); production does not exist yet (IR-10 epic scope).

Do not create a tag until these facts are known. Keep this file focused and link to detailed deployment documentation rather than duplicating it.

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
