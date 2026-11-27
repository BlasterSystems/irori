// @vitest-environment happy-dom
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { deriveTopology, hardwareSnapshotSchema, type NetworkEntry, type TopologyLink } from "@irori/core";
import { liveMock } from "./live-mock";
import {
  arrowFor,
  diagramLayout,
  fabricSummary,
  flowIntensity,
  flowParams,
  fmtLoadPct,
  isClockwise,
  laneGeometry,
  linkFlowState,
  loadBarPct,
  ringOrder,
  sampleSource,
  sharedFormat,
  TILE,
  type FlowRow,
} from "../src/network";

/** IR-286 (IRI-171): Network card motion, decluttered labels, container layout. */

vi.mock("../src/live", async () => ({ live: (await import("./live-mock")).liveMock }));

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p: string[]) => readFileSync(path.join(here, "..", ...p), "utf8");
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

const idOf = (name: string) => fixture.nodes.find((n) => n.name === name)!.id;

/** Every node reports a fresh snapshot: DGX-1's first fabric port carries 1.25 GB/s out, 125 MB/s in. */
function seedSnapshots(): void {
  for (const n of fixture.nodes) {
    const net = parseNet(fixture.snapshots[n.id]!).map((e) => (n.name === "DGX-1" && e.iface === "enp1s0f0np0" ? { ...e, txBps: 1_250_000_000, rxBps: 125_000_000 } : e));
    liveMock.snapshots.set(n.id, { network: net });
    liveMock.snapshotAt.set(n.id, Date.now());
  }
}

async function mountCard(topology: object) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/v1/network/tests")) return new Response(JSON.stringify({ tests: [], running: false }), { status: 200 });
      if (url.includes("/history")) return new Response(JSON.stringify({ points: [] }), { status: 200 });
      return new Response(JSON.stringify({ ...topology, generatedAt: "x" }), { status: 200 });
    }),
  );
  const { default: NetworkCard } = await import("../src/components/NetworkCard.vue");
  const w = mount(NetworkCard as never, { attachTo: document.body });
  await new Promise((r) => setTimeout(r, 20));
  return w;
}

afterEach(() => {
  vi.unstubAllGlobals();
  liveMock.snapshots.clear();
  liveMock.snapshotAt.clear();
  document.body.replaceChildren();
});

