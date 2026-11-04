// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { chatTurnSchema, chatsResponseSchema } from "@irori/core";

/**
 * IRI-084: ChatsView detail tier — opening a session fetches the detail and
 * renders the turns (text, tool calls, truncation chip).
 */

vi.mock("../src/live", async () => ({ live: (await import("./live-mock")).liveMock }));
vi.mock("../src/scrim", () => ({ vScrimClose: {} }));

afterEach(() => {
  vi.unstubAllGlobals();
  window.location.hash = "";
});

const UUID = "11111111-1111-4111-8111-111111111111";
const NOW = Date.now();

const sessionsBody = chatsResponseSchema.parse({
  range: "24h",
  capturedWithoutBodies: 0,
  costCurrency: "EUR",
  sessions: [
    { id: UUID, startMs: NOW - 3600_000, lastMs: NOW, requests: 2, messages: 3, promptTokens: 500, totalTokens: 900, models: ["glm-5.3"], clientName: "claude", clientProject: "irori", clientAgentType: "main", sourceAddrs: ["127.0.0.1"], compacted: true, truncated: false, costMinor: 120 },
  ],
});

const turns = [
  chatTurnSchema.parse({ requestId: UUID, role: "user", ts: NOW, model: "glm-5.3", kind: "message", text: "list the nodes", toolCalls: [], toolResult: null, imageUrls: [], truncated: false }),
  chatTurnSchema.parse({ requestId: UUID, role: "tool", ts: NOW, model: "glm-5.3", kind: "response", text: null, toolCalls: [{ id: "call_1", name: "web_search", arguments: "{\"q\":\"dgx spark\"}" }], toolResult: { callId: "call_1", error: false }, imageUrls: [], truncated: false }),
  chatTurnSchema.parse({ requestId: UUID, role: "user", ts: NOW, model: "glm-5.3", kind: "message", text: "here are the nodes…", toolCalls: [], toolResult: null, imageUrls: [], truncated: true }),
];

const detailBody = {
  id: UUID, startMs: NOW - 3600_000, lastMs: NOW, requests: 2, compacted: true, truncated: false,
  clientName: "claude", clientProject: "irori", clientAgentType: "main", sourceAddrs: ["127.0.0.1"],
  models: ["glm-5.3"], turns,
};

const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  let body: unknown = {};
  if (url.startsWith("/api/v1/usage/chats/")) body = detailBody;
  else if (url.startsWith("/api/v1/usage/chats")) body = sessionsBody;
  else if (url.includes("/usage/clients")) body = { clients: [] };
  else if (url.includes("/api/v1/updates")) body = { baseline: null, nodes: [] };
  else if ([ "/setups", "/nodes", "/jobs", "/quants", "/health/findings", "/api/v1/bench" ].some((e) => url.includes(e))) body = [];
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
});

describe("ChatsView detail tier", () => {
  it("opens a session and renders its turns", async () => {
    vi.stubGlobal("fetch", fetchStub);
    window.location.hash = "#/chats";
    const { default: ChatsView } = await import("../src/components/ChatsView.vue");
    const w = mount(ChatsView as never);
    await new Promise((r) => setTimeout(r, 100));
    await w.findAll("button, .row, tr").filter((n) => n.text().includes("claude"))[0]!.trigger("click");
    await new Promise((r) => setTimeout(r, 120));
    const text = w.text();
    expect(text).toContain("list the nodes");
    expect(text).toContain("web_search");
    expect(text).toContain("here are the nodes…");
    expect(text).toContain("compaction detected"); // compacted chip
    expect(text).toContain("truncated");
    w.unmount();
    window.location.hash = "";
  });
});
