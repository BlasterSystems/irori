import { describe, expect, it } from "vitest";
import { hoverIndex, sparklinePath, sparklineScale } from "../src/sparkline";

describe("sparklinePath", () => {
  it("scales to the data min/max across the viewBox", () => {
    expect(sparklinePath([0, 100], 100, 10)).toBe("M0.00,10.00 L100.00,0.00");
  });

  it("honors a fixed domain without clipping the data", () => {
    expect(sparklinePath([10, 20], 100, 10, { min: 0, max: 100 })).toBe(
      "M0.00,9.00 L100.00,8.00",
    );
  });

  it("breaks the path at null gaps and dots lone points", () => {
    // min 5, max 15 → y(10)=15, y(5)=30, y(15)=0 on a 90×30 viewBox; x stays
    // index-based, so the gap keeps its slot and the run resumes at x=60.
    expect(sparklinePath([10, null, 5, 15], 90, 30)).toBe(
      "M0.00,15.00 l0.01,0 M60.00,30.00 L90.00,0.00",
    );
  });

  it("centers a flat series", () => {
    expect(sparklinePath([5, 5, 5], 100, 20)).toBe(
      "M0.00,10.00 L50.00,10.00 L100.00,10.00",
    );
  });

  it("renders a single point as a dot at mid-x", () => {
    expect(sparklinePath([7], 100, 20)).toBe("M50.00,10.00 l0.01,0");
  });

  it("returns an empty path when there is no readable data", () => {
    expect(sparklinePath([], 100, 10)).toBe("");
    expect(sparklinePath([null, null], 100, 10)).toBe("");
  });
});

describe("sparklineScale", () => {
  it("widens a fixed domain without clipping the data", () => {
    expect(sparklineScale([10, 20], { min: 0, max: 100 })).toEqual({ min: 0, max: 100 });
    expect(sparklineScale([10, 200], { min: 0, max: 100 })).toEqual({ min: 0, max: 200 });
  });

  it("gives a flat series ±0.5 slack so values render mid-height", () => {
    expect(sparklineScale([5, 5, 5])).toEqual({ min: 4.5, max: 5.5 });
  });

  it("is null without readable data", () => {
    expect(sparklineScale([])).toBeNull();
    expect(sparklineScale([null, null])).toBeNull();
  });
});

describe("hoverIndex", () => {
  it("maps a pointer fraction to the nearest bucket", () => {
    expect(hoverIndex(11, 0)).toBe(0);
    expect(hoverIndex(11, 0.54)).toBe(5);
    expect(hoverIndex(11, 0.56)).toBe(6);
    expect(hoverIndex(11, 1)).toBe(10);
  });

  it("clamps out-of-range fractions and handles degenerate counts", () => {
    expect(hoverIndex(11, -1)).toBe(0);
    expect(hoverIndex(11, 2)).toBe(10);
    expect(hoverIndex(1, 0.7)).toBe(0);
    expect(hoverIndex(0, 0.5)).toBe(-1);
  });
});
