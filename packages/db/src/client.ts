import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres from "postgres";
import { applyMigrations } from "./migrator.js";
import { repairSchema } from "./repair.js";
import * as baseSchema from "./schema.js";
import * as opsSchema from "./schema-ops.js";

/** Fleet-ops tables live in schema-ops.ts; both are one drizzle schema. */
const schema = { ...baseSchema, ...opsSchema };

export type Db = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  sql: postgres.Sql;
  /** Runs pending migrations under a shared advisory lock (idempotent). */
  migrate: () => Promise<void>;
  /** Lightweight liveness probe; false while the DB is unreachable. */
  isHealthy: () => Promise<boolean>;
  close: () => Promise<void>;
}

const MIGRATE_LOCK_KEY = 732_914_117; // hashtext('irori-migrate')

/**
 * IRI-124: drizzle decides what is pending by comparing the journal's
 * `when` with MAX(created_at) in `drizzle.__drizzle_migrations`. A journal
 * entry whose timestamp was hand-edited into the future (0019 shipped with
 * `when` ≈ 2026-12-26) poisons that watermark: every later migration is
 * silently skipped, so new columns never reach a database that applied it.
 * This restores the intended invariant — created_at equals the journal's
 * `when` for every recognised hash — before the migrator runs. Idempotent and
 * never fatal (missing table, fresh DB, or a read-only role just no-ops).
 *
 * IR-188: pending detection is now hash membership (`applyMigrations`), so a
 * poisoned watermark can no longer skip migrations. The heal stays because
 * `drizzle.__drizzle_migrations` is the audit record operators read, and
 * `drizzle-kit` still interprets it as a watermark.
 */
async function normalizeMigrationWatermark(sql: postgres.Sql, migrationsFolder: string): Promise<void> {
  try {
    const migrations = readMigrationFiles({ migrationsFolder });
    const byHash = new Map(migrations.map((m) => [m.hash, m.folderMillis]));
    const skewLimit = Date.now() + 60_000;
    const rows = await sql<{ id: number; hash: string; created_at: number }[]>`
      select id, hash, created_at from drizzle.__drizzle_migrations
    `;
    for (const row of rows) {
      const folderMillis = byHash.get(row.hash);
      // Only heal impossible values for entries we can identify.
      if (folderMillis === undefined || row.created_at <= skewLimit) continue;
      await sql`update drizzle.__drizzle_migrations set created_at = ${folderMillis} where id = ${row.id}`;
      console.warn(
        `[irori-db] migration watermark healed: row ${row.id} recorded ${row.created_at} (future-dated); restored ${folderMillis} from the journal`,
      );
    }
  } catch (err: unknown) {
    // Boot must never depend on the repair path — but a silent failure here
    // means later migrations keep being skipped with no clue why.
    console.warn(
      `[irori-db] migration watermark check failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Opens the connection (postgres.js — pure JS per ADR-0002). Connection is
 * lazy; call `migrate()` on boot and `isHealthy()` before writes.
 */
export function createDbHandle(databaseUrl: string): DbHandle {
  const sql = postgres(databaseUrl, {
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
    onnotice: () => {},
  });
  const db = drizzle(sql, { schema });

  const migrationsFolder = (() => {
    const candidates = [
      join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle"),
      join(process.cwd(), "packages", "db", "drizzle"),
      join(process.cwd(), "drizzle"),
    ];
    return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
  })();

  return {
    db,
    sql,
    isHealthy: async () => {
      try {
        await sql`select 1`;
        return true;
      } catch {
        return false;
      }
    },
    migrate: async () => {
      // Advisory lock so N containers booting concurrently don't race
      // (ADR-0002). pg_advisory_lock is session-scoped: acquire/release must
      // run on the SAME connection, so reserve one for the whole critical
      // section — pooled checkouts would leak the lock and race after 30 s.
      const reserved = await sql.reserve();
      try {
        await reserved`SELECT pg_advisory_lock(${MIGRATE_LOCK_KEY})`;
        await normalizeMigrationWatermark(sql, migrationsFolder);
        // IR-188: hash-membership migrator that tolerates objects created out
        // of band, so a schema without bookkeeping converges instead of
        // aborting the boot on "already exists".
        const report = await applyMigrations(sql, migrationsFolder);
        if (report.applied.length > 0) {
          console.info(`[irori-db] migrations applied: ${report.applied.join(", ")}`);
        }
        // IRI-084 hotfix: heal journals that are AHEAD of the schema (the
        // live hub recorded 0020+ while its objects were absent). Idempotent.
        await repairSchema(sql);
      } finally {
        await reserved`SELECT pg_advisory_unlock(${MIGRATE_LOCK_KEY})`.catch(() => {});
        reserved.release();
      }
    },
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}
