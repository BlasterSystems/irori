import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { deriveTopology, fabricHostsFor, hardwareSnapshotSchema, nodeForFabricIp, type Topology } from "@irori/core";
import { nodeIdForHost, rewritePushHosts } from "../src/network-service.js";
import { createPushRemediation } from "../src/push-remediation.js";

/** IRI-167 (ADR-0021): pushes between directly cabled Sparks use the fabric. */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(path.join(here, "..", "..", "..", "packages", "core", "test", "fixtures", "network-fleet-2026-11-27.json"), "utf8"),
) as { nodes: Array<{ id: string; name: string; kind: string; host: string; online: boolean }>; snapshots: Record<string, unknown[]>; setups: never[] };

const net = (raw: unknown[]) =>
  hardwareSnapshotSchema.parse({
    schemaVersion: 1, agentVersion: "0.7.0", hostname: "x", transport: "ws", timestampMs: 0,
    cpu: { model: "m", cores: 1, usagePct: null, tempC: null, packagePowerW: null }, memory: { totalBytes: 1, usedBytes: 0 }, gpus: [], network: raw,
  }).network;

const topology: Topology = deriveTopology({
  nodes: fixture.nodes,
  network: Object.fromEntries(Object.entries(fixture.snapshots).map(([id, raw]) => [id, net(raw)])),
  setups: [],
});
const id = (name: string) => fixture.nodes.find((n) => n.name === name)!.id;
const host = (name: string) => fixture.nodes.find((n) => n.name === name)!.host;
const deps = { listNodes: async () => fixture.nodes, network: { topology: async () => ({ ...topology, generatedAt: "x" }) } };

describe("fabric push hosts", () => {
  it("lists the destination's address on both lanes of a direct cable, none for a non-adjacent pair", () => {
    expect(fabricHostsFor(topology, id("DGX-1"), id("DGX-2"))).toEqual(["10.100.112.1", "10.100.113.1"]);
    expect(fabricHostsFor(topology, id("DGX-2"), id("DGX-1"))).toEqual(["10.100.112.2", "10.100.113.2"]);
    expect(fabricHostsFor(topology, id("DGX-1"), id("DGX-3"))).toEqual([]); // ring: two hops
    expect(nodeForFabricIp(topology, "10.100.113.1")).toBe(id("DGX-2"));
    expect(nodeForFabricIp(topology, "10.0.10.5")).toBeNull();
  });

  it("rewrites a direct push to per-lane fabric hosts, keeping the cache user and the LAN hosts", async () => {
    const params = { name: "GLM-5.3", hosts: [`piresbruno@${host("DGX-2")}`], jobs: 4 };
    expect(await rewritePushHosts(deps, id("DGX-1"), params)).toEqual({
      name: "GLM-5.3",
      hosts: ["piresbruno@10.100.112.1", "piresbruno@10.100.113.1"],
      jobs: 4,
      _lanHosts: [`piresbruno@${host("DGX-2")}`],
    });
  });

  it("leaves non-adjacent, unknown, remediated and fallback pushes alone", async () => {
    const lan = { name: "m", hosts: [host("DGX-3")] };
    expect(await rewritePushHosts(deps, id("DGX-1"), lan)).toBe(lan);
    const unknown = { name: "m", hosts: ["elsewhere.lan"] };
    expect(await rewritePushHosts(deps, id("DGX-1"), unknown)).toBe(unknown);
    const already = { name: "m", hosts: ["10.100.112.1"], _lanHosts: [host("DGX-2")] };
    expect(await rewritePushHosts(deps, id("DGX-1"), already)).toBe(already);
    const fallback = { name: "m", hosts: [host("DGX-2")], _fabricFallback: true };
    expect(await rewritePushHosts(deps, id("DGX-1"), fallback)).toBe(fallback);
    const broken = { listNodes: async () => fixture.nodes, network: { topology: async () => Promise.reject(new Error("down")) } };
    const p = { name: "m", hosts: [host("DGX-2")] };
    expect(await rewritePushHosts(broken as never, id("DGX-1"), p)).toBe(p);
  });

  it("resolves registry hosts and fabric addresses to nodes", async () => {
    expect(await nodeIdForHost(deps, host("DGX-2"))).toBe(id("DGX-2"));
    expect(await nodeIdForHost(deps, "10.100.112.1")).toBe(id("DGX-2"));
    expect(await nodeIdForHost(deps, "10.9.9.9")).toBeNull();
  });
});

