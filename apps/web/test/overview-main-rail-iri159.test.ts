// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { liveMock } from "./live-mock";

/**
 * IRI-159: the Overview Main+Rail shell — power renders in the main column,
 * token stats / NAS / clock caps / telemetry render in the rail, node cards
 * render in a 2-col grid with constants carried in tooltips, and the thermal
 * alert row appears only when a spark node runs at/above the warn tier.
 */

vi.mock("../src/live", async () => ({ live: (await import("./live-mock")).liveMock }));
vi.mock("../src/scrim", () => ({ vScrimClose: {} }));

const D1 = "aaaaaaaa-1111-4111-8111-111111111111";
const D2 = "bbbbbbbb-2222-4222-8222-222222222222";

const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  let body: unknown = {};
  if (url.includes("/api/v1/updates")) body = { baseline: null, nodes: [] };
  else if (url.includes("/api/v1/analytics")) body = { range: "24h", granularity: "minute", series: [] };
  else if (["/setups", "/nodes", "/jobs", "/quants", "/health/findings", "/api/v1/bench"].some((e) => url.includes(e))) body = [];
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
});

function snap(gpuTempC: number): Record<string, unknown> {
  return {
    schemaVersion: 1,
    agentVersion: "0.7.0",
    hostname: "dgx",
    transport: "ws",
    timestampMs: Date.now(),
    gpus: [{ index: 0, name: "NVIDIA GB10", uuid: null, usagePct: 34, tempC: gpuTempC, memUsedBytes: 42_100_000_000, memTotalBytes: 127_000_000_000, powerW: 74, powerLimitW: null, smClockMHz: null, smClockMaxMHz: null, throttleReasons: [], processes: [] }],
    cpu: { model: "GB10", cores: 20, usagePct: 18, tempC: 58, packagePowerW: 41 },
    memory: { totalBytes: 127 * 2 ** 30, usedBytes: 96 * 2 ** 30, swapTotalBytes: null, swapUsedBytes: null },
    unifiedMemory: null,
  };
}

async function mountOverview() {
  // vi.mock hoisting: the component must load after the live-store mock registers.
  const { default: OverviewView } = await import("../src/components/OverviewView.vue");
  const w = mount(OverviewView as never);
  // Settle window (repo convention in every mount test): mounting fires async
  // fetch chains against the stubs; the await gives those promises one task
  // cycle before assertions (real time — fake timers cannot flush them).
  await new Promise((r) => setTimeout(r, 150));
  return w;
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.location.hash = "";
  liveMock.nodes.clear();
  liveMock.snapshots.clear();
  liveMock.llm.clear();
});

describe("OverviewView Main+Rail (IRI-159)", () => {
  it("renders power in the main column and token/NAS/caps/feed in the rail", async () => {
    vi.stubGlobal("fetch", fetchStub);
    liveMock.nodes.set(D1, { id: D1, name: "dgx1", online: true, role: "head", kind: "spark" });
    liveMock.nodes.set("cccccccc-3333-4333-8333-333333333333", { id: "cccccccc-3333-4333-8333-333333333333", name: "nas", online: true, kind: "nas" });
    const w = await mountOverview();
    const main = w.find(".maincol");
    const rail = w.find(".rail");
    expect(main.exists()).toBe(true);
    expect(rail.exists()).toBe(true);
    expect(main.text()).toContain("Power");
    const railText = rail.text();
    for (const surface of ["Token stats", "NAS store", "Fleet clock caps", "Telemetry"]) {
      expect(railText).toContain(surface);
    }
    // Updates stays full-width below the shell, not inside it.
    expect(w.find(".ov-shell").text()).not.toContain("Updates");
    expect(w.text()).toContain("Updates");
    w.unmount();
  });

  it("renders node cards in a 2-col grid with constants in tooltips", async () => {
    vi.stubGlobal("fetch", fetchStub);
    liveMock.nodes.set(D1, { id: D1, name: "dgx1", online: true, role: "head", kind: "spark", agentVersion: "0.7.0" });
    liveMock.nodes.set(D2, { id: D2, name: "dgx2", online: true, role: "worker", kind: "spark", agentVersion: "0.7.0" });
    liveMock.snapshots.set(D1, snap(65));
    liveMock.snapshots.set(D2, snap(66));
    const w = await mountOverview();
    const grid = w.find(".nodes-grid");
    expect(grid.exists()).toBe(true);
    expect(grid.findAll(".card")).toHaveLength(2);
    // decluttered head: no kind chip, no agent version, no inference line
    const head = grid.find(".card__head").text();
    expect(head).not.toContain("spark");
    expect(head).not.toContain("Agent");
    expect(head).not.toContain(":");
    // the visible compact values carry no GPU model and no totals
    const compact = grid.findAll(".v-compact").map((s) => s.text()).join(" · ");
    expect(compact).not.toContain("NVIDIA GB10");
    expect(compact).not.toContain("/ 127.0 GB");
    // the head tooltip carries the identity, the row labels carry the totals
    const nametip = grid.find(".nametip");
    expect(nametip.text()).toContain("dgx1");
    expect(nametip.attributes("data-tip")).toContain("NVIDIA GB10");
    expect(nametip.attributes("data-tip")).toContain("agent 0.7.0");
    const rowtip = grid.find(".rowtip");
    expect(rowtip.attributes("data-tip")).toContain("VRAM");
    // compact value renders; the touch-fallback full value sits in the DOM
    const memRow = grid.findAll(".barrow").find((r) => r.text().startsWith("MEM"))!;
    expect(memRow.find(".v-compact").text()).toBe("96.0 GB");
    expect(memRow.find(".v-total").text()).toBe("96.0 / 127.0 GB");
    w.unmount();
  });

  it("shows the thermal alert only when a spark node reaches the warn tier", async () => {
    vi.stubGlobal("fetch", fetchStub);
    liveMock.nodes.set(D1, { id: D1, name: "dgx1", online: true, role: "head", kind: "spark" });
    liveMock.nodes.set(D2, { id: D2, name: "dgx2", online: true, role: "worker", kind: "spark" });
    liveMock.snapshots.set(D1, snap(72));
    liveMock.snapshots.set(D2, snap(60));
    const w = await mountOverview();
    const alert = w.find(".thermal-alert");
    expect(alert.exists()).toBe(true);
    expect(alert.text()).toContain("72°C dgx1");
    expect(alert.text()).not.toContain("dgx2"); // cool nodes stay out
    w.unmount();

    liveMock.snapshots.set(D1, snap(60));
    const w2 = await mountOverview();
    expect(w2.find(".thermal-alert").exists()).toBe(false);
    w2.unmount();
  });
});
