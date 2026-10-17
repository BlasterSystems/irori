/**
 * Pure sparkline geometry: map a series (nulls = gaps) onto an SVG path in
 * viewBox coordinates. DOM-free so it is unit-testable in the node env.
 *
 * Coordinates: x is the point index scaled across the viewBox width; y maps
 * the value linearly from the data domain (or a fixed `domain`) onto
 * height..0, SVG top being zero.
 */
export interface SparklineDomain {
  /** Optional fixed floor (e.g. 0 for percentage series). */
  min?: number;
  /** Optional fixed ceiling (e.g. 100 for percentage series). */
  max?: number;
}

export function sparklinePath(
  points: Array<number | null>,
  width: number,
  height: number,
  domain?: SparklineDomain,
): string {
  const finite = points.filter((p): p is number => p !== null);
  if (finite.length === 0) return "";

  let min = Infinity;
  let max = -Infinity;
  for (const v of finite) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  // Honor a fixed domain but never clip: widen it to include the data.
  if (domain?.min !== undefined) min = Math.min(domain.min, min);
  if (domain?.max !== undefined) max = Math.max(domain.max, max);
  // A flat series would collapse to a zero-height edge line; give it slack so
  // the value renders at mid-height instead.
  if (min === max) {
    min -= 0.5;
    max += 0.5;
  }

  const n = points.length;
  let d = "";
  let run = 0;
  for (let i = 0; i < n; i++) {
    const v = points[i];
    if (v === null || v === undefined) {
      run = 0;
      continue;
    }
    const px = n <= 1 ? width / 2 : (i / (n - 1)) * width;
    const py = height - ((v - min) / (max - min)) * height;
    d += `${d === "" ? "" : " "}${run === 0 ? "M" : "L"}${px.toFixed(2)},${py.toFixed(2)}`;
    run++;
    // A run of exactly one point is invisible (a lone M draws nothing); add a
    // hairline segment so it renders as a dot under round linecaps.
    if (run === 1 && (i === n - 1 || points[i + 1] === null)) {
      d += " l0.01,0";
    }
  }
  return d;
}
