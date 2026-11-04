import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";

/**
 * IRI-084 hotfix: schema repair for hubs whose drizzle journal is AHEAD of
 * the physical schema (restored/cloned volume, failed-and-journaled apply):
 * 0020+0021 are recorded as applied while their objects are absent, so the
 * boot migrate skips them and every epic endpoint 500s. This runs the
 * 0020+0021 statements idempotently (IF NOT EXISTS / guarded DO blocks)
 * AFTER the journal migrate on every boot — a no-op on healthy databases.
 */

/** Locates the shipped drizzle folder (same resolution as the migrator). */
function repairPath(): string | null {
  const candidates = [
    join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle", "0027_schema_repair.sql"),
    join(process.cwd(), "packages", "db", "drizzle", "0027_schema_repair.sql"),
    join(process.cwd(), "drizzle", "0027_schema_repair.sql"),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** Runs the idempotent repair after the journal migrate. Never throws. */
export async function repairSchema(sql: Sql): Promise<boolean> {
  try {
    const path = repairPath();
    if (path === null) return false;
    const text = await readFile(path, "utf8");
    await sql.unsafe(text);
    return true;
  } catch {
    // A repair failure must never block boot — the journal migrate already ran.
    return false;
  }
}
