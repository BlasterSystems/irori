import { ref } from "vue";
import { OVERVIEW_RANGES, type OverviewRange } from "./overview";

/** IR-224 S4: one persisted Overview range, owned by the shell menu (the
 *  IR-128 "one range, two surfaces" contract moves here — the menu is the
 *  control surface, not a second source of truth). S6 consumes it in
 *  OverviewView; S7's token card follows the same ref. Persistence rides the
 *  try/catch idiom of `irori-theme` (storage unavailable = session only). */
const STORAGE_KEY = "irori.range";

function loadInitial(): OverviewRange {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored !== null && OVERVIEW_RANGES.some((r) => r.value === stored)) {
      return stored as OverviewRange;
    }
  } catch {
    /* storage unavailable — fall through to the default */
  }
  // Owner gate (IR-224): 24h is the review lens; the fleet-now surfaces stay
  // minute-fresh regardless of this window.
  return "24h";
}

export const overviewRange = ref<OverviewRange>(loadInitial());

export function setOverviewRange(value: OverviewRange): void {
  overviewRange.value = value;
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* storage unavailable — the pick still applies for this visit */
  }
}
