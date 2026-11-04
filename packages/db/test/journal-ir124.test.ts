import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * IRI-124: the drizzle journal is load-bearing. The migrator treats
 * MAX(created_at) in `drizzle.__drizzle_migrations` as the watermark and only
 * applies entries whose `when` is greater — a hand-edited future timestamp
 * therefore skips every later migration, silently. 0019 shipped with a
 * `when` in 2026-12-26 and did exactly that; these invariants keep it from
 * happening again. (Historical entries are NOT strictly ordered — the
 * migrator applies them in idx order regardless — so monotonicity is not
 * asserted here.)
 */

const DRIZZLE = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta", "_journal.json"), "utf8")) as {
  entries: JournalEntry[];
};

describe("migration journal", () => {
  it("has a SQL file for every entry", () => {
    for (const entry of journal.entries) {
      expect(existsSync(join(DRIZZLE, `${entry.tag}.sql`)), entry.tag).toBe(true);
    }
  });

  it("never dates an entry in the future", () => {
    // One day of slack for clock skew between the generating machine and CI.
    const limit = Date.now() + 86_400_000;
    for (const entry of journal.entries) {
      expect(entry.when, `${entry.tag} is future-dated and poisons the watermark`).toBeLessThan(limit);
    }
  });
});
