// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { logRowSchema } from "@irori/core";

/**
 * IRI-084: LogsView shaped tier — a schema-parsed page renders rows with
 * level chips, the summary counts, and the live-tail chip.
 */

vi.mock("../src/live", async () => ({ live: (await import("./live-mock")).liveMock }));
vi.mock("../src/scrim", () => ({ vScrimClose: {} }));

afterEach(() => {
  vi.unstubAllGlobals();
  window.location.hash = "";
});

const UUID = "11111111-1111-4111-8111-111111111111";
const nowIso = new Date().toISOString();

const row = (over: Record<string, unknown>) =>
  logRowSchema.parse({
    id: "42", eventId: UUID, nodeId: UUID, ts: nowIso, eventTs: Date.now(),
    scope: "hub", setupId: null, runId: null, jobId: null,
    level: "info", source: "system", seq: null, line: "boot migrate ok", ...over,
  });

const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  let body: unknown = {};
  if (url.startsWith("/api/v1/logs?")) body = { rows: [row({ id: "42", level: "error", line: "ECONNREFUSED 8081" }), row({ id: "41" })], nextCursor: null, latestId: "42", truncated: false };
  else if (url.startsWith("/api/v1/logs/summary")) body = { counts: { trace: 0, debug: 0, info: 1, warn: 0, error: 1 }, total: 2, truncated: false };
  else if (url.includes("/api/v1/updates")) body = { baseline: null, nodes: [] };
  else if ([ "/setups", "/nodes", "/jobs", "/quants", "/health/findings", "/api/v1/bench" ].some((e) => url.includes(e))) body = [];
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
});

describe("LogsView shaped tier", () => {
  it("renders rows with their line text and the level summary", async () => {
    vi.stubGlobal("fetch", fetchStub);
    window.location.hash = "#/logs";
    const { default: LogsView } = await import("../src/components/LogsView.vue");
    const w = mount(LogsView as never);
    await new Promise((r) => setTimeout(r, 120));
    const text = w.text();
    expect(text).toContain("ECONNREFUSED 8081");
    expect(text).toContain("boot migrate ok");
    expect(text).toContain("2"); // summary total
    w.unmount();
  });

  it("surfaces load errors instead of a blank table", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    window.location.hash = "#/logs";
    const { default: LogsView } = await import("../src/components/LogsView.vue");
    const w = mount(LogsView as never);
    await new Promise((r) => setTimeout(r, 120));
    expect(w.text()).toContain("GET /api/v1/logs");
    w.unmount();
  });
});
