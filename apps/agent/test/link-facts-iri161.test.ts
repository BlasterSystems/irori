import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hardwareSnapshotSchema } from "@irori/core";
import {
  classifyIface,
  counterRate,
  createLinkFactsCache,
  parseProcNetArp,
  parseRdmaRate,
  parseRdmaState,
  readLinkFacts,
  readRdmaPort,
  sampleRdmaCounters,
} from "../src/link-facts.js";
import { networkRates, rdmaPortsOf } from "../src/collector.js";

/**
 * IRI-161 (ADR-0021): link facts on a synthetic sysfs/procfs tree. The
 * netdev names, addresses and the four-netdev CX7 layout are the real DGX-1
 * ones captured from the dev hub (packages/core/test/fixtures); the
 * /sys/class/infiniband layout follows the mlx5 driver (one RoCE device and
 * port per netdev). The deployed agents report the real tree after rollout.
 */

let root: string;
let sys: string;
let proc: string;

function file(rel: string, content: string): void {
  const p = path.join(root, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
}

const CX7: Array<[string, string, string, string]> = [
  // netdev, mac, rdma device, pci
  ["enp1s0f0np0", "38:a7:46:5a:1b:6f", "rocep1s0f0", "0000:01:00.0"],
  ["enp1s0f1np1", "38:a7:46:5a:1b:70", "rocep1s0f1", "0000:01:00.1"],
  ["enP2p1s0f0np0", "38:a7:46:5a:1b:73", "roceP2p1s0f0", "0002:01:00.0"],
  ["enP2p1s0f1np1", "38:a7:46:5a:1b:74", "roceP2p1s0f1", "0002:01:00.1"],
];

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "irori-linkfacts-"));
  sys = path.join(root, "sys");
  proc = path.join(root, "proc");
  file("sys/bus/pci/drivers/mlx5_core/.keep", "");
  file("sys/bus/pci/drivers/r8169/.keep", "");
  for (const [iface, mac, dev, pci] of CX7) {
    const devDir = `sys/devices/pci/${pci}`;
    file(`${devDir}/infiniband/${dev}/.keep`, "");
    mkdirSync(path.join(root, "sys/class/net", iface), { recursive: true });
    symlinkSync(path.join(root, devDir), path.join(root, "sys/class/net", iface, "device"));
    symlinkSync(path.join(root, "sys/bus/pci/drivers/mlx5_core"), path.join(root, devDir, "driver"));
    file(`sys/class/net/${iface}/address`, `${mac}\n`);
    file(`sys/class/net/${iface}/mtu`, "9000\n");
    const port = `sys/class/infiniband/${dev}/ports/1`;
    file(`${port}/link_layer`, "Ethernet\n");
    file(`${port}/state`, "4: ACTIVE\n");
    file(`${port}/rate`, "200 Gb/sec (4X HDR)\n");
    file(`${port}/counters/port_rcv_data`, "1000\n");
    file(`${port}/counters/port_xmit_data`, "2000\n");
  }
  // Management LAN (Realtek), a docker bridge without a device, tailscale.
  file("sys/devices/pci/0007:01:00.0/.keep", "");
  mkdirSync(path.join(root, "sys/class/net/enP7s7"), { recursive: true });
  symlinkSync(path.join(root, "sys/devices/pci/0007:01:00.0"), path.join(root, "sys/class/net/enP7s7/device"));
  symlinkSync(path.join(root, "sys/bus/pci/drivers/r8169"), path.join(root, "sys/devices/pci/0007:01:00.0/driver"));
  file("sys/class/net/enP7s7/address", "4c:bb:47:00:00:01\n");
  file("sys/class/net/enP7s7/mtu", "1500\n");
  file("sys/class/net/docker0/address", "02:42:ac:11:00:01\n");
  file("sys/class/net/docker0/mtu", "1500\n");
  file("sys/class/net/tailscale0/mtu", "1280\n");
  file(
    "proc/net/arp",
    [
      "IP address       HW type     Flags       HW address            Mask     Device",
      "10.100.112.1     0x1         0x2         38:a7:46:5a:1a:74     *        enp1s0f0np0",
      "10.100.113.1     0x1         0x2         38:a7:46:5a:1a:78     *        enP2p1s0f0np0",
      "10.100.118.4     0x1         0x0         00:00:00:00:00:00     *        enp1s0f1np1",
      "10.0.10.1        0x1         0x2         aa:bb:cc:dd:ee:ff     *        enP7s7",
      "",
    ].join("\n"),
  );
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("classifyIface", () => {
  it("marks virtual names and device-less interfaces virtual", () => {
    for (const iface of ["docker0", "veth12ab", "br-326f112229eb", "virbr0", "tailscale0", "wg0", "tun0"]) {
      expect(classifyIface({ iface, hasDevice: true, driver: null, rdma: null, speedMbps: 1000 })).toBe("virtual");
    }
    expect(classifyIface({ iface: "bond0", hasDevice: false, driver: null, rdma: null, speedMbps: null })).toBe("virtual");
  });

  it("marks an RDMA-bound netdev or a fast mlx5 port as fabric, else LAN", () => {
    const rdma = { device: "rocep1s0f0", port: 1, linkLayer: "Ethernet", state: "ACTIVE", rateGbps: 200 };
    expect(classifyIface({ iface: "enp1s0f0np0", hasDevice: true, driver: "mlx5_core", rdma, speedMbps: 200_000 })).toBe("fabric");
    expect(classifyIface({ iface: "enp1s0f0np0", hasDevice: true, driver: "mlx5_core", rdma: null, speedMbps: 200_000 })).toBe("fabric");
    expect(classifyIface({ iface: "enp1s0f0np0", hasDevice: true, driver: "mlx5_core", rdma: null, speedMbps: 25_000 })).toBe("lan");
    expect(classifyIface({ iface: "enP7s7", hasDevice: true, driver: "r8169", rdma: null, speedMbps: 1000 })).toBe("lan");
    expect(classifyIface({ iface: "wlP9s9", hasDevice: true, driver: "mt7925e", rdma: null, speedMbps: null })).toBe("lan");
  });
});

