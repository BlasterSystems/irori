// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import {
  capOptions,
  computeDetailData,
  CPU_CLOCK_CAP_PRESETS,
  GPU_CLOCK_CAP_PRESETS,
} from "../src/detail-data";
import type { HistoryPoint, HistoryResponse } from "../src/api";
import SparklineVue from "../src/components/Sparkline.vue";

/**
 * IRI-124: clock-cap preset options, the temperature overlay series, and the
 * two-series Sparkline (dashed temp line + two-row tooltip).
 */

afterEach(() => vi.unstubAllGlobals());

describe("capOptions", () => {
  it("lists the GPU presets with MHz labels", () => {
    expect(capOptions(GPU_CLOCK_CAP_PRESETS, null)).toEqual([
      { value: "1800", label: "1800 MHz" },
      { value: "2000", label: "2000 MHz" },
      { value: "2200", label: "2200 MHz" },
      { value: "3000", label: "3000 MHz" },
    ]);
  });

  it("keeps the three CPU presets the owner chose", () => {
    expect(capOptions(CPU_CLOCK_CAP_PRESETS, null).map((o) => o.value)).toEqual(["1400", "2000", "2800"]);
  });

  it("appends a stored cap that is not a preset, and never duplicates one", () => {
    const withCurrent = capOptions(GPU_CLOCK_CAP_PRESETS, 2400);
    expect(withCurrent.at(-1)).toEqual({ value: "2400", label: "2400 MHz (current)" });
    expect(capOptions(GPU_CLOCK_CAP_PRESETS, 2000)).toHaveLength(4);
  });
});

const point = (overrides: Partial<HistoryPoint> = {}): HistoryPoint => ({
  t: 1_760_000_000_000,
  cpu: 18,
  cpuTemp: { min: 55, avg: 62, max: 71 },
  mem: 1,
  gpu: 34,
  gpuTemp: { min: 58, avg: 61, max: 66 },
  gpuPowerW: 74,
  gpuMem: 1,
  netRx: 10,
  netTx: 2,
  samples: 60,
  ...overrides,
});

const history: HistoryResponse = {
  granularity: "hour",
  points: [point(), point({ cpu: 22, cpuTemp: { min: 60, avg: 64, max: 70 }, gpuTemp: { min: 59, avg: 63, max: 67 } })],
};

describe("temperature series", () => {
  it("carries bucket-average temperature for CPU and GPU only", () => {
    const d = computeDetailData(null, history, "24h");
    expect(d.cpu.tempSeries).toEqual([62, 64]);
    expect(d.gpu.tempSeries).toEqual([61, 63]);
    expect(d.memory.tempSeries).toBeNull();
    expect(d.network.tempSeries).toBeNull();
  });

  it("keeps null buckets as gaps instead of zeros", () => {
    const d = computeDetailData(null, { granularity: "hour", points: [point({ cpuTemp: { min: null, avg: null, max: null } })] }, "24h");
    expect(d.cpu.tempSeries).toEqual([null]);
  });
});

describe("Sparkline with a second series", () => {
  function mountDual() {
    const w = mount(SparklineVue as never, {
      props: {
        points: [0, 50, 100],
        points2: [40, 60, 55],
        width: 100,
        height: 20,
        label: "usage",
        label2: "temp",
        format: (v: number) => `${v}%`,
        format2: (v: number) => `${v} °C`,
      } as never,
    });
    const svg = w.find("svg");
    svg.element.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    return { w, svg };
  }

  it("draws the second series dashed and does not touch the first", () => {
    const { w } = mountDual();
    const paths = w.findAll("path");
    expect(paths).toHaveLength(2);
    expect(paths[0]!.attributes("stroke-dasharray")).toBe("4 3");
    expect(paths[0]!.attributes("stroke")).toBe("var(--thread)");
    expect(paths[1]!.attributes("stroke-dasharray")).toBeUndefined();
    expect(paths[1]!.attributes("stroke")).toBe("var(--ink-2)");
    w.unmount();
  });

  it("shows one tooltip row per series with its own formatter", async () => {
    const { w, svg } = mountDual();
    await svg.trigger("pointermove", { clientX: 50, clientY: 10 });
    await new Promise((r) => setTimeout(r, 10));
    const rows = w.findAll(".charttip__row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.text()).toContain("usage");
    expect(rows[0]!.text()).toContain("50%");
    expect(rows[1]!.text()).toContain("temp");
    expect(rows[1]!.text()).toContain("60 °C");
    w.unmount();
  });

  it("keeps the single-line tooltip when there is no second series", async () => {
    const w = mount(SparklineVue as never, {
      props: { points: [0, 50, 100], width: 100, height: 20, format: (v: number) => `${v}%` } as never,
    });
    const svg = w.find("svg");
    svg.element.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    await svg.trigger("pointermove", { clientX: 50, clientY: 10 });
    await new Promise((r) => setTimeout(r, 10));
    expect(w.findAll(".charttip__row")).toHaveLength(0);
    expect(w.find(".charttip").text()).toBe("50%");
    w.unmount();
  });
});
