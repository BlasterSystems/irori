# ADR-0016: Boot migrations converge an out-of-band schema

- **Status:** Proposed
- **Date:** 2026-11-06
- **Decision owners:** Not assigned
- **Scope:** `packages/db` boot migration path, `drizzle.__drizzle_migrations` bookkeeping, hub startup
- **Tags:** storage, postgres, drizzle, migrations, deployment, boot
- **Supersedes:** None
- **Superseded by:** None

## Context

ADR-0002 chose Drizzle migrations applied on boot under an advisory lock. That
mechanism has two failure modes that both end in a hub that cannot start:

1. **Watermark poisoning.** Drizzle decides what is pending from
   `MAX(created_at)` in `drizzle.__drizzle_migrations` and applies only journal
   entries with a greater `when`. Journal 0019 shipped a hand-edited future
   `when`, so every later migration was silently skipped on any database that
   applied it (IRI-124).
2. **Schema ahead of bookkeeping.** The IRI-084 repair path creates objects
   without recording them. On `dev-0.5.0-1` the DEV schema was complete while
   rows for 0020–0027 were missing; once the watermark heal restored 0019's
   real timestamp, drizzle saw 0020+ as pending and aborted the boot on
   `CREATE TABLE "alert_channels"` (already exists). The hub came up `db:false`
   and the only fix was three hand-inserted journal rows (IR-188).

Both are the same underlying problem: the migrator treats "not recorded" as
"not applied" and treats one duplicate object as fatal.

## Decision drivers

- A hub must boot on a database whose schema is already correct, whatever the
  bookkeeping says.
- A genuinely broken migration must still fail loudly, not be papered over.
- `drizzle-kit` and any external tooling must keep reading the same table.
- No new dependency, no new table, no manual repair step for operators.

## Considered options

### Option 1 — repair path records what it creates

`repairSchema` inserts the journal row for each migration it applies. Fixes the
IRI-084 direction only; a schema created by any other out-of-band route (volume
restore, manual psql, a future repair file) still aborts the boot.

### Option 2 — hash-membership pending set + per-statement tolerance

Pending is decided by hash membership: a migration applies iff its hash has no
row. Each statement runs under a savepoint; duplicate-object SQLSTATEs
(42P07, 42701, 42P06, 42710, 42723) are logged and skipped, and the migration
is still recorded. Any other error rolls that migration back, leaves it
unrecorded, and propagates.

### Option 3 — keep drizzle's migrator, pre-check object existence

Query the catalog before each statement. Correct but reimplements DDL
introspection for every object kind, and drifts from the SQL the migration
actually contains.

## Decision

Option 2, implemented in `packages/db/src/migrator.ts` (`applyMigrations`).
`createDbHandle().migrate()` calls it instead of drizzle's `migrate`; the
watermark heal stays as bookkeeping hygiene but is no longer load-bearing.

`postgres.js`'s `sql.begin()` cannot host the tolerance: its transaction helper
records the **first** query error and rethrows it at `COMMIT` even when the
caller caught it, so a tolerated duplicate would still abort the boot. The
migrator therefore reserves a connection and drives
`BEGIN` / `SAVEPOINT` / `ROLLBACK TO SAVEPOINT` / `COMMIT` by hand.

## Consequences

### Positive

- A database whose schema is complete boots regardless of bookkeeping state.
- A future-dated `when` can no longer skip migrations; the watermark is no
  longer a correctness dependency.
- Operators get one log line per tolerated statement naming the journal tag.

### Negative

- The migrator is ours, not drizzle's: a drizzle-orm upgrade no longer
  automatically changes migration semantics.
- Tolerating `42701` (duplicate column) can mask a migration that adds a column
  with a different type than the out-of-band one. The log line is the only
  signal.

### Risks and mitigations

- **Silent divergence.** Tolerated statements are logged with tag and SQLSTATE;
  the migration is recorded, so the divergence is visible in the log rather
  than in a failed boot.
- **Partial apply on a real error.** Each migration is one transaction, so a
  non-tolerated error leaves nothing behind and the next boot retries it.

## Implementation and validation

- `packages/db/src/migrator.ts`, `packages/db/src/client.ts`.
- `packages/db/test/db.test.ts`: a complete schema with the bookkeeping schema
  dropped converges and records every journal entry; a folder with one good and
  one broken migration applies the good one (even with `when` predating the
  watermark), rolls the broken one back, and records only the good one.
- `pnpm --filter @irori/db test` and `pnpm --filter @irori/server test` against
  a real Postgres.

## Revisit triggers

- Drizzle ships a migrator with configurable duplicate-object tolerance.
- A tolerated statement is found to have masked a real schema divergence.
- The journal format changes in a way that makes hash membership ambiguous.

## References

- ADR-0002 (PostgreSQL on Proxmox storage — boot migrations under an advisory
  lock)
- IR-188, IRI-125 (task file), IRI-124 (watermark heal), IRI-084 (repair path)
