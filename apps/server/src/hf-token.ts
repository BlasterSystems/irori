import { eq } from "drizzle-orm";
import { settings } from "@irori/db";
import type { Db } from "@irori/db";

export const HF_TOKEN_KEY = "hf_token";

/**
 * IRI-019: the global HF token lives in the settings table and is handed to
 * agents via config-update (ADR-0009 addendum). Always optional: `null`
 * means "not configured" everywhere, and clearing deletes the row. The token
 * is write-only through the API — it never appears in a GET body, a job
 * param, or a job-output frame.
 */
export interface HfTokenService {
  /** The configured token, or null when unset. */
  get(): Promise<string | null>;
  /** Sets a non-empty token; null clears (row deleted). */
  set(token: string | null): Promise<void>;
}

export function createHfTokenService(db: Db): HfTokenService {
  return {
    async get() {
      const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, HF_TOKEN_KEY));
      const value = row?.value;
      return typeof value === "string" && value.length > 0 ? value : null;
    },
    async set(token) {
      if (token === null) {
        await db.delete(settings).where(eq(settings.key, HF_TOKEN_KEY));
        return;
      }
      await db
        .insert(settings)
        .values({ key: HF_TOKEN_KEY, value: token })
        .onConflictDoUpdate({ target: settings.key, set: { value: token, updatedAt: new Date() } });
    },
  };
}
