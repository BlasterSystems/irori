import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchBenchActive, fetchBenchRuns } from "../src/bench";
import { fetchNodes } from "../src/api";

/**
 * IRI-084: fetch-wrapper contract tests — URL shapes, query params, error
 * propagation. The global fetch is stubbed per test.
 */

afterEach(() => vi.unstubAllGlobals());

describe("bench wrappers", () => {
  it("fetchBenchRuns encodes type + node filter", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify({ runs: [] }), { status: 200 })));
    await fetchBenchRuns("decode", { nodeId: "n1", limit: 5 });
    const url = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(url).toContain("/api/v1/bench/decode");
    expect(url).toContain("nodeId=n1");
    expect(url).toContain("limit=5");
  });

  it("fetchBenchActive hits the active endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ runs: [] }), { status: 200 })));
    await fetchBenchActive();
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string).toContain("/active");
  });

  it("propagates HTTP failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 503 })));
    await expect(fetchBenchRuns("decode")).rejects.toThrow();
  });
});

describe("api wrappers", () => {
  it("fetchNodes propagates failures with the status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
    await expect(fetchNodes()).rejects.toThrow(/500/);
  });
});
