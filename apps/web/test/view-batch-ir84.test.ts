// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";

/**
 * IRI-084: zero-coverage view mounts. Path-aware fetch envelopes settle the
 * loaders; the complete live fake feeds the SSE singletons.
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
  else if (url.includes("/api/v1/community")) body = { sources: [], topics: [], items: [], releases: [] };
  else if (url.includes("/api/v1/updates")) body = { baseline: null, nodes: [] };
  else if (url.includes("/logs")) body = { rows: [] };
  else if ([ "/setups", "/nodes", "/jobs", "/quants", "/usage/retries", "/health/findings", "/api/v1/bench" ].some((e) => url.includes(e))) body = [];
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
});

const mounts = {
  overview: async () => (await import("../src/components/OverviewView.vue")).default,
  chats: async () => (await import("../src/components/ChatsView.vue")).default,
  logs: async () => (await import("../src/components/LogsView.vue")).default,
  community: async () => (await import("../src/components/CommunityView.vue")).default,
};

describe("zero-coverage view mounts", () => {
  for (const [name, loader] of Object.entries(mounts)) {
    it(`mounts ${name}`, async () => {
      vi.stubGlobal("fetch", emptyOk);
      const View = (await loader()) as never;
      const w = mount(View);
      await new Promise((r) => setTimeout(r, 80));
      expect(w.exists()).toBe(true);
      w.unmount();
    });
  }
});
