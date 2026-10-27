import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AnalyticsPoint, AnalyticsSeries, LlmPortSnapshot, SseEvent } from "@irori/core";
import type { LlmHistoryPoint } from "../src/api";
import {
  binFleetPower,
  computeNasData,
  computePower,
  feedLines,
  fleetEnergyKwh,
  fleetPowerSeries,
  fmtEnergy,
  heroDataForPort,
  heroSpark,
  OVERVIEW_RANGES,
  peakDecode,
  pickPrimaryPort,
  powerBarSlot,
  relativeTime,
  tokenCostOf,
  tokenTotals,
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

  it("charts decode and prefill as two series with independent zero-floored scales", () => {
    const chart = heroSpark(HIST, "30m");
    expect(chart.series.map((s) => s.label)).toEqual(["decode 30m", "prefill 30m"]);
    expect(chart.series[0]?.points).toEqual([100, 168, null]);
    expect(chart.series[1]?.points).toEqual([2000, null, 3100]);
    // IR-110: each series owns its scale (decode ≤168, prefill ≤3100); the
    // chart-level domain is the union and prefill is not flattened by decode.
    expect(chart.series[0]?.scale).toEqual({ min: 0, max: 168 });
    expect(chart.series[1]?.scale).toEqual({ min: 0, max: 3100 });
    expect(chart.yMin).toBe(0);
    expect(chart.yMax).toBe(3100);
    expect(chart.paths.length).toBe(2);
    expect(chart.paths[0]?.d).toBe("M0.00,52.62 L300.00,0.00");
    expect(chart.paths[1]?.d).toBe("M0.00,46.13 l0.01,0 M600.00,0.00 l0.01,0");
  });

  it("labels follow the selected range", () => {
    expect(heroSpark(HIST, "24h").series.map((s) => s.label)).toEqual(["decode 24h", "prefill 24h"]);
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

  it("renders job-progress output with node and kind from the job context (IR-102)", () => {
    const events: SseEvent[] = [
      { type: "job-progress", serverTimeMs: 2, nodeId: "a", jobId: "j", seq: 1, line: " 163.6G 79%  111 MB/s  0:05:19" },
    ];
    const lines = feedLines(events, nodeName, 30, (id) =>
      id === "j" ? { nodeId: "a", kind: "sync-local" } : undefined,
    );
    expect(lines.map((l) => l.text)).toEqual(["spark1 · sync-local:  163.6G 79%  111 MB/s  0:05:19"]);
  });

  it("falls back to the frame's node when no job context exists (IR-102)", () => {
    const events: SseEvent[] = [
      { type: "job-progress", serverTimeMs: 2, nodeId: "a", jobId: "unknown", seq: 1, line: "progress line" },
    ];
    const lines = feedLines(events, nodeName);
    expect(lines.map((l) => l.text)).toEqual(["spark1 · progress line"]);
  });
});

// ─── source pins (DOM-free, per chrome-markup convention) ───────────────────

const OVERVIEW_SRC = readFileSync(new URL("../src/components/OverviewView.vue", import.meta.url), "utf8");

describe("OverviewView source pins", () => {
  it("keeps the page contract: per-process heroes, nodes grid, one feed, add-node", () => {
    expect(OVERVIEW_SRC).toContain("heroProcesses");
    expect(OVERVIEW_SRC).toContain("statgrid statgrid--6");
    expect(OVERVIEW_SRC).toContain(">Telemetry</h3>");
    expect(OVERVIEW_SRC).toContain("Add node…</button>");
    expect(OVERVIEW_SRC).toContain('class="hero-grid"');
    expect(OVERVIEW_SRC).toContain("fetchLlmHistory(nodeId, range.value)");
  });

  it("leads with nodes above power/nas and auto-scrolls the feed (IR-108/IR-109)", () => {
    // IR-108: the nodes section swapped places with the fleet power/NAS row.
    expect(OVERVIEW_SRC.indexOf(">Nodes</h2>")).toBeGreaterThan(-1);
    expect(OVERVIEW_SRC.indexOf(">Nodes</h2>")).toBeLessThan(OVERVIEW_SRC.indexOf("Fleet power + NAS store"));
    // IR-109: the newest-last feed scrolls to the latest line.
    expect(OVERVIEW_SRC).toContain('ref="feedLog"');
    expect(OVERVIEW_SRC).toContain("feedLog.value.scrollTop = feedLog.value.scrollHeight");
  });

  it("spans a single serving process across the full row (no dead column)", () => {
    expect(OVERVIEW_SRC).toContain("'hero-grid--single': heroProcesses.length === 1");
    expect(OVERVIEW_SRC).toContain(".hero-grid--single");
  });

  it("has no fleet lens filter and no head-anchored hero", () => {
    expect(OVERVIEW_SRC).not.toContain('const lens = ref<Lens>');
    expect(OVERVIEW_SRC).not.toContain('aria-label="Lens"');
    expect(OVERVIEW_SRC).not.toContain("60m window");
  });
});

describe("overview range filter + fleet aggregation (IRI-025)", () => {
  function point(t: number, patch: Partial<AnalyticsPoint> = {}): AnalyticsPoint {
    return {
      t,
      coverage: null,
      usedBytes: null,
      totalBytes: null,
      gpuUsedBytes: null,
      decodeTps: null,
      prefillTps: null,
      watts: null,
      gpuW: null,
      cpuW: null,
      baseW: null,
      gpuMin: null,
      gpuMax: null,
      gpuAvg: null,
      cpuMin: null,
      cpuMax: null,
      cpuAvg: null,
      throttled: null,
      generated: null,
      prompt: null,
      cached: null,
      ...patch,
    };
  }
  const sparkA: AnalyticsSeries = { key: "a", label: "DGX-1", points: [point(0, { watts: 60 }), point(60_000, { watts: 80 })] };
  const sparkB: AnalyticsSeries = { key: "b", label: "DGX-2", points: [point(0, { watts: 50 }), point(60_000, { watts: null })] };
  const nas: AnalyticsSeries = { key: "nas", label: "NAS", points: [point(0)] };
  const sparkIds = new Set(["a", "b"]);

  it("lists the six filter options with week/month labels over 7d/30d", () => {
    expect(OVERVIEW_RANGES.map((r) => r.value)).toEqual(["30m", "1h", "4h", "24h", "7d", "30d"]);
    expect(OVERVIEW_RANGES.find((r) => r.value === "7d")?.label).toBe("week");
    expect(OVERVIEW_RANGES.find((r) => r.value === "30d")?.label).toBe("month");
  });

  it("sums spark watts per bucket and skips the NAS", () => {
    const pts = fleetPowerSeries([sparkA, sparkB, nas], sparkIds);
    expect(pts).toEqual([
      { t: 0, w: 110 },
      { t: 60_000, w: 80 },
    ]);
  });

  it("integrates energy over bucket duration and returns null with no data", () => {
    const pts = fleetPowerSeries([sparkA], sparkIds);
    // (60 W + 80 W) held for a 60 s bucket = 2.33 Wh = 140/60000 kWh
    expect(fleetEnergyKwh(pts, 60_000)).toBeCloseTo(140 / 60_000, 9);
    expect(fleetEnergyKwh([{ t: 0, w: null }], 60_000)).toBeNull();
  });

  it("bins the fleet series to at most the target bar count", () => {
    const many: AnalyticsSeries = { key: "a", label: "x", points: Array.from({ length: 100 }, (_, i) => point(i * 60_000, { watts: 100 + i })) };
    const { bars, avgW } = binFleetPower(fleetPowerSeries([many], sparkIds), 60_000, 24);
    expect(bars.length).toBeLessThanOrEqual(24);
    expect(bars.length).toBeGreaterThan(0);
    expect(avgW).toBeCloseTo(149.5, 1);
  });

  it("emits per-bar energy and covered span from the bucket duration (IR-97)", () => {
    const pts = fleetPowerSeries([sparkA], sparkIds); // 60 W @ t0, 80 W @ t1, 60 s buckets
    const { bars } = binFleetPower(pts, 60_000);
    expect(bars[0]!.t).toBe(0);
    expect(bars[0]!.endT).toBe(60_000);
    expect(bars[0]!.w).toBe(60);
    expect(bars[0]!.wh).toBeCloseTo(1, 9); // 60 W held 60 s
    expect(bars[1]!.t).toBe(60_000);
    expect(bars[1]!.endT).toBe(120_000);
    expect(bars[1]!.w).toBe(80);
    expect(bars[1]!.wh).toBeCloseTo(80 / 60, 9); // 80 W held 60 s
    expect(binFleetPower([{ t: 0, w: null }], 60_000).bars).toEqual([]);
  });

  it("formats energy as Wh below a kWh and kWh above", () => {
    expect(fmtEnergy(0.83)).toBe("0.8 Wh");
    expect(fmtEnergy(3.1)).toBe("3.1 Wh");
    expect(fmtEnergy(148.8)).toBe("149 Wh");
    expect(fmtEnergy(1488)).toBe("1.49 kWh");
  });

  it("labels the covered slot per granularity", () => {
    const hhmm = (t: number) => {
      const d = new Date(t);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };
    const bar = (t: number, endT: number) => ({ t, endT, w: 60, wh: 1, pct: 10 });
    const minuteBase = new Date(2026, 10, 3, 14, 32).getTime();
    expect(powerBarSlot(bar(minuteBase, minuteBase + 60_000), "minute")).toBe(`${hhmm(minuteBase)} – ${hhmm(minuteBase + 60_000)}`);
    const hourBase = new Date(2026, 10, 3, 14, 0).getTime();
    expect(powerBarSlot(bar(hourBase, hourBase + 5 * 3_600_000), "hour")).toBe(`Nov 3 14:00 – ${hhmm(hourBase + 5 * 3_600_000)}`);
    const dayBase = new Date(2026, 10, 3).getTime();
    expect(powerBarSlot(bar(dayBase, dayBase + 86_400_000), "day")).toBe("Nov 3");
    expect(powerBarSlot(bar(dayBase, dayBase + 3 * 86_400_000), "day")).toBe("Nov 3 – Nov 5");
  });

  it("totals tokens over spark nodes only and prices billable input minus cached", () => {
    const tokens: AnalyticsSeries = { key: "a", label: "DGX-1", points: [point(0, { prompt: 1_000_000, cached: 200_000, generated: 100_000 })] };
    const totals = tokenTotals([tokens, nas], sparkIds);
    expect(totals).toEqual({ input: 1_000_000, cached: 200_000, generated: 100_000 });
    // (1M − 200k) × 0.15 + 200k × 0.015 + 100k × 0.6 = 0.12 + 0.003 + 0.06
    expect(tokenCostOf(totals, { input: 0.15, cached: 0.015, output: 0.6 })).toBeCloseTo(0.183, 6);
  });
});
