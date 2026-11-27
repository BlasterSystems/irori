// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { setupInfoSchema } from "@irori/core";
import { liveMock } from "./live-mock";

/**
 * IRI-084: OverviewView shaped tier — a running setup renders a hero card
 * (decode/prefill/queue + KV cache), the fleet header counts it, and the
 * Updates card reflects the served baseline state.
 */

vi.mock("../src/live", async () => ({ live: (await import("./live-mock")).liveMock }));
vi.mock("../src/scrim", () => ({ vScrimClose: {} }));

afterEach(() => {
  vi.unstubAllGlobals();
  window.location.hash = "";
});

const UUID = "11111111-1111-4111-8111-111111111111";

const setupRow = setupInfoSchema.parse({
  id: UUID,
  name: "GLM-Flash-TP2-MIIA",
  kind: "cluster",
  model: "GLM-5.3-Flash-EXL3",
  port: 8081,
  headNodeId: UUID,
  nodes: [{ nodeId: UUID, role: "worker" }],
  scriptStart: "/opt/recipes/glm/start.sh",
  scriptStop: "/opt/recipes/glm/stop.sh",
  captureProxy: true,
  bodyRetention: true,
  status: "running",
  health: "healthy",
  lastError: null,
  lastStartedAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  let body: unknown = {};
  if (url === "/api/v1/setups") body = { setups: [setupRow] };
  else if (url.startsWith("/api/v1/setups/")) body = { setup: setupRow, transfers: [] };
  else if (url.includes("/api/v1/updates")) body = { baseline: { dgxOs: "7.6.0", driver: "580.178.04", kernel: null, uefi: null, ec: null, soc: null, source: "cache", fetchedAtMs: Date.now() }, nodes: [] };
  // IR-224 S6: the power fetch is pinned to 24h and the token fetch follows
  // the persisted menu range (default 24h) — fetchAnalytics validates that
  // the response range echoes the request, so the stub echoes 24h too.
  else if (url.includes("/api/v1/analytics/power")) body = { lens: "power", range: "24h", groupBy: "node", granularity: "minute", series: [{ key: UUID, label: "dgx1", points: [{ t: Date.now() - 60000, coverage: 1, watts: 40 }, { t: Date.now(), coverage: 1, watts: 44 }] }], costSeries: [], models: [], costMinor: null, costCurrency: null };
  else if (url.includes("/api/v1/analytics/tokens")) body = { lens: "tokens", range: "24h", groupBy: "node", granularity: "minute", series: [{ key: UUID, label: "dgx1", points: [{ t: Date.now() - 60000, coverage: 1, tokens: 500 }, { t: Date.now(), coverage: 1, tokens: 700 }] }], costSeries: [], models: [], costMinor: 1234, costCurrency: "EUR" };
  else if (url.includes("/api/v1/analytics")) body = { range: "24h", granularity: "minute", series: [] };
  else if ([ "/setups", "/nodes", "/jobs", "/quants", "/health/findings", "/api/v1/bench" ].some((e) => url.includes(e))) body = [];
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
});

describe("OverviewView shaped tier", () => {
  it("renders the hero card for a running setup and the fleet header", async () => {
    vi.stubGlobal("fetch", fetchStub);
        const { default: OverviewView } = await import("../src/components/OverviewView.vue");
    liveMock.nodes.set(UUID, { id: UUID, name: "dgx1", online: true, role: "head", kind: "spark" });
    liveMock.llm.set(UUID, { ports: [{ port: 8082, detected: true, model: null, backend: "sglang", kvCachePct: null, decodeTps: null, prefillTps: null, queueRunning: null, queueWaiting: null, ttftP95Ms: null, e2eP95Ms: null, itlP95Ms: null, tokens: null, probedAtMs: Date.now(), engineMeta: null }] });
    // IR-224 S6: Fleet now + the per-node barrows read live snapshots, not the
    // range-fetched buckets — 4 W gpu + 40 W base overhead = 44 W.
    liveMock.snapshots.set(UUID, {
      schemaVersion: 1,
      agentVersion: "0.7.0",
      hostname: "dgx1",
      transport: "ws",
      timestampMs: Date.now(),
      gpus: [{ index: 0, name: "NVIDIA GB10", uuid: null, usagePct: 10, tempC: 50, memUsedBytes: 1, memTotalBytes: 4, powerW: 4 }],
      cpu: { model: "GB10", cores: 10, usagePct: 5, tempC: 45, packagePowerW: 0 },
      memory: { totalBytes: 8, usedBytes: 2, swapTotalBytes: null, swapUsedBytes: null },
      unifiedMemory: null,
    });
    const w = mount(OverviewView as never);
    await new Promise((r) => setTimeout(r, 150));
    const text = w.text();
    expect(text).toContain("GLM-Flash-TP2-MIIA");
    expect(text).toContain("2 serving"); // hero card + detected engine card
    expect(text).toContain("KV cache");
    expect(text).toContain("baseline cached"); // updates card renders the served baseline
    expect(text).toContain("44 W"); // fleet now = live snapshot math (gpu + base overhead)
    expect(text).toContain("Energy · 24 h"); // the power card is pinned to 24 h
    expect(text).toContain("0.00kWh"); // energy strip
    expect(text).toContain("unmanaged"); // engine card posture
    expect(text).toContain("port 8082"); // detected-but-unmanaged engine card
    // IR-285: the real hero renders inside the main column, and two serving
    // processes flatten the shell at mount level (not just by source pin).
    expect(w.find(".maincol .hero-grid").exists()).toBe(true);
    expect(w.find(".ov-shell--flat").exists()).toBe(true);
    liveMock.nodes.delete(UUID);
    liveMock.llm.delete(UUID);
    liveMock.snapshots.delete(UUID);
    w.unmount();
  });

  it("renders a starting setup as a hero with the starting chip (IR-220 round-3 MAJOR)", async () => {
    vi.stubGlobal("fetch", fetchStub);
    const startingRow = setupInfoSchema.parse({
      ...setupRow,
      id: "22222222-2222-4222-8222-222222222222",
      name: "Qwen3.8-Flash-Next",
      status: "starting",
    });
    const startingStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/v1/setups") return new Response(JSON.stringify({ setups: [startingRow] }), { status: 200, headers: { "content-type": "application/json" } });
      return fetchStub(input);
    });
    vi.stubGlobal("fetch", startingStub);
    const { default: OverviewView } = await import("../src/components/OverviewView.vue");
    liveMock.nodes.set(UUID, { id: UUID, name: "dgx1", online: true, role: "head", kind: "spark" });
    const w = mount(OverviewView as never);
    await new Promise((r) => setTimeout(r, 150));
    const text = w.text();
    expect(text).toContain("Qwen3.8-Flash-Next"); // the starting setup is a hero card
    expect(text).toContain("starting"); // its state chip, not silent absence
    // IR-285: a single hero keeps the shell unflattened, inside the main column.
    expect(w.find(".maincol .hero-grid--single").exists()).toBe(true);
    expect(w.find(".ov-shell--flat").exists()).toBe(false);
    liveMock.nodes.delete(UUID);
    liveMock.llm.delete(UUID);
    w.unmount();
  });
});
