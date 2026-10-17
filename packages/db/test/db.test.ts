import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbHandle, createNodeStore, type DbHandle } from "../src/index.js";

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
});
