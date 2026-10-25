import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AnalyticsSeries, LlmPortSnapshot, SseEvent } from "@irori/core";
import type { LlmHistoryPoint } from "../src/api";
import {
  computeNasData,
  computePower,
  feedLines,
  heroDataForPort,
  heroSpark,
  peakDecode,
  pickPrimaryPort,
  relativeTime,
} from "../src/overview";

function port(overrides: Partial<LlmPortSnapshot> = {}): LlmPortSnapshot {
  return {
    port: 8000,
    host: "127.0.0.1",
    backend: "exl3",
    detected: true,
    model: "GLM-5.3-Flash-EXL3",
    decodeTps: null,
    prefillTps: null,
    queueRunning: null,
    queueWaiting: null,
    kvCachePct: null,
    ttftP95Ms: null,
    e2eP95Ms: null,
    itlP95Ms: null,
    engineMeta: null,
    tokens: null,
    probedAtMs: 1,
    ...overrides,
  };
}

describe("pickPrimaryPort", () => {
  it("prefers the busiest serving port", () => {
    const busy = port({ port: 8000, decodeTps: 10 });
    const busier = port({ port: 8001, decodeTps: 142 });
    expect(pickPrimaryPort([busy, busier])?.port).toBe(8001);
  });

  it("falls back to a detected idle port, then to the first port", () => {
    expect(pickPrimaryPort([port({ decodeTps: null })])?.port).toBe(8000);
    // no detected port at all → first port wins (stable order)
    expect(pickPrimaryPort([port({ detected: false, model: null }), port({ port: 8001, detected: false, model: null })])?.port).toBe(8000);
    expect(pickPrimaryPort([])).toBeNull();
    expect(pickPrimaryPort(null)).toBeNull();
  });
});

describe("heroDataForPort", () => {
  it("maps one port snapshot to the six hero stats", () => {
    const hero = heroDataForPort(port({ decodeTps: 65, queueRunning: 2, kvCachePct: 32 }));
    expect(hero).toMatchObject({ port: 8000, backend: "exl3", model: "GLM-5.3-Flash-EXL3", decodeTps: 65, queueRunning: 2, kvCachePct: 32 });
    expect(hero.cacheHitPct).toBeNull();
  });
});

const HIST: LlmHistoryPoint[] = [
  { t: 1, decodeTps: 100, prefillTps: 2000, queueRunning: 1, queueWaiting: 0, kvCachePct: 50, ttftP95Ms: 80, samples: 5 },
  { t: 2, decodeTps: 168, prefillTps: null, queueRunning: 0, queueWaiting: 2, kvCachePct: 60, ttftP95Ms: 82, samples: 5 },
  { t: 3, decodeTps: null, prefillTps: 3100, queueRunning: null, queueWaiting: null, kvCachePct: null, ttftP95Ms: null, samples: 0 },
];

describe("hero spark + peak", () => {
  it("peaks at the highest decode sample", () => {
    expect(peakDecode(HIST)).toBe(168);
    expect(peakDecode([{ t: 1, decodeTps: null, prefillTps: null, queueRunning: null, queueWaiting: null, kvCachePct: null, ttftP95Ms: null, samples: 0 }])).toBeNull();
  });

  it("charts decode and prefill as two series over a shared zero-floored domain", () => {
    const chart = heroSpark(HIST);
    expect(chart.series.map((s) => s.label)).toEqual(["decode 30m", "prefill 30m"]);
    expect(chart.series[0]?.points).toEqual([100, 168, null]);
    expect(chart.series[1]?.points).toEqual([2000, null, 3100]);
    expect(chart.yMin).toBeLessThanOrEqual(0);
    expect(chart.paths.length).toBe(2);
  });
});

const SERIES: AnalyticsSeries[] = [
  {
    key: "a",
    label: "spark1",
    points: [
      { t: 1, watts: 80, coverage: 0.9 } as never,
      { t: 2, watts: 87, coverage: 0.98 } as never,
    ],
  },
  {
    key: "b",
    label: "spark2",
    points: [
      { t: 1, watts: null, coverage: null } as never,
      { t: 2, watts: 74, coverage: 0.95 } as never,
    ],
  },
];

describe("computePower", () => {
  it("takes the latest readable watts per node and sums the fleet", () => {
    const power = computePower(SERIES);
    expect(power.nodes).toEqual([
      { key: "a", label: "spark1", watts: 87, coverage: 0.98 },
      { key: "b", label: "spark2", watts: 74, coverage: 0.95 },
    ]);
    expect(power.fleetNow).toBe(161);
    expect(power.coverage).toBeCloseTo((0.98 + 0.95) / 2);
  });

  it("stays null when nothing is readable", () => {
    const power = computePower([{ key: "a", label: "spark1", points: [{ t: 1, watts: null, coverage: null } as never] }]);
    expect(power.fleetNow).toBeNull();
    expect(power.coverage).toBeNull();
    expect(power.nodes[0]?.watts).toBeNull();
  });
});

