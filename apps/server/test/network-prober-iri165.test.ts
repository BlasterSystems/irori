import { createServer } from "node:http";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { SCHEMA_VERSION } from "@irori/core";
import type { AppDeps } from "../src/app.js";
import { createApp } from "../src/app.js";
import { createAgentHub, type AgentHubDeps } from "../src/hub.js";
import { createNetPeersSync } from "../src/network-service.js";
import { NETWORK_SETTINGS_DEFAULTS, type NetworkSettings, type NetworkSettingsService } from "../src/network-settings.js";
import { createRings } from "../src/rings.js";
import { createSseHub } from "../src/sse.js";
import { listen, makeFakeStore, makeSseSpy, nextMessage, opened } from "./helpers.js";

/** IRI-165 (ADR-0021): prober config in config-update, peer sync, network settings routes. */

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

async function hubWith(overrides: Partial<AgentHubDeps>, kind = "spark") {
  const fake = makeFakeStore();
  const created = await fake.store.create({ name: "spark1", kind: kind as never, role: "head", host: "spark1.local" });
  const hub = createAgentHub({
    store: fake.store,
    llmStore: fake.llmStore,
    rings: createRings(),
    sse: makeSseSpy().sse,
    getCadenceMs: () => 2000,
    serverVersion: "test",
    writeFlushMs: 30,
    ...overrides,
  } as AgentHubDeps);
  const server = createServer();
  hub.attach(server);
  const port = await listen(server);
  cleanups.push(() => {
    hub.stop();
    server.close();
    server.closeAllConnections();
  });
  return { url: `ws://127.0.0.1:${port}/agent-ws`, created };
}

async function helloConfig(url: string, token: string): Promise<Record<string, unknown>> {
  const ws = new WebSocket(url);
  await opened(ws);
  ws.send(JSON.stringify({ type: "hello", schemaVersion: SCHEMA_VERSION, agentVersion: "0.7.0", token, hostname: "spark1" }));
  const reply = nextMessage(ws);
  const config = nextMessage(ws);
  await reply;
  const out = (await config) as Record<string, unknown>;
  ws.close();
  return out;
}

describe("config-update prober fields", () => {
  it("carries the interval and expected peers", async () => {
    const { url, created } = await hubWith({
      getNetConfig: async () => ({ netProbeIntervalS: 10, netPeers: [{ iface: "enp1s0f0np0", ip: "10.100.112.1" }] }),
    });
    const config = await helloConfig(url, created.token);
    expect(config).toMatchObject({ type: "config-update", netProbeIntervalS: 10, netPeers: [{ iface: "enp1s0f0np0", ip: "10.100.112.1" }] });
  });

  it("omits the keys when the network service is not ready", async () => {
    const { url, created } = await hubWith({ getNetConfig: async () => Promise.reject(new Error("not ready")) });
    const config = await helloConfig(url, created.token);
    expect(config.type).toBe("config-update");
    expect("netPeers" in config).toBe(false);
    expect("netProbeIntervalS" in config).toBe(false);
  });

  it("never sends prober config to the NAS", async () => {
    const getNetConfig = vi.fn(async () => ({ netProbeIntervalS: 10, netPeers: [] }));
    const { url, created } = await hubWith({ getNetConfig }, "nas");
    const config = await helloConfig(url, created.token);
    expect("netPeers" in config).toBe(false);
    expect(getNetConfig).not.toHaveBeenCalled();
  });
});

describe("net peers sync", () => {
  const lane = (aNode: string, aIp: string, bNode: string, bIp: string) => ({
    a: { nodeId: aNode, iface: "p0", ip: aIp },
    b: { nodeId: bNode, iface: "p1", ip: bIp },
  });

  it("re-sends config only to online nodes whose peer set changed", async () => {
    let links = [{ lanes: [lane("A", "10.1.0.1", "B", "10.1.0.2")] }];
    const topology = async () => ({ nodes: [{ id: "A" }, { id: "B" }], links }) as never;
    const refreshConfig = vi.fn(async () => true);
    const sync = createNetPeersSync({ network: { topology }, probeIntervalS: () => 10, online: () => new Set(["A", "B", "NAS"]), refreshConfig });
    expect(await sync.configFor("A")).toEqual({ netProbeIntervalS: 10, netPeers: [{ iface: "p0", ip: "10.1.0.2" }] });
    await sync.configFor("B");
    await sync.tick();
    expect(refreshConfig).not.toHaveBeenCalled();
    links = [{ lanes: [lane("A", "10.1.0.1", "B", "10.1.0.2"), lane("A", "10.2.0.1", "B", "10.2.0.2")] }];
    await sync.tick();
    expect(refreshConfig.mock.calls.map((c) => (c as unknown[])[0])).toEqual(["A", "B"]); // never the NAS
  });
});

describe("network settings routes", () => {
  function fakeSettings(): NetworkSettingsService & { value: NetworkSettings } {
    const svc = {
      value: { ...NETWORK_SETTINGS_DEFAULTS },
      get: async () => svc.value,
      set: async (patch: Partial<NetworkSettings>) => (svc.value = { ...svc.value, ...patch }),
      cached: () => svc.value,
    };
    return svc;
  }
  const deps = (settings: NetworkSettingsService | null, onNetworkSettingsChanged = vi.fn()) =>
    ({
      getStore: () => makeFakeStore().store,
      getLlmStore: () => null,
      getHistory: () => null,
      getLlmHistory: () => null,
      dbHealthy: async () => true,
      rings: createRings(),
      sse: createSseHub({ heartbeatMs: 0 }),
      getHub: () => null,
      getJobs: () => null,
      hfQuants: { listQuants: async () => ({}) } as never,
      version: "test",
      tag: null,
      staticDir: null,
      getNetworkSettings: () => settings,
      onNetworkSettingsChanged,
    }) as unknown as AppDeps;

  it("reads defaults, applies a validated patch and notifies", async () => {
    const svc = fakeSettings();
    const changed = vi.fn();
    const app = createApp(deps(svc, changed));
    expect((await request(app).get("/api/v1/settings/network")).body).toEqual({ testsEnabled: true, liveEnabled: true, probeIntervalS: 10 });
    const put = await request(app).put("/api/v1/settings/network").send({ probeIntervalS: 0, testsEnabled: false });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ testsEnabled: false, liveEnabled: true, probeIntervalS: 0 });
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown keys and out-of-range values; 503 without a DB", async () => {
    const svc = fakeSettings();
    const app = createApp(deps(svc));
    expect((await request(app).put("/api/v1/settings/network").send({ probeIntervalS: -1 })).status).toBe(400);
    expect((await request(app).put("/api/v1/settings/network").send({ rogue: true })).status).toBe(400);
    expect((await request(createApp(deps(null))).get("/api/v1/settings/network")).status).toBe(503);
  });
});
