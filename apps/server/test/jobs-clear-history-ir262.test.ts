import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbHandle, downloadQueue, jobOutput, jobs, nodes, type Db } from "@irori/db";
import { createApp, type AppDeps } from "../src/app.js";
import { createJobsService } from "../src/jobs-service.js";
import { createRings } from "../src/rings.js";
import { createSseHub } from "../src/sse.js";

/**
 * IR-262: clear-history semantics — only settled rows (succeeded/failed/
 * canceled) are deleted; queued/running rows and the active slot survive,
 * job_output cascades, download_queue references go NULL. Requires a REAL
 * Postgres (ADR-0002 — same convention as agent-update.test.ts).
 *
 * clearHistory deletes globally by design, so the suite runs against its own
 * THROWAWAY database: parallel vitest files share IRORI_TEST_DATABASE_URL,
 * and a global delete would vanish rows a neighbor suite is asserting on
 * (the shared-DB fixture rule).
 */
const url = process.env.IRORI_TEST_DATABASE_URL;
const d = url ? describe : describe.skip;
const DB_NAME = "irori_ir262_clear";

d("jobs clear-history (db integration, dedicated database)", () => {
  let admin: ReturnType<typeof createDbHandle>;
  let handle: ReturnType<typeof createDbHandle>;
  let db: Db;
  let nodeId: string;
  // Two nodes: the partial unique index holds ONE active (queued/running)
  // job per node, so the queued and the running seed rows cannot share one.
  let nodeIdB: string;

  beforeAll(async () => {
    admin = createDbHandle(url!);
    await admin.sql.unsafe(`drop database if exists ${DB_NAME} with (force)`);
    await admin.sql.unsafe(`create database ${DB_NAME}`);
    handle = createDbHandle(url!.replace(/\/[^/]+$/, `/${DB_NAME}`));
    await handle.migrate();
    db = handle.db;
    nodeId = randomUUID();
    nodeIdB = randomUUID();
    for (const [id, name] of [
      [nodeId, `clear-test-${nodeId.slice(0, 8)}`],
      [nodeIdB, `clear-test-${nodeIdB.slice(0, 8)}`],
    ] as const) {
      await db.insert(nodes).values({
        id,
        name,
        kind: "spark",
        role: "standalone",
        host: "localhost",
        agentTokenHash: "x",
        agentTokenEnc: "x",
      });
    }
  });

  afterAll(async () => {
    await handle.close();
    await admin.sql.unsafe(`drop database if exists ${DB_NAME} with (force)`);
    await admin.close();
  });

  async function seedRow(owner: string, status: "queued" | "running" | "succeeded" | "failed" | "canceled"): Promise<string> {
    const id = randomUUID();
    await db.insert(jobs).values({
      id,
      nodeId: owner,
      kind: "sync-local",
      status,
      params: { name: `iri262-${status}` },
      progress: null,
      createdAt: new Date(),
    });
    return id;
  }

  it("deletes only settled rows, cascades output, nulls queue references", async () => {
    // The active rows sit on different nodes (one active slot per node).
    const queuedId = await seedRow(nodeIdB, "queued");
    const runningId = await seedRow(nodeId, "running");
    const doneIds = [await seedRow(nodeId, "succeeded"), await seedRow(nodeId, "failed"), await seedRow(nodeId, "canceled")];
    await db.insert(jobOutput).values({ jobId: doneIds[0]!, seq: 1, line: "last line" });
    const queueId = randomUUID();
    await db.insert(downloadQueue).values({ source: "hf", name: "iri262-model", jobId: doneIds[0]!, id: queueId });

    const service = createJobsService(db, () => true);
    expect(await service.clearHistory()).toBe(3);

    const mine = await db.select().from(jobs).where(eq(jobs.nodeId, nodeId));
    const mineB = await db.select().from(jobs).where(eq(jobs.nodeId, nodeIdB));
    expect(mine.filter((j) => doneIds.includes(j.id))).toHaveLength(0);
    expect(mine.find((j) => j.id === runningId)?.status).toBe("running");
    expect(mineB.find((j) => j.id === queuedId)?.status).toBe("queued");
    // job_output cascaded with its settled row.
    expect(await db.select().from(jobOutput).where(eq(jobOutput.jobId, doneIds[0]!))).toHaveLength(0);
    // download_queue survives with the reference nulled.
    const [entry] = await db.select().from(downloadQueue).where(eq(downloadQueue.id, queueId));
    expect(entry?.jobId).toBeNull();
    await db.delete(downloadQueue).where(eq(downloadQueue.id, queueId));
  });
});

describe("DELETE /api/v1/jobs (route)", () => {
  function makeApp(jobsService: unknown) {
    const deps = {
      getStore: () => null,
      getLlmStore: () => null,
      getHistory: () => null,
      getLlmHistory: () => null,
      dbHealthy: async () => true,
      rings: createRings(),
      sse: createSseHub({ heartbeatMs: 0 }),
      getHub: () => null,
      getJobs: jobsService === null ? () => null : () => jobsService,
      getInventory: () => null,
      hfQuants: { listQuants: async () => ({}) } as never,
      version: "test",
      tag: null,
      staticDir: null,
    } as unknown as AppDeps;
    return createApp(deps);
  }

  it("returns the deleted count and answers 503 while degraded", async () => {
    const res = await request(makeApp({ clearHistory: async () => 7 })).delete("/api/v1/jobs");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 7 });

    const down = await request(makeApp(null)).delete("/api/v1/jobs");
    expect(down.status).toBe(503);
  });
});
