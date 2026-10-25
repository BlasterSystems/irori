import { eq } from "drizzle-orm";
import { settings } from "@irori/db";
import type { Db } from "@irori/db";

export const CADENCE_MS_KEY = "cadence_ms";

/**
 * The hub snapshot cadence lives in the settings table and overrides the
 * CADENCE_MS env default; changes are pushed to agents via config-update.
 * get() returns null when unset (env default wins) or when the stored value
 * is out of bounds (treated as unset, never trusted).
 */
export interface CadenceService {
  /** The configured cadence in ms, or null when unset. */
  get(): Promise<number | null>;
  /** Persists a validated cadence. */
  set(cadenceMs: number): Promise<void>;
}

export function createCadenceService(db: Db, minMs: number, maxMs: number): CadenceService {
  return {
    async get() {
      const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, CADENCE_MS_KEY));
      const raw = row?.value;
      const ms = typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseInt(raw, 10) : Number.NaN;
      if (!Number.isInteger(ms) || ms < minMs || ms > maxMs) return null;
      return ms;
    },
    async set(cadenceMs) {
      await db
        .insert(settings)
        .values({ key: CADENCE_MS_KEY, value: String(cadenceMs) })
        .onConflictDoUpdate({ target: settings.key, set: { value: String(cadenceMs), updatedAt: new Date() } });
    },
  };
}
