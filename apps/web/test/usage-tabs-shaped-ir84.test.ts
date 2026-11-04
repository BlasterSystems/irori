// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import {
  usageAgentsResponseSchema,
  usageErrorsResponseSchema,
  usageRequestsResponseSchema,
  usageToolsResponseSchema,
} from "@irori/core";

/**
 * IRI-084: UsageView shaped rows for the agents/tools/errors tabs — each tab
 * renders its table from a schema-parsed fixture (fixtures cannot drift).
 */

vi.mock("../src/live", async () => ({ live: (await import("./live-mock")).liveMock }));
vi.mock("../src/scrim", () => ({ vScrimClose: {} }));

afterEach(() => {
  vi.unstubAllGlobals();
  window.location.hash = "";
});

const UUID = "11111111-1111-4111-8111-111111111111";
const NOW = Date.now();

const agentsBody = usageAgentsResponseSchema.parse({
  range: "24h",
  groups: [
    { project: "irori", agentType: "main", name: "claude", keyHash: null, sourceAddrs: ["127.0.0.1"], requests: 12, errors: 1, promptTokens: 40000, completionTokens: 9000, totalTokens: 49000, costMinor: 340, lastSeenMs: NOW },
  ],
  truncated: false,
  costCurrency: "EUR",
});

const toolsBody = usageToolsResponseSchema.parse({
  range: "24h",
  tools: [
    { tool: "web_search", model: "glm-5.3", calls: 7, errors: 0, argsChars: 900, resultChars: 4200, promptTokens: 3000, completionTokens: 800, costMinor: 45, lastSeenMs: NOW },
  ],
  series: [],
  costCurrency: "EUR",
});

const errorsBody = usageErrorsResponseSchema.parse({
  range: "24h",
  groups: [
    { sig: "conn-refused-8081", count: 2, firstSeenMs: NOW - 9e6, lastSeenMs: NOW, sample: "ECONNREFUSED", models: ["glm-5.3"], status: null, costMinor: 0 },
  ],
  errorsCostMinor: 0,
  costCurrency: null,
});

const requestsBody = usageRequestsResponseSchema.parse({ total: 0, rows: [], costCurrency: null });

const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  let body: unknown = {};
  if (url.startsWith("/api/v1/usage/agents")) body = agentsBody;
  else if (url.startsWith("/api/v1/usage/tools")) body = toolsBody;
  else if (url.startsWith("/api/v1/usage/errors")) body = errorsBody;
  else if (url.startsWith("/api/v1/usage/requests?") || url === "/api/v1/usage/requests") body = requestsBody;
  else if (url.includes("/usage/clients")) body = { clients: [] };
  else if (url.includes("/api/v1/updates")) body = { baseline: null, nodes: [] };
  else if ([ "/setups", "/nodes", "/jobs", "/quants", "/health/findings", "/api/v1/bench" ].some((e) => url.includes(e))) body = [];
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
});

async function mountAt(tab: string) {
  vi.stubGlobal("fetch", fetchStub);
  window.location.hash = `#/usage?tab=${tab}&range=24h`;
  const { default: UsageView } = await import("../src/components/UsageView.vue");
  const w = mount(UsageView as never);
  await new Promise((r) => setTimeout(r, 100));
  return w;
}

describe("UsageView shaped rows per tab", () => {
  it("agents tab renders the identity group with cost", async () => {
    const w = await mountAt("agents");
    const text = w.text();
    expect(text).toContain("claude");
    expect(text).toContain("irori");
    w.unmount();
    window.location.hash = "";
  });

  it("tools tab renders the tool row", async () => {
    const w = await mountAt("tools");
    expect(w.text()).toContain("web_search");
    w.unmount();
    window.location.hash = "";
  });

  it("errors tab renders the signature group", async () => {
    const w = await mountAt("errors");
    expect(w.text()).toContain("conn-refused-8081");
    w.unmount();
    window.location.hash = "";
  });
});
