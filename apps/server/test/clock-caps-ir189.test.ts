import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { ClocksGetResultMsg } from "@irori/core";
import type { NodeStore } from "@irori/db";
import { createApp, type AppDeps } from "../src/app.js";
import { clockDrift, createClockCapService, type ClockCapHub } from "../src/clock-caps.js";
import { createRings } from "../src/rings.js";
import { createSseHub } from "../src/sse.js";
import { makeFakeStore } from "./helpers.js";

/**
 * IR-189: SPEC §10 promised re-apply on every node online transition and a
 * fleet-wide apply; neither existed. These cover the comparison, the
 * re-assert, the drift streak the health rule reads, and the fleet route.
 */

function reading(overrides: Partial<ClocksGetResultMsg> = {}): ClocksGetResultMsg {
  return {
    type: "clocks-get-result",
    id: randomUUID(),
    ok: true,
    gpus: [
      { index: 0, name: "GB10", smMHz: 1200, smMaxMHz: 3003, memMHz: 4266, memMaxMHz: 4266, smCapMHz: null },
    ],
    cpu: { capMHz: null, policies: [] },
    error: null,
    ...overrides,
  };
}

function gpu(smCapMHz: number | null, index = 0) {
  return { index, name: "GB10", smMHz: 1200, smMaxMHz: 3003, memMHz: 4266, memMaxMHz: 4266, smCapMHz };
}

describe("clockDrift (pure)", () => {
  it("reports nothing when no cap is stored", () => {
    expect(clockDrift({ gpu: null, cpu: null }, reading())).toEqual([]);
  });

  it("reports nothing when the live ceiling matches the stored cap", () => {
    const r = reading({ gpus: [gpu(2000)], cpu: { capMHz: 2800, policies: [] } });
    expect(clockDrift({ gpu: 2000, cpu: 2800 }, r)).toEqual([]);
  });

  it("reports a GPU drift when the ceiling reverted to a different real value", () => {
    const r = reading({ gpus: [gpu(3003)] });
    expect(clockDrift({ gpu: 2000, cpu: null }, r)).toEqual([{ side: "gpu", stored: 2000, observed: 3003 }]);
  });

  it("treats an all-null GPU read-back as unmeasurable, not drift (IR-259)", () => {
    // GB10 rejects clocks.applications.sm: cards are visible but no cap is
    // expressible — the same contract as an empty gpus array.
    expect(clockDrift({ gpu: 2000, cpu: null }, reading({ gpus: [gpu(null)] }))).toEqual([]);
  });

  it("reports a GPU drift when only one card lost the cap", () => {
    const r = reading({ gpus: [gpu(2000, 0), gpu(null, 1)] });
    expect(clockDrift({ gpu: 2000, cpu: null }, r)).toHaveLength(1);
  });

  it("treats an unreadable GPU list as not measurable, not as drift", () => {
    expect(clockDrift({ gpu: 2000, cpu: null }, reading({ gpus: [] }))).toEqual([]);
  });

  it("reports a CPU drift when the policies are no longer uniformly capped", () => {
    const r = reading({ cpu: { capMHz: null, policies: [] } });
    expect(clockDrift({ gpu: null, cpu: 2800 }, r)).toEqual([{ side: "cpu", stored: 2800, observed: null }]);
  });

  it("treats an agent without the cpu block as not measurable", () => {
    const r = reading();
    delete (r as { cpu?: unknown }).cpu;
    expect(clockDrift({ gpu: null, cpu: 2800 }, r)).toEqual([]);
  });
});

