// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";

/**
 * IRI-084: big-view mounts. The views execute their whole <script setup> on
 * mount — stubbing live (SSE singleton) and fetch (empty envelopes) covers
 * the load/parse/render paths that string-pin tests never touched.
 */

vi.mock("../src/live", async () => ({ live: (await import("./live-mock")).liveMock }));
vi.mock("../src/scrim", () => ({ vScrimClose: {} }));

const emptyOk = async () => new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });

describe("UsageView mount", () => {
  it("mounts the usage view end to end", async () => {
    vi.stubGlobal("fetch", vi.fn(emptyOk));
    const { default: UsageView } = await import("../src/components/UsageView.vue");
    const w = mount(UsageView as never);
    await new Promise((r) => setTimeout(r, 50));
    expect(w.exists()).toBe(true);
    w.unmount();
  });

  it("renders the retry-waste tab (failing-before: it sat after the final v-else and could never render)", async () => {
    vi.stubGlobal("fetch", emptyOk);
    window.location.hash = "#/usage?tab=retries&range=24h";
    const { default: UsageView } = await import("../src/components/UsageView.vue");
    const w = mount(UsageView as never);
    await new Promise((r) => setTimeout(r, 50));
    expect(w.text()).toContain("Retry waste");
    w.unmount();
    window.location.hash = "";
  });

  it("renders every tab branch (interactive depth: each template block executes)", async () => {
    vi.stubGlobal("fetch", emptyOk);
    window.location.hash = "#/usage";
    const { default: UsageView } = await import("../src/components/UsageView.vue");
    const w = mount(UsageView as never);
    await new Promise((r) => setTimeout(r, 50));
    for (const tab of ["overview", "requests", "errors", "agents", "tools", "models", "retries"] as const) {
      const btn = w.findAll("button").find((b) => b.text().toLowerCase() === tab);
      expect(btn, `tab button ${tab}`).toBeDefined();
      await btn!.trigger("click");
      await new Promise((r) => setTimeout(r, 30));
      expect(w.exists()).toBe(true);
    }
    w.unmount();
    window.location.hash = "";
  });
});
