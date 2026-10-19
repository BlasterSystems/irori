import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDbHandle, createNodeStore, nodes, type DbHandle, type NodeRecord, type NodeStore } from "@irori/db";
import { createRings, type Rings } from "../src/rings.js";
import { createSseHub, type SseHub } from "../src/sse.js";
import {
  createSetupsService,
  SetupOfflineError,
  type SetupsService,
  type SetupsServiceDeps,
} from "../src/setups-service.js";
import { makeLlmPort } from "./helpers.js";

/**
 * Requires a REAL Postgres (ADR-0002 — no :memory: exists for postgres.js).
 * Same convention as packages/db: IRORI_TEST_DATABASE_URL must point at a
 * DISPOSABLE database. CI starts a Postgres service container for this suite.
 */
const url = process.env.IRORI_TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

interface FakeJobView {
  id: string;
  nodeId: string;
  kind: string;
  status: "running";
}

interface Harness {
  service: SetupsService;
  sent: Array<{ nodeId: string; msg: Record<string, unknown> }>;
  refreshed: string[];
  online: Set<string>;
  created: FakeJobView[];
  holders: Map<string, Set<string>>;
  catalog: Map<string, { name: string; repository: string; runtime: string; bytes: number }>;
}

function makeHarness(db: DbHandle["db"], rings: Rings, sse: Pick<SseHub, "send">, store: NodeStore, owned: () => string[]): Harness {
  const sent: Array<{ nodeId: string; msg: Record<string, unknown> }> = [];
  const refreshed: string[] = [];
  const online = new Set<string>();
  const created: FakeJobView[] = [];
  const holders = new Map<string, Set<string>>();
  const catalog = new Map<string, { name: string; repository: string; runtime: string; bytes: number }>();

  // The disposable DB may carry rows from other runs/suites — only our own
  // nodes are visible to the service.
  const myNodes = async (): Promise<NodeRecord[]> => {
    const mine = new Set(owned());
    return (await store.list()).filter((n) => mine.has(n.id));
  };

  const deps: SetupsServiceDeps = {
    db,
    rings,
    sse,
    getNode: async (id) => (await store.get(id)) ?? null,
    getNodes: () => myNodes(),
    online: () => online,
    sendToNode: (nodeId, msg) => {
      sent.push({ nodeId, msg: msg as Record<string, unknown> });
      return true;
    },
    refreshNodeConfig: async (nodeId) => {
      refreshed.push(nodeId);
      return true;
    },
    jobs: {
      create: async (nodeId, kind, params) => {
        // Real UUIDs: the transfer stages are persisted and re-validated via
        // transferStageSchema (jobId is a uuid) — "job-N" would be dropped.
        const job: FakeJobView = { id: randomUUID(), nodeId, kind, status: "running" };
        created.push(job);
        void params;
        return job as never;
      },
      cancel: async () => true,
      findModel: async (name) => catalog.get(name) ?? null,
      presentNodesFor: async (name) => [...(holders.get(name) ?? [])],
    },
    log: () => {},
  };
  return { service: createSetupsService(deps), sent, refreshed, online, created, holders, catalog };
}

interface Ids {
  head: string;
  nas: string;
  worker: string;
}