describe("push remediation over the fabric", () => {
  const nodes = fixture.nodes.map((n) => ({ id: n.id, host: n.host, cacheUser: "piresbruno" }));
  const resolveNodeId = (h: string) => nodeIdForHost(deps, h);

  function remediator() {
    const created: Array<{ nodeId: string; kind: string; params: Record<string, unknown> }> = [];
    const jobs = {
      create: vi.fn(async (nodeId: string, kind: string, params: Record<string, unknown>) => {
        created.push({ nodeId, kind, params });
        return { id: `${kind}-${created.length}` } as never;
      }),
      get: vi.fn(async (jobId: string) => {
        const output = jobId.startsWith("transfer-key-ensure")
          ? [{ seq: 0, line: "IRORI_TRANSFER_PUBKEY=ssh-ed25519 AAAA irori-transfer" }]
          : jobId.startsWith("transfer-key-authorize")
            ? [{ seq: 0, line: "IRORI_HOSTKEY=ssh-ed25519 BBBB root@dgx2" }]
            : [];
        return { id: jobId, status: "succeeded", output } as never;
      }),
    };
    const remediate = createPushRemediation({ jobs, getNode: async (nid) => nodes.find((n) => n.id === nid) ?? null, getNodes: async () => nodes, resolveNodeId });
    return { remediate, created };
  }

  const settle = () => new Promise((r) => setTimeout(r, 30));

  it("falls back to the LAN hosts once when the fabric is unreachable", async () => {
    const { remediate, created } = remediator();
    remediate({
      jobId: "j1",
      nodeId: id("DGX-1"),
      params: { name: "m", hosts: ["piresbruno@10.100.112.1", "piresbruno@10.100.113.1"], jobs: 4, _lanHosts: [`piresbruno@${host("DGX-2")}`] },
      output: [{ seq: 0, line: "IRORI_PREFLIGHT (piresbruno@10.100.112.1): unreachable — Connection timed out" }],
    });
    await settle();
    expect(created).toEqual([{ nodeId: id("DGX-1"), kind: "push", params: { name: "m", hosts: [`piresbruno@${host("DGX-2")}`], jobs: 4, _fabricFallback: true } }]);
  });

  it("finds the destination by fabric address and pins the host key for every lane", async () => {
    const { remediate, created } = remediator();
    remediate({
      jobId: "j2",
      nodeId: id("DGX-1"),
      params: { name: "m", hosts: ["piresbruno@10.100.112.1", "piresbruno@10.100.113.1"], jobs: 4, _lanHosts: [`piresbruno@${host("DGX-2")}`] },
      output: [
        { seq: 0, line: "IRORI_PREFLIGHT (piresbruno@10.100.112.1): destination host key not pinned — the hub wires the pair automatically" },
        { seq: 1, line: "IRORI_PREFLIGHT (piresbruno@10.100.113.1): destination host key not pinned — the hub wires the pair automatically" },
      ],
    });
    await settle();
    expect(created.map((c) => `${c.kind}@${fixture.nodes.find((n) => n.id === c.nodeId)!.name}`)).toEqual([
      "transfer-key-ensure@DGX-1",
      "transfer-key-authorize@DGX-2",
      "transfer-hostkey-pin@DGX-1",
      "transfer-hostkey-pin@DGX-1",
      "push@DGX-1",
    ]);
    expect(created.filter((c) => c.kind === "transfer-hostkey-pin").map((c) => c.params.hostKeys)).toEqual([
      ["10.100.112.1 ssh-ed25519 BBBB"],
      ["10.100.113.1 ssh-ed25519 BBBB"],
    ]);
    expect(created.at(-1)!.params).toMatchObject({ hosts: ["piresbruno@10.100.112.1", "piresbruno@10.100.113.1"], _remediated: true });
  });
});
