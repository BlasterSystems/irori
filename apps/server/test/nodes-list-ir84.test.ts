import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createDbHandle, type Db } from "@irori/db";
import { createNodeStore } from "@irori/db";
import { createApp, type AppDeps } from "../src/app.js";
import { createRings } from "../src/rings.js";
import { createSseHub } from "../src/sse.js";

/**
 * IRI-084 regression: /api/v1/nodes against the REAL store wrapper + db —
 * pins the live-hub 500 (dev-0.3.0-63: the fleet journal was ahead of the
 * schema, so the epic columns were absent and every list threw).
 */
const url = process.env.IRORI_TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d("nodes endpoint reproduction", () => {
  let db: Db;
  beforeAll(async () => {
    const handle = createDbHandle(url!);
    await handle.migrate();
    db = handle.db;
  });

  it("lists nodes through the real store + app", async () => {
    const store = createNodeStore(db, "a".repeat(64));
    await store.create({ name: `repro-${randomUUID().slice(0, 6)}`, kind: "spark", role: "standalone", host: "localhost", agentTokenEnc: "x" } as never);
    const deps = {
      getStore: () => store,
      getLlmStore: () => null,
      getHistory: () => null,
      getLlmHistory: () => null,
      dbHealthy: async () => true,
      rings: createRings(),
      sse: createSseHub({ heartbeatMs: 0 }),
      getHub: () => null,
      getJobs: () => null,
      getInventory: () => null,
      hfQuants: { listQuants: async () => ({}) } as never,
      version: "test",
      tag: null,
      staticDir: null,
    } as unknown as AppDeps;
    const app = createApp(deps);
    const res = await request(app).get("/api/v1/nodes");
    console.log("STATUS", res.status, "BODY", JSON.stringify(res.body).slice(0, 300));
    expect(res.status).toBe(200);
  });
});
