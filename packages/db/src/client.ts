import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "./schema.js";

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
        await migrate(db, { migrationsFolder });
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
