import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  deriveTopology,
  hardwareSnapshotSchema,
  ipv4InSubnet,
  linkRates,
  parseIpv4Cidr,
  type NetworkEntry,
  type TopologyInput,
} from "../src/index.js";

/**
 * IRI-162 (ADR-0021): topology derivation. The "real ring" cases run on the
 * dev hub capture of 2026-11-27 (agent 0.7.0 — no kind/cidrs/mac yet, so the
 * old-agent inference path); the synthetic cases use new-agent entries.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.join(here, "fixtures", "network-fleet-2026-11-27.json"), "utf8")) as {
  nodes: TopologyInput["nodes"];
  snapshots: Record<string, unknown[]>;
  setups: TopologyInput["setups"];
};

/** Parse raw entries through the schema so defaults apply exactly as on the hub. */
function parseNet(raw: unknown[]): NetworkEntry[] {
  return hardwareSnapshotSchema.parse({
    schemaVersion: 1,
    agentVersion: "0.7.0",
    hostname: "x",
    transport: "ws",
    timestampMs: 0,
    cpu: { model: "m", cores: 1, usagePct: null, tempC: null, packagePowerW: null },
    memory: { totalBytes: 1, usedBytes: 0 },
    gpus: [],
    network: raw,
  }).network;
}

const realInput = (): TopologyInput => ({
  nodes: fixture.nodes,
  network: Object.fromEntries(Object.entries(fixture.snapshots).map(([id, raw]) => [id, parseNet(raw)])),
  setups: fixture.setups,
});

const id = (name: string): string => fixture.nodes.find((n) => n.name === name)!.id;

/** A new-agent fabric entry. */
function fab(iface: string, mac: string, cidr: string, extra: Partial<NetworkEntry> = {}): NetworkEntry {
  return {
    iface,
    rxBps: 0,
    txBps: 0,
    speedMbps: 200_000,
    operState: "up",
    addrs: [cidr.split("/")[0]!],
    mac,
    mtu: 9000,
    driver: "mlx5_core",
    kind: "fabric",
    cidrs: [cidr],
    rdma: { device: `roce-${iface}`, port: 1, linkLayer: "Ethernet", state: "ACTIVE", rateGbps: 200 },
    neighbors: [],
    rdmaRxBps: null,
    rdmaTxBps: null,
    ...extra,
  };
}

const N = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const node = (n: number, extra: Partial<TopologyInput["nodes"][number]> = {}) => ({ id: N(n), name: `S${n}`, kind: "spark", host: `s${n}.lan`, online: true, ...extra });

describe("deriveTopology on the real fleet capture (four-node ring)", () => {
  it("finds the four cables, two lanes each, and excludes the NAS", () => {
    const t = deriveTopology(realInput());
    expect(t.nodes.map((n) => n.name)).toEqual(["DGX-1", "DGX-2", "DGX-3", "DGX-4"]);
    const pairs = t.links.map((l) => [t.nodes.find((n) => n.id === l.a)!.name, t.nodes.find((n) => n.id === l.b)!.name].sort().join("–")).sort();
    expect(pairs).toEqual(["DGX-1–DGX-2", "DGX-1–DGX-4", "DGX-2–DGX-3", "DGX-3–DGX-4"]);
    for (const l of t.links) {
      expect(l.lanes).toHaveLength(2);
      expect(l.lanesUp).toBe(2);
      expect(l.speedMbps).toBe(200_000);
      // 0.7.0 agents report no kind/rdma: the medium is honestly unknown.
      expect(l.medium).toBe("unknown");
      expect(l.lanes.every((x) => x.evidence === "subnet")).toBe(true);
    }
    const d12 = t.links.find((l) => [l.a, l.b].sort().join() === [id("DGX-1"), id("DGX-2")].sort().join())!;
    expect(d12.lanes.map((x) => x.subnet).sort()).toEqual(["10.100.112.0/24", "10.100.113.0/24"]);
    expect(t.switches).toEqual([]);
  });

  it("checks the running TP4 cluster: DGX-3 reaches the head through DGX-2 or DGX-4", () => {
    const t = deriveTopology(realInput());
    const tp4 = t.clusters.find((c) => c.name === "GLM-5.3-Flash-EXL3-TP4")!;
    expect(tp4.running).toBe(true);
    expect(tp4.fabricPath).toBe(true);
    expect(t.warnings.filter((w) => w.code === "cluster-no-path")).toEqual([]);
    expect(t.nodes.find((n) => n.name === "DGX-1")!.role).toBe("head");
    expect(t.nodes.find((n) => n.name === "DGX-4")!.role).toBe("worker");
  });

  it("flags that every registry host is on the management LAN", () => {
    const t = deriveTopology({ ...realInput(), nodes: fixture.nodes.map((n) => ({ ...n, hostAddrs: [`10.0.10.${n.name.slice(-1)}`] })) });
    expect(t.nodes.every((n) => n.hostOnFabric === false)).toBe(true);
    const w = t.warnings.find((x) => x.code === "push-not-on-fabric")!;
    expect(w.severity).toBe("info");
    expect(w.nodeIds).toHaveLength(4);
    // Unresolved names stay unknown (no guess); DGX-4 is registered by IP literal.
    const unresolved = deriveTopology(realInput());
    expect(unresolved.warnings.find((x) => x.code === "push-not-on-fabric")!.nodeIds).toEqual([id("DGX-4")]);
    expect(unresolved.nodes.find((n) => n.name === "DGX-1")!.hostOnFabric).toBeNull();
  });

  it("ignores virtual and LAN interfaces (tailscale, docker, the 1 GbE port)", () => {
    const t = deriveTopology(realInput());
    expect(t.nodes.every((n) => n.fabricIfaces === 4)).toBe(true);
  });
});

