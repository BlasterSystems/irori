// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nodeInfoSchema, type NodeInfo } from "@irori/core";

/**
 * IR-260: the identity meta line carries the bundle generation state —
 * "bundle: current" on a match, "bundle: behind (running …, expected …)"
 * prefix-truncated on a stale bundle, and "bundle: unknown" when either side
 * is missing (old agents render unknown, never a verdict).
 */

vi.mock("../src/live", async () => ({ live: (await import("./live-mock")).liveMock }));
vi.mock("../src/scrim", () => ({ vScrimClose: {} }));

afterEach(() => vi.unstubAllGlobals());

const UUID = "11111111-1111-4111-8111-111111111111";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

type BundleState = { running: string | null; expected: string | null; state: "current" | "behind" | "unknown" };

function makeNode(bundle?: BundleState): NodeInfo {
  return nodeInfoSchema.parse({
    id: UUID,
    name: "DGX-3",
    kind: "spark",
    role: "worker",
    host: "dgx3.lan",
    enabled: true,
    agentVersion: "0.7.0",
    online: true,
    lastSeenAt: new Date().toISOString(),
    sortOrder: 0,
    llmPorts: [],
    nasRoot: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...(bundle === undefined ? {} : { bundle }),
  });
}

function makeFetchStub() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    let body: unknown = {};
    if (url.includes("/history")) body = { granularity: "minute", points: [] };
    else if (url.includes("/models")) body = { report: null, updatedAt: null };
    else if (url.includes("/versions")) body = { agentVersion: "0.7.0", pin: null, versions: null, drift: [], updatedAt: new Date().toISOString() };
    else if (url.includes("/health/findings")) body = { findings: [] };
    else if (url.includes("/api/v1/jobs")) body = [];
    else if (["/setups", "/nodes", "/quants", "/api/v1/bench", "/api/v1/llm", "/cleanup"].some((e) => url.includes(e))) body = [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
}

async function mountWithNode(n: NodeInfo) {
  const { liveMock } = await import("./live-mock");
  (liveMock.nodes as Map<string, unknown>).set(UUID, n);
  vi.stubGlobal("fetch", makeFetchStub());
  const { default: NodeDetail } = await import("../src/components/NodeDetail.vue");
  const w = mount(NodeDetail as never, { props: { nodeId: UUID } } as never);
  await new Promise((r) => setTimeout(r, 120));
  return w;
}

describe("Node detail bundle state (IR-260)", () => {
  it("renders current when the running hash matches the served artifact", async () => {
    const w = await mountWithNode(makeNode({ running: SHA_A, expected: SHA_A, state: "current" }));
    expect(w.find("p.stat__sub.faint").text()).toContain("bundle: current");
    w.unmount();
  });

  it("renders behind with truncated hash prefixes on a stale bundle", async () => {
    const w = await mountWithNode(makeNode({ running: SHA_B, expected: SHA_A, state: "behind" }));
    expect(w.find("p.stat__sub.faint").text()).toContain("bundle: behind (running bbbbbbbb, expected aaaaaaaa)");
    w.unmount();
  });

  it("renders unknown when the node payload carries no bundle state (old hub)", async () => {
    const w = await mountWithNode(makeNode());
    expect(w.find("p.stat__sub.faint").text()).toContain("bundle: unknown");
    w.unmount();
  });
});
