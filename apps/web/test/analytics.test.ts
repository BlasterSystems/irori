import { describe, expect, it } from "vitest";
import type { AnalyticsSeries } from "@irori/core";
import {
  fmtBucket,
  fmtBytes,
  fmtCount,
  lensChart,
} from "../src/analytics";

function series(points: Array<Record<string, number | null | boolean>>): AnalyticsSeries {
  return {
    key: "n1",
    label: "node 1",
    points: points.map((p) => ({ t: 0, coverage: null, usedBytes: null, totalBytes: null, gpuUsedBytes: null, decodeTps: null, prefillTps: null, watts: null, gpuW: null, cpuW: null, baseW: null, gpuMin: null, gpuMax: null, gpuAvg: null, cpuMin: null, cpuMax: null, cpuAvg: null, throttled: null, generated: null, prompt: null, cached: null, ...p })) as AnalyticsSeries["points"],
  };
}

describe("lensChart", () => {
  it("floors power at zero and pins the ceiling to the GB10 envelope", () => {
    const chart = lensChart([series([{ watts: 300 }, { watts: 100 }])], "watts", 600, 100, { floorZero: true, ceiling: 240 });
    // 300 clamps the domain ceiling to 300 (never clips), 240 is inside.
    expect(chart.yMin).toBe(0);
    expect(chart.yMax).toBe(300);
  });

  it("mixes metrics per series via valueKeys (hero decode+prefill)", () => {
    const chart = lensChart(
      [series([{ t: 1000, decodeTps: 10 }, { t: 2000, decodeTps: 20 }]), series([{ t: 1000, prefillTps: 2000 }, { t: 2000, prefillTps: null }])],
      "decodeTps",
      600,
      100,
      { floorZero: true, valueKeys: ["decodeTps", "prefillTps"] },
    );
    expect(chart.series[0]?.points).toEqual([10, 20]);
    expect(chart.series[1]?.points).toEqual([2000, null]);
    expect(chart.yMax).toBe(2000);
  });

  it("emits 85/90 guides and crossing markers for temps", () => {
    const chart = lensChart([series([{ gpuMax: 60 }, { gpuMax: 88 }, { gpuMax: 92 }])], "gpuMax", 600, 100, {
      floor: 30,
      guides: [85, 90],
      markers: { key: "gpuMax", warn: 85, critical: 90 },
    });
    expect(chart.guides.map((g) => g.value)).toEqual([85, 90]);
    expect(chart.markers).toHaveLength(2);
    expect(chart.markers[0]!.tier).toBe("warn");
    expect(chart.markers[1]!.tier).toBe("critical");
  });

  it("renders nothing for all-null series", () => {
    const chart = lensChart([series([{ gpuMax: null }])], "gpuMax", 600, 100, { floor: 30 });
    expect(chart.paths).toHaveLength(0);
  });

  it("exposes hoverable series values and the canonical bucket times", () => {
    const chart = lensChart(
      [series([{ t: 1000, decodeTps: 10 }, { t: 2000, decodeTps: null }]), series([{ t: 1000 }, { t: 2000 }])],
      "decodeTps",
      600,
      100,
      { floorZero: true },
    );
    expect(chart.series).toHaveLength(2);
    expect(chart.series[0]!.points).toEqual([10, null]);
    expect(chart.times).toEqual([1000, 2000]);
  });

  it("scales each series independently when perSeriesScale is set (IR-110)", () => {
    const chart = lensChart(
      [series([{ t: 1000, decodeTps: 90 }, { t: 2000, decodeTps: 10 }]), series([{ t: 1000, prefillTps: 2 }, { t: 2000, prefillTps: 1 }])],
      "decodeTps",
      600,
      100,
      { floorZero: true, valueKeys: ["decodeTps", "prefillTps"], perSeriesScale: true },
    );
    // The quiet prefill line gets its own domain instead of flattening under
    // decode's; both maxima reach the top of the chart.
    expect(chart.series[0]?.scale).toEqual({ min: 0, max: 90 });
    expect(chart.series[1]?.scale).toEqual({ min: 0, max: 2 });
    expect(chart.yMin).toBe(0);
    expect(chart.yMax).toBe(90); // chart-level domain is the union
    expect(chart.paths[0]?.d).toBe("M0.00,0.00 L600.00,88.89");
    expect(chart.paths[1]?.d).toBe("M0.00,0.00 L600.00,50.00");
  });

  it("pins an all-zero series flat at the bottom of its own scale", () => {
    const chart = lensChart(
      [series([{ t: 1000, decodeTps: 90 }, { t: 2000, decodeTps: 10 }]), series([{ t: 1000, prefillTps: 0 }, { t: 2000, prefillTps: 0 }])],
      "decodeTps",
      600,
      100,
      { floorZero: true, valueKeys: ["decodeTps", "prefillTps"], perSeriesScale: true },
    );
    expect(chart.series[1]?.scale).toEqual({ min: 0, max: 1 });
    expect(chart.paths[1]?.d).toBe("M0.00,100.00 L600.00,100.00");
  });

  it("centers a non-zero constant series on its own ±0.5 slack", () => {
    const chart = lensChart([series([{ gpuMax: 40 }, { gpuMax: 40 }])], "gpuMax", 600, 100, { floorZero: true, perSeriesScale: true });
    expect(chart.series[0]?.scale).toEqual({ min: 39.5, max: 40.5 });
    expect(chart.paths[0]?.d).toBe("M0.00,50.00 L600.00,50.00");
  });

  it("leaves a null-scale series pathless in per-series mode", () => {
    const chart = lensChart(
      [series([{ t: 1000, decodeTps: 90 }, { t: 2000, decodeTps: 10 }]), series([{ t: 1000, prefillTps: null }, { t: 2000, prefillTps: null }])],
      "decodeTps",
      600,
      100,
      { floorZero: true, valueKeys: ["decodeTps", "prefillTps"], perSeriesScale: true },
    );
    expect(chart.series[1]?.scale).toBeUndefined();
    expect(chart.paths).toHaveLength(1);
  });
});

describe("fmtBucket", () => {
  const t = new Date(2026, 9, 20, 14, 5).getTime();
  it("labels buckets per granularity", () => {
    expect(fmtBucket(t, "minute")).toBe("14:05");
    expect(fmtBucket(t, "hour")).toBe("Oct 20 14:00");
    expect(fmtBucket(t, "day")).toBe("Oct 20");
  });
});

describe("formatters", () => {
  it("formats bytes humanly", () => {
    expect(fmtBytes(212_400_000_000)).toBe("212 GB");
    expect(fmtBytes(null)).toBe("—");
  });

  it("formats token counts", () => {
    expect(fmtCount(1_234_567)).toBe("1.2M");
    expect(fmtCount(null)).toBe("—");
  });
});