describe("parsers", () => {
  it("keeps only complete, non-zero ARP entries", () => {
    const arp = parseProcNetArp(
      "IP address HW type Flags HW address Mask Device\n" +
        "10.100.112.1 0x1 0x2 38:A7:46:5A:1A:74 * enp1s0f0np0\n" +
        "10.100.118.4 0x1 0x0 00:00:00:00:00:00 * enp1s0f1np1\n" +
        "garbage\n",
    );
    expect(arp.get("enp1s0f0np0")).toEqual([{ ip: "10.100.112.1", mac: "38:a7:46:5a:1a:74" }]);
    expect(arp.has("enp1s0f1np1")).toBe(false);
  });

  it("parses rate and state strings, tolerating odd shapes", () => {
    expect(parseRdmaRate("200 Gb/sec (4X HDR)")).toBe(200);
    expect(parseRdmaRate("100 Gb/sec (2X HDR)")).toBe(100);
    expect(parseRdmaRate("invalid")).toBeNull();
    expect(parseRdmaState("4: ACTIVE")).toBe("ACTIVE");
    expect(parseRdmaState("1: DOWN")).toBe("DOWN");
    expect(parseRdmaState("ACTIVE")).toBe("ACTIVE");
  });

  it("computes counter rates and refuses a counter that went backwards", () => {
    expect(counterRate(1000, 3000, 200)).toBe(10_000);
    expect(counterRate(3000, 1000, 200)).toBeNull();
    expect(counterRate(undefined, 1000, 200)).toBeNull();
    expect(counterRate(1000, 2000, 0)).toBeNull();
  });
});

