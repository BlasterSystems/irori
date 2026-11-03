// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";

/**
 * IRI-084: big-view mounts. The views execute their whole <script setup> on
 * mount — stubbing live (SSE singleton) and fetch (empty envelopes) covers
 * the load/parse/render paths that string-pin tests never touched.
 */

vi.mock("../src/live", () => ({
  live: { on: () => () => {}, off: () => {}, send: () => {}, connected: false },
}));
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
    vi.stubGlobal("fetch", vi.fn(emptyOk));
    window.location.hash = "#/usage?tab=retries&range=24h";
    const { default: UsageView } = await import("../src/components/UsageView.vue");
    const w = mount(UsageView as never);
    await new Promise((r) => setTimeout(r, 50));
    expect(w.text()).toContain("Retry waste");
    w.unmount();
    window.location.hash = "";
  });
});
