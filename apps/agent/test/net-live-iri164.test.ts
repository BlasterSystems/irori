import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { netLiveMsgSchema, serverMsgSchema, type NetRatesMsg } from "@irori/core";
import type { LinkFacts } from "../src/link-facts.js";
import { NetLive } from "../src/net-live.js";

/** IRI-164 (ADR-0021): the agent's leased live-rate stream. */

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function tree(rx: number, tx: number, rdmaRx: number, rdmaTx: number): { proc: string; sys: string; set: (rx: number, tx: number, rr: number, rt: number) => void } {
  const root = mkdtempSync(path.join(tmpdir(), "irori-netlive-"));
  roots.push(root);
  const proc = path.join(root, "proc");
  const sys = path.join(root, "sys");
  const set = (r: number, t: number, rr: number, rt: number) => {
    mkdirSync(path.join(proc, "net"), { recursive: true });
    writeFileSync(
      path.join(proc, "net", "dev"),
      `Inter-|   Receive\n face |bytes\nenp1s0f0np0: ${r} 0 0 0 0 0 0 0 ${t} 0 0 0 0 0 0 0\n  enP7s7: 5 0 0 0 0 0 0 0 5 0 0 0 0 0 0 0\n`,
    );
    const c = path.join(sys, "class", "infiniband", "rocep1s0f0", "ports", "1", "counters");
    mkdirSync(c, { recursive: true });
    writeFileSync(path.join(c, "port_rcv_data"), String(rr));
    writeFileSync(path.join(c, "port_xmit_data"), String(rt));
  };
  set(rx, tx, rdmaRx, rdmaTx);
  return { proc, sys, set };
}

const facts = (): ReadonlyMap<string, LinkFacts> =>
  new Map<string, LinkFacts>([
    ["enp1s0f0np0", { mac: "aa", mtu: 9000, driver: "mlx5_core", kind: "fabric", rdma: { device: "rocep1s0f0", port: 1, linkLayer: "Ethernet", state: "ACTIVE", rateGbps: 200 }, neighbors: [] }],
    ["enP7s7", { mac: "bb", mtu: 1500, driver: "r8169", kind: "lan", rdma: null, neighbors: [] }],
  ]);

describe("net-live contract", () => {
  it("enforces the 250 ms floor and a bounded duration", () => {
    expect(netLiveMsgSchema.safeParse({ type: "net-live", intervalMs: 250, durationMs: 75_000 }).success).toBe(true);
    expect(netLiveMsgSchema.safeParse({ type: "net-live", intervalMs: 0, durationMs: 0 }).success).toBe(true);
    expect(netLiveMsgSchema.safeParse({ type: "net-live", intervalMs: 100, durationMs: 75_000 }).success).toBe(false);
    expect(netLiveMsgSchema.safeParse({ type: "net-live", intervalMs: 1000, durationMs: 3_600_000 }).success).toBe(false);
    expect(serverMsgSchema.safeParse({ type: "net-live", intervalMs: 500, durationMs: 1000 }).success).toBe(true);
  });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("NetLive", () => {
  it("sends fabric-only rates per sample, RDMA in 4-byte words", async () => {
    const t = tree(0, 0, 0, 0);
    const sent: NetRatesMsg[] = [];
    const live = new NetLive({ procRoot: t.proc, sysRoot: t.sys, facts, send: (m) => (sent.push(m), true) });
    live.apply(10_000, 60_000); // long interval: the test drives ticks itself
    await sleep(30); // baseline sample, nothing sent
    expect(sent).toHaveLength(0);
    t.set(1_000_000, 2_000_000, 250_000, 500_000);
    await live.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.intervalMs).toBe(10_000);
    expect(sent[0]!.ifaces.map((i) => i.iface)).toEqual(["enp1s0f0np0"]); // no LAN
    const r = sent[0]!.ifaces[0]!;
    expect(r.rxBps).toBeGreaterThan(0);
    // 250 000 words × 4 bytes = 1 000 000 bytes, the same as the netdev delta.
    expect(r.rdmaRxBps! / r.rxBps!).toBeCloseTo(1, 1);
    expect(r.rdmaTxBps! / r.txBps!).toBeCloseTo(1, 1);
    live.stop();
  });

  it("stops on its own when the duration elapses, and on a failed send", async () => {
    const t = tree(0, 0, 0, 0);
    let now = 0;
    const live = new NetLive({ procRoot: t.proc, sysRoot: t.sys, facts, send: () => true, now: () => now });
    live.apply(10_000, 3000);
    expect(live.active).toBe(true);
    now = 3000;
    await live.tick();
    expect(live.active).toBe(false);

    now = 0;
    const failing = new NetLive({ procRoot: t.proc, sysRoot: t.sys, facts, send: () => false, now: () => now });
    failing.apply(10_000, 60_000);
    await sleep(30);
    t.set(10, 10, 10, 10);
    await failing.tick();
    expect(failing.active).toBe(false);
  });

  it("a zero frame stops; a renewal at the same rate keeps the timer", async () => {
    const t = tree(0, 0, 0, 0);
    const live = new NetLive({ procRoot: t.proc, sysRoot: t.sys, facts, send: () => true });
    live.apply(500, 60_000);
    const timer = (live as unknown as { timer: unknown }).timer;
    live.apply(500, 60_000);
    expect((live as unknown as { timer: unknown }).timer).toBe(timer);
    live.apply(0, 0);
    expect(live.active).toBe(false);
    // Defence in depth: an out-of-contract interval is clamped to the floor.
    live.apply(10, 60_000);
    expect((live as unknown as { intervalMs: number }).intervalMs).toBe(250);
    live.stop();
    await sleep(30);
  });
});
