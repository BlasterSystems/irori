import { seedThresholds, type HealthThresholds } from "@irori/core";

/**
 * IRI-069: UI threshold values come from the SERVER (the health rules are the
 * single source of truth). This module starts with the core seed values and is
 * overwritten by `GET /api/v1/health/thresholds` at boot (main.ts).
 */
export const thresholds: HealthThresholds = seedThresholds();

export function setThresholds(t: HealthThresholds): void {
  thresholds.tempWarnC = t.tempWarnC;
  thresholds.tempCriticalC = t.tempCriticalC;
  thresholds.diskWarnPct = t.diskWarnPct;
  thresholds.hubDiskWarnPct = t.hubDiskWarnPct;
  thresholds.dbUnavailable = t.dbUnavailable;
}
