// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nodeInfoSchema, nodeInventorySchema } from "@irori/core";

/**
 * IR-253: a section with no content and no action renders nothing. Mounted
 * with a node that has no inference ports, no update report and no snapshot:
 * the Inference cell, the Updates card and every "no data yet" chart card are
 * ABSENT (the permanent fillers they replaced are gone too), while transient
 * and actionable states stay.
 */

vi.mock("../src/live", async () => ({ live: (await import("./live-mock")).liveMock }));
vi.mock("../src/scrim", () => ({ vScrimClose: {} }));

afterEach(() => vi.unstubAllGlobals());

const UUID = "11111111-1111-4111-8111-111111111111";

const node = nodeInfoSchema.parse({
  id: UUID,
  name: "DGX-9",
  kind: "spark",
  role: "worker",
  host: "dgx9.lan",
  enabled: true,
  agentVersion: "0.7.0",
  online: true,
  lastSeenAt: new Date().toISOString(),
  sortOrder: 0,
  llmPorts: [],
  nasRoot: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const report = nodeInventorySchema.parse({
  generatedAtMs: Date.now(),
  store: null,
  local: [
    {
      user: "operator",
      home: "/home/operator",
      cacheDir: "/home/operator/.cache/huggingface/hub",
      modelctlVersion: null,
      error: null,
      models: [],
    },
  ],
});

const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  let body: unknown = {};
  if (url.includes("/models")) body = { report, updatedAt: new Date().toISOString() };
  else if (url.includes("/history")) body = { granularity: "minute", points: [] };
  else if (url.includes("/versions")) body = { agentVersion: "0.7.0", pin: null, versions: null, drift: [], updatedAt: new Date().toISOString() };
  else if (url.includes("/api/v1/updates")) body = { baseline: null, nodes: [] };
  else if (url.includes("/health/findings")) body = { findings: [] };
  else if (url.includes("/api/v1/jobs")) body = [];
  else if ([ "/setups", "/nodes", "/quants", "/api/v1/bench", "/api/v1/llm", "/cleanup" ].some((e) => url.includes(e))) body = [];
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
});

describe("IR-253: contentless sections render nothing", () => {
  it("hides the inference cell, updates card and chart cards when they have no data", async () => {
    const { liveMock } = await import("./live-mock");
    (liveMock.nodes as Map<string, unknown>).set(UUID, node);
    vi.stubGlobal("fetch", fetchStub);
    const { default: NodeDetail } = await import("../src/components/NodeDetail.vue");
    const w = mount(NodeDetail as never, { props: { nodeId: UUID } } as never);
    await new Promise((r) => setTimeout(r, 120));
    const text = w.text();

    expect(text).not.toContain("no LLM ports configured");
    expect(text).not.toContain("no update report yet");
    expect(text).not.toContain("no data yet");
    expect(text).not.toContain("Inference");
    // Transient and actionable states stay.
    expect(text).toContain("waiting for first snapshot");
    expect(text).toContain("Install modelctl for operator");
    w.unmount();
  });
});