describe("clock cap service", () => {
  function makeService(opts: {
    caps: { gpu: number | null; cpu: number | null };
    reading?: ClocksGetResultMsg | null;
    setOk?: boolean;
  }) {
    const applied: Array<{ caps: unknown; persist: boolean | undefined }> = [];
    const hub: ClockCapHub = {
      clocks: async () => (opts.reading === undefined ? reading() : opts.reading),
      setClocks: async (_id, caps, persist) => {
        applied.push({ caps, persist });
        return { ok: opts.setOk ?? true, error: opts.setOk === false ? "nvidia-smi failed" : null };
      },
    };
    const service = createClockCapService({
      store: { get: async () => ({ gpuClockCapMHz: opts.caps.gpu, cpuClockCapMHz: opts.caps.cpu }) },
      hub: () => hub,
    });
    return { service, applied };
  }

  it("does nothing when the node has no stored cap", async () => {
    const { service, applied } = makeService({ caps: { gpu: null, cpu: null } });
    expect(await service.reassert("n1")).toEqual({ checked: false, applied: [] });
    expect(applied).toHaveLength(0);
  });

  it("re-applies a drifted cap without touching persistence", async () => {
    const { service, applied } = makeService({
      caps: { gpu: 2000, cpu: null },
      reading: reading({ gpus: [gpu(3003)] }),
    });
    expect(await service.reassert("n1")).toEqual({ checked: true, applied: ["gpu"] });
    // persist=false: the registry already holds the desired state.
    expect(applied).toEqual([{ caps: { smMaxMHz: 2000 }, persist: false }]);
  });

  it("leaves a matching cap alone", async () => {
    const { service, applied } = makeService({
      caps: { gpu: 2000, cpu: 2800 },
      reading: reading({ gpus: [gpu(2000)], cpu: { capMHz: 2800, policies: [] } }),
    });
    expect(await service.reassert("n1")).toEqual({ checked: true, applied: [] });
    expect(applied).toHaveLength(0);
  });

  it("reports a failed re-apply as not applied", async () => {
    const { service } = makeService({
      caps: { gpu: 2000, cpu: null },
      reading: reading({ gpus: [gpu(3003)] }),
      setOk: false,
    });
    expect(await service.reassert("n1")).toEqual({ checked: true, applied: [] });
  });

  it("counts consecutive drifting sweeps and resets on a match", async () => {
    let current = reading({ gpus: [gpu(3003)] });
    const service = createClockCapService({
      store: { get: async () => ({ gpuClockCapMHz: 2000, cpuClockCapMHz: null }) },
      hub: () => ({ clocks: async () => current, setClocks: async () => ({ ok: true, error: null }) }),
    });
    expect(await service.driftStreak("n1")).toBe(1);
    expect(await service.driftStreak("n1")).toBe(2);
    current = reading({ gpus: [gpu(2000)] });
    expect(await service.driftStreak("n1")).toBe(0);
    current = reading({ gpus: [gpu(3003)] });
    expect(await service.driftStreak("n1")).toBe(1);
  });

  it("returns null when the node has no cap or the agent cannot answer", async () => {
    const noCap = makeService({ caps: { gpu: null, cpu: null } });
    expect(await noCap.service.driftStreak("n1")).toBeNull();

    const offline = makeService({ caps: { gpu: 2000, cpu: null }, reading: null });
    expect(await offline.service.driftStreak("n1")).toBeNull();
  });

  it("treats an all-null GPU read-back as unmeasurable: no re-apply, no streak (IR-259)", async () => {
    const { service, applied } = makeService({
      caps: { gpu: 2000, cpu: null },
      reading: reading({ gpus: [gpu(null)] }),
    });
    expect(await service.reassert("n1")).toEqual({ checked: true, applied: [] });
    expect(applied).toHaveLength(0);
    expect(await service.driftStreak("n1")).toBe(0);
  });
});

