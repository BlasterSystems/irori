import { describe, expect, it, vi } from "vitest";
import { configUpdateMsgSchema } from "@irori/core";
import type { LinkFacts } from "../src/link-facts.js";
import { LinkProber, MAX_PEERS, parsePingSummary, probeTargets } from "../src/link-prober.js";

/** IRI-165 (ADR-0021): fabric latency prober with injected ping output. */

const OK = [
  "PING 10.100.112.1 (10.100.112.1) from 10.100.112.2 enp1s0f0np0: 56(84) bytes of data.",
  "",
  "--- 10.100.112.1 ping statistics ---",
  "5 packets transmitted, 5 received, 0% packet loss, time 811ms",
  "rtt min/avg/max/mdev = 0.031/0.040/0.052/0.007 ms",
].join("\n");
const LOST = "--- 10.100.118.4 ping statistics ---\n5 packets transmitted, 0 received, +5 errors, 100% packet loss, time 4090ms\n";
const PARTIAL = "5 packets transmitted, 3 received, 40% packet loss, time 800ms\nrtt min/avg/max/mdev = 0.030/0.045/0.070/0.010 ms\n";

const fabric = (neighbors: Array<{ ip: string; mac: string }> = []): LinkFacts => ({
  mac: "aa:bb:cc:dd:ee:ff",
  mtu: 9000,
  driver: "mlx5_core",
  kind: "fabric",
  rdma: null,
  neighbors,
});

describe("parsePingSummary", () => {
  it("parses counts, loss and rtt", () => {
    expect(parsePingSummary(OK)).toEqual({ transmitted: 5, received: 5, lossPct: 0, rttMinMs: 0.031, rttAvgMs: 0.04, rttMaxMs: 0.052, mdevMs: 0.007 });
    expect(parsePingSummary(PARTIAL)).toMatchObject({ received: 3, lossPct: 40, rttAvgMs: 0.045 });
  });

  it("reports 100 % loss without an rtt line, and null for garbage", () => {
    expect(parsePingSummary(LOST)).toMatchObject({ received: 0, lossPct: 100, rttAvgMs: null });
    expect(parsePingSummary("ping: SO_BINDTODEVICE: Operation not permitted")).toBeNull();
    expect(parsePingSummary("")).toBeNull();
  });
});

describe("probeTargets", () => {
  it("takes hub peers then fabric neighbours, deduped, never LAN or invalid input", () => {
    const facts = new Map<string, LinkFacts>([
      ["enp1s0f0np0", fabric([{ ip: "10.100.112.1", mac: "x" }])],
      ["enP7s7", { ...fabric([{ ip: "10.0.10.1", mac: "y" }]), kind: "lan" }],
    ]);
    const targets = probeTargets(facts, [
      { iface: "enp1s0f0np0", ip: "10.100.112.1" },
      { iface: "enP7s7", ip: "10.0.10.1" }, // LAN: refused
      { iface: "enp1s0f0np0; rm -rf /", ip: "10.100.112.9" }, // invalid iface
      { iface: "enp1s0f0np0", ip: "10.100.112.1 -f" }, // invalid ip
      { iface: "enp1s0f0np0", ip: "999.1.1.1" },
    ]);
    expect(targets).toEqual([{ iface: "enp1s0f0np0", ip: "10.100.112.1" }]);
  });

  it("caps the peer count", () => {
    const peers = Array.from({ length: 40 }, (_, i) => ({ iface: "p0", ip: `10.1.0.${i + 1}` }));
    expect(probeTargets(new Map([["p0", fabric()]]), peers)).toHaveLength(MAX_PEERS);
  });
});

describe("LinkProber", () => {
  it("probes every target and reports an unreachable peer as 100 % loss", async () => {
    const ping = vi.fn(async (_iface: string, ip: string) => {
      if (ip === "10.100.118.4") return LOST;
      if (ip === "10.100.119.4") throw new Error("spawn ping ENOENT");
      return OK;
    });
    const prober = new LinkProber({ facts: () => new Map([["p0", fabric()], ["p1", fabric()]]), ping, now: () => 42 });
    prober.configure(10, [
      { iface: "p0", ip: "10.100.112.1" },
      { iface: "p1", ip: "10.100.118.4" },
      { iface: "p1", ip: "10.100.119.4" },
    ]);
    await prober.tick();
    expect(ping).toHaveBeenCalledTimes(3);
    const byIp = new Map(prober.results().map((r) => [r.peerIp, r]));
    expect(byIp.get("10.100.112.1")).toEqual({ iface: "p0", peerIp: "10.100.112.1", rttMinMs: 0.031, rttAvgMs: 0.04, rttMaxMs: 0.052, mdevMs: 0.007, lossPct: 0, at: 42 });
    expect(byIp.get("10.100.118.4")).toMatchObject({ lossPct: 100, rttAvgMs: null });
    expect(byIp.get("10.100.119.4")).toMatchObject({ lossPct: 100 });
  });

  it("drops results for peers that are no longer targeted", async () => {
    const prober = new LinkProber({ facts: () => new Map([["p0", fabric()]]), ping: async () => OK });
    prober.configure(10, [{ iface: "p0", ip: "10.1.0.2" }]);
    await prober.tick();
    prober.configure(undefined, [{ iface: "p0", ip: "10.1.0.3" }]);
    await prober.tick();
    expect(prober.results().map((r) => r.peerIp)).toEqual(["10.1.0.3"]);
  });

  it("interval 0 disables probing and clears results", async () => {
    vi.useFakeTimers();
    try {
      const ping = vi.fn(async () => OK);
      const prober = new LinkProber({ facts: () => new Map([["p0", fabric()]]), ping });
      prober.configure(10, [{ iface: "p0", ip: "10.1.0.2" }]);
      prober.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(ping).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(ping).toHaveBeenCalledTimes(2);
      prober.configure(0, undefined);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(ping).toHaveBeenCalledTimes(2);
      expect(prober.results()).toEqual([]);
      prober.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("config-update contract", () => {
  it("accepts the prober fields, and old frames without them", () => {
    const base = { type: "config-update", cadenceMs: 2000 };
    expect(configUpdateMsgSchema.parse(base).netPeers).toBeUndefined();
    const parsed = configUpdateMsgSchema.parse({ ...base, netProbeIntervalS: 10, netPeers: [{ iface: "enp1s0f0np0", ip: "10.100.112.1" }] });
    expect(parsed.netPeers).toEqual([{ iface: "enp1s0f0np0", ip: "10.100.112.1" }]);
    expect(configUpdateMsgSchema.safeParse({ ...base, netPeers: [{ iface: "x; reboot", ip: "10.1.1.1" }] }).success).toBe(false);
  });
});
