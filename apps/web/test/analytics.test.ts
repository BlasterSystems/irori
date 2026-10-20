import { describe, expect, it } from "vitest";
import type { AnalyticsSeries } from "@irori/core";
import {
  diskChipCls,
  diskPct,
  fmtBucket,
  fmtBytes,
  fmtCount,
  lensChart,
  sumReclaimable,
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

describe("disk chip tiers (SPEC §11.6)", () => {
  it("no chip under 80, plain 80–89, warn ≥90", () => {
    expect(diskChipCls(70)).toBeNull();
    expect(diskChipCls(85)).toBe("chip");
    expect(diskChipCls(91)).toBe("chip--warn");
  });

  it("computes disk percent safely", () => {
    expect(diskPct(50, 100)).toBe(50);
    expect(diskPct(50, 0)).toBeNull();
    expect(diskPct(null, 100)).toBeNull();
  });

  it("sums reclaimable bytes from an audit", () => {
    expect(sumReclaimable({ categories: [{ reclaimableBytes: 5 }, { reclaimableBytes: 7 }] })).toBe(12);
    expect(sumReclaimable(null)).toBe(0);
  });
});
