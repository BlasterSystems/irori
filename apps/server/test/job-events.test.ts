import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbHandle, jobs, modelMeta, nodeModels, nodes, type Db, type DbHandle } from "@irori/db";
import { createJobsService, type JobSettledEvent, type JobsService } from "../src/jobs-service.js";

/**
 * IRI-013 integration: every terminal job transition emits exactly one
 * JobSettledEvent. Requires a REAL Postgres (ADR-0002) — same convention as
 * m7.test.ts: IRORI_TEST_DATABASE_URL at a DISPOSABLE database.
 */
const url = process.env.IRORI_TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d("job settle events (db integration)", () => {
  let handle: DbHandle;
  let db: Db;
  let nodeId: string;
  let service: JobsService;
  let settled: JobSettledEvent[];

  beforeAll(async () => {
    handle = createDbHandle(url!);
    await handle.migrate();
    db = handle.db;
    nodeId = randomUUID();
    await db.insert(nodes).values({
      id: nodeId,
      name: `jobevt-${nodeId.slice(0, 8)}`,
      kind: "spark",
      role: "standalone",
      host: "localhost",
      agentTokenHash: "x",
      agentTokenEnc: "x",
    });
    settled = [];
    service = createJobsService(db, () => true, (e) => settled.push(e));
  });

  afterAll(async () => {
    await db.delete(jobs).where(eq(jobs.nodeId, nodeId));
    await db.delete(nodes).where(eq(nodes.id, nodeId));
    await handle.close();
  });

  it("emits exactly one event on done, none on a repeated done", async () => {
    const row = await service.create(nodeId, "sync-local", {});
    await service.onDone(nodeId, row.id, "succeeded", 0);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ nodeId, jobId: row.id, kind: "sync-local", status: "succeeded", exitCode: 0 });
    expect(settled[0]!.durationMs).not.toBeNull();
    await service.onDone(nodeId, row.id, "failed", 1);
    expect(settled).toHaveLength(1);
  });

  it("emits canceled on cancel", async () => {
    const row = await service.create(nodeId, "sync-local", {});
    await service.cancel(row.id);
    expect(settled).toHaveLength(2);
    expect(settled[1]).toMatchObject({ jobId: row.id, kind: "sync-local", status: "canceled" });
  });

  it("emits failed when the reaper collects an offline node's job", async () => {
    const row = await service.create(nodeId, "sync-local", {});
    // The reaper is global across the shared disposable DB — foreign active
    // rows (crashed earlier runs) may be collected too. Assert on THIS row.
    const reaped = await service.reapOffline(new Set());
    expect(reaped).toContain(row.id);
    const mine = settled.filter((s) => s.jobId === row.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ jobId: row.id, kind: "sync-local", status: "failed" });
  });

  it("drops the model cache row when the last placement is deleted, keeps it otherwise (IRI-018)", async () => {
    const other = randomUUID();
    await db.insert(nodes).values({
      id: other,
      name: `jobevt-o-${other.slice(0, 8)}`,
      kind: "spark",
      role: "worker",
      host: "other",
      agentTokenHash: "x",
      agentTokenEnc: "x",
    });
    const gone = "jobevt-gone-model";
    const kept = "jobevt-kept-model";
    // Shared disposable DB: a previous aborted run may have left these rows.
    await db.delete(modelMeta).where(inArray(modelMeta.name, [gone, kept]));
    await db.delete(nodeModels).where(inArray(nodeModels.model, [gone, kept]));
    await db.insert(modelMeta).values([
      { name: gone, repository: "org/gone", runtime: "vllm", bytes: 1, meta: { source: "catalog" } },
      { name: kept, repository: "org/kept", runtime: "vllm", bytes: 1, meta: { source: "catalog" } },
    ]);
    await db.insert(nodeModels).values([
      { nodeId, model: gone },
      { nodeId, model: kept },
      { nodeId: other, model: kept },
    ]);
    // A succeeded nas-delete-apply removes this node's placement — and the
    // model cache row when it was the last placement (model_meta is
    // upsert-only, so without this the deleted model stays listed forever).
    const row = await service.create(nodeId, "nas-delete-apply", { name: gone });
    await service.onDone(nodeId, row.id, "succeeded", 0);
    expect(await db.select().from(modelMeta).where(eq(modelMeta.name, gone))).toHaveLength(0);
    expect(await db.select().from(nodeModels).where(eq(nodeModels.model, gone))).toHaveLength(0);

    // Another node still holding the model keeps its cache row.
    const row2 = await service.create(nodeId, "nas-delete-apply", { name: kept });
    await service.onDone(nodeId, row2.id, "succeeded", 0);
    expect(await db.select().from(modelMeta).where(eq(modelMeta.name, kept))).toHaveLength(1);

    await db.delete(modelMeta).where(inArray(modelMeta.name, [gone, kept]));
    await db.delete(nodeModels).where(inArray(nodeModels.model, [gone, kept]));
    await db.delete(nodes).where(eq(nodes.id, other));
  });
});
