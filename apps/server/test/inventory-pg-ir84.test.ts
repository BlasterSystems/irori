import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createDbHandle, nodes, nodeInventory, type Db } from "@irori/db";
import { eq } from "drizzle-orm";
import { createInventoryService } from "../src/inventory-service.js";
import { isUniqueViolation, pgErrorCode } from "../src/pg.js";

/**
 * IRI-084: db-gated tier for the inventory read cache (IRI-028) — corrupt
 * cache rows degrade to absent, never throw; plus the server pg handle
 * helper against the same disposable database.
 */

const url = process.env.IRORI_TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d("inventory service (db)", () => {
  let db: Db;
  let nodeId: string;

  beforeAll(async () => {
    const handle = createDbHandle(url!);
    await handle.migrate();
    db = handle.db;
    nodeId = randomUUID();
    await db.insert(nodes).values({
      id: nodeId,
      name: `inv-${nodeId.slice(0, 8)}`,
      kind: "spark",
      role: "standalone",
      host: "localhost",
      agentTokenHash: "x",
      agentTokenEnc: "x",
    });
  });

  it("returns null for a node with no report", async () => {
    const svc = createInventoryService(db);
    expect(await svc.get(randomUUID())).toBeNull();
  });

  it("returns the parsed report when present", async () => {
    const report = {
      generatedAtMs: Date.now(),
      store: null,
      local: [],
      versions: null,
      updates: null,
    };
    await db.insert(nodeInventory).values({ nodeId, report });
    const svc = createInventoryService(db);
    const entry = await svc.get(nodeId);
    expect(entry).not.toBeNull();
    expect(entry!.report.store).toBeNull();
    expect(typeof entry!.updatedAt).toBe("string");
    await db.delete(nodeInventory).where(eq(nodeInventory.nodeId, nodeId));
  });

  it("treats a corrupt cache row as absent", async () => {
    await db.insert(nodeInventory).values({ nodeId, report: { nonsense: true } });
    const svc = createInventoryService(db);
    expect(await svc.get(nodeId)).toBeNull();
  });
});

d("pg error-chain helpers", () => {
  it("walks the cause chain for a driver code", () => {
    const err = new Error("wrapped", { cause: Object.assign(new Error("23505"), { code: "23505" }) });
    expect(pgErrorCode(err)).toBe("23505");
    expect(isUniqueViolation(err)).toBe(true);
  });

  it("returns null for untagged errors", () => {
    expect(pgErrorCode(new Error("plain"))).toBeNull();
    expect(pgErrorCode(undefined)).toBeNull();
    expect(isUniqueViolation(new Error("x"))).toBe(false);
  });
});
