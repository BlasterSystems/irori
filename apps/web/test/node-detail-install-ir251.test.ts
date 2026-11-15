// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nodeInfoSchema, nodeInventorySchema } from "@irori/core";

/**
 * IR-251 regression: the "Install modelctl for <user>" button must actually
 * dispatch. installModelctl() guarded on the nodeBusyJob COMPUTED without
 * `.value` in script, so the guard was always true and every click silently
 * no-oped — the button looked enabled (the template unwraps correctly) while
 * no job was ever created (live audit showed zero modelctl-install rows).
 */

vi.mock("../src/live", async () => ({ live: (await import("./live-mock")).liveMock }));
vi.mock("../src/scrim", () => ({ vScrimClose: {} }));

afterEach(() => vi.unstubAllGlobals());

const UUID = "11111111-1111-4111-8111-111111111111";

const node = nodeInfoSchema.parse({
  id: UUID,
  name: "DGX-3",
  kind: "spark",
  role: "worker",
  host: "dgx3.as267.com",
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
      user: "piresbruno",
      home: "/home/piresbruno",
      cacheDir: "/home/piresbruno/.cache/huggingface/hub",
      modelctlVersion: null,
      error: null,
      models: [],
    },
  ],
});

const job = {
  id: "22222222-2222-4222-8222-222222222222",
  nodeId: UUID,
  kind: "modelctl-install" as const,
  status: "queued" as const,
  params: { user: "piresbruno" },
  exitCode: null,
  createdAt: new Date().toISOString(),
  startedAt: null,
  finishedAt: null,
};

const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  let body: unknown = {};
  if (method === "POST" && url.endsWith(`/api/v1/nodes/${UUID}/jobs`)) body = { job };
  else if (method === "GET" && url.includes("/api/v1/jobs/")) body = { job, output: [] };
  else if (url.includes("/api/v1/jobs")) body = [];
  else if (url.includes("/models")) body = { report, updatedAt: new Date().toISOString() };
  else if (url.includes("/versions")) body = { agentVersion: "0.7.0", pin: null, versions: null, drift: [], updatedAt: new Date().toISOString() };
  else if (url.includes("/api/v1/updates")) body = { baseline: null, nodes: [] };
  else if (url.includes("/health/findings")) body = { findings: [] };
  else if ([ "/setups", "/nodes", "/quants", "/api/v1/bench", "/api/v1/llm", "/cleanup" ].some((e) => url.includes(e))) body = [];
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
});

describe("IR-251: install modelctl dispatches", () => {
  it("clicking Install modelctl POSTs a modelctl-install job for the cache user", async () => {
    const { liveMock } = await import("./live-mock");
    (liveMock.nodes as Map<string, unknown>).set(UUID, node);
    vi.stubGlobal("fetch", fetchStub);
    const { default: NodeDetail } = await import("../src/components/NodeDetail.vue");
    const w = mount(NodeDetail as never, { props: { nodeId: UUID } } as never);
    await new Promise((r) => setTimeout(r, 120));

    const btn = w.findAll("button").find((b) => b.text() === "Install modelctl for piresbruno");
    expect(btn, "install button renders for a cache row with modelctlVersion null").toBeDefined();

    await btn!.trigger("click");
    await new Promise((r) => setTimeout(r, 80));

    const posts = fetchStub.mock.calls.filter(
      ([u, init]) => String(u).endsWith(`/api/v1/nodes/${UUID}/jobs`) && (init as RequestInit | undefined)?.method === "POST",
    );
    expect(posts, "the click dispatches exactly one job").toHaveLength(1);
    expect(JSON.parse(String((posts[0]![1] as RequestInit).body))).toEqual({
      kind: "modelctl-install",
      params: { user: "piresbruno" },
    });
    w.unmount();
  });
});