describe("motion helpers", () => {
  it("maps per-direction rates onto a log scale from 1 Mb/s to 400 Gb/s", () => {
    expect(flowIntensity(null)).toBe(0);
    expect(flowIntensity(100_000)).toBe(0); // 0.8 Mb/s: idle
    expect(flowIntensity(125_000)).toBe(0); // exactly 1 Mb/s: the floor
    expect(flowIntensity(50_000_000_000)).toBe(1); // 400 Gb/s
    expect(flowIntensity(500_000_000_000)).toBe(1); // clamped
    const mid = flowIntensity(850_000_000); // 6.8 Gb/s
    expect(mid).toBeGreaterThan(0.5);
    expect(mid).toBeLessThan(0.75);
    // 50 Mb/s still visibly moves — a linear scale would make it invisible on 400G.
    expect(flowIntensity(6_250_000)).toBeGreaterThan(0.25);
    expect(flowIntensity(6_250_000)).toBeLessThan(mid);
  });

  it("derives particle speed, gap and opacity; idle has no particles", () => {
    expect(flowParams(0)).toBeNull();
    expect(flowParams(1)).toEqual({ speed: 168, gap: 8, opacity: 1 });
    const half = flowParams(0.5)!;
    expect(half.speed).toBe(93);
    expect(half.gap).toBe(17);
    expect(half.opacity).toBeCloseTo(0.675);
  });

  it("orients links by the drawn ring, clockwise when b follows a", () => {
    const t = realTopology();
    const order = ringOrder(t.nodes, t.links);
    const [d1, d2, d4] = [idOf("DGX-1"), idOf("DGX-2"), idOf("DGX-4")];
    expect(isClockwise({ a: d1, b: d2 }, order)).toBe(true);
    expect(isClockwise({ a: d2, b: d1 }, order)).toBe(false);
    expect(isClockwise({ a: d4, b: d1 }, order)).toBe(true); // wraps
    expect(isClockwise({ a: d1, b: d4 }, order)).toBe(false);
    expect(isClockwise({ a: "x", b: "y" }, ["x", "y"])).toBe(true); // two nodes: a → b
    // Every real link is exactly one ring step in one direction.
    for (const l of t.links) expect(isClockwise(l, order) !== isClockwise({ a: l.b, b: l.a }, order)).toBe(true);
  });

  it("derives link state with down > offline > stale > idle > ok", () => {
    const base = { lanesUp: 2, online: true, lastSampleMs: 10_000, intervalMs: 2000, nowMs: 11_000, cwBps: 1e9, ccwBps: 1e6 };
    expect(linkFlowState(base)).toBe("ok");
    expect(linkFlowState({ ...base, cwBps: 10_000, ccwBps: 0 })).toBe("idle");
    expect(linkFlowState({ ...base, cwBps: null, ccwBps: null })).toBe("stale");
    expect(linkFlowState({ ...base, nowMs: 15_001 })).toBe("stale"); // > 2.5 × 2 s
    expect(linkFlowState({ ...base, nowMs: 15_000 })).toBe("ok");
    expect(linkFlowState({ ...base, lastSampleMs: null })).toBe("stale");
    expect(linkFlowState({ ...base, online: false })).toBe("offline");
    expect(linkFlowState({ ...base, lanesUp: 0, online: false })).toBe("down");
  });

  it("judges freshness by the source the rates came from: a fresh live frame, else the snapshot", () => {
    const snap = { liveOn: true, frame: undefined, snapshotAtMs: 10_000, snapshotIntervalMs: 2000, nowMs: 11_000 };
    // Live on, no frames (old agent, lapsed lease, before the first frame): still the snapshot cadence.
    expect(sampleSource(snap)).toEqual({ lastSampleMs: 10_000, intervalMs: 2000 });
    const notStale = { lanesUp: 2, online: true, nowMs: 11_000, cwBps: 1e9, ccwBps: 1e9, ...sampleSource(snap) };
    expect(linkFlowState(notStale)).toBe("ok"); // 1 s old against 2 s × 2.5 — never flickers stale
    // A fresh frame wins, judged at its own interval.
    const frame = { receivedAtMs: 10_900, intervalMs: 250 };
    expect(sampleSource({ ...snap, frame })).toEqual({ lastSampleMs: 10_900, intervalMs: 250 });
    // A frame too old to override the rates falls back to the snapshot too.
    expect(sampleSource({ ...snap, frame: { receivedAtMs: 1000, intervalMs: 250 } })).toEqual({ lastSampleMs: 10_000, intervalMs: 2000 });
    // A late frame (700 ms at 250 ms: past 2.5 × but inside withLiveRates' 3 × + 1 s) hands over to the fresh snapshot.
    expect(sampleSource({ ...snap, frame: { receivedAtMs: 10_300, intervalMs: 250 } })).toEqual({ lastSampleMs: 10_000, intervalMs: 2000 });
    expect(linkFlowState({ lanesUp: 2, online: true, nowMs: 11_000, cwBps: 1e9, ccwBps: 1e9, ...sampleSource({ ...snap, frame: { receivedAtMs: 10_300, intervalMs: 250 } }) })).toBe("ok");
    // Live off ignores frames entirely.
    expect(sampleSource({ ...snap, liveOn: false, frame })).toEqual({ lastSampleMs: 10_000, intervalMs: 2000 });
    expect(sampleSource({ ...snap, snapshotAtMs: undefined })).toEqual({ lastSampleMs: null, intervalMs: 2000 });
  });

  it("shares one format across links, or none when any differs", () => {
    const links = realTopology().links;
    expect(sharedFormat(links)).toBe("Fabric · 200G ×2");
    const odd: TopologyLink = { ...links[0]!, lanes: links[0]!.lanes.slice(0, 1) };
    expect(sharedFormat([odd, ...links.slice(1)])).toBeNull();
    expect(sharedFormat([])).toBeNull();
  });

  it("puts the load bar on the log scale and formats small percentages", () => {
    expect(loadBarPct(null, null)).toBe(0);
    expect(loadBarPct(850_000_000, 1)).toBeGreaterThan(50);
    expect(fmtLoadPct(null)).toBe("—");
    expect(fmtLoadPct(0.04)).toBe("<0.1 %");
    expect(fmtLoadPct(1.7)).toBe("1.7 %");
    expect(fmtLoadPct(42)).toBe("42 %");
  });

  it("summarises health, the both-direction total, the busiest direction and the worst RTT over fresh links", () => {
    const row = (over: Partial<FlowRow>): FlowRow => ({ id: "l", title: "A ↔ B", from: "A", to: "B", cwBps: 100, ccwBps: 10, rttMs: 0.3, state: "ok", warn: false, ...over });
    const s = fabricSummary([
      row({ id: "1" }),
      row({ id: "2", title: "C ↔ D", from: "C", to: "D", cwBps: 5, ccwBps: 400, rttMs: 0.9 }),
      row({ id: "3", state: "stale", cwBps: 9999, rttMs: 7 }), // stale: excluded from numbers
    ]);
    expect(s).toMatchObject({ health: "healthy", warnings: 0, linksUp: 3, links: 3, totalBps: 515 });
    expect(s.busiest).toEqual({ bps: 400, from: "D", to: "C" });
    expect(s.worstRtt).toEqual({ ms: 0.9, title: "C ↔ D" });
    expect(fabricSummary([row({ state: "down" })])).toMatchObject({ health: "warn", warnings: 1, linksUp: 0, totalBps: null });
    expect(fabricSummary([row({ state: "stale" })]).health).toBe("no-data");
  });

  it("splits an edge into an outer clockwise lane and an inner counter-clockwise lane, between tile borders", () => {
    const g = laneGeometry({ x: 100, y: 80 }, { x: 400, y: 80 }, { x: 250, y: 190 }, TILE);
    expect([g.outer.x + 0, g.outer.y]).toEqual([0, -1]); // top edge: outer is up
    expect(g.cw[0]).toEqual({ x: 166, y: 75 }); // starts at the tile border, 5 px outward
    expect(g.cw[1]).toEqual({ x: 334, y: 75 });
    expect(g.ccw[0]).toEqual({ x: 334, y: 85 }); // travels back, inner side
    expect(arrowFor({ x: 100, y: 80 }, { x: 400, y: 80 })).toBe("→");
    expect(arrowFor({ x: 400, y: 80 }, { x: 400, y: 300 })).toBe("↓");
    expect(arrowFor({ x: 400, y: 300 }, { x: 400, y: 80 })).toBe("↑");
  });

  it("lays a ring of four out as a compact square that fills its box", () => {
    const t = realTopology();
    const lay = diagramLayout(ringOrder(t.nodes, t.links));
    expect([lay.width, lay.height]).toEqual([520, 380]);
    const xs = [...lay.pos.values()].map((p) => p.x);
    const ys = [...lay.pos.values()].map((p) => p.y);
    // Tiles stay inside the box with a small margin.
    expect(Math.min(...xs) - TILE.w / 2).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs) + TILE.w / 2).toBeLessThanOrEqual(lay.width);
    expect(Math.min(...ys) - TILE.h / 2).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys) + TILE.h / 2).toBeLessThanOrEqual(lay.height);
  });
});

