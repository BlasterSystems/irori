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

export interface SparklineScale {
  min: number;
  max: number;
}

/**
 * Value domain for a series (nulls = gaps): data min/max widened by any fixed
 * domain, never clipping. A flat series gets ±0.5 slack so values render at
 * mid-height. null when no point is readable.
 */
export function sparklineScale(
  points: Array<number | null>,
  domain?: SparklineDomain,
): SparklineScale | null {
  const finite = points.filter((p): p is number => p !== null && p !== undefined);
  if (finite.length === 0) return null;

  let min = Infinity;
  let max = -Infinity;
  for (const v of finite) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (domain?.min !== undefined) min = Math.min(domain.min, min);
  if (domain?.max !== undefined) max = Math.max(domain.max, max);
  if (min === max) {
    min -= 0.5;
    max += 0.5;
  }
  return { min, max };
}

export function sparklinePath(
  points: Array<number | null>,
  width: number,
  height: number,
  domain?: SparklineDomain,
  /** Precomputed scale used verbatim (per-series lens charts); skips derivation. */
  fixed?: SparklineScale,
): string {
  const scale = fixed ?? sparklineScale(points, domain);
  if (scale === null) return "";
  const { min, max } = scale;

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

/**
 * Nearest bucket index for a pointer x-fraction (0..1 across the plot).
 * Returns -1 when there is nothing to point at.
 */
export function hoverIndex(count: number, frac: number): number {
  if (count <= 0) return -1;
  const f = Math.min(1, Math.max(0, frac));
  return Math.round(f * (count - 1));
}

/**
 * Keep a centered tooltip (≈2·half px wide) on screen: clamp its anchor x to
 * the viewport. DOM-free guard so the helper stays unit-testable.
 */
export function clampTipX(x: number, half = 72): number {
  if (typeof window === "undefined") return x;
  return Math.min(Math.max(x, half + 4), window.innerWidth - half - 4);
}
