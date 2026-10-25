import { ref } from "vue";
import type { EnergyCost, TokenCost } from "@irori/core";
import { fetchEnergyCost, fetchTokenCost } from "./api";

/**
 * Reactive cost settings (IRI-025): loaded at boot and refreshed after the
 * hub-settings modal saves, so the Overview cost previews update without a
 * reload. null = not configured (the UI hides the affected stats).
 */
export const energyCost = ref<EnergyCost | null>(null);
export const tokenCost = ref<TokenCost | null>(null);

/** Best-effort: a failed load (older hub, degraded DB) keeps nulls. */
export async function loadCostSettings(): Promise<void> {
  try {
    energyCost.value = await fetchEnergyCost();
  } catch {
    /* cosmetic — the cost stats stay hidden */
  }
  try {
    tokenCost.value = await fetchTokenCost();
  } catch {
    /* cosmetic — the cost stats stay hidden */
  }
}
