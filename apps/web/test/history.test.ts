import { describe, expect, it, vi } from "vitest";
import {
  fetchHistory,
  parseHistoryResponse,
  type HistoryPoint,
} from "../src/api";

const POINT: HistoryPoint = {
  t: 1_760_000_000_000,
  cpu: 18,
  cpuTemp: { min: 55, avg: 62, max: 71 },
  mem: 96 * 2 ** 30,
  gpu: 34,
  gpuTemp: { min: 58, avg: 61, max: 66 },
  gpuPowerW: 74,
  gpuMem: 42.1 * 2 ** 30,
  netRx: 184.4e6,
  netTx: 12e6,
  samples: 60,
};

describe("parseHistoryResponse", () => {
  it("parses granularity and points", () => {
    const res = parseHistoryResponse({ granularity: "hour", points: [POINT] });
    expect(res.granularity).toBe("hour");
    expect(res.points).toHaveLength(1);
    expect(res.points[0]).toEqual(POINT);
  });

  it("tolerates unknown keys on the envelope and points", () => {
    const res = parseHistoryResponse({
      granularity: "day",
      future: true,
      points: [{ ...POINT, future: true }],
    });
    expect(res.points[0]).toEqual(POINT);
  });

  it("accepts null metrics and bands", () => {
    const res = parseHistoryResponse({
      granularity: "minute",
      points: [
        {
          ...POINT,
          cpu: null,
          cpuTemp: { min: null, avg: null, max: null },
          samples: null,
        },
      ],
    });
    expect(res.points[0]?.cpu).toBeNull();
    expect(res.points[0]?.cpuTemp).toEqual({ min: null, avg: null, max: null });
  });

  it.each([
    [null, "expected a JSON object"],
    [[], "expected a JSON object"],
    [{ points: [] }, "granularity"],
    [{ granularity: "" }, "granularity"],
    [{ granularity: "hour" }, "points"],
    [{ granularity: "hour", points: {} }, "points"],
    [{ granularity: "hour", points: [5] }, "point must be an object"],
    [{ granularity: "hour", points: [{ ...POINT, t: "x" }] }, "point.t"],
    [{ granularity: "hour", points: [{ ...POINT, cpu: "18" }] }, "point.cpu"],
    [{ granularity: "hour", points: [{ ...POINT, mem: "x" }] }, "point.mem"],
    [{ granularity: "hour", points: [{ ...POINT, gpu: "x" }] }, "point.gpu"],
    [
      { granularity: "hour", points: [{ ...POINT, gpuPowerW: "x" }] },
      "point.gpuPowerW",
    ],
    [{ granularity: "hour", points: [{ ...POINT, gpuMem: "x" }] }, "point.gpuMem"],
    [{ granularity: "hour", points: [{ ...POINT, netRx: "x" }] }, "point.netRx"],
    [{ granularity: "hour", points: [{ ...POINT, netTx: "x" }] }, "point.netTx"],
    [
      { granularity: "hour", points: [{ ...POINT, samples: "x" }] },
      "point.samples",
    ],
    [
      { granularity: "hour", points: [{ ...POINT, cpuTemp: { min: 1, avg: 2 } }] },
      "cpuTemp",
    ],
    [{ granularity: "hour", points: [{ ...POINT, gpuTemp: 61 }] }, "gpuTemp"],
  ])("rejects malformed payloads", (body, message) => {
    expect(() => parseHistoryResponse(body)).toThrow(message);
  });
});

describe("fetchHistory", () => {
  it("requests the node history endpoint with the range and parses the body", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ granularity: "hour", points: [POINT] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await fetchHistory(
      "00000000-0000-4000-8000-000000000001",
      "24h",
    );
    expect(res.points).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/nodes/00000000-0000-4000-8000-000000000001/history?range=24h",
      expect.objectContaining({
        headers: { accept: "application/json" },
      }),
    );
    vi.unstubAllGlobals();
  });

  it("throws on non-OK responses (400 bad range, 404 unknown node)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "bad range" }), { status: 400 })),
    );
    await expect(fetchHistory("n1", "7d")).rejects.toThrow("HTTP 400");
    vi.unstubAllGlobals();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 404 })),
    );
    await expect(fetchHistory("n1", "1h")).rejects.toThrow("HTTP 404");
    vi.unstubAllGlobals();
  });
});
