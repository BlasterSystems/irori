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

  it("reconciles node presence from an inventory settle and prunes only on a complete report (IR-140)", async () => {
    const names = { resident: "iri140-resident", ghost: "iri140-ghost", late: "iri140-late" };
    await db.delete(nodeModels).where(inArray(nodeModels.model, Object.values(names)));
    await db.delete(nodeInventory).where(eq(nodeInventory.nodeId, nodeId));
    // Pre-existing presence: the resident model plus a ghost a delete removed
    // outside a hub job (the false-negative the ticket reports).
    await db.insert(nodeModels).values([{ nodeId, model: names.resident }, { nodeId, model: names.ghost }]);

    const cache = (user: string, modelNames: string[], error: string | null = null) => ({
      user,
      home: `/home/${user}`,
      cacheDir: `/home/${user}/.cache/huggingface/hub`,
      modelctlVersion: "0.23.0",
      error,
      models: modelNames.map((name) => ({ name, repository: "org/" + name, runtime: "vllm", bytes: null })),
      orphans: [] as string[],
    });

    // Complete report (every cache read succeeded): upsert the late model,
    // keep the resident one, prune the ghost.
    const inv1 = await service.create(nodeId, "models-inventory", {});
    await db.insert(jobOutput).values({ jobId: inv1.id, seq: 1, line: JSON.stringify({ generatedAtMs: Date.now(), store: null, local: [cache("root", [names.resident, names.late]), cache("operator", [names.late])] }) });
    await service.onDone(nodeId, inv1.id, "succeeded", 0);
    const after1 = (await db.select({ model: nodeModels.model }).from(nodeModels).where(eq(nodeModels.nodeId, nodeId))).map((r) => r.model).sort();
    expect(after1).toEqual([names.late, names.resident]);

    // Partial report (one cache read failed → its models list is empty but
    // NOT authoritative): no prune — the surviving rows stay.
    const inv2 = await service.create(nodeId, "models-inventory", {});
    await db.insert(jobOutput).values({ jobId: inv2.id, seq: 1, line: JSON.stringify({ generatedAtMs: Date.now(), store: null, local: [cache("root", [names.resident, names.late]), cache("operator", [], "modelctl timed out")] }) });
    await service.onDone(nodeId, inv2.id, "succeeded", 0);
    const after2 = (await db.select({ model: nodeModels.model }).from(nodeModels).where(eq(nodeModels.nodeId, nodeId))).map((r) => r.model).sort();
    expect(after2).toEqual([names.late, names.resident]);

    // Complete report where every cache lists nothing: prune everything.
    const inv3 = await service.create(nodeId, "models-inventory", {});
    await db.insert(jobOutput).values({ jobId: inv3.id, seq: 1, line: JSON.stringify({ generatedAtMs: Date.now(), store: null, local: [cache("root", [])] }) });
    await service.onDone(nodeId, inv3.id, "succeeded", 0);
    expect(await db.select().from(nodeModels).where(eq(nodeModels.nodeId, nodeId))).toHaveLength(0);

    await db.delete(nodeModels).where(inArray(nodeModels.model, Object.values(names)));
    await db.delete(nodeInventory).where(eq(nodeInventory.nodeId, nodeId));
  });

  it("presentNodesFor unions the cached inventory report (IR-140 defense)", async () => {
    const name = "iri140-cached-only";
    await db.delete(nodeModels).where(eq(nodeModels.model, name));
    await db.delete(nodeInventory).where(eq(nodeInventory.nodeId, nodeId));
    expect(await service.presentNodesFor(name)).toEqual([]);

    // A report row without a node_models write still reports presence.
    await db.insert(nodeInventory).values({
      nodeId,
      report: {
        generatedAtMs: Date.now(),
        store: null,
        local: [{ user: "root", home: "/root", cacheDir: "/root/.cache/huggingface/hub", modelctlVersion: "0.23.0", error: null, models: [{ name, repository: "org/x", runtime: "vllm", bytes: null }], orphans: [] }],
      },
    });
    expect(await service.presentNodesFor(name)).toEqual([nodeId]);

    // Model-ops settle deletes the cached row — the union can no longer lie.
    const del = await service.create(nodeId, "delete-local", { name });
    await service.onDone(nodeId, del.id, "succeeded", 0);
    expect(await service.presentNodesFor(name)).toEqual([]);

    await db.delete(nodeInventory).where(eq(nodeInventory.nodeId, nodeId));
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
