// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { deriveTopology, hardwareSnapshotSchema, type NetworkEntry, type TopologyLink } from "@irori/core";
import { liveMock } from "./live-mock";
import { diagramLayout, fmtBits, linkFormat, linkLatency, ringOrder, utilPct } from "../src/network";

/** IRI-163 (ADR-0021): Overview Network card helpers and render. */

vi.mock("../src/live", async () => ({ live: (await import("./live-mock")).liveMock }));

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(path.join(here, "..", "..", "..", "packages", "core", "test", "fixtures", "network-fleet-2026-11-27.json"), "utf8"),
) as { nodes: Array<{ id: string; name: string; kind: string; host: string; online: boolean }>; snapshots: Record<string, unknown[]>; setups: never[] };

function parseNet(raw: unknown[]): NetworkEntry[] {
  return hardwareSnapshotSchema.parse({
    schemaVersion: 1, agentVersion: "0.7.0", hostname: "x", transport: "ws", timestampMs: 0,
    cpu: { model: "m", cores: 1, usagePct: null, tempC: null, packagePowerW: null },
    memory: { totalBytes: 1, usedBytes: 0 }, gpus: [], network: raw,
  }).network;
}

const realTopology = () =>
  deriveTopology({
    nodes: fixture.nodes,
    network: Object.fromEntries(Object.entries(fixture.snapshots).map(([id, raw]) => [id, parseNet(raw)])),
    setups: fixture.setups,
  });

afterEach(() => {
  vi.unstubAllGlobals();
  liveMock.snapshots.clear();
});

describe("network helpers", () => {
  it("orders the real ring in cable order, so no edge crosses", () => {
    const t = realTopology();
    const order = ringOrder(t.nodes, t.links).map((id) => t.nodes.find((n) => n.id === id)!.name);
    expect(order).toEqual(["DGX-1", "DGX-2", "DGX-3", "DGX-4"]);
    const lay = diagramLayout(ringOrder(t.nodes, t.links));
    expect(lay.pos.size).toBe(4);
    // A ring of four sits as a square: two distinct xs and two distinct ys.
    expect(new Set([...lay.pos.values()].map((p) => p.x)).size).toBe(2);
    expect(new Set([...lay.pos.values()].map((p) => p.y)).size).toBe(2);
  });

  it("formats a link's medium, lanes and MTU, flagging a mismatch", () => {
    const base = realTopology().links[0]!;
    expect(linkFormat(base)).toBe("Fabric · 200G ×2");
    const roce: TopologyLink = {
      ...base,
      medium: "roce",
      lanes: base.lanes.map((l, i) => ({ ...l, a: { ...l.a, mtu: 9000 }, b: { ...l.b, mtu: i === 0 ? 1500 : 9000 } })),
    };
    expect(linkFormat(roce)).toBe("RoCE v2 · 200G ×2 · MTU 9000 ≠ 1500");
  });

  it("formats bit rates and utilisation", () => {
    expect(fmtBits(null)).toBe("—");
    expect(fmtBits(2_300_000_000)).toBe("18.4 Gb/s");
    expect(fmtBits(125_000)).toBe("1.0 Mb/s");
    expect(utilPct({ txBps: 2_500_000_000, rxBps: 0 }, 200_000)).toBe(10);
    expect(utilPct({ txBps: null, rxBps: null }, 200_000)).toBeNull();
    expect(utilPct({ txBps: 1, rxBps: 1 }, null)).toBeNull();
  });

  it("takes the worst up lane's latency", () => {
    const link = realTopology().links[0]!;
    expect(linkLatency(link)).toEqual({ rttMs: null, lossPct: null, at: null });
    const probed = {
      ...link,
      lanes: [
        { ...link.lanes[0]!, probe: { rttAvgMs: 0.03, rttMaxMs: 0.05, lossPct: 0, at: 10 } },
        { ...link.lanes[1]!, probe: { rttAvgMs: 0.05, rttMaxMs: 0.07, lossPct: 20, at: 8 } },
      ],
    };
    expect(linkLatency(probed)).toEqual({ rttMs: 0.05, lossPct: 20, at: 8 });
  });
});

describe("NetworkCard", () => {
  it("renders the ring's links with live rates from the SSE snapshot", async () => {
    const t = realTopology();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...t, generatedAt: "2026-11-27T00:00:00Z" }), { status: 200 })));
    const d1 = fixture.nodes.find((n) => n.name === "DGX-1")!.id;
    const net = parseNet(fixture.snapshots[d1]!).map((e) => (e.iface === "enp1s0f0np0" ? { ...e, txBps: 1_250_000_000, rxBps: 125_000_000 } : e));
    liveMock.snapshots.set(d1, { network: net });
    const { default: NetworkCard } = await import("../src/components/NetworkCard.vue");
    const w = mount(NetworkCard as never);
    await new Promise((r) => setTimeout(r, 20));
    const text = w.text();
    expect(text).toContain("DGX-1 ↔ DGX-2");
    expect(text).toContain("DGX-3 ↔ DGX-4");
    expect(text).toContain("↑ 10.0 Gb/s ↓ 1.0 Gb/s");
    expect(text).toContain("2/2 lanes up");
    expect(w.findAll(".nettile")).toHaveLength(4);
    expect(text).not.toContain("NAS");
    w.unmount();
  });

  it("shows the empty state for a fleet without fabric links", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ nodes: [], links: [], switches: [], clusters: [], warnings: [], generatedAt: "x" }), { status: 200 })));
    const { default: NetworkCard } = await import("../src/components/NetworkCard.vue");
    const w = mount(NetworkCard as never);
    await new Promise((r) => setTimeout(r, 20));
    expect(w.text()).toContain("No RoCE fabric links detected between Sparks.");
    w.unmount();
  });

  it("reports a malformed payload instead of crashing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const { default: NetworkCard } = await import("../src/components/NetworkCard.vue");
    const w = mount(NetworkCard as never);
    await new Promise((r) => setTimeout(r, 20));
    expect(w.text()).toContain("Topology unavailable: malformed topology payload");
    w.unmount();
  });
});
