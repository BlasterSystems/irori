import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type postgres from "postgres";

/**
 * IR-188: the boot migrator must converge a database whose schema was created
 * out of band (objects present, `drizzle.__drizzle_migrations` missing rows).
 *
 * drizzle's own migrator decides what is pending from MAX(created_at) and
 * applies each migration as one transaction, so a single `CREATE TABLE` that
 * already exists aborts the whole boot — that is exactly how the DEV hub came
 * up `db:false` on dev-0.5.0-1 after the IRI-084 repair created 0020–0027
 * without recording them.
 *
 * This migrator keeps drizzle's journal format and table (so `drizzle-kit`
 * and any external tooling still agree) but changes two things:
 *
 *  - Pending is decided by HASH MEMBERSHIP, not by a timestamp watermark. A
 *    migration is applied iff its hash has no row, so a future-dated `when`
 *    can no longer skip later migrations, and an out-of-band schema is
 *    recognised as "not recorded" rather than "already applied".
 *  - Each statement runs under a savepoint and duplicate-object SQLSTATEs are
 *    tolerated (logged, then the migration is still recorded). A real error
 *    still aborts that migration's transaction and propagates.
 */

/** SQLSTATEs that mean "this object already exists" — the out-of-band case. */
const TOLERATED_SQLSTATES = new Map<string, string>([
  ["42P07", "duplicate_table"],
  ["42701", "duplicate_column"],
  ["42P06", "duplicate_schema"],
  ["42710", "duplicate_object"],
  ["42723", "duplicate_function"],
]);

export interface MigrationReport {
  /** Journal tags applied by this call, in order. */
  applied: string[];
  /** Statements skipped because their object already existed. */
  tolerated: Array<{ tag: string; sqlstate: string; message: string }>;
}

/** Journal `when` → tag, so logs name the migration instead of a hash. */
async function readJournalTags(migrationsFolder: string): Promise<Map<number, string>> {
  try {
    const raw = await readFile(join(migrationsFolder, "meta", "_journal.json"), "utf8");
    const journal = JSON.parse(raw) as { entries?: Array<{ when: number; tag: string }> };
    return new Map((journal.entries ?? []).map((entry) => [entry.when, entry.tag]));
  } catch {
    return new Map();
  }
}

/**
 * Applies every journal migration whose hash is not yet recorded. Idempotent;
 * the caller holds the advisory lock (see `createDbHandle().migrate`).
 */
export async function applyMigrations(
  sql: postgres.Sql,
  migrationsFolder: string,
): Promise<MigrationReport> {
  const migrations = readMigrationFiles({ migrationsFolder });
  const tags = await readJournalTags(migrationsFolder);

  await sql`create schema if not exists drizzle`;
  await sql`
    create table if not exists drizzle.__drizzle_migrations (
      "id" serial primary key,
      "hash" text not null,
      "created_at" bigint
    )
  `;

  const recorded = new Set(
    (await sql<{ hash: string }[]>`select hash from drizzle.__drizzle_migrations`).map((row) => row.hash),
  );

  const report: MigrationReport = { applied: [], tolerated: [] };

  // A reserved connection, not `sql.begin`: postgres.js's transaction helper
  // records the FIRST query error and rethrows it at COMMIT even when the
  // caller caught it, so a tolerated duplicate would still abort the boot.
  // Driving BEGIN/SAVEPOINT/COMMIT by hand keeps the tolerance real.
  const conn = await sql.reserve();
  try {
    for (const migration of migrations) {
      if (recorded.has(migration.hash)) continue;
      const tag = tags.get(migration.folderMillis) ?? migration.hash.slice(0, 8);

      await conn.unsafe("begin");
      try {
        for (const statement of migration.sql) {
          if (statement.trim() === "") continue;
          await conn.unsafe("savepoint irori_migration_statement");
          try {
            await conn.unsafe(statement);
            await conn.unsafe("release savepoint irori_migration_statement");
          } catch (err: unknown) {
            const sqlstate = (err as { code?: string }).code ?? "";
            const label = TOLERATED_SQLSTATES.get(sqlstate);
            // A real failure must roll the migration back and stop the boot.
            if (label === undefined) throw err;
            await conn.unsafe("rollback to savepoint irori_migration_statement");
            const message = err instanceof Error ? err.message : String(err);
            report.tolerated.push({ tag, sqlstate, message });
            console.warn(
              `[irori-db] ${tag}: tolerated ${label} (${sqlstate}) — object already exists, recording the migration`,
            );
          }
        }
        await conn`
          insert into drizzle.__drizzle_migrations ("hash", "created_at")
          values (${migration.hash}, ${migration.folderMillis})
        `;
        await conn.unsafe("commit");
      } catch (err: unknown) {
        await conn.unsafe("rollback").catch(() => {});
        throw err;
      }

      report.applied.push(tag);
    }
  } finally {
    conn.release();
  }

  return report;
}