describe("POST /api/v1/clock-cap (fleet)", () => {
  function makeApp() {
    const fake = makeFakeStore();
    const calls: Array<{ nodeId: string; caps: unknown; persist: boolean | undefined }> = [];
    const refusing = new Set<string>();
    const deps: AppDeps = {
      getStore: () => fake.store,
      getLlmStore: () => null,
      getHistory: () => null,
      getLlmHistory: () => null,
      dbHealthy: async () => true,
      rings: createRings(),
      sse: createSseHub({ heartbeatMs: 0 }),
      getHub: () => ({
        online: () => new Set<string>(),
        sendToNode: () => true,
        refreshConfig: async () => true,
        clocks: async () => reading(),
        setClocks: async (nodeId, caps, persist) => {
          calls.push({ nodeId, caps, persist });
          const ok = !refusing.has(nodeId);
          return { type: "clocks-set-result", id: randomUUID(), ok, error: ok ? null : "nvidia-smi failed" };
        },
        shutdownNode: async () => null,
      }),
      getJobs: () => null,
      getInventory: () => null,
      getHfToken: null,
      hfQuants: { listQuants: async () => ({}) } as never,
      version: "test",
      tag: null,
      staticDir: null,
    };
    return { app: createApp(deps), fake, calls, refusing };
  }

  async function seed(store: NodeStore) {
    const a = await store.create({ name: "dgx1", kind: "spark", role: "head", host: "a.lan" });
    const b = await store.create({ name: "dgx2", kind: "spark", role: "worker", host: "b.lan" });
    const nas = await store.create({ name: "nas", kind: "nas", role: "standalone", host: "n.lan" });
    const off = await store.create({ name: "dgx3", kind: "spark", role: "worker", host: "c.lan" });
    await store.patch(off.id, { enabled: false });
    return { a, b, nas, off };
  }

  it("applies to every enabled spark node and skips NAS and disabled nodes", async () => {
    const { app, fake, calls } = makeApp();
    const { a, b, nas, off } = await seed(fake.store);

    const res = await request(app).post("/api/v1/clock-cap").send({ capMHz: 2000, persistent: true });

    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(2);
    expect(res.body.failed).toBe(0);
    expect(res.body.results.map((r: { name: string }) => r.name).sort()).toEqual(["dgx1", "dgx2"]);
    // IR-199: each ok side carries the applied cap; a side left alone gets no entry.
    for (const node of res.body.results) {
      expect(node.results).toEqual([{ side: "gpu", ok: true, offline: false, error: null, appliedMHz: 2000 }]);
    }
    expect(calls.map((c) => c.nodeId).sort()).toEqual([a.id, b.id].sort());
    expect(calls.every((c) => c.persist === true)).toBe(true);
    expect(calls.some((c) => c.nodeId === nas.id || c.nodeId === off.id)).toBe(false);
  });

  it("reports a partial fleet as 207 with per-node outcomes", async () => {
    const { app, fake, refusing } = makeApp();
    const { b } = await seed(fake.store);
    refusing.add(b.id);

    const res = await request(app).post("/api/v1/clock-cap").send({ capMHz: 2000 });
    expect(res.status).toBe(207);
    expect(res.body.failed).toBe(1);
    expect(res.body.applied).toBe(1);
    const failed = res.body.results.find((r: { status: number }) => r.status !== 200);
    expect(failed.name).toBe("dgx2");
    expect(failed.results[0]).toMatchObject({ side: "gpu", ok: false, error: "nvidia-smi failed", appliedMHz: null });
    const applied = res.body.results.find((r: { status: number }) => r.status === 200);
    expect(applied.results[0]).toMatchObject({ side: "gpu", ok: true, appliedMHz: 2000 });
  });

  it("reports an all-failed fleet as 502", async () => {
    const { app, fake, refusing } = makeApp();
    const { a, b } = await seed(fake.store);
    refusing.add(a.id);
    refusing.add(b.id);

    const res = await request(app).post("/api/v1/clock-cap").send({ cpuCapMHz: 2800 });
    expect(res.status).toBe(502);
    expect(res.body.applied).toBe(0);
    expect(res.body.failed).toBe(2);
    // IR-199: a refused side applied nothing.
    for (const node of res.body.results) {
      expect(node.results[0]).toMatchObject({ side: "cpu", ok: false, appliedMHz: null });
    }
  });

  it("carries the applied cap per side: set value for ok, null for a clear", async () => {
    const { app, fake } = makeApp();
    await seed(fake.store);

    const res = await request(app).post("/api/v1/clock-cap").send({ capMHz: 2000, cpuCapMHz: null });
    expect(res.status).toBe(200);
    for (const node of res.body.results) {
      expect(node.results).toEqual([
        { side: "gpu", ok: true, offline: false, error: null, appliedMHz: 2000 },
        { side: "cpu", ok: true, offline: false, error: null, appliedMHz: null },
      ]);
    }
  });

  it("rejects a body with neither side", async () => {
    const { app } = makeApp();
    const res = await request(app).post("/api/v1/clock-cap").send({ persistent: true });
    expect(res.status).toBe(400);
  });

  it("rejects an out-of-range cap", async () => {
    const { app } = makeApp();
    const res = await request(app).post("/api/v1/clock-cap").send({ capMHz: 99 });
    expect(res.status).toBe(400);
  });
});
