// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { usageRequestsResponseSchema, usageTraceSchema } from "@irori/core";

/**
 * IRI-084: shaped-data interactive tier — the requests tab renders a real
 * row, the drawer opens on it, and the IRI-079 trace waterfall renders with
 * the p50 comparison. Fixtures are schema-parsed so they can never drift
 * from the wire contract.
 */

vi.mock("../src/live", async () => ({ live: (await import("./live-mock")).liveMock }));
vi.mock("../src/scrim", () => ({ vScrimClose: {} }));

afterEach(() => {
  vi.unstubAllGlobals();
  window.location.hash = "";
});

const UUID = "11111111-1111-4111-8111-111111111111";

const requestsBody = usageRequestsResponseSchema.parse({
  total: 1,
  costCurrency: "EUR",
  rows: [
    {
      id: UUID,
      ts: Date.now(),
      port: 8080,
      endpoint: "/v1/chat/completions",
      model: "glm-5.3",
      status: 200,
      finishReason: "stop",
      durationMs: 1234,
      ttftMs: 120,
      decodeTps: 42.5,
      promptTokens: 1000,
      completionTokens: 500,
      cachedTokens: 0,
      reasoningTokens: 0,
      totalTokens: 1500,
      costMinor: 102,
      nodeId: UUID,
      receivedAtMs: Date.now(),
      reqBytes: 1200,
      resBytes: 3400,
    },
  ],
});

const traceBody = usageTraceSchema.parse({
  requestId: UUID,
  nodeId: UUID,
  model: "glm-5.3",
  traceId: "otel-trace-1",
  durationMs: 1234,
  modelP50Ms: 900,
  error: null,
  spans: [
    { name: "queue + prefill", startMs: 0, endMs: 120, attrs: {} },
    { name: "decode", startMs: 120, endMs: 1234, attrs: { spec_accepted: 480 } },
  ],
});

const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  let body: unknown = {};
  if (url.startsWith("/api/v1/usage/requests?") || url === "/api/v1/usage/requests") body = requestsBody;
  else if (url.includes("/usage/requests/") && url.endsWith("/trace")) body = traceBody;
  else if (url.includes("/usage/requests/")) body = requestsBody.rows[0];
  else if (url.includes("/usage/clients")) body = { clients: [] };
  else if (url.includes("/setups") && !url.includes("/validate")) body = { setups: [] };
  else if (url.includes("/api/v1/updates")) body = { baseline: null, nodes: [] };
  else if ([ "/setups", "/nodes", "/jobs", "/quants", "/health/findings" ].some((e) => url.includes(e))) body = [];
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
});

describe("UsageView shaped-data interactive tier", () => {
  it("renders a real request row, opens the drawer, and draws the p50 waterfall", async () => {
    vi.stubGlobal("fetch", fetchStub);
    window.location.hash = "#/usage?tab=requests&range=24h";
    const { default: UsageView } = await import("../src/components/UsageView.vue");
    const w = mount(UsageView as never);
    await new Promise((r) => setTimeout(r, 80));
    // The row renders with its model + cost.
    expect(w.text()).toContain("glm-5.3");
    // The detail button opens the drawer.
    const detailBtn = w.findAll("button").find((b) => b.text() === "detail");
    expect(detailBtn).toBeDefined();
    await detailBtn!.trigger("click");
    await new Promise((r) => setTimeout(r, 80));
    // Drawer: trace waterfall + p50 comparison chip + copy button.
    expect(w.text()).toContain("Trace");
    expect(w.text()).toContain("vs p50");
    expect(w.text()).toContain("queue + prefill");
    expect(w.text()).toContain("decode");
    w.unmount();
    window.location.hash = "";
  });
});