describe("NetworkCard (IR-286)", () => {
  it("never paints text on an edge; rate pills sit clear of both lanes", async () => {
    seedSnapshots();
    const w = await mountCard(realTopology());
    const edges = w.findAll(".netedge");
    expect(edges).toHaveLength(4);
    for (const e of edges) {
      // The only text inside an edge group is a deviation badge (none here).
      expect(e.findAll("text").filter((t) => t.element.closest(".netbadge") === null)).toHaveLength(0);
      const hit = e.find(".nethit").element;
      const [x1, y1, x2, y2] = ["x1", "y1", "x2", "y2"].map((k) => Number(hit.getAttribute(k)));
      const pill = w.find(`.netpill[data-link="${e.attributes("data-link")}"]`);
      for (const t of pill.findAll("text")) {
        const [px, py] = [Number(t.attributes("x")), Number(t.attributes("y"))];
        const dist = Math.abs((y2! - y1!) * px - (x2! - x1!) * py + x2! * y1! - y2! * x1!) / Math.hypot(y2! - y1!, x2! - x1!);
        expect(dist).toBeGreaterThan(10); // lanes are ±5 px from the centre line
      }
    }
    // Named directions in the table; clockwise first.
    expect(w.text()).toContain("DGX-1 → DGX-2 10.0 Gb/s");
    expect(w.text()).toContain("DGX-2 → DGX-1 1.0 Gb/s");
    w.unmount();
  });

  it("swaps tx/rx for links whose a → b runs counter-clockwise", async () => {
    // DGX-1 ↔ DGX-4: a = DGX-1, but the ring runs DGX-4 → DGX-1 clockwise.
    const t = realTopology();
    const link = t.links.find((l) => [l.a, l.b].includes(idOf("DGX-1")) && [l.a, l.b].includes(idOf("DGX-4")))!;
    expect(link.a).toBe(idOf("DGX-1"));
    const port = link.lanes[0]!.a.iface;
    for (const n of fixture.nodes) {
      const net = parseNet(fixture.snapshots[n.id]!).map((e) => (n.name === "DGX-1" && e.iface === port ? { ...e, txBps: 625_000_000, rxBps: 12_500_000 } : e));
      liveMock.snapshots.set(n.id, { network: net });
      liveMock.snapshotAt.set(n.id, Date.now());
    }
    const w = await mountCard(t);
    const row = w.findAll("tr.netrow").find((r) => r.text().includes("DGX-1 ↔ DGX-4"))!;
    const dirs = row.findAll(".netdir").map((d) => d.text());
    expect(dirs[0]).toMatch(/^DGX-4 → DGX-1\s+100\.0 Mb\/s$/); // clockwise = DGX-1's rx
    expect(dirs[1]).toMatch(/^DGX-1 → DGX-4\s+5\.0 Gb\/s$/); // counter-clockwise = DGX-1's tx
    w.unmount();
  });

  it("keeps badges and pills clear of both lanes on a 3-node ring's diagonal edges", async () => {
    seedSnapshots();
    const t = realTopology();
    const drop = idOf("DGX-4");
    t.nodes = t.nodes.filter((n) => n.id !== drop);
    t.links = t.links.filter((l) => l.a !== drop && l.b !== drop);
    t.clusters = [];
    t.warnings = [];
    // Every remaining link carries a badge (the widest text: "1/2 lanes").
    for (const l of t.links) {
      l.lanes = l.lanes.map((x, i) => ({ ...x, up: i === 0 }));
      l.lanesUp = 1;
    }
    const w = await mountCard(t);
    expect(w.findAll(".nettile")).toHaveLength(3);
    const signed = (x1: number, y1: number, x2: number, y2: number, px: number, py: number) =>
      ((y2 - y1) * px - (x2 - x1) * py + x2 * y1 - y2 * x1) / Math.hypot(y2 - y1, x2 - x1);
    let diagonal = 0;
    for (const e of w.findAll(".netedge")) {
      const hit = e.find(".nethit").element;
      const [x1, y1, x2, y2] = ["x1", "y1", "x2", "y2"].map((k) => Number(hit.getAttribute(k))) as [number, number, number, number];
      if (x1 !== x2 && y1 !== y2) diagonal++;
      // Every corner of the badge rect lies on one side, beyond the ±5 lane band.
      const r = e.find(".netbadge rect");
      const [rx, ry, rw, rh] = ["x", "y", "width", "height"].map((k) => Number(r.attributes(k))) as [number, number, number, number];
      const corners = [[rx, ry], [rx + rw, ry], [rx, ry + rh], [rx + rw, ry + rh]].map(([px, py]) => signed(x1, y1, x2, y2, px!, py!));
      expect(corners.every((d) => d > 5) || corners.every((d) => d < -5)).toBe(true);
      // Pill anchors sit beyond the lanes on the other side.
      for (const tx of w.findAll(`.netpill[data-link="${e.attributes("data-link")}"] text`)) {
        expect(Math.abs(signed(x1, y1, x2, y2, Number(tx.attributes("x")), Number(tx.attributes("y"))))).toBeGreaterThan(10);
      }
    }
    expect(diagonal).toBeGreaterThan(0);
    w.unmount();
  });

  it("still draws the node tiles for a fabric of switched subnets only", async () => {
    seedSnapshots();
    const t = realTopology();
    t.links = [];
    t.switches = [{ id: "s1", subnet: "10.200.0.0/24", members: t.nodes.slice(0, 3).map((n) => ({ nodeId: n.id, iface: "enp1s0f0np0" })) }] as never;
    const w = await mountCard(t);
    expect(w.findAll(".nettile")).toHaveLength(4);
    expect(w.text()).toContain("Switched subnet 10.200.0.0/24");
    w.unmount();
  });

  it("states the shared format once in the header and drops the Format column", async () => {
    seedSnapshots();
    const w = await mountCard(realTopology());
    expect(w.find(".netsub").text()).toContain("every link Fabric · 200G ×2");
    expect(w.findAll("th").map((t) => t.text())).not.toContain("Format");
    expect(w.text()).toContain("Test all links");
    expect(w.text()).not.toContain("Test all fabric links");
    w.unmount();
  });

  it("badges degraded and MTU-mismatched links and reports mixed formats", async () => {
    seedSnapshots();
    const t = realTopology();
    const byName = (a: string, b: string) => t.links.find((l) => [l.a, l.b].sort().join() === [idOf(a), idOf(b)].sort().join())!;
    const degraded = byName("DGX-3", "DGX-4");
    degraded.lanes = degraded.lanes.map((l, i) => ({ ...l, up: i === 0 }));
    degraded.lanesUp = 1;
    const mtu = byName("DGX-1", "DGX-4");
    mtu.lanes = mtu.lanes.map((l, i) => ({ ...l, a: { ...l.a, mtu: 9000 }, b: { ...l.b, mtu: i === 0 ? 1500 : 9000 } }));
    const w = await mountCard(t);
    const badges = w.findAll(".netbadge text").map((x) => x.text());
    expect(badges).toContain("1/2 lanes");
    expect(badges).toContain("MTU ≠");
    expect(w.find(".netsub").text()).toContain("mixed formats");
    expect(w.find(".netstat").text()).toContain("2 warnings");
    expect(w.text()).toContain("MTU 9000 ≠ 1500");
    w.unmount();
  });

  it("cross-highlights a table row's edge and endpoint tiles, dimming the rest", async () => {
    seedSnapshots();
    const w = await mountCard(realTopology());
    const row = w.findAll("tr.netrow").find((r) => r.text().includes("DGX-1 ↔ DGX-2"))!;
    await row.trigger("mouseenter");
    const id = row.attributes("data-link");
    expect(w.find(`.netedge[data-link="${id}"]`).classes()).toContain("netedge--on");
    expect(w.findAll(".netedge--dim")).toHaveLength(3);
    expect(w.findAll(".nettile--on").map((t) => t.text())).toEqual(expect.arrayContaining([expect.stringContaining("DGX-1"), expect.stringContaining("DGX-2")]));
    expect(w.findAll(".nettile--dim")).toHaveLength(2);
    await row.trigger("mouseleave");
    expect(w.findAll(".netedge--dim")).toHaveLength(0);
    // Hovering a tile highlights its two links and their rows.
    await w.find(`.nettile[data-node="${idOf("DGX-3")}"]`).trigger("mouseenter");
    expect(w.findAll(".netedge--on")).toHaveLength(2);
    expect(w.findAll("tr.netrow--on")).toHaveLength(2);
    w.unmount();
  });

  it("shows no motion and says so when no snapshot arrives", async () => {
    const w = await mountCard(realTopology());
    expect(w.findAll(".netedge--stale")).toHaveLength(4);
    expect(w.findAll(".netpill text").map((t) => t.text())).toEqual(["no data", "no data", "no data", "no data"]);
    expect(w.find(".netmode").text()).toBe("no data");
    // The visible badge is not a live region; the announcement names the mode only.
    expect(w.find(".netmode").attributes("role")).toBeUndefined();
    expect(w.find('[role="status"].visually-hidden').text()).toBe("Network data is stale");
    expect(w.find(".netstat").text()).toContain("no data");
    w.unmount();
  });

  it("uses the snapshot mode badge with fresh data and a static encoding under reduced motion", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), addEventListener() {}, removeEventListener() {} }));
    seedSnapshots();
    const w = await mountCard(realTopology());
    expect(w.find(".netmode").text()).toBe("snapshot · 2 s");
    const busy = w.find(`.netedge[data-link] .netflow--cw[style*="stroke-dasharray"]`);
    expect(busy.exists()).toBe(true);
    expect(busy.attributes("style")).toContain("stroke-dasharray: none");
    // The badge and the stale threshold follow the hub's configured cadence (IR-87).
    const { serverCadenceMs } = await import("../src/version");
    try {
      serverCadenceMs.value = 1000;
      await new Promise((r) => setTimeout(r, 0));
      expect(w.find(".netmode").text()).toBe("snapshot · 1 s");
    } finally {
      serverCadenceMs.value = null;
      w.unmount();
    }
  });
});

