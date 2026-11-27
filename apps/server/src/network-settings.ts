import { eq } from "drizzle-orm";
import { NETWORK_SETTINGS_DEFAULTS, networkSettingsPatchSchema, networkSettingsSchema, type NetworkSettings } from "@irori/core";
import { settings } from "@irori/db";
import type { Db } from "@irori/db";

/**
 * ADR-0021: the network kill switches and the prober interval live in one
 * `network` settings row. An absent or unreadable row means the defaults; a
 * stored value is validated on read and never trusted blindly.
 */

export const NETWORK_SETTINGS_KEY = "network";

export { NETWORK_SETTINGS_DEFAULTS, networkSettingsPatchSchema, networkSettingsSchema, type NetworkSettings };

export interface NetworkSettingsService {
  get(): Promise<NetworkSettings>;
  set(patch: Partial<NetworkSettings>): Promise<NetworkSettings>;
  /** Last value read or written (defaults before the first read); never throws. */
  cached(): NetworkSettings;
}

export function createNetworkSettingsService(db: Db): NetworkSettingsService {
  let last: NetworkSettings = { ...NETWORK_SETTINGS_DEFAULTS };
  const service: NetworkSettingsService = {
    async get() {
      const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, NETWORK_SETTINGS_KEY));
      const parsed = networkSettingsSchema.partial().safeParse(row?.value ?? {});
      last = { ...NETWORK_SETTINGS_DEFAULTS, ...(parsed.success ? parsed.data : {}) };
      return last;
    },
    async set(patch) {
      const next = networkSettingsSchema.parse({ ...(await service.get()), ...patch });
      await db
        .insert(settings)
        .values({ key: NETWORK_SETTINGS_KEY, value: next })
        .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: new Date() } });
      last = next;
      return next;
    },
    cached: () => last,
  };
  return service;
}
