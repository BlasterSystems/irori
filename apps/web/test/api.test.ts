import { describe, expect, it, vi } from "vitest";
import { fetchNodeLlm, fetchLlmHistory, fetchNodes } from "../src/api";

const VALID_NODE = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "spark2",
  kind: "spark",
  role: "worker",
  host: "10.0.30.21",
  enabled: true,
  agentVersion: "0.1.0",
  online: true,
  lastSeenAt: "2026-10-17T12:00:00.000Z",
  sortOrder: 1,
  llmPorts: [],
  nasRoot: null,
  createdAt: "2026-10-16T09:00:00.000Z",
  updatedAt: "2026-10-17T12:00:00.000Z",
};

function mockFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("fetchNodes", () => {
  it("parses a node array and tolerates extra fields", async () => {
    vi.stubGlobal("fetch", mockFetch(200, [{ ...VALID_NODE, futureField: true }]));
    const nodes = await fetchNodes();
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ name: "spark2", kind: "spark", role: "worker" });
    expect((nodes[0] as Record<string, unknown>).futureField).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("throws on non-OK responses", async () => {
    vi.stubGlobal("fetch", mockFetch(500, { error: "boom" }));
    await expect(fetchNodes()).rejects.toThrow("HTTP 500");
    vi.unstubAllGlobals();
  });

  it("throws when the body is not an array", async () => {
    vi.stubGlobal("fetch", mockFetch(200, { nodes: [] }));
    await expect(fetchNodes()).rejects.toThrow("expected a JSON array");
    vi.unstubAllGlobals();
  });

  it("throws when an item fails the node schema", async () => {
    const { host: _host, ...invalid } = VALID_NODE;
    vi.stubGlobal("fetch", mockFetch(200, [invalid]));
    await expect(fetchNodes()).rejects.toThrow();
    vi.unstubAllGlobals();
  });

  it("re-attaches configured llm ports from the raw payload", async () => {
    vi.stubGlobal("fetch", mockFetch(200, [{ ...VALID_NODE, llmPorts: [8000, 8001, 8080.5, "x"] }]));
    const nodes = await fetchNodes();
    expect(nodes[0]).toMatchObject({ llmPorts: [8000, 8001] });
    vi.unstubAllGlobals();
  });

  it("defaults llmPorts to [] when the payload omits them", async () => {
    vi.stubGlobal("fetch", mockFetch(200, [VALID_NODE]));
    const nodes = await fetchNodes();
    expect(nodes[0]).toMatchObject({ llmPorts: [] });
    vi.unstubAllGlobals();
  });
});

/* ── Node LLM inference ───────────────────────────────────────────────── */

const LLM_PORT = {
  port: 8000,
  backend: "exl3",
  detected: true,
  model: "GLM-5.3-Flash-EXL3",
  decodeTps: 142.3,
  probedAtMs: 1_760_000_000_000,
  futureField: true,
};

describe("fetchNodeLlm", () => {
  it("parses the llm snapshot and applies schema defaults", async () => {
    vi.stubGlobal("fetch", mockFetch(200, { ports: [LLM_PORT], updatedAt: "2026-10-17T12:00:00.000Z" }));
    const res = await fetchNodeLlm("abc");
    expect(res.updatedAt).toBe("2026-10-17T12:00:00.000Z");
    expect(res.ports).toHaveLength(1);
    expect(res.ports[0]).toMatchObject({
      port: 8000,
      backend: "exl3",
      detected: true,
      host: "127.0.0.1", // schema default applied
      model: "GLM-5.3-Flash-EXL3",
      decodeTps: 142.3,
      queueRunning: null,
      engineMeta: null,
    });
    vi.unstubAllGlobals();
  });

  it("throws on non-OK responses (404 unknown node)", async () => {
    vi.stubGlobal("fetch", mockFetch(404, { error: "unknown" }));
    await expect(fetchNodeLlm("abc")).rejects.toThrow("HTTP 404");
    vi.unstubAllGlobals();
  });

  it("throws when ports is missing", async () => {
    vi.stubGlobal("fetch", mockFetch(200, { updatedAt: "x" }));
    await expect(fetchNodeLlm("abc")).rejects.toThrow("ports must be an array");
    vi.unstubAllGlobals();
  });

  it("throws when a port has an unknown backend", async () => {
    vi.stubGlobal("fetch", mockFetch(200, { ports: [{ ...LLM_PORT, backend: "magic" }] }));
    await expect(fetchNodeLlm("abc")).rejects.toThrow("known backend");
    vi.unstubAllGlobals();
  });
});

const LLM_HISTORY_POINT = {
  t: 1_760_000_000_000,
  decodeTps: 142.3,
  prefillTps: null,
  queueRunning: 3,
  queueWaiting: 12,
  kvCachePct: 78,
  ttftP95Ms: 84,
  samples: 60,
};

describe("fetchLlmHistory", () => {
  it("requests the llm history endpoint with the range and parses the body", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      new Response(
        JSON.stringify({
          granularity: "hour",
          series: [{ port: 8000, points: [{ ...LLM_HISTORY_POINT, extra: 1 }] }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await fetchLlmHistory("abc", "24h");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/nodes/abc/llm/history?range=24h");
    expect(res.granularity).toBe("hour");
    expect(res.series).toEqual([{ port: 8000, points: [LLM_HISTORY_POINT] }]);
    vi.unstubAllGlobals();
  });

  it("throws on non-OK responses", async () => {
    vi.stubGlobal("fetch", mockFetch(400, { error: "bad range" }));
    await expect(fetchLlmHistory("abc", "24h")).rejects.toThrow("HTTP 400");
    vi.unstubAllGlobals();
  });

  it("throws when a point metric is not a number or null", async () => {
    vi.stubGlobal("fetch", mockFetch(200, {
      granularity: "hour",
      series: [{ port: 8000, points: [{ ...LLM_HISTORY_POINT, decodeTps: "fast" }] }],
    }));
    await expect(fetchLlmHistory("abc", "24h")).rejects.toThrow(
      "llm history: point.decodeTps must be a number or null",
    );
    vi.unstubAllGlobals();
  });
});
