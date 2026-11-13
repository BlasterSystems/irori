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
  else if (url.includes("/api/v1/analytics/power")) body = { lens: "power", range: "30m", groupBy: "node", granularity: "minute", series: [{ key: UUID, label: "dgx1", points: [{ t: Date.now() - 60000, coverage: 1, watts: 40 }, { t: Date.now(), coverage: 1, watts: 44 }] }], costSeries: [], models: [], costMinor: null, costCurrency: null };
  else if (url.includes("/api/v1/analytics/tokens")) body = { lens: "tokens", range: "30m", groupBy: "node", granularity: "minute", series: [{ key: UUID, label: "dgx1", points: [{ t: Date.now() - 60000, coverage: 1, tokens: 500 }, { t: Date.now(), coverage: 1, tokens: 700 }] }], costSeries: [], models: [], costMinor: 1234, costCurrency: "EUR" };
  else if (url.includes("/api/v1/analytics")) body = { range: "30m", granularity: "minute", series: [] };
  else if ([ "/setups", "/nodes", "/jobs", "/quants", "/health/findings", "/api/v1/bench" ].some((e) => url.includes(e))) body = [];
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
});

describe("OverviewView shaped tier", () => {
  it("renders the hero card for a running setup and the fleet header", async () => {
    vi.stubGlobal("fetch", fetchStub);
        const { default: OverviewView } = await import("../src/components/OverviewView.vue");
    liveMock.nodes.set(UUID, { id: UUID, name: "dgx1", online: true, role: "head", kind: "spark" });
    liveMock.llm.set(UUID, { ports: [{ port: 8082, detected: true, model: null, backend: "sglang", kvCachePct: null, decodeTps: null, prefillTps: null, queueRunning: null, queueWaiting: null, ttftP95Ms: null, e2eP95Ms: null, itlP95Ms: null, tokens: null, probedAtMs: Date.now(), engineMeta: null }] });
    const w = mount(OverviewView as never);
    await new Promise((r) => setTimeout(r, 150));
    const text = w.text();
    expect(text).toContain("GLM-Flash-TP2-MIIA");
    expect(text).toContain("2 serving"); // hero card + detected engine card
    expect(text).toContain("KV cache");
    expect(text).toContain("baseline cached"); // updates card renders the served baseline
    expect(text).toContain("44 W"); // fleet now = latest power bucket
    expect(text).toContain("0.00kWh"); // energy strip
    expect(text).toContain("unmanaged"); // engine card posture
    expect(text).toContain("port 8082"); // detected-but-unmanaged engine card
    liveMock.nodes.delete(UUID);
    liveMock.llm.delete(UUID);
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
    liveMock.nodes.delete(UUID);
    liveMock.llm.delete(UUID);
    w.unmount();
  });
});