d("setups service", () => {
  let h: DbHandle;
  let rings: Rings;
  let sse: SseHub;
  let ctx: Harness;
  let ids: Ids;

  async function waitFor(pred: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
    const deadline = Date.now() + ms;
    for (;;) {
      if (await pred()) return;
      if (Date.now() > deadline) throw new Error("condition not met in time");
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  beforeAll(async () => {
    h = createDbHandle(url!);
    await h.migrate();
    rings = createRings();
    sse = createSseHub({ heartbeatMs: 0 });
    const store = createNodeStore(h.db, "a".repeat(64));
    const created: Record<string, string> = {};
    for (const [name, kind, role, host] of [
      ["dgx1", "spark", "head", "dgx1.lan"],
      ["nas", "nas", "standalone", "nas.lan"],
      ["spark2", "spark", "worker", "spark2.lan"],
    ] as const) {
      const suffix = `${name}-${Math.random().toString(36).slice(2, 8)}`;
      const { id } = await store.create({ name: suffix, kind: kind as never, role: role as never, host });
      created[name] = id;
    }
    await h.db.update(nodes).set({ nasRoot: "/mnt/nas" }).where(eq(nodes.id, created.nas!));
    ids = { head: created.dgx1!, nas: created.nas!, worker: created.spark2! };
    ctx = makeHarness(h.db, rings, sse, store, () => Object.values(created));
    ctx.online.add(ids.head);
  });

  afterAll(async () => {
    await h.close();
  });

  it("creates a setup, assigns the probe port to the head, and refreshes its config", async () => {
    const setup = await ctx.service.create({
      name: "GLM-5.3-Flash-EXL3",
      kind: "cluster",
      model: "GLM-5.3-Flash-EXL3",
      port: 8081,
      headNodeId: ids.head,
      nodes: [{ nodeId: ids.worker, role: "worker" }],
      scriptStart: "/home/me/glm/start.sh",
      scriptStop: "/home/me/glm/stop.sh",
      env: { modelName: true, port: true, extraArgs: "--thinking", modelPath: true },
    });
    expect(setup.status).toBe("stopped");
    expect(setup.startupTimeoutMs).toBe(15 * 60_000);
    const [row] = await h.sql<{ llm_ports: Array<{ port: number }> }[]>`select llm_ports from nodes where id = ${ids.head}`;
    expect(row!.llm_ports.map((p) => p.port)).toContain(8081);
    expect(ctx.refreshed).toContain(ids.head);
  });

  it("validates scripts through the head agent", async () => {
    const promise = ctx.service.validateScripts(ids.head, ["/a/start.sh", "/a/stop.sh"]);
    await waitFor(() => ctx.sent.some((s) => (s.msg as { type?: string }).type === "setup-validate"));
    // Simulate the agent's validate-result frame.
    const sentValidate = ctx.sent.filter((s) => (s.msg as { type?: string }).type === "setup-validate").pop()!;
    expect(sentValidate).toBeDefined();
    ctx.service.onValidateResult(
      {
        type: "setup-validate-result",
        validateId: (sentValidate!.msg as { validateId: string }).validateId,
        results: [
          { script: "/a/start.sh", ok: true, error: null },
          { script: "/a/stop.sh", ok: false, error: "not found" },
        ],
      },
      ids.head,
    );
    const results = await promise;
    expect(results[0]!.ok).toBe(true);
    expect(results[1]!.ok).toBe(false);
  });

  it("refuses to start when the head agent is offline and surfaces nack errors", async () => {
    const setup = await ctx.service.create({
      name: "offline",
      kind: "single",
      model: "m2",
      port: 9001,
      headNodeId: ids.head,
      nodes: [],
      scriptStart: "/s/start.sh",
      scriptStop: "/s/stop.sh",
      env: { modelName: false, port: false, extraArgs: "", modelPath: false },
    });
    ctx.online.delete(ids.head);
    await expect(ctx.service.start(setup.id)).rejects.toBeInstanceOf(SetupOfflineError);
    ctx.online.add(ids.head);

    const failing = ctx.service.start(setup.id);
    await waitFor(() => ctx.sent.some((s) => (s.msg as { type?: string }).type === "setup-start" && (s.msg as { setupId?: string }).setupId === setup.id));
    ctx.service.onDriverAck({ type: "setup-ack", setupId: setup.id, ok: false, error: "start script is not executable" }, ids.head);
    await expect(failing).rejects.toThrow("start script is not executable");
    const after = await ctx.service.get(setup.id);
    expect(after!.status).toBe("failed");
    expect(after!.lastError).toContain("not executable");
  });

  it("starts with env exports and modelPathName, then derives health from the probe", async () => {
    const setup = await ctx.service.create({
      name: "health",
      kind: "single",
      model: "GLM-5.3-Flash-EXL3",
      port: 8081,
      headNodeId: ids.head,
      nodes: [],
      scriptStart: "/home/me/glm/start.sh",
      scriptStop: "/home/me/glm/stop.sh",
      env: { modelName: true, port: true, extraArgs: "--thinking", modelPath: true },
    });
    const starting = ctx.service.start(setup.id);
    await waitFor(() => ctx.sent.some((s) => (s.msg as { type?: string }).type === "setup-start" && (s.msg as { setupId?: string }).setupId === setup.id));
    ctx.service.onDriverAck({ type: "setup-ack", setupId: setup.id, ok: true, error: null }, ids.head);
    const info = await starting;
    expect(info.status).toBe("starting");

    // The agent gets MODEL_NAME/PORT/EXTRA_ARGS exports and the resolve flag.
    const frames = ctx.sent.filter((s) => s.nodeId === ids.head && (s.msg as { type?: string }).type === "setup-start");
    const frame = frames[frames.length - 1]!;
    expect(frame).toBeDefined();
    const env = (frame!.msg as { env: Record<string, string> }).env;
    expect(env).toMatchObject({ MODEL_NAME: "GLM-5.3-Flash-EXL3", PORT: "8081", EXTRA_ARGS: "--thinking" });
    expect((frame!.msg as { modelPathName: string | null }).modelPathName).toBe("GLM-5.3-Flash-EXL3");

    // Driver running → status starting until the probe confirms.
    await ctx.service.onDriverEvent({ type: "setup-event", setupId: setup.id, runId: null, state: "running", exitCode: null, pid: 10, pgid: 10, error: null }, ids.head);
    expect((await ctx.service.get(setup.id))!.status).toBe("starting");

    rings.pushLlm(ids.head, {
      serverTimeMs: Date.now(),
      ports: [makeLlmPort({ port: 8081, host: "127.0.0.1", detected: true, model: "glm-5.3-flash-exl3" })],
    });
    await ctx.service.tick();
    const healthy = await ctx.service.get(setup.id);
    expect(healthy!.status).toBe("running");
    expect(healthy!.health).toBe("healthy");

    // A different engine on the port → foreign (nothing was stopped).
    rings.pushLlm(ids.head, {
      serverTimeMs: Date.now(),
      ports: [makeLlmPort({ port: 8081, host: "127.0.0.1", detected: true, model: "qwen3-8b" })],
    });
    await ctx.service.tick();
    expect((await ctx.service.get(setup.id))!.health).toBe("foreign");

    // Startup timeout never overrides an answered probe: the port answers a
    // DIFFERENT engine, so foreign is the truthful state (health axis).
    await h.db.execute(sql`update setups set last_started_at = now() - interval '16 minutes' where id = ${setup.id}`);
    await ctx.service.tick();
    expect((await ctx.service.get(setup.id))!.health).toBe("foreign");

    // A silent probe on a HEALTHY setup demotes it (engine crash / kill).
    rings.pushLlm(ids.head, {
      serverTimeMs: Date.now(),
      ports: [makeLlmPort({ port: 8081, host: "127.0.0.1", detected: true, model: "glm-5.3-flash-exl3" })],
    });
    await ctx.service.tick();
    expect((await ctx.service.get(setup.id))!.health).toBe("healthy");
    rings.pushLlm(ids.head, {
      serverTimeMs: Date.now(),
      ports: [makeLlmPort({ port: 8081, host: "127.0.0.1", detected: false, model: null })],
    });
    await ctx.service.tick();
    const demoted = await ctx.service.get(setup.id);
    expect(demoted!.health).toBe("timeout");
    expect(demoted!.lastError).toContain("stopped answering");

    // With nothing having ever answered and the budget elapsed, timeout too.
    await h.db.execute(sql`update setups set health = null, last_started_at = now() - interval '16 minutes' where id = ${setup.id}`);
    await ctx.service.tick();
    expect((await ctx.service.get(setup.id))!.health).toBe("timeout");

    // The driver-truth poll (exitCode null) may NOT resurrect a stopped setup
    // even when the probe still sees the model on the port.
    const stopping = ctx.service.stop(setup.id);
    await waitFor(() => ctx.sent.some((s) => (s.msg as { type?: string }).type === "setup-stop" && (s.msg as { setupId?: string }).setupId === setup.id));
    ctx.service.onDriverAck({ type: "setup-ack", setupId: setup.id, ok: true, error: null }, ids.head);
    expect((await stopping)!.status).toBe("stopped");
    await ctx.service.onDriverEvent({ type: "setup-event", setupId: setup.id, runId: null, state: "stopped", exitCode: null, pid: null, pgid: null, error: null }, ids.head);
    const afterPoll = await ctx.service.get(setup.id);
    expect(afterPoll!.status).toBe("stopped");
    expect(afterPoll!.health).toBeNull();
  });

  it("builds staged transfers per target and chains them on job completion", async () => {
    const setup = await ctx.service.create({
      name: "transfer",
      kind: "single",
      model: "DeepSeek-V4-Flash",
      port: 8082,
      headNodeId: ids.head,
      nodes: [],
      scriptStart: "/s/start.sh",
      scriptStop: "/s/stop.sh",
      env: { modelName: false, port: false, extraArgs: "", modelPath: false },
    });
    ctx.catalog.set("DeepSeek-V4-Flash", { name: "DeepSeek-V4-Flash", repository: "deepseek-ai/DeepSeek-V4-Flash", runtime: "vllm", bytes: 41.5 * 1024 ** 3 });
    ctx.holders.set("DeepSeek-V4-Flash", new Set([ids.head]));

    const transfer = await ctx.service.createTransfer(setup.id, [ids.worker, ids.nas]);
    expect(transfer.stages).toHaveLength(2);
    const byTarget = new Map(transfer.stages.map((s) => [s.targetId, s]));
    // worker mounts no NAS but the head holds the model → push from the head.
    expect(byTarget.get(ids.worker)!.kind).toBe("push");
    expect(byTarget.get(ids.worker)!.nodeId).toBe(ids.head);
    expect((byTarget.get(ids.worker)!.params as { hosts: string[] }).hosts).toEqual(["spark2.lan"]);
    // NAS mounts the store → sync-local on the NAS itself.
    expect(byTarget.get(ids.nas)!.kind).toBe("sync-local");
    expect(byTarget.get(ids.nas)!.nodeId).toBe(ids.nas);

    // Stage job ids appear on the live stages array as the runner enqueues —
    // sequentially: stage 1's job only exists after stage 0 succeeded.
    await waitFor(() => transfer.stages[0]!.jobId !== null);
    for (const stage of transfer.stages) {
      await waitFor(() => stage.jobId !== null);
      await ctx.service.onJobDone(stage.nodeId, stage.jobId!, "succeeded", 0);
    }
    await waitFor(async () => {
      const persisted = (await ctx.service.transfers(setup.id)).find((t) => t.id === transfer.id);
      return persisted !== undefined && persisted.status === "succeeded";
    });
    const persisted = (await ctx.service.transfers(setup.id)).find((t) => t.id === transfer.id)!;
    expect(persisted.stages.every((s) => s.status === "succeeded")).toBe(true);
  });

  it("parses rsync progress into the running stage", async () => {
    const setup = await ctx.service.create({
      name: "progress",
      kind: "single",
      model: "Progress-Model",
      port: 8085,
      headNodeId: ids.head,
      nodes: [],
      scriptStart: "/s/start.sh",
      scriptStop: "/s/stop.sh",
      env: { modelName: false, port: false, extraArgs: "", modelPath: false },
    });
    ctx.catalog.set("Progress-Model", { name: "Progress-Model", repository: "org/Progress-Model", runtime: "vllm", bytes: 2048 });
    ctx.holders.set("Progress-Model", new Set([ids.head]));
    const transfer = await ctx.service.createTransfer(setup.id, [ids.nas]);
    await waitFor(() => transfer.stages[0]!.jobId !== null);
    const stage = transfer.stages[0]!;
    await ctx.service.onJobOutput(stage.nodeId, stage.jobId!, 0, " 2,713,533   45%    1.00MB/s    0:00:03");
    expect(stage.progress).toEqual({ bytes: 2713533, percent: 45, rateBytesPerSec: 1024 * 1024, etaSeconds: 3 });
    await ctx.service.onJobDone(stage.nodeId, stage.jobId!, "succeeded", 0);
    await waitFor(async () => {
      const persisted = (await ctx.service.transfers(setup.id)).find((t) => t.id === transfer.id);
      return persisted !== undefined && persisted.status === "succeeded";
    });
  });

  it("chains an HF download when the model is absent from the catalog", async () => {
    const setup = await ctx.service.create({
      name: "hfchain",
      kind: "single",
      model: "incoai/GLM-5.3-Flash-DFlash2",
      port: 8083,
      headNodeId: ids.head,
      nodes: [],
      scriptStart: "/s/start.sh",
      scriptStop: "/s/stop.sh",
      env: { modelName: false, port: false, extraArgs: "", modelPath: false },
    });
    const transfer = await ctx.service.createTransfer(setup.id, [ids.worker]);
    // No catalog entry, no local holder, and the worker mounts no NAS root:
    // the chain stages the store download on the NAS, then a direct HF
    // download into the worker's cache (the "pull from HF instead" path).
    expect(transfer.stages.map((s) => s.kind)).toEqual(["download-queue", "download"]);
    expect(transfer.stages[0]!.nodeId).toBe(ids.nas);
    expect((transfer.stages[0]!.params as { downloads: Array<{ source: string }> }).downloads[0]!.source).toBe("incoai/GLM-5.3-Flash-DFlash2");
  });

  it("skips only the failed target's remaining stages", async () => {
    const setup = await ctx.service.create({
      name: "skip",
      kind: "single",
      model: "Skip-Model",
      port: 8084,
      headNodeId: ids.head,
      nodes: [],
      scriptStart: "/s/start.sh",
      scriptStop: "/s/stop.sh",
      env: { modelName: false, port: false, extraArgs: "", modelPath: false },
    });
    ctx.catalog.set("Skip-Model", { name: "Skip-Model", repository: "org/Skip-Model", runtime: "vllm", bytes: 1024 });
    ctx.holders.set("Skip-Model", new Set([ids.head]));
    const transfer = await ctx.service.createTransfer(setup.id, [ids.worker, ids.nas]);
    expect(transfer.stages).toHaveLength(2);
    // Two-pass order: the NAS sync runs first; the worker's push follows.
    const syncStage = transfer.stages.find((s) => s.kind === "sync-local")!;
    const pushStage = transfer.stages.find((s) => s.kind === "push")!;
    await waitFor(() => syncStage.jobId !== null);
    await ctx.service.onJobDone(syncStage.nodeId, syncStage.jobId!, "succeeded", 0);
    await waitFor(() => pushStage.jobId !== null);
    await ctx.service.onJobDone(pushStage.nodeId, pushStage.jobId!, "failed", 1);
    // push failed → the worker target is done (failed); the transfer finalizes.
    await waitFor(async () => {
      const persisted = (await ctx.service.transfers(setup.id)).find((t) => t.id === transfer.id);
      return persisted !== undefined && persisted.status === "failed";
    });
    const persisted = (await ctx.service.transfers(setup.id)).find((t) => t.id === transfer.id)!;
    expect(persisted.stages.find((s) => s.kind === "push")!.status).toBe("failed");
    expect(persisted.stages.find((s) => s.kind === "sync-local")!.status).toBe("succeeded");
  });
});
