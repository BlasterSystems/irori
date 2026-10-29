import { ref } from "vue";

/**
 * Shared width tier (IR-128): one reactive state drives every tiered surface —
 * hero sparklines, the range select, the topbar hamburger — and is mirrored
 * onto `<html data-tier>` so CSS (`html[data-tier="small"] …`) gates density.
 *
 * Tiers: small ≤900 px, medium 901–1440, full >1440. 900 matches the shipped
 * `.hero-grid` collapse in OverviewView, so the serving cards never reflow
 * twice at one width.
 */

export type WidthTier = "small" | "medium" | "full";

/** Pure tier from a viewport width (unit-testable; mirrors the media queries). */
export function tierFromWidth(width: number): WidthTier {
  if (width <= 900) return "small";
  if (width <= 1440) return "medium";
  return "full";
}

function computeTier(): WidthTier {
  if (typeof matchMedia === "undefined") return "full";
  return matchMedia("(max-width: 900px)").matches
    ? "small"
    : matchMedia("(max-width: 1440px)").matches
      ? "medium"
      : "full";
}

export const tier = ref<WidthTier>(computeTier());

if (typeof matchMedia !== "undefined") {
  const apply = (): void => {
    tier.value = computeTier();
    document.documentElement.dataset.tier = tier.value;
  };
  matchMedia("(max-width: 900px)").addEventListener("change", apply);
  matchMedia("(max-width: 1440px)").addEventListener("change", apply);
  apply();
}
