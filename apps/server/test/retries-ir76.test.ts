import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbHandle, llmRequests, nodes, type Db, type DbHandle } from "@irori/db";
import { createUsageStore } from "../src/usage-store.js";

/**
 * IRI-076 (IR-167): retry waste — a seeded retry chain (superseded attempts
 * via retry_superseded_by) grouped per client key with priced waste cost.
 */

const url = process.env.IRORI_TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d("retry waste (db integration)", () => {
  let handle: DbHandle;
  let db: Db;
  let nodeId: string;

  beforeAll(async () => {
    handle = createDbHandle(url!);
    await handle.migrate();
    db = handle.db;
    nodeId = randomUUID();
    await db.delete(llmRequests);
    await db.delete(nodes);
    await db.insert(nodes).values({ id: nodeId, name: "retry-test", kind: "spark", role: "standalone", host: "localhost", agentTokenHash: "x", agentTokenEnc: "x" });
    const now = Date.now();
    const row = (id: string, supersededBy: string | null, prompt: number) => ({
      id, nodeId, port: 8081, ts: new Date(now), receivedAt: new Date(now), model: "glm", endpoint: "/v1/chat/completions",
      stream: false, status: 200, promptTokens: prompt, completionTokens: 0, cachedTokens: 0, error: null, errorSig: null, durationMs: 10,
      retrySupersededBy: supersededBy,
    });
    await db.insert(llmRequests).values([
      row(randomUUID(), randomUUID(), 100_000), // superseded attempt #1
      row(randomUUID(), randomUUID(), 200_000), // superseded attempt #2
      row(randomUUID(), null, 50), // the final attempt — never waste
    ]);
  });

  afterAll(async () => {
    await db.delete(nodes);
    await handle.close();
  });

  it("groups superseded attempts per client key and prices the waste", async () => {
    const store = createUsageStore(db, {
      pricing: async () => ({ currency: "EUR" as const, resolve: () => ({ input: 1, cached: 0, output: 0, currency: "EUR" as const }) }),
    });
    const res = await store.retries({ range: "24h", nodeId });
    expect(res.groups).toHaveLength(1);
    expect(res.groups[0]!.attempts).toBe(2);
    // 100k + 200k prompt at 1 EUR/Mtok = 0.30 EUR = 30 minor of waste.
    expect(res.retriesCostMinor).toBe(30);
    expect(res.groups[0]!.costMinor).toBe(30);
    expect(res.costCurrency).toBe("EUR");
  });

  it("unpriced deployments report no currency and no waste", async () => {
    const store = createUsageStore(db);
    const res = await store.retries({ range: "24h", nodeId });
    expect(res.costCurrency).toBeNull();
    expect(res.retriesCostMinor).toBe(0);
  });
});
