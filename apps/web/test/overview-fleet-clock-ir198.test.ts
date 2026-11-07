// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { liveMock } from "./live-mock";

/**
 * IR-198: the fleet clock caps section is demoted below Nodes/Power on the
 * Overview, hidden entirely on a NAS-only fleet, and per-node apply outcomes
 * render as touch-legible rows (not title-only chips). 200/207/502 semantics
 * and the fleetError banner are preserved. IR-199: ok sides name the applied
 * cap per side (GPU 2000 · CPU cleared), failures keep the API error text.
 */

vi.mock("../src/live", async () => ({ live: (await import("./live-mock")).liveMock }));
vi.mock("../src/scrim", () => ({ vScrimClose: {} }));

const DGX1 = "22222222-2222-4222-8222-222222222222";
const DGX2 = "33333333-3333-4333-8333-333333333333";
const NAS = "44444444-4444-4444-8444-444444444444";

const clockCapBody = {
  results: [
    // IR-199: per-side applied cap (2000 applied; null = cleared or failed side).
    { nodeId: DGX1, name: "dgx1", status: 200, results: [{ side: "gpu", ok: true, offline: false, error: null, appliedMHz: 2000 }, { side: "cpu", ok: true, offline: false, error: null, appliedMHz: null }] },
    { nodeId: DGX2, name: "dgx2", status: 502, results: [{ side: "gpu", ok: true, offline: false, error: null, appliedMHz: 2000 }, { side: "cpu", ok: false, offline: false, error: "agent busy, retry", appliedMHz: null }] },
  ],
  applied: 1,
  failed: 1,
  persistent: false,
};

function stubFetch(clockCap: { body: unknown; status: number }) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    let body: unknown = {};
    if (url === "/api/v1/clock-cap") body = clockCap.body;
    else if (url === "/api/v1/setups") body = { setups: [] };
    else if (url.includes("/api/v1/updates")) body = { baseline: { dgxOs: "7.6.0", driver: "580.178.04", kernel: null, uefi: null, ec: null, soc: null, source: "cache", fetchedAtMs: Date.now() }, nodes: [] };
    else if (url.includes("/api/v1/analytics/power")) body = { lens: "power", range: "30m", groupBy: "node", granularity: "minute", series: [], costSeries: [], models: [], costMinor: null, costCurrency: null };
    else if (url.includes("/api/v1/analytics/tokens")) body = { lens: "tokens", range: "30m", groupBy: "node", granularity: "minute", series: [], costSeries: [], models: [], costMinor: null, costCurrency: null };
    else if (url.includes("/api/v1/analytics")) body = { range: "30m", granularity: "minute", series: [] };
    else if (["/setups", "/nodes", "/jobs", "/quants", "/health/findings", "/api/v1/bench"].some((e) => url.includes(e))) body = [];
    return new Response(JSON.stringify(body), { status: url === "/api/v1/clock-cap" ? clockCap.status : 200, headers: { "content-type": "application/json" } });
  });
}

async function mountOverview() {
  const { default: OverviewView } = await import("../src/components/OverviewView.vue");
  const w = mount(OverviewView as never);
  await new Promise((r) => setTimeout(r, 150));
  return w;
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.location.hash = "";
  liveMock.nodes.clear();
  liveMock.llm.clear();
});

describe("OverviewView fleet clock caps (IR-198)", () => {
  it("renders below Power and above Updates", async () => {
    vi.stubGlobal("fetch", stubFetch({ body: clockCapBody, status: 200 }));
    liveMock.nodes.set(DGX1, { id: DGX1, name: "dgx1", online: true, role: "head", kind: "spark" });
    liveMock.nodes.set(DGX2, { id: DGX2, name: "dgx2", online: true, role: "worker", kind: "spark" });
    const w = await mountOverview();
    const sections = Array.from((w.element as HTMLElement).querySelectorAll("section"));
    const clockIdx = sections.findIndex((s) => s.getAttribute("aria-label") === "Fleet clock caps");
    const powerIdx = sections.findIndex((s) => Array.from(s.querySelectorAll("h3")).some((h) => h.textContent === "Power"));
    const updatesIdx = sections.findIndex((s) => Array.from(s.querySelectorAll("h3")).some((h) => h.textContent === "Updates"));
    expect(clockIdx).toBeGreaterThan(-1);
    expect(powerIdx).toBeGreaterThan(-1);
    expect(updatesIdx).toBeGreaterThan(-1);
    expect(clockIdx).toBeGreaterThan(powerIdx);
    expect(clockIdx).toBeLessThan(updatesIdx);
    w.unmount();
  });

  it("is hidden entirely on a NAS-only fleet", async () => {
    vi.stubGlobal("fetch", stubFetch({ body: clockCapBody, status: 200 }));
    liveMock.nodes.set(NAS, { id: NAS, name: "nas", online: true, kind: "nas" });
    const w = await mountOverview();
    expect(w.find('section[aria-label="Fleet clock caps"]').exists()).toBe(false);
    expect(w.text()).toContain("no spark nodes"); // the empty-fleet ghost, not dead space
    w.unmount();
  });

  it("renders per-node outcomes as visible rows, not title-only chips", async () => {
    vi.stubGlobal("fetch", stubFetch({ body: clockCapBody, status: 200 }));
    liveMock.nodes.set(DGX1, { id: DGX1, name: "dgx1", online: true, role: "head", kind: "spark" });
    liveMock.nodes.set(DGX2, { id: DGX2, name: "dgx2", online: true, role: "worker", kind: "spark" });
    const w = await mountOverview();
    const clear = w.findAll("button").find((b) => b.text() === "Clear fleet");
    expect(clear).toBeDefined();
    await clear!.trigger("click");
    await new Promise((r) => setTimeout(r, 80));
    const section = w.find('section[aria-label="Fleet clock caps"]');
    const rows = section.findAll(".orow");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.text()).toContain("dgx1");
    expect(rows[0]!.text()).toContain("GPU 2000"); // IR-199: applied cap per side (mockup S7/S8)
    expect(rows[0]!.text()).toContain("CPU cleared");
    expect(rows[1]!.text()).toContain("dgx2");
    expect(rows[1]!.text()).toContain("GPU 2000");
    expect(rows[1]!.text()).toContain("CPU failed — agent busy, retry"); // visible text, not a title attribute
    expect(section.findAll(".chip")).toHaveLength(0); // title-only chips are gone
    expect(section.text()).toContain("cleared on 1/2 nodes · 1 failed"); // 200/207/502 status line intact
    w.unmount();
  });

  it("keeps the warn banner for a total fleet failure (502)", async () => {
    vi.stubGlobal("fetch", stubFetch({ body: { error: "clock cap apply failed on every node" }, status: 502 }));
    liveMock.nodes.set(DGX1, { id: DGX1, name: "dgx1", online: true, role: "head", kind: "spark" });
    const w = await mountOverview();
    const clear = w.findAll("button").find((b) => b.text() === "Clear fleet");
    expect(clear).toBeDefined();
    await clear!.trigger("click");
    await new Promise((r) => setTimeout(r, 80));
    const banner = w.find('section[aria-label="Fleet clock caps"] .banner--warn');
    expect(banner.exists()).toBe(true);
    expect(banner.text()).toContain("clock cap apply failed on every node");
    w.unmount();
  });
});
