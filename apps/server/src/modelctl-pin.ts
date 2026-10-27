import { eq } from "drizzle-orm";
import { settings } from "@irori/db";
import type { Db } from "@irori/db";
import { modelctlPinPutSchema } from "@irori/core";

export const MODELCTL_PIN_KEY = "modelctl_pin";

export interface ModelctlPinService {
  get(): Promise<string | null>;
  set(pin: string): Promise<void>;
}

/**
 * IR-105: hub-pinned modelctl version (settings table, like the cadence and
 * cost settings). get() returns null when unset — agents keep their
 * IRORI_MODELCTL_PIN env default and no auto-provisioning is dispatched.
 */
export function createModelctlPinService(db: Db): ModelctlPinService {
  async function read(): Promise<string | null> {
    const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, MODELCTL_PIN_KEY));
    if (row?.value === undefined || row?.value === null) return null;
    const parsed = modelctlPinPutSchema.safeParse(row.value);
    return parsed.success ? parsed.data.pin : null;
  }
  async function write(pin: string): Promise<void> {
    await db
      .insert(settings)
      .values({ key: MODELCTL_PIN_KEY, value: { pin } })
      .onConflictDoUpdate({ target: settings.key, set: { value: { pin }, updatedAt: new Date() } });
  }
  return { get: read, set: write };
}
