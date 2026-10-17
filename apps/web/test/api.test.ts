import { describe, expect, it, vi } from "vitest";
import { fetchNodes } from "../src/api";

const VALID_NODE = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "spark2",
  kind: "spark",
  role: "worker",
  host: "10.50.50.21",
  enabled: true,
  agentVersion: "0.1.0",
  online: true,
  lastSeenAt: "2026-10-17T12:00:00.000Z",
  sortOrder: 1,
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
});
