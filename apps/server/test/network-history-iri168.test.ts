import request from "supertest";
import { describe, expect, it } from "vitest";
import { hardwareSnapshotSchema, type HardwareSnapshot, type Topology } from "@irori/core";
import type { AppDeps } from "../src/app.js";
import { createApp } from "../src/app.js";
import { createLinkHistory, type LinkHistoryStore, type LinkMinuteRow } from "../src/network-history.js";
import { createRings } from "../src/rings.js";
import { createSseHub } from "../src/sse.js";
import { makeFakeStore } from "./helpers.js";

/** IRI-168 (ADR-0021): per-link minute history — folding, flush, route. */

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const LINK = `${A}|${B}`;

const ep = (nodeId: string, iface: string, ip: string) => ({ nodeId, iface, ip, mac: null, mtu: 9000, speedMbps: 200_000, operState: "up", rdma: null });
let probe: { rttAvgMs: number; rttMaxMs: number; lossPct: number; at: number } | null = { rttAvgMs: 0.03, rttMaxMs: 0.05, lossPct: 0, at: 1 };
const topology = (): Topology => ({
  nodes: [],
  switches: [],
  clusters: [],
  warnings: [],
  links: [{ id: LINK, a: A, b: B, medium: "roce", speedMbps: 200_000, lanesUp: 1, lanes: [{ a: ep(A, "p0", "10.1.0.1"), b: ep(B, "p1", "10.1.0.2"), subnet: "10.1.0.0/24", evidence: "subnet", up: true, probe }] }],
});

function snap(txBps: number, rxBps: number): HardwareSnapshot {
  return hardwareSnapshotSchema.parse({
    schemaVersion: 1, agentVersion: "x", hostname: "x", transport: "ws", timestampMs: 0,
    cpu: { model: "m", cores: 1, usagePct: null, tempC: null, packagePowerW: null }, memory: { totalBytes: 1, usedBytes: 0 }, gpus: [],
    network: [{ iface: "p0", rxBps, txBps, speedMbps: 200000, operState: "up", addrs: [] }],
  });
}

describe("link history", () => {
  it("folds 10 s samples into one row per minute and writes it on rollover", async () => {
    const written: LinkMinuteRow[][] = [];
    const store: LinkHistoryStore = { write: async (rows) => void written.push(rows), query: async () => [], prune: async () => 0 };
    let t = Date.parse("2026-11-27T12:00:05Z");
    let current = snap(1000, 100);
    const h = createLinkHistory({ store, topology: async () => topology(), latest: (id) => (id === A ? current : undefined), now: () => t });
    await h.sample();
    t += 10_000;
    current = snap(3000, 300);
    probe = { rttAvgMs: 0.05, rttMaxMs: 0.06, lossPct: 20, at: 2 };
    await h.sample();
    expect(written).toEqual([]);
    t = Date.parse("2026-11-27T12:01:01Z");
    await h.sample();
    expect(written).toHaveLength(1);
    expect(written[0]).toEqual([
      {
        linkId: LINK,
        aNodeId: A,
        bNodeId: B,
        bucketStart: new Date("2026-11-27T12:00:00Z"),
        txBpsAvg: 2000,
        rxBpsAvg: 200,
        txBpsMax: 3000,
        rxBpsMax: 300,
        rttMsAvg: 0.04,
        lossPctAvg: 10,
        samples: 2,
      },
    ]);
  });

  it("keeps sampling when a write fails", async () => {
    const store: LinkHistoryStore = { write: async () => Promise.reject(new Error("db down")), query: async () => [], prune: async () => 0 };
    let t = 0;
    const h = createLinkHistory({ store, topology: async () => topology(), latest: () => snap(1, 1), now: () => t });
    await h.sample();
    t = 61_000;
    await expect(h.sample()).resolves.toBeUndefined();
  });
});

describe("GET /api/v1/network/links/:id/history", () => {
  const deps = (history: unknown) =>
    ({
      getStore: () => makeFakeStore().store, getLlmStore: () => null, getHistory: () => null, getLlmHistory: () => null,
      dbHealthy: async () => true, rings: createRings(), sse: createSseHub({ heartbeatMs: 0 }), getHub: () => null, getJobs: () => null,
      hfQuants: { listQuants: async () => ({}) } as never, version: "test", tag: null, staticDir: null,
      getLinkHistory: () => history,
    }) as unknown as AppDeps;

  it("validates the link id and range, then serves the points", async () => {
    const calls: Array<[string, string]> = [];
    const history = { query: async (id: string, range: string) => (calls.push([id, range]), [{ t: "x", txBps: 1, rxBps: 2, txMaxBps: 3, rxMaxBps: 4, rttMs: null, lossPct: null }]) };
    const app = createApp(deps(history));
    const ok = await request(app).get(`/api/v1/network/links/${encodeURIComponent(LINK)}/history?range=7d`);
    expect(ok.status).toBe(200);
    expect(ok.body.points).toHaveLength(1);
    expect(calls).toEqual([[LINK, "7d"]]);
    expect((await request(app).get(`/api/v1/network/links/${encodeURIComponent(LINK)}/history?range=1y`)).status).toBe(400);
    expect((await request(app).get(`/api/v1/network/links/${encodeURIComponent("x' OR 1=1")}/history`)).status).toBe(400);
    expect((await request(createApp(deps(null))).get(`/api/v1/network/links/${encodeURIComponent(LINK)}/history`)).status).toBe(503);
  });
});
