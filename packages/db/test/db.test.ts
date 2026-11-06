import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyMigrations, createDbHandle, createNodeStore, type DbHandle } from "../src/index.js";

const DRIZZLE = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");
const JOURNAL_ENTRIES = (
  JSON.parse(readFileSync(join(DRIZZLE, "meta", "_journal.json"), "utf8")) as { entries: unknown[] }
).entries.length;

/**
 * Requires a REAL Postgres (ADR-0002 — no :memory: exists for postgres.js).
 * IRORI_TEST_DATABASE_URL must point at a DISPOSABLE database: the suite
 * wipes its public schema, migrates, and leaves it empty. CI starts a
 * Postgres service container for this suite; locally:
 *   docker run --rm -d -p 54329:5432 -e POSTGRES_PASSWORD=test postgres:16-alpine
 *   IRORI_TEST_DATABASE_URL=postgres://postgres:test@localhost:54329/postgres pnpm test
 */
const url = process.env.IRORI_TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d("db integration", () => {
  let h: DbHandle;

  beforeAll(async () => {
    h = createDbHandle(url!);
    // The suite owns the schema (doc above): drop + migrate so ordering vs
    // the other suites (server tests leave rows behind) can never fail it.
    // drizzle's migration bookkeeping lives in its own schema — drop it too
    // or migrate() sees all migrations applied and creates nothing.
    await h.sql`drop schema if exists public cascade`;
    await h.sql`create schema public`;
    await h.sql`drop schema if exists drizzle cascade`;
    await h.migrate();
  });

  afterAll(async () => {
    await h.close();
  });

  it("creates a node with an encrypted token and verifies it", async () => {
    const store = createNodeStore(h.db, "a".repeat(64));
    const { id, token } = await store.create({ name: "spark1", kind: "spark", role: "head", host: "spark1.lan" });
    expect(token).toMatch(/^irn_/);
    expect(await store.verifyToken(token)).toBe(id);
    expect(await store.verifyToken("irn_wrong")).toBeNull();

    // Token is stored encrypted, never plaintext (ADR-0002).
    const [row] = await h.sql<{ agent_token_enc: string }[]>`select agent_token_enc from nodes where id = ${id}`;
    expect(row?.agent_token_enc).not.toContain(token);
    expect(row?.agent_token_enc.startsWith("v1:")).toBe(true);
  });

  it("persists the cache user on create and patch (IR-101)", async () => {
    const store = createNodeStore(h.db, "a".repeat(64));
    const { id } = await store.create({ name: "cacheuser", kind: "spark", role: "worker", host: "cu.lan", cacheUser: "operator" });
    expect((await store.get(id))?.cacheUser).toBe("operator");
    await store.patch(id, { cacheUser: null });
    expect((await store.get(id))?.cacheUser).toBeNull();
  });

  it("snapshots insert, count and prune", async () => {
    const store = createNodeStore(h.db, "a".repeat(64));
    const { id } = await store.create({ name: "spark2", kind: "spark", role: "worker", host: "spark2.lan" });
    await store.insertSnapshot(id, { schemaVersion: 1, agentVersion: "0.1.0" });
    expect(await store.countSnapshots(id)).toBe(1);
    expect(await store.pruneSnapshots(new Date(Date.now() + 60_000))).toBeGreaterThanOrEqual(0);
    expect(await store.countSnapshots(id)).toBe(0);
  });

  it("rotates tokens and invalidates the old one", async () => {
    const store = createNodeStore(h.db, "a".repeat(64));
    const { id, token } = await store.create({ name: "nas1", kind: "nas", role: "standalone", host: "nas.lan" });
    const { token: token2 } = await store.rotateToken(id);
    expect(await store.verifyToken(token)).toBeNull();
    expect(await store.verifyToken(token2)).toBe(id);
  });

  it("boot migrations are idempotent", async () => {
    await h.migrate();
    await h.migrate();
    expect(await h.isHealthy()).toBe(true);
  });

  /**
   * IR-188: the DEV hub booted `db:false` on dev-0.5.0-1 because its schema was
   * complete while `drizzle.__drizzle_migrations` had no rows for 0020–0027
   * (the IRI-084 repair created the objects without recording them). drizzle's
   * migrator aborted on the first `CREATE TABLE ... already exists`. The boot
   * migrator must converge that state instead.
   */
  it("converges a schema created out of band (IR-188)", async () => {
    await h.sql`drop schema if exists drizzle cascade`;

    await h.migrate();

    const [{ n }] = await h.sql<{ n: number }[]>`
      select count(*)::int as n from drizzle.__drizzle_migrations
    `;
    expect(n).toBe(JOURNAL_ENTRIES);

    // The converged database is usable, not just recorded.
    const store = createNodeStore(h.db, "a".repeat(64));
    const { id } = await store.create({ name: "ir188", kind: "spark", role: "worker", host: "ir188.lan" });
    expect((await store.get(id))?.name).toBe("ir188");
  });

  /**
   * The tolerance must not swallow real failures: a non-duplicate error rolls
   * that migration back and propagates, and the migration stays unrecorded so
   * the next boot retries it. The good migration in the same folder applies
   * even though its `when` predates the watermark — pending is hash-based now.
   */
  it("still fails on a real error and records nothing (IR-188)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "irori-migrate-"));
    try {
      await mkdir(join(dir, "meta"), { recursive: true });
      await writeFile(
        join(dir, "meta", "_journal.json"),
        JSON.stringify({
          version: "7",
          dialect: "postgresql",
          entries: [
            { idx: 0, version: "7", when: 1, tag: "0000_old_when", breakpoints: true },
            { idx: 1, version: "7", when: 2, tag: "0001_bad", breakpoints: true },
          ],
        }),
      );
      await writeFile(join(dir, "0000_old_when.sql"), `create table ir188_old_when (id int);`);
      await writeFile(
        join(dir, "0001_bad.sql"),
        `create table ir188_bad (id int);\n--> statement-breakpoint\nselect * from ir188_missing_table;`,
      );

      const before = await h.sql<{ n: number }[]>`select count(*)::int as n from drizzle.__drizzle_migrations`;

      await expect(applyMigrations(h.sql, dir)).rejects.toThrow();

      const after = await h.sql<{ n: number }[]>`select count(*)::int as n from drizzle.__drizzle_migrations`;
      expect(after[0]!.n).toBe(before[0]!.n + 1);

      const [tables] = await h.sql<{ good: string | null; bad: string | null }[]>`
        select to_regclass('public.ir188_old_when')::text as good,
               to_regclass('public.ir188_bad')::text as bad
      `;
      expect(tables?.good).not.toBeNull();
      expect(tables?.bad).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
