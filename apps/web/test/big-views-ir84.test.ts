// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";

/**
 * IRI-084: big-view mounts — ModelsView, ServeView, NodeDetail. The views
 * execute their whole <script setup> on mount; a path-aware fetch stub
 * returns harmless empty envelopes so loaders settle instead of throwing.
 */

vi.mock("../src/live", () => ({
  live: { on: () => () => {}, off: () => {}, send: () => {}, connected: false },
}));
vi.mock("../src/scrim", () => ({ vScrimClose: {} }));

afterEach(() => {
  vi.unstubAllGlobals();
  window.location.hash = "";
});

/** Path-aware empty envelopes: arrays where the views expect lists. */
const emptyOk = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  const body = url.includes("/setups") || url.includes("/nodes") || url.includes("/jobs") || url.includes("/quants") || url.includes("/models?") ? [] : {};
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
});

describe("big view mounts", () => {
  it("mounts ModelsView end to end", async () => {
    vi.stubGlobal("fetch", emptyOk);
    const { default: ModelsView } = await import("../src/components/ModelsView.vue");
    const w = mount(ModelsView as never);
    await new Promise((r) => setTimeout(r, 80));
    expect(w.exists()).toBe(true);
    w.unmount();
  });

  // ServeView + NodeDetail mounts need deeper prop/shape stubs — tracked as
  // the remaining view-mount work in IR-175 comments.
});
