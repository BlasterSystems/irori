import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp, type AppDeps } from "../src/app.js";
import { createRings } from "../src/rings.js";
import { createSseHub } from "../src/sse.js";
import { broadcastForLanIp, buildMagicPacket, normalizeMac } from "../src/wol.js";
import { makeFakeStore } from "./helpers.js";

/**
 * IRI-068 (IR-159): power actions — WoL magic-packet framing, the armed
 * two-step shutdown (stale-token rejection), and the clock-cap registry
 * round-trip. Pure builders + route contract over the in-memory store fake.
 */

describe("wake-on-lan framing", () => {
  it("builds the 102-byte magic packet: 6×0xFF then the MAC ×16", () => {
    const magic = buildMagicPacket("aa:bb:cc:dd:ee:ff");
    expect(magic).toHaveLength(102);
    expect(magic.subarray(0, 6).every((b) => b === 0xff)).toBe(true);
    for (let i = 0; i < 16; i++) {
      expect([...magic.subarray(6 + i * 6, 12 + i * 6)]).toEqual([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]);
    }
  });

  it("accepts hyphen-separated MACs and rejects garbage", () => {
    expect(normalizeMac("AA-BB-CC-DD-EE-FF")).toBe("aa:bb:cc:dd:ee:ff");
    expect(normalizeMac("not-a-mac")).toBeNull();
    expect(normalizeMac(null)).toBeNull();
    expect(normalizeMac("aa:bb:cc:dd:ee")).toBeNull();
  });

  it("derives a /24 directed broadcast from the node host", () => {
    expect(broadcastForLanIp("10.0.10.4")).toBe("10.0.10.255");
    expect(broadcastForLanIp("dgx1.example.com")).toBe("255.255.255.255");
  });
});

function makeApp() {
  const fake = makeFakeStore();
  const online = new Set<string>();
  const shutdowns: Array<{ nodeId: string; graceS: number; origin: string }> = [];
  const clockCaps: Array<{ nodeId: string; capMHz: number | null; persist: boolean }> = [];
  const deps: AppDeps = {
    getStore: () => fake.store,
    getLlmStore: () => null,
    getHistory: () => null,
    getLlmHistory: () => null,
    dbHealthy: async () => true,
    rings: createRings(),
    sse: createSseHub({ heartbeatMs: 0 }),
    getHub: () => ({
      online: () => online,
      sendToNode: () => true,
      refreshConfig: async () => true,
      clocks: async () => ({ type: "clocks-get-result", id: "x", ok: true, gpus: [], error: null }),
      setClocks: async (nodeId, capMHz, persist = false) => {
        clockCaps.push({ nodeId, capMHz, persist });
        return { type: "clocks-set-result", id: "x", ok: true, error: null };
      },
      shutdownNode: async (nodeId, graceS, origin) => {
        shutdowns.push({ nodeId, graceS, origin });
        return { type: "node-shutdown-ack", id: "x", ok: true, error: null };
      },
    }),
    version: "test",
    tag: null,
    staticDir: null,
  };
  return { app: createApp(deps), fake, shutdowns, clockCaps };
}