describe("layout and tokens (source pins)", () => {
  const card = read("src", "components", "NetworkCard.vue");
  const css = read("src", "assets", "irori.css");

  it("lays out by the card's own width at the designed breakpoints", () => {
    expect(card).toMatch(/\.netcard \{ container-type: inline-size; container-name: netcard; \}/);
    for (const bp of [1279, 819, 699, 599]) expect(card).toContain(`@container netcard (max-width: ${bp}px)`);
    // < 1280: the table goes below the animation.
    expect(card).toMatch(/max-width: 1279px\) \{\s*\.netbody \{[^}]*grid-template-areas: "diag aside" "list list"/);
    // Grid children can shrink; the viewport-tier rule that hid the diagram is gone.
    expect(card).toContain(".netbody > * { min-width: 0; }");
    expect(card).not.toContain('data-tier="small"');
  });

  it("defines the ADR-0022 flow tokens in light and both dark blocks", () => {
    expect(css).toContain("--flow-cw: var(--thread);");
    expect(css).toContain("--flow-ccw: oklch(0.52 0.14 255);");
    expect(css.match(/--flow-ccw: oklch\(0\.72 0\.12 250\)/g)).toHaveLength(2);
    expect(existsSync(path.join(here, "..", "..", "..", "docs", "adr", "0022-directional-flow-colour-token.md"))).toBe(true);
  });
});