describe("readLinkFacts on a DGX Spark tree", () => {
  it("reads MAC, MTU, driver, RDMA port, kind and fabric neighbours", async () => {
    const speeds = new Map<string, number | null>([...CX7.map(([i]) => [i, 200_000] as [string, number]), ["enP7s7", 1000]]);
    const facts = await readLinkFacts(sys, proc, speeds);
    const f0 = facts.get("enp1s0f0np0")!;
    expect(f0).toEqual({
      mac: "38:a7:46:5a:1b:6f",
      mtu: 9000,
      driver: "mlx5_core",
      kind: "fabric",
      rdma: { device: "rocep1s0f0", port: 1, linkLayer: "Ethernet", state: "ACTIVE", rateGbps: 200 },
      neighbors: [{ ip: "10.100.112.1", mac: "38:a7:46:5a:1a:74" }],
    });
    expect(facts.get("enp1s0f1np1")?.neighbors).toEqual([]); // incomplete ARP entry dropped
    expect(facts.get("enP2p1s0f0np0")?.rdma?.device).toBe("roceP2p1s0f0");
    // LAN neighbours are never reported (RoCE scope only).
    expect(facts.get("enP7s7")).toMatchObject({ kind: "lan", driver: "r8169", neighbors: [], rdma: null });
    expect(facts.get("docker0")).toMatchObject({ kind: "virtual", driver: null });
    expect(facts.get("tailscale0")).toMatchObject({ kind: "virtual", mac: null });
  });

  it("returns nothing without sysfs", async () => {
    expect((await readLinkFacts(path.join(root, "missing"), proc, new Map())).size).toBe(0);
    expect(await readRdmaPort(sys, "enP7s7")).toBeNull();
  });

  it("samples RDMA byte counters in 4-byte words", async () => {
    const facts = await readLinkFacts(sys, proc, new Map());
    const counters = await sampleRdmaCounters(sys, rdmaPortsOf(facts));
    expect(counters.get("enp1s0f0np0")).toEqual({ rx: 4000, tx: 8000 });
    expect(counters.size).toBe(4);
  });

  it("caches the facts for the TTL", async () => {
    let t = 0;
    const cache = createLinkFactsCache(30_000, () => t);
    const first = await cache.get(sys, proc, new Map());
    file("sys/class/net/enp1s0f0np0/mtu", "1500\n");
    t = 29_999;
    expect((await cache.get(sys, proc, new Map())).get("enp1s0f0np0")?.mtu).toBe(9000);
    expect(cache.peek()).toBe(first);
    t = 30_000;
    expect((await cache.get(sys, proc, new Map())).get("enp1s0f0np0")?.mtu).toBe(1500);
    file("sys/class/net/enp1s0f0np0/mtu", "9000\n");
  });
});

describe("snapshot compatibility (ADR-0006)", () => {
  const base = {
    schemaVersion: 1,
    agentVersion: "0.7.0",
    hostname: "spark-1",
    transport: "ws" as const,
    timestampMs: 1,
    cpu: { model: "Grace", cores: 20, usagePct: 1, tempC: null, packagePowerW: null },
    memory: { totalBytes: 1, usedBytes: 1 },
    gpus: [],
  };

  it("a new hub parses an old agent's network entry with defaults", () => {
    const parsed = hardwareSnapshotSchema.parse({
      ...base,
      network: [{ iface: "enp1s0f0np0", rxBps: 0, txBps: 0, speedMbps: 200000, operState: "up", addrs: ["10.100.112.2"] }],
    });
    expect(parsed.network[0]).toMatchObject({ mac: null, mtu: null, kind: null, cidrs: [], rdma: null, neighbors: [], rdmaRxBps: null });
    expect(parsed.linkProbes).toBeUndefined();
  });

  it("a new agent's entry round-trips, and unknown future fields are stripped", () => {
    const net0 = new Map([["enp1s0f0np0", { rx: 0, tx: 0 }]]);
    const net1 = new Map([["enp1s0f0np0", { rx: 1000, tx: 2000 }]]);
    const facts = new Map([
      [
        "enp1s0f0np0",
        {
          mac: "38:a7:46:5a:1b:6f",
          mtu: 9000,
          driver: "mlx5_core",
          kind: "fabric" as const,
          rdma: { device: "rocep1s0f0", port: 1, linkLayer: "Ethernet", state: "ACTIVE", rateGbps: 200 },
          neighbors: [],
        },
      ],
    ]);
    const link = new Map([["enp1s0f0np0", { speedMbps: 200000, operState: "up", addrs: ["10.100.112.2"], cidrs: ["10.100.112.2/24"] }]]);
    const rdma0 = new Map([["enp1s0f0np0", { rx: 0, tx: 0 }]]);
    const rdma1 = new Map([["enp1s0f0np0", { rx: 4_000_000, tx: 8_000_000 }]]);
    const network = networkRates(net0, net1, 1000, link, facts, { rdma0, rdma1 });
    expect(network[0]).toMatchObject({ kind: "fabric", cidrs: ["10.100.112.2/24"], rdmaRxBps: 4_000_000, rdmaTxBps: 8_000_000 });
    const parsed = hardwareSnapshotSchema.parse({ ...base, network: [{ ...network[0], futureField: 1 }] });
    expect(parsed.network[0]).toEqual(network[0]);
  });
});