describe("armed node shutdown (two-step)", () => {
  it("arms with a token, confirms, and dispatches with the origin", async () => {
    const { app, shutdowns } = makeApp();
    const created = await request(app).post("/api/v1/nodes").send({ name: "dgx8", kind: "spark", role: "standalone", host: "10.0.10.8" });
    const id = created.body.node.id as string;

    const arm = await request(app).post(`/api/v1/nodes/${id}/shutdown`).send({});
    expect(arm.status).toBe(200);
    expect(arm.body.armed).toBe(true);
    const token = arm.body.confirmToken as string;
    expect(token).toBeTruthy();

    const confirm = await request(app).post(`/api/v1/nodes/${id}/shutdown`).send({ confirmToken: token, origin: "test-suite" });
    expect(confirm.status).toBe(200);
    expect(confirm.body.scheduled).toBe(true);
    expect(shutdowns).toEqual([{ nodeId: id, graceS: 10, origin: "test-suite" }]);
  });

  it("rejects a stale or reused token with 409 (audited attempt)", async () => {
    const { app } = makeApp();
    const created = await request(app).post("/api/v1/nodes").send({ name: "dgx9", kind: "spark", role: "standalone", host: "10.0.10.9" });
    const id = created.body.node.id as string;

    const arm = await request(app).post(`/api/v1/nodes/${id}/shutdown`).send({});
    const token = arm.body.confirmToken as string;
    await request(app).post(`/api/v1/nodes/${id}/shutdown`).send({ confirmToken: token, origin: "first" });
    // Replay the same token — consumed, stale.
    const replay = await request(app).post(`/api/v1/nodes/${id}/shutdown`).send({ confirmToken: token, origin: "replay" });
    expect(replay.status).toBe(409);
    // Wrong token also 409s.
    const wrong = await request(app).post(`/api/v1/nodes/${id}/shutdown`).send({ confirmToken: "nope" });
    expect(wrong.status).toBe(409);
  });

  it("a re-arm produces a fresh token and invalidates the old one", async () => {
    const { app } = makeApp();
    const created = await request(app).post("/api/v1/nodes").send({ name: "dgx7", kind: "spark", role: "standalone", host: "10.0.10.7" });
    const id = created.body.node.id as string;
    const arm1 = await request(app).post(`/api/v1/nodes/${id}/shutdown`).send({});
    const arm2 = await request(app).post(`/api/v1/nodes/${id}/shutdown`).send({});
    const stale = await request(app).post(`/api/v1/nodes/${id}/shutdown`).send({ confirmToken: arm1.body.confirmToken });
    expect(stale.status).toBe(409);
    const ok = await request(app).post(`/api/v1/nodes/${id}/shutdown`).send({ confirmToken: arm2.body.confirmToken });
    expect(ok.status).toBe(200);
  });
});

describe("clock-cap registry round-trip", () => {
  it("dispatches the cap with persistence and stores it on the node", async () => {
    const { app, fake, clockCaps } = makeApp();
    const created = await request(app).post("/api/v1/nodes").send({ name: "dgx6", kind: "spark", role: "standalone", host: "10.0.10.6" });
    const id = created.body.node.id as string;

    const res = await request(app).put(`/api/v1/nodes/${id}/clock-cap`).send({ capMHz: 1500, persistent: true });
    expect(res.status).toBe(200);
    expect(clockCaps).toEqual([{ nodeId: id, capMHz: 1500, persist: true }]);
    const row = await fake.store.get(id);
    expect(row?.gpuClockCapMHz).toBe(1500);
    expect(row?.gpuClockCapPersistent).toBe(true);
  });

  it("clears the cap and refuses a persistent clear", async () => {
    const { app, fake } = makeApp();
    const created = await request(app).post("/api/v1/nodes").send({ name: "dgx5", kind: "spark", role: "standalone", host: "10.0.10.5" });
    const id = created.body.node.id as string;

    const bad = await request(app).put(`/api/v1/nodes/${id}/clock-cap`).send({ capMHz: null, persistent: true });
    expect(bad.status).toBe(400);

    await request(app).put(`/api/v1/nodes/${id}/clock-cap`).send({ capMHz: 1500, persistent: false });
    const clear = await request(app).put(`/api/v1/nodes/${id}/clock-cap`).send({ capMHz: null });
    expect(clear.status).toBe(200);
    const row = await fake.store.get(id);
    expect(row?.gpuClockCapMHz).toBeNull();
  });

  it("rejects non-integer caps", async () => {
    const { app } = makeApp();
    const created = await request(app).post("/api/v1/nodes").send({ name: "dgx4", kind: "spark", role: "standalone", host: "10.0.10.4" });
    const id = created.body.node.id as string;
    const res = await request(app).put(`/api/v1/nodes/${id}/clock-cap`).send({ capMHz: "fast" });
    expect(res.status).toBe(400);
  });
});
