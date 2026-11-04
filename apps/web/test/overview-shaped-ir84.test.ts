// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { setupInfoSchema } from "@irori/core";

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
  else if (url.includes("/api/v1/analytics")) body = { range: "30m", granularity: "minute", kpis: { requests: 0, errors: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, reasoningTokens: 0, totalTokens: 0, ttftP50Ms: null, ttftP95Ms: null, decodeTps: null }, series: [], tokenMix: [], costMinor: 0, costCurrency: null };
  else if ([ "/setups", "/nodes", "/jobs", "/quants", "/health/findings", "/api/v1/bench" ].some((e) => url.includes(e))) body = [];
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
});

describe("OverviewView shaped tier", () => {
  it("renders the hero card for a running setup and the fleet header", async () => {
    vi.stubGlobal("fetch", fetchStub);
    const { default: OverviewView } = await import("../src/components/OverviewView.vue");
    const w = mount(OverviewView as never);
    await new Promise((r) => setTimeout(r, 150));
    const text = w.text();
    expect(text).toContain("GLM-Flash-TP2-MIIA");
    expect(text).toContain("1 serving");
    expect(text).toContain("KV cache");
    expect(text).toContain("baseline cached"); // updates card renders the served baseline
    w.unmount();
  });
});
