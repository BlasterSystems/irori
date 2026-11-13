// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import type { LensChart } from "../src/analytics";

/**
 * IRI-084: LensChart hover tier — pointermove picks the nearest bucket, the
 * tooltip lists the readable series, and the time label formats.
 */

afterEach(() => vi.unstubAllGlobals());

const chart: LensChart = {
  paths: [],
  series: [{ label: "tok/s", color: "var(--accent)", points: [10, 50, 90] }],
  times: [1000, 2000, 3000],
  guides: [{ y: 50, value: 50 }],
  markers: [{ x: 100, tier: "warn" }],
  yMin: 0,
  yMax: 100,
  width: 300,
  height: 100,
};

describe("LensChart labeled variant (IR-219)", () => {
  it("renders the y column, x labels and legend while hover keeps working", async () => {
    const { default: LensChartC } = await import("../src/components/LensChart.vue");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = mount(LensChartC as never, { props: { chart, labeled: true, format: (v: number) => `${v} tok/s`, timeFormat: (t: number) => `t${t}` } as any });
    const svg = w.find("svg");
    expect(svg.exists()).toBe(true);
    svg.element.getBoundingClientRect = () => ({ left: 0, top: 0, right: 300, bottom: 100, width: 300, height: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    await svg.trigger("pointermove", { clientX: 150, clientY: 20 });
    await new Promise((r) => setTimeout(r, 10));
    const text = w.text();
    expect(text).toContain("50 tok/s"); // hover rows still work in labeled mode
    expect(text).toContain("t2000");
    // Y column: 4 scale ticks with the compact formatter.
    for (const label of ["0", "33.3", "66.7", "100"]) expect(text).toContain(label);
    // X labels: first / middle / last bucket times, formatted.
    for (const label of ["t1000", "t2000", "t3000"]) expect(text).toContain(label);
    // Legend swatch per series.
    expect(text).toContain("tok/s");
    expect(w.findAll(".bs-legend > span").length).toBe(1);
    expect(w.findAll(".lens-chart__grid").length).toBe(4);
    w.unmount();
  });

  it("per-series-scaled charts skip the y column (a chart-level scale would lie)", async () => {
    const scaled: LensChart = { ...chart, series: [{ ...chart.series[0]!, scale: { min: 0, max: 10 } }] };
    const { default: LensChartC } = await import("../src/components/LensChart.vue");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = mount(LensChartC as never, { props: { chart: scaled, labeled: true } as any });
    expect(w.find(".lens-chart__ycol").exists()).toBe(false);
    expect(w.find(".bs-legend").exists()).toBe(true); // x labels + legend still land
    w.unmount();
  });

  it("strokes never distort at narrow widths (vector-effect on .spark)", () => {
    // happy-dom does not give a file: URL — resolve from process.cwd().
    const css = readFileSync(resolve(process.cwd(), "src/assets/irori.css"), "utf8");
    expect(css).toContain(".spark line, .spark path, .spark polyline { vector-effect: non-scaling-stroke; }");
    expect(css).toContain(".bs-legend { display: flex; flex-wrap: wrap; gap: 6px 16px;");
  });
});

describe("LensChart hover", () => {
  it("shows the tooltip rows and time label while hovering", async () => {
    const { default: LensChartC } = await import("../src/components/LensChart.vue");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = mount(LensChartC as never, { props: { chart, format: (v: number) => `${v} tok/s`, timeFormat: (t: number) => `t${t}` } as any });
    const svg = w.find("svg");
    expect(svg.exists()).toBe(true);
    svg.element.getBoundingClientRect = () => ({ left: 0, top: 0, right: 300, bottom: 100, width: 300, height: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    await svg.trigger("pointermove", { clientX: 150, clientY: 20 });
    await new Promise((r) => setTimeout(r, 10));
    const text = w.text();
    expect(text).toContain("50 tok/s"); // fmt through the custom formatter
    expect(text).toContain("t2000"); // time label for the hovered bucket
    w.unmount();
  });

  it("hides the tooltip when no series has data at the bucket", async () => {
    const sparse: LensChart = { ...chart, series: [{ label: "gaps", color: "var(--muted)", points: [null, null, null] }] };
    const { default: LensChartC } = await import("../src/components/LensChart.vue");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = mount(LensChartC as never, { props: { chart: sparse } as any });
    const svg = w.find("svg");
    svg.element.getBoundingClientRect = () => ({ left: 0, top: 0, right: 300, bottom: 100, width: 300, height: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    await svg.trigger("pointermove", { clientX: 150, clientY: 20 });
    await new Promise((r) => setTimeout(r, 10));
    expect(w.text()).not.toContain("gaps"); // no tooltip rows
    w.unmount();
  });
});
