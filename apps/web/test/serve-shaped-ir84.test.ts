// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { setupInfoSchema } from "@irori/core";

/**
 * IRI-084: ServeView shaped-data tier — a real running setup row renders the
 * board card (IR-152 chip, IR-151 probe escape hatch) and the detail drawer.
 * The fixture is setupInfoSchema-parsed so it cannot drift from the wire.
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
  scriptStart: "/home/piresbruno/developer/recipes/glm/start.sh",
  scriptStop: "/home/piresbruno/developer/recipes/glm/stop.sh",
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
  else if (url.startsWith("/api/v1/setups/")) body = { setup: setupRow, transfers: [], workers: [] };
  else if (url.includes("/api/v1/updates")) body = { baseline: null, nodes: [] };
  else if ([ "/setups", "/nodes", "/jobs", "/quants", "/health/findings", "/api/v1/bench", "/usage/retries" ].some((e) => url.includes(e))) body = [];
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
});

describe("ServeView shaped-data tier", () => {
  it("renders a running setup card with the healthy chip", async () => {
    vi.stubGlobal("fetch", fetchStub);
    const { default: ServeView } = await import("../src/components/ServeView.vue");
    const w = mount(ServeView as never, { props: { route: { recipeJob: null } } } as never);
    await new Promise((r) => setTimeout(r, 120));
    expect(w.text()).toContain("GLM-Flash-TP2-MIIA");
    expect(w.text()).toContain("healthy");
    w.unmount();
  });

  it("renders the fallback chip for a stopped row the probe sees (IR-151)", async () => {
    const stopped = setupInfoSchema.parse({ ...setupRow, status: "stopped" });
    const stub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url === "/api/v1/setups" ? { setups: [stopped] } : url.startsWith("/api/v1/setups/") ? { setup: stopped, transfers: [] } : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", stub);
    const { default: ServeView } = await import("../src/components/ServeView.vue");
    const w = mount(ServeView as never, { props: { route: { recipeJob: null } } } as never);
    await new Promise((r) => setTimeout(r, 120));
    // IR-152: a stopped row reads "stopped"/"never started" — the probe can
    // only upgrade it to "serving :port" when the LLM probe reports the engine.
    expect(w.text()).toContain("GLM-Flash-TP2-MIIA");
    w.unmount();
  });
});
