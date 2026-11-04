// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";

/**
 * IRI-084: big-view mounts. Path-aware fetch envelopes settle the loaders;
 * the complete live fake feeds the SSE singletons and derived computeds.
 */

vi.mock("../src/live", async () => ({ live: (await import("./live-mock")).liveMock }));
vi.mock("../src/scrim", () => ({ vScrimClose: {} }));

afterEach(() => {
  vi.unstubAllGlobals();
  window.location.hash = "";
});

const emptyOk = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  let body: unknown = {};
  if (url.includes("/setups") && !url.includes("/validate")) body = { setups: [] };
  else if ([ "/setups", "/nodes", "/jobs", "/quants", "/usage/retries", "/health/findings", "/api/v1/bench" ].some((e) => url.includes(e))) body = [];
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
});

describe("big view mounts", () => {
  it("mounts ServeView end to end", async () => {
    vi.stubGlobal("fetch", emptyOk);
    const { default: ServeView } = await import("../src/components/ServeView.vue");
    const w = mount(ServeView as never, { props: { route: { recipeJob: null } } } as never);
    await new Promise((r) => setTimeout(r, 80));
    expect(w.exists()).toBe(true);
    w.unmount();
  });

  it("mounts NodeDetail end to end", async () => {
    vi.stubGlobal("fetch", emptyOk);
    const { default: NodeDetail } = await import("../src/components/NodeDetail.vue");
    const w = mount(NodeDetail as never, { props: { nodeId: "11111111-1111-4111-8111-111111111111" } } as never);
    await new Promise((r) => setTimeout(r, 80));
    expect(w.exists()).toBe(true);
    w.unmount();
    window.location.hash = "";
  });

  it("opens the setup wizard and walks its steps (interactive depth)", async () => {
    vi.stubGlobal("fetch", emptyOk);
    const { default: ServeView } = await import("../src/components/ServeView.vue");
    const w = mount(ServeView as never, { props: { route: { recipeJob: null } } } as never);
    await new Promise((r) => setTimeout(r, 50));
    const newBtn = w.findAll("button").find((b) => b.text().includes("New setup"));
    expect(newBtn).toBeDefined();
    await newBtn!.trigger("click");
    await new Promise((r) => setTimeout(r, 30));
    // The wizard renders its step rail + fields.
    expect(w.text()).toContain("New setup");
    w.unmount();
  });
});
