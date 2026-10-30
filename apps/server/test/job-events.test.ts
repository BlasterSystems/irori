import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbHandle, jobOutput, jobs, modelMeta, nodeInventory, nodeModels, nodes, type Db, type DbHandle } from "@irori/db";
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
    expect(settled[0]).toMatchObject({ nodeId, jobId: row.id, kind: "sync-local", status: "succeeded", exitCode: 0, params: {} });
    expect(settled[0]!.durationMs).not.toBeNull();
    await service.onDone(nodeId, row.id, "failed", 1);
    expect(settled).toHaveLength(1);
  });

  it("threads job params through settle events (IR-121)", async () => {
    const params = { name: "glm", hosts: ["operator@dgx3"], jobs: 4 };
    const row = await service.create(nodeId, "push", params);
    await service.onDone(nodeId, row.id, "succeeded", 0);
    const mine = settled.filter((s) => s.jobId === row.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.params).toEqual(params);
  });

  it("emits canceled only once the agent confirms the kill (IR-131)", async () => {
    const row = await service.create(nodeId, "sync-local", {});
    const result = await service.cancel(row.id);
    expect(result).toEqual({ ok: true });
    // Verify-before-write: no settle event until the ack or job-done.
    expect(settled.filter((s) => s.jobId === row.id)).toHaveLength(0);
    await service.onCancelAck(nodeId, row.id);
    // Fixture-relative: earlier tests in this suite share the settled array.
    const mine = settled.filter((s) => s.jobId === row.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ jobId: row.id, kind: "sync-local", status: "canceled" });
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

  it("register-local upserts the node-model row and drops the cached inventory (IR-104)", async () => {
    const name = "jobevt-reg-model";
    await db.delete(nodeModels).where(eq(nodeModels.model, name));
    await db.delete(nodeInventory).where(eq(nodeInventory.nodeId, nodeId));
    await db.insert(nodeInventory).values({ nodeId, report: { generatedAtMs: 1, store: null, local: [] } });

    const row = await service.create(nodeId, "register-local", { name, user: "operator" });
    await service.onDone(nodeId, row.id, "succeeded", 0);
    expect(await db.select().from(nodeModels).where(eq(nodeModels.model, name))).toHaveLength(1);
    expect(await db.select().from(nodeInventory).where(eq(nodeInventory.nodeId, nodeId))).toHaveLength(0);

    await db.delete(nodeModels).where(eq(nodeModels.model, name));
  });

  it("auto-provisions below-pin cache users after an inventory settle (IR-105)", async () => {
    const withPin = createJobsService(db, () => true, (e) => settled.push(e), undefined, async () => "0.23.0");
    const report = {
      generatedAtMs: Date.now(),
      store: null,
      local: [
        { user: "root", home: "/root", cacheDir: "/root/.cache/huggingface/hub", modelctlVersion: "0.23.0", error: null, models: [], orphans: [] },
        { user: "operator", home: "/home/operator", cacheDir: "/home/operator/.cache/huggingface/hub", modelctlVersion: "0.20.1", error: null, models: [], orphans: [] },
      ],
    };
    const inv = await withPin.create(nodeId, "models-inventory", {});
    await db.insert(jobOutput).values({ jobId: inv.id, seq: 1, line: JSON.stringify(report) });
    await withPin.onDone(nodeId, inv.id, "succeeded", 0);
    const rows = await db.select().from(jobs).where(eq(jobs.nodeId, nodeId));
    const active = (j: (typeof rows)[number]) => j.status === "queued" || j.status === "running";
    const installs = rows.filter((j) => j.kind === "modelctl-install" && active(j));
    // Only the below-pin user gets an install job; the satisfied one is skipped.
    expect(installs).toHaveLength(1);
    expect(installs[0]!.params).toEqual({ user: "operator" });
    // Free the one-active slot: the dispatched install stays running (the
    // fake agent never settles it).
    await withPin.onDone(nodeId, installs[0]!.id, "succeeded", 0);
  });

  it("does not auto-provision when the pin is unset (IR-105)", async () => {
    const withoutPin = createJobsService(db, () => true, (e) => settled.push(e));
    const report = {
      generatedAtMs: Date.now(),
      store: null,
      local: [
        { user: "operator", home: "/home/p", cacheDir: "/home/p/.cache/huggingface/hub", modelctlVersion: "0.20.1", error: null, models: [], orphans: [] },
      ],
    };
    const inv = await withoutPin.create(nodeId, "models-inventory", {});
    await db.insert(jobOutput).values({ jobId: inv.id, seq: 1, line: JSON.stringify(report) });
    await withoutPin.onDone(nodeId, inv.id, "succeeded", 0);
    const rows = await db.select().from(jobs).where(eq(jobs.nodeId, nodeId));
    expect(rows.filter((j) => j.kind === "modelctl-install" && (j.status === "queued" || j.status === "running"))).toHaveLength(0);
  });

  it("reports canceling on a second cancel and never goes terminal unconfirmed (IR-131)", async () => {
    const row = await service.create(nodeId, "sync-local", {});
    expect(await service.cancel(row.id)).toEqual({ ok: true });
    expect(await service.cancel(row.id)).toEqual({ ok: false, reason: "canceling" });
    const [r] = await db.select().from(jobs).where(eq(jobs.id, row.id));
    expect(r!.status).toBe("running");
    expect(r!.cancelRequestedAt).not.toBeNull();
    await service.onDone(nodeId, row.id, "canceled", null); // settle: shared DB hygiene
  });

  it("hello reconcile settles unreported rows but never agent-update rows (IR-131)", async () => {
    const orphan = await service.create(nodeId, "sync-local", {});
    await service.settleOrphansOnHello(nodeId, []); // fresh agent reports nothing running
    const [settled1] = await db.select().from(jobs).where(eq(jobs.id, orphan.id));
    expect(settled1!.status).toBe("failed");
    // ADR-0007: an agent-update row is owned by the hello version check, not
    // the orphan path — even though the update child is never reported.
    const update = await service.create(nodeId, "agent-update", { expectedVersion: "0.4.0" });
    await service.settleOrphansOnHello(nodeId, []);
    const [settled2] = await db.select().from(jobs).where(eq(jobs.id, update.id));
    expect(settled2!.status).toBe("running");
    await service.onDone(nodeId, update.id, "failed", null); // settle: shared DB hygiene
  });
});
