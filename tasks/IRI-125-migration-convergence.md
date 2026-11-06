# Task: IRI-125 — boot migrations converge a schema created out of band

Jira **IR-188** (Task, Medium). Follow-up to the dev-0.5.0-1 deploy incident
(IRI-124 / IR-180).

## Objective

The DEV hub booted `db:false` on `dev-0.5.0-1`. Its schema was complete while
`drizzle.__drizzle_migrations` had no rows for 0020–0027: the IRI-084 repair
(`repairSchema`) created those objects without recording them. Once the
IRI-124 watermark heal restored 0019's real timestamp, drizzle's migrator saw
0020+ as pending and aborted the boot on `CREATE TABLE "alert_channels"`
(already exists). The immediate fix was three hand-inserted journal rows — a
one-time repair, not a mechanism.

Two structural defects made that state fatal:

1. **Pending was decided by a timestamp watermark.** `MAX(created_at)` means a
   single future-dated `when` skips every later migration, and a schema that
   exists without bookkeeping is indistinguishable from "already applied".
2. **One duplicate object aborted the whole boot.** drizzle applies each
   migration as one transaction, so the first `already exists` rolls back and
   the hub never comes up.

## Acceptance criteria

- [x] Pending is decided by hash membership: a migration applies iff its hash
      has no row in `drizzle.__drizzle_migrations`. A future-dated `when` can
      no longer skip later migrations.
- [x] Duplicate-object SQLSTATEs (42P07, 42701, 42P06, 42710, 42723) are
      tolerated per statement, logged with the journal tag, and the migration
      is still recorded.
- [x] Any other error rolls that migration back, leaves it unrecorded, and
      propagates — the boot still fails loudly on a genuinely broken migration.
- [x] Regression test: a complete schema with the bookkeeping schema dropped
      converges on the next `migrate()` and records every journal entry.
- [x] Regression test: a folder with one good and one broken migration applies
      the good one (even with `when` predating the watermark), rolls the broken
      one back, and records only the good one.
- [x] `drizzle-kit` compatibility: same table, same columns, same journal.

## Scope

- `packages/db/src/migrator.ts` (new): `applyMigrations()` — hash-membership
  pending set, per-statement savepoints, tolerated SQLSTATEs.
- `packages/db/src/client.ts`: `migrate()` calls `applyMigrations` instead of
  drizzle's `migrate`; the watermark heal stays as bookkeeping hygiene (it is
  no longer load-bearing for pending detection).
- `packages/db/src/index.ts`: export the migrator.
- `packages/db/test/db.test.ts`: the two regression tests.

Not in scope: `repairSchema` (the journal-ahead-of-schema direction) is
unchanged; it still runs after the migrator on every boot.

## Implementation notes

`postgres.js`'s `sql.begin()` cannot host this tolerance: its transaction
helper records the **first** query error and rethrows it at `COMMIT` even when
the caller caught it, so a tolerated duplicate would still abort the boot. The
migrator therefore reserves a connection and drives `BEGIN` / `SAVEPOINT` /
`ROLLBACK TO SAVEPOINT` / `COMMIT` by hand.

## Verification

- `pnpm --filter @irori/db test` with `IRORI_TEST_DATABASE_URL` — 15 passed,
  including both new tests; the convergence test applies all 24 journal
  entries against a complete schema and records them.
- `pnpm --filter @irori/server test` — 374 passed (sequential, same database).
- `pnpm build`, `.agentic/bin/validate`, `.agentic/bin/docs-check --strict`.