describe("computeNasData + relativeTime", () => {
  it("picks the largest mount for the store bar", () => {
    const nas = computeNasData(14, "2026-10-20T09:00:00.000Z", {
      storage: [
        { mount: "/", fs: "ext4", totalBytes: 100, usedBytes: 10 },
        { mount: "/mnt/nas", fs: "ext4", totalBytes: 8000, usedBytes: 2400 },
      ],
    } as never);
    expect(nas).toMatchObject({ modelCount: 14, storeUsedBytes: 2400, storeTotalBytes: 8000, storePct: 30 });
  });

  it("renders unknown model counts as null, not zero", () => {
    expect(computeNasData(null, null, null).modelCount).toBeNull();
  });

  it("formats relative time", () => {
    const now = Date.parse("2026-10-20T10:00:00.000Z");
    expect(relativeTime("2026-10-20T09:59:30.000Z", now)).toBe("30s ago");
    expect(relativeTime("2026-10-20T09:55:00.000Z", now)).toBe("5m ago");
    expect(relativeTime("2026-10-20T06:00:00.000Z", now)).toBe("4h ago");
    expect(relativeTime("2026-10-17T10:00:00.000Z", now)).toBe("3d ago");
    expect(relativeTime("not-a-date", now)).toBeNull();
    expect(relativeTime(null, now)).toBeNull();
  });
});

describe("feedLines", () => {
  const names = new Map([["a", "spark1"]]);
  const nodeName = (id: string): string => names.get(id) ?? "node";
  const nodeOnline = { type: "node-online", serverTimeMs: 1, nodeId: "a", agentVersion: "0.3.0" } as const;

  it("maps every event class into one feed", () => {
    const events: SseEvent[] = [
      nodeOnline,
      { type: "job", serverTimeMs: 2, nodeId: "a", jobId: "j", kind: "push", status: "succeeded", exitCode: 0, durationMs: 372_000 },
      { type: "thermal", serverTimeMs: 3, nodeId: "a", gpuIndex: 0, active: [] },
      { type: "thermal", serverTimeMs: 4, nodeId: "a", gpuIndex: 0, active: ["HW Slowdown"] },
      { type: "bench", serverTimeMs: 5, nodeId: "a", runId: "r", bench: "decode", status: "completed", progress: null },
      { type: "setup-state", serverTimeMs: 6, setupId: "s", status: "running", health: "healthy", lastError: null },
      { type: "setup-transfer", serverTimeMs: 7, setupId: "s", transferId: "t", stageIndex: 0, stageCount: 2, label: "GLM → spark2", nodeId: "a", jobId: null, status: "running", progress: { bytes: null, percent: 44, rateBytesPerSec: null, etaSeconds: null } },
      { type: "node-offline", serverTimeMs: 8, nodeId: "zzz", agentVersion: null },
    ];
    const lines = feedLines(events, nodeName);
    expect(lines.map((l) => l.text)).toEqual([
      "spark1 · online",
      "spark1 · push succeeded · 6m 12s",
      "spark1 · GPU0 throttle cleared",
      "spark1 · GPU0 throttle: HW Slowdown",
      "spark1 · decode bench completed",
      "setup · running · healthy",
      "transfer · GLM → spark2 running · 44%",
      "node · offline",
    ]);
  });

  it("caps at the requested length, newest last", () => {
    const events: SseEvent[] = Array.from({ length: 40 }, (_, i) => ({ ...nodeOnline, serverTimeMs: i }) as SseEvent);
    const lines = feedLines(events, nodeName, 30);
    expect(lines).toHaveLength(30);
    expect(lines[0]?.t).toBe(10);
    expect(lines.at(-1)?.t).toBe(39);
  });

  it("never renders snapshot/llm/heartbeat frames", () => {
    const lines = feedLines(
      [
        { type: "snapshot", serverTimeMs: 1, nodeId: "a", snapshot: {} as never },
        { type: "heartbeat", serverTimeMs: 2 },
      ],
      nodeName,
    );
    expect(lines).toEqual([]);
  });
});

// ─── source pins (DOM-free, per chrome-markup convention) ───────────────────

const OVERVIEW_SRC = readFileSync(new URL("../src/components/OverviewView.vue", import.meta.url), "utf8");

describe("OverviewView source pins", () => {
  it("keeps the page contract: per-process heroes, nodes grid, one feed, add-node", () => {
    expect(OVERVIEW_SRC).toContain("heroProcesses");
    expect(OVERVIEW_SRC).toContain('class="statgrid statgrid--6"');
    expect(OVERVIEW_SRC).toContain(">Telemetry</h3>");
    expect(OVERVIEW_SRC).toContain("Add node…</button>");
    expect(OVERVIEW_SRC).toContain('class="hero-grid"');
    expect(OVERVIEW_SRC).toContain('fetchLlmHistory(nodeId, "30m")');
  });

  it("has no fleet lens filter and no head-anchored hero", () => {
    expect(OVERVIEW_SRC).not.toContain('const lens = ref<Lens>');
    expect(OVERVIEW_SRC).not.toContain('aria-label="Lens"');
    expect(OVERVIEW_SRC).not.toContain("60m window");
  });
});
