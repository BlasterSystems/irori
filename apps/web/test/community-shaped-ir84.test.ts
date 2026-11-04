// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import type { CommunityViewData } from "../src/api";

/**
 * IRI-084: CommunityView shaped tier — topics + items render, the curate
 * POST hides, and an open breaker shows its degraded chip.
 */

vi.mock("../src/live", async () => ({ live: (await import("./live-mock")).liveMock }));
vi.mock("../src/scrim", () => ({ vScrimClose: {} }));

afterEach(() => {
  vi.unstubAllGlobals();
  window.location.hash = "";
});

const UUID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date().toISOString();

const body: CommunityViewData = {
  sources: [{ source: "forum-gb10", ok: true, failures: 0, lastFetchedAt: NOW, breakerOpen: false }],
  topics: [{ topic: "thermals", count: 3 }],
  items: [{ id: UUID, source: "forum-gb10", title: "GB10 thermal paste guide", summary: "how to repaste", canonicalUrl: "https://x", author: "a", publishedAt: NOW, score: 42, pinned: false, seen: false, embedOnly: false }],
  releases: [],
};

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

describe("CommunityView shaped tier", () => {
  it("renders topics and item titles; the hide button POSTs curate", async () => {
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => json(String(input).startsWith("/api/v1/community/") ? { ok: true } : body));
    vi.stubGlobal("fetch", fetchStub);
    const { default: CommunityView } = await import("../src/components/CommunityView.vue");
    const w = mount(CommunityView as never);
    await new Promise((r) => setTimeout(r, 120));
    const text = w.text();
    expect(text).toContain("GB10 thermal paste guide");
    expect(text).toContain("thermals");
    const buttons = w.findAll("button").filter((b) => b.text() === "hide");
    expect(buttons.length).toBe(1);
    await buttons[0]!.trigger("click");
    await new Promise((r) => setTimeout(r, 60));
    expect(fetchStub).toHaveBeenCalledWith("/api/v1/community/" + UUID, expect.objectContaining({ method: "POST" }));
    w.unmount();
  });

  it("shows the degraded chip when a breaker is open", async () => {
    const broken: CommunityViewData = { sources: [{ source: "forum-gb10", ok: false, failures: 9, lastFetchedAt: null, breakerOpen: true }], topics: [], items: [], releases: [] };
    vi.stubGlobal("fetch", vi.fn(async () => json(broken)));
    const { default: CommunityView } = await import("../src/components/CommunityView.vue");
    const w = mount(CommunityView as never);
    await new Promise((r) => setTimeout(r, 120));
    expect(w.find(".chip--warn").exists()).toBe(true);
    expect(w.text()).toContain("no pollers reported yet" === "" ? "" : "degraded");
    w.unmount();
  });
});
