// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import Tip from "../src/components/Tip.vue";
import SparklineVue from "../src/components/Sparkline.vue";

/**
 * IRI-084: the real component tier — @vue/test-utils mounts (replacing the
 * readFileSync string pins). Tip carries hover metadata; Sparkline renders
 * its polyline into the svg.
 */

describe("Tip", () => {
  it("mounts and exposes the text via data-tip", () => {
    const w = mount(Tip, { props: { text: "median of the same model" } });
    expect(w.find("span.tip").attributes("data-tip")).toBe("median of the same model");
  });
});

describe("Sparkline", () => {
  it("mounts and renders a path for a series", () => {
    const w = mount(SparklineVue as never, { props: { points: [0, 5, 10], width: 100, height: 20 } as never });
    expect(w.find("path").exists()).toBe(true);
    expect(w.find("path").attributes("d")).toMatch(/[0-9]/);
  });

  it("renders no path without points", () => {
    const w = mount(SparklineVue as never, { props: { points: [], width: 100, height: 20 } as never });
    expect(w.find("path").exists()).toBe(false);
  });
});
