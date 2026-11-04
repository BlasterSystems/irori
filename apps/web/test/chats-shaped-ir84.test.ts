// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { chatsResponseSchema } from "@irori/core";

/**
 * IRI-084: ChatsView shaped tier — a schema-parsed session renders its
 * summary row (requests, tokens, cost) in the sessions table.
 */

vi.mock("../src/live", async () => ({ live: (await import("./live-mock")).liveMock }));
vi.mock("../src/scrim", () => ({ vScrimClose: {} }));

afterEach(() => vi.unstubAllGlobals());

const UUID = "11111111-1111-4111-8111-111111111111";

const chatsBody = chatsResponseSchema.parse({
  range: "24h",
  capturedWithoutBodies: 0,
  costCurrency: "EUR",
  sessions: [
    {
      id: UUID,
      startMs: Date.now() - 3_600_000,
      lastMs: Date.now(),
      requests: 3,
      messages: 9,
      promptTokens: 12000,
      totalTokens: 15400,
      models: ["glm-5.3"],
      clientName: "claude",
      clientProject: "irori",
      clientAgentType: "main",
      sourceAddrs: ["127.0.0.1"],
      compacted: false,
      truncated: false,
      costMinor: 250,
    },
  ],
});

const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  let body: unknown = {};
  if (url.includes("/usage/chats")) body = chatsBody;
  else if (url.includes("/usage/clients")) body = { clients: [] };
  else if (url.includes("/api/v1/updates")) body = { baseline: null, nodes: [] };
  else if ([ "/setups", "/nodes", "/jobs", "/quants", "/health/findings", "/api/v1/bench" ].some((e) => url.includes(e))) body = [];
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
});

describe("ChatsView shaped tier", () => {
  it("renders a session row with client, model and tokens", async () => {
    vi.stubGlobal("fetch", fetchStub);
    window.location.hash = "#/chats";
    const { default: ChatsView } = await import("../src/components/ChatsView.vue");
    const w = mount(ChatsView as never);
    await new Promise((r) => setTimeout(r, 120));
    const text = w.text();
    expect(text).toContain("claude");
    expect(text).toContain("15k tok");
    expect(text).toContain("€2.50"); // IR-076: session cost column
    w.unmount();
    window.location.hash = "";
  });
});
