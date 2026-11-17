# Contributing to Irori

Irori is developed **docs-first**: [docs/SPEC.md](docs/SPEC.md) is the
authoritative spec, decisions land as [ADRs](docs/adr/README.md) before
implementation, and milestones are sliced in [docs/PLAN.md](docs/PLAN.md).
Read [AGENTS.md](AGENTS.md) for project conventions and
[docs/DEVELOPMENT_PROCESS.md](docs/DEVELOPMENT_PROCESS.md) for the working
agreement.

## Environment

- Node 24 + pnpm 10 (`corepack enable`)
- PostgreSQL 16+ reachable as `IRORI_TEST_DATABASE_URL` for server/db tests
  (CI throws a disposable cluster per job; locally:
  `docker compose --profile dev up`)

```bash
pnpm install --frozen-lockfile
pnpm build        # all workspaces
pnpm test         # unit + integration
pnpm typecheck
```

## Gates (CI enforces these on every PR)

| Gate | Command |
|---|---|
| Types + tests + coverage thresholds | `pnpm typecheck && pnpm test && pnpm coverage` |
| Scaffold/config integrity | `.agentic/bin/validate` |
| Documentation coverage (strict) | `.agentic/bin/docs-check` |

`pnpm lint` (eslint) is available locally and expected clean on new code.

## Conventions

- Tasks are `IRI-<number>` files in `tasks/`; epics and milestones live in
  `docs/PLAN.md`. Durable, cross-cutting decisions need an ADR
  (`docs/adr/template.md`).
- UI changes are **mockup-first**: iterate `mockups/*.html` against the
  BlasterSystems design system, then port to `apps/web`. Every screen must
  work at 390 px without horizontal overflow, in light and dark themes.
- Behavior changes update `docs/` and `CHANGELOG.md`.
- Keep changes focused; delete dead weight; prefer boring design.

## Pull requests

Open PRs against `main` using the template. Small, single-purpose PRs with
the task ID in the title (`feat(server): … (IRI-xxx)`) review fastest.