describe("deriveTopology on synthetic layouts", () => {
  it("direct pair with neighbours on both sides is confirmed RoCE", () => {
    const t = deriveTopology({
      nodes: [node(1), node(2)],
      network: {
        [N(1)]: [fab("p0", "aa:00:00:00:00:01", "10.1.0.1/24", { neighbors: [{ ip: "10.1.0.2", mac: "aa:00:00:00:00:02" }] })],
        [N(2)]: [fab("p0", "aa:00:00:00:00:02", "10.1.0.2/24", { neighbors: [{ ip: "10.1.0.1", mac: "aa:00:00:00:00:01" }] })],
      },
      setups: [],
    });
    expect(t.links).toHaveLength(1);
    expect(t.links[0]).toMatchObject({ id: `${N(1)}|${N(2)}`, medium: "roce", lanesUp: 1 });
    expect(t.links[0]!.lanes[0]).toMatchObject({ evidence: "confirmed", subnet: "10.1.0.0/24" });
    expect(t.links[0]!.lanes[0]!.a.ip).toBe("10.1.0.1");
  });

  it("one-sided neighbour evidence, and a neighbour-only lane without a shared subnet", () => {
    const t = deriveTopology({
      nodes: [node(1), node(2)],
      network: {
        [N(1)]: [fab("p0", "aa:00:00:00:00:01", "10.1.0.1/24", { neighbors: [{ ip: "x", mac: "aa:00:00:00:00:02" }] })],
        [N(2)]: [fab("p0", "aa:00:00:00:00:02", "10.9.0.2/24")],
      },
      setups: [],
    });
    expect(t.links[0]!.lanes[0]!.evidence).toBe("neighbor");
    expect(t.links[0]!.lanes[0]!.subnet).toBeNull();
  });

  it("missing neighbours still yield probable lanes from the subnet", () => {
    const t = deriveTopology({
      nodes: [node(1), node(2)],
      network: { [N(1)]: [fab("p0", "aa:01", "10.1.0.1/30")], [N(2)]: [fab("p0", "aa:02", "10.1.0.2/30")] },
      setups: [],
    });
    expect(t.links[0]!.lanes[0]!.evidence).toBe("subnet");
  });

  it("a subnet shared by three nodes becomes a switch, not three links", () => {
    const t = deriveTopology({
      nodes: [node(1), node(2), node(3)],
      network: {
        [N(1)]: [fab("p0", "aa:01", "10.2.0.1/24")],
        [N(2)]: [fab("p0", "aa:02", "10.2.0.2/24")],
        [N(3)]: [fab("p0", "aa:03", "10.2.0.3/24", { neighbors: [{ ip: "10.2.0.1", mac: "aa:01" }] })],
      },
      setups: [{ id: "c", name: "C", kind: "cluster", headNodeId: N(1), nodes: [{ nodeId: N(3) }], status: "stopped" }],
    });
    expect(t.links).toEqual([]);
    expect(t.switches).toHaveLength(1);
    expect(t.switches[0]!.members.map((m) => m.nodeId)).toEqual([N(1), N(2), N(3)]);
    // Paths through a switch count for the cluster overlay.
    expect(t.clusters[0]!.fabricPath).toBe(true);
  });

  it("an offline node contributes no links and a cluster worker without a path is flagged", () => {
    const t = deriveTopology({
      nodes: [node(1), node(2), node(3, { online: false })],
      network: {
        [N(1)]: [fab("p0", "aa:01", "10.1.0.1/24"), fab("p1", "aa:11", "10.3.0.1/24")],
        [N(2)]: [fab("p0", "aa:02", "10.4.0.2/24")],
        [N(3)]: [fab("p0", "aa:03", "10.3.0.3/24")],
      },
      setups: [{ id: "c", name: "TP2", kind: "cluster", headNodeId: N(1), nodes: [{ nodeId: N(2) }, { nodeId: N(3) }], status: "running" }],
    });
    expect(t.links).toEqual([]);
    expect(t.warnings.map((w) => w.code).sort()).toEqual(["cluster-no-path", "node-offline"]);
    expect(t.warnings.find((w) => w.code === "cluster-no-path")!.message).toBe("S2 has no RoCE path to S1, the head of TP2.");
    expect(t.clusters[0]!.fabricPath).toBe(false);
  });

  it("warns on MTU and speed mismatches and down lanes, and a down lane breaks the path", () => {
    const t = deriveTopology({
      nodes: [node(1), node(2)],
      network: {
        [N(1)]: [fab("p0", "aa:01", "10.1.0.1/24"), fab("p1", "aa:11", "10.5.0.1/24", { operState: "down" })],
        [N(2)]: [fab("p0", "aa:02", "10.1.0.2/24", { mtu: 1500, speedMbps: 100_000 }), fab("p1", "aa:12", "10.5.0.2/24")],
      },
      setups: [{ id: "c", name: "C", kind: "cluster", headNodeId: N(1), nodes: [{ nodeId: N(2) }], status: "stopped" }],
    });
    const codes = t.warnings.map((w) => w.code).sort();
    expect(codes).toEqual(["lane-down", "mtu-mismatch", "speed-mismatch"]);
    expect(t.warnings.find((w) => w.code === "mtu-mismatch")!.message).toBe("S1 p0 is MTU 9000 and S2 p0 is MTU 1500.");
    expect(t.links[0]!.lanesUp).toBe(1);
    expect(t.links[0]!.speedMbps).toBe(200_000);
    expect(t.clusters[0]!.fabricPath).toBe(true); // p0 is still up
  });

  it("an Ethernet-only fabric port (no RDMA device) is reported as Ethernet", () => {
    const t = deriveTopology({
      nodes: [node(1), node(2)],
      network: { [N(1)]: [fab("p0", "aa:01", "10.1.0.1/24", { rdma: null })], [N(2)]: [fab("p0", "aa:02", "10.1.0.2/24")] },
      setups: [],
    });
    expect(t.links[0]!.medium).toBe("ethernet");
  });

  it("attaches prober results to lanes from either side", () => {
    const t = deriveTopology({
      nodes: [node(1), node(2)],
      network: { [N(1)]: [fab("p0", "aa:01", "10.1.0.1/24")], [N(2)]: [fab("p0", "aa:02", "10.1.0.2/24")] },
      probes: { [N(2)]: [{ iface: "p0", peerIp: "10.1.0.1", rttMinMs: 0.02, rttAvgMs: 0.03, rttMaxMs: 0.05, mdevMs: 0.01, lossPct: 0, at: 5 }] },
      setups: [],
    });
    expect(t.links[0]!.lanes[0]!.probe).toEqual({ rttAvgMs: 0.03, rttMaxMs: 0.05, lossPct: 0, at: 5 });
  });

  it("is empty for a fleet without fabric interfaces", () => {
    const t = deriveTopology({ nodes: [node(1)], network: { [N(1)]: [] }, setups: [] });
    expect(t).toMatchObject({ links: [], switches: [], warnings: [] });
    expect(t.nodes[0]!.hostOnFabric).toBeNull();
  });
});

