// @vitest-environment happy-dom
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
