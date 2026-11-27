import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { hardwareSnapshotSchema, type HardwareSnapshot, type SetupInfo } from "@irori/core";
import type { AppDeps } from "../src/app.js";
import { createApp } from "../src/app.js";
import { createNetworkService } from "../src/network-service.js";
import { createRings } from "../src/rings.js";
import { createSseHub } from "../src/sse.js";
import { makeFakeStore } from "./helpers.js";

/** IRI-162 (ADR-0021): hub topology service + GET /api/v1/network/topology. */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(path.join(here, "..", "..", "..", "packages", "core", "test", "fixtures", "network-fleet-2026-11-27.json"), "utf8"),
) as { nodes: Array<{ id: string; name: string; kind: string; host: string }>; snapshots: Record<string, unknown[]>; setups: SetupInfo[] };

function snapshotOf(network: unknown[]): HardwareSnapshot {
  return hardwareSnapshotSchema.parse({
    schemaVersion: 1,
    agentVersion: "0.7.0",
    hostname: "x",
    transport: "ws",
    timestampMs: 0,
    cpu: { model: "m", cores: 1, usagePct: null, tempC: null, packagePowerW: null },
    memory: { totalBytes: 1, usedBytes: 0 },
    gpus: [],
    network,
  });
}

function service(opts: { online?: string[]; resolve?: (h: string) => Promise<string[]> } = {}) {
  const resolved: string[] = [];
  const svc = createNetworkService({
    listNodes: async () => fixture.nodes,
    online: () => new Set(opts.online ?? fixture.nodes.map((n) => n.id)),
    latest: (id) => (fixture.snapshots[id] === undefined ? undefined : snapshotOf(fixture.snapshots[id]!)),
    listSetups: async () => fixture.setups,
    resolveHost:
      opts.resolve ??
      (async (h) => {
        resolved.push(h);
        return [`10.0.10.${h.slice(3, 4)}`];
      }),
    now: () => Date.parse("2026-11-27T12:00:00Z"),
  });
  return { svc, resolved };
}

describe("network service", () => {
  it("derives the real ring and resolves hosts once (cached)", async () => {
    const { svc, resolved } = service();
    const t = await svc.topology();
    expect(t.links).toHaveLength(4);
    expect(t.generatedAt).toBe("2026-11-27T12:00:00.000Z");
    expect(t.nodes.map((n) => n.hostOnFabric)).toEqual([false, false, false, false]);
    await svc.topology();
    // dgx1..3 are names (resolved once each); DGX-4 is an IP literal; the NAS is skipped.
    expect(resolved.sort()).toEqual(["dgx1.lan", "dgx2.lan", "dgx3.lan"]);
  });

  it("treats an unresolvable host as unknown and drops offline nodes' links", async () => {
    const dgx1 = fixture.nodes.find((n) => n.name === "DGX-1")!.id;
    const { svc } = service({
      online: fixture.nodes.filter((n) => n.id !== dgx1).map((n) => n.id),
      resolve: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    const t = await svc.topology();
    expect(t.links).toHaveLength(2); // DGX-1's two cables are gone
    expect(t.nodes.find((n) => n.id === dgx1)!.online).toBe(false);
    expect(t.nodes.find((n) => n.name === "DGX-2")!.hostOnFabric).toBeNull();
    expect(t.warnings.some((w) => w.code === "node-offline")).toBe(true);
  });
});

describe("GET /api/v1/network/topology", () => {
  const baseDeps = (getNetwork?: AppDeps["getNetwork"]) =>
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
      ...(getNetwork === undefined ? {} : { getNetwork }),
    }) as unknown as AppDeps;

  it("answers 503 while the service is unavailable", async () => {
    const res = await request(createApp(baseDeps())).get("/api/v1/network/topology");
    expect(res.status).toBe(503);
  });

  it("serves the derived topology", async () => {
    const { svc } = service();
    const res = await request(createApp(baseDeps(() => svc))).get("/api/v1/network/topology");
    expect(res.status).toBe(200);
    expect(res.body.links).toHaveLength(4);
    expect(res.body.nodes.map((n: { name: string }) => n.name)).toEqual(["DGX-1", "DGX-2", "DGX-3", "DGX-4"]);
  });
});