describe("helpers", () => {
  it("parses CIDRs and subnet membership", () => {
    expect(parseIpv4Cidr("10.100.112.2/24")).toEqual({ ip: "10.100.112.2", prefix: 24, subnet: "10.100.112.0/24" });
    expect(parseIpv4Cidr("fe80::1/64")).toBeNull();
    expect(parseIpv4Cidr("10.0.0.1/33")).toBeNull();
    expect(ipv4InSubnet("10.100.112.1", "10.100.112.0/24")).toBe(true);
    expect(ipv4InSubnet("10.100.113.1", "10.100.112.0/24")).toBe(false);
  });

  it("sums lane rates from node a's side, taking the larger of RDMA and netdev", () => {
    const lanes = [{ a: { iface: "p0" } }, { a: { iface: "p1" } }] as never;
    const rates = linkRates({ lanes }, [
      fab("p0", "aa", "10.1.0.1/24", { txBps: 100, rxBps: 50, rdmaTxBps: 1000, rdmaRxBps: null }),
      fab("p1", "bb", "10.2.0.1/24", { txBps: 10, rxBps: 5 }),
    ]);
    expect(rates).toEqual({ txBps: 1010, rxBps: 55 });
    expect(linkRates({ lanes }, undefined)).toEqual({ txBps: null, rxBps: null });
  });
});
