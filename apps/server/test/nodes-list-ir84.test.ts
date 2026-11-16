import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import request from "supertest";
import { createDbHandle, nodes, type Db } from "@irori/db";
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

  it("IR-260: classifies the node's bundle against the served artifact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "irori-bundle-"));
    const bundlePath = join(dir, "irori-agent.mjs");
    const content = "console.log('expected generation');\n";
    writeFileSync(bundlePath, content);
    const expected = createHash("sha256").update(content).digest("hex");
    const store = createNodeStore(db, "a".repeat(64));
    const { id } = await store.create({ name: `bundle-${randomUUID().slice(0, 6)}`, kind: "spark", role: "standalone", host: "localhost", agentTokenEnc: "x" } as never);
    await db.update(nodes).set({ bundleSha256: expected }).where(eq(nodes.id, id));
    const makeDeps = (agentArtifacts: AppDeps["agentArtifacts"]) =>
      ({
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
        agentArtifacts,
      }) as unknown as AppDeps;
    const find = (body: unknown, nodeId: string) =>
      (body as Array<{ id: string; bundle: { running: string | null; expected: string | null; state: string } }>).find((n) => n.id === nodeId)!.bundle;

    // Matching hashes → current.
    const res = await request(createApp(makeDeps({ installer: join(dir, "install-agent.sh"), unit: join(dir, "irori-agent.service"), bundle: bundlePath }))).get("/api/v1/nodes");
    expect(res.status).toBe(200);
    expect(find(res.body, id)).toEqual({ running: expected, expected, state: "current" });

    // A different running generation is behind.
    await db.update(nodes).set({ bundleSha256: "b".repeat(64) }).where(eq(nodes.id, id));
    const res2 = await request(createApp(makeDeps({ installer: join(dir, "i"), unit: join(dir, "u"), bundle: bundlePath }))).get("/api/v1/nodes");
    expect(find(res2.body, id).state).toBe("behind");

    // No artifact to compare → unknown, never a verdict (IR-243 rule).
    const res3 = await request(createApp(makeDeps(null))).get("/api/v1/nodes");
    expect(find(res3.body, id).state).toBe("unknown");
    await rm(dir, { recursive: true, force: true });
  });
});
