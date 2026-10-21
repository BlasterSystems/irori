import { eq } from "drizzle-orm";
import { settings } from "@irori/db";
import type { Db } from "@irori/db";
import { bodyRetentionSchema, type BodyRetention } from "@irori/core";

/**
 * IR-52 body-retention caps (the "global cap" of the per-setup flag). One
 * settings row (`usage_body_retention`) holds the caps the server hands to
 * flagged agents at setup start; defaults apply when the row is absent or
 * malformed. Changing caps takes effect on the next setup start/restart.
 */

export const USAGE_BODY_RETENTION_KEY = "usage_body_retention";

export const DEFAULT_BODY_RETENTION: BodyRetention = {
  bodyCapBytes: 16 * 1024 * 1024,
  partCapBytes: 4 * 1024 * 1024,
};

export async function readBodyRetention(db: Db): Promise<BodyRetention> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, USAGE_BODY_RETENTION_KEY));
  const parsed = bodyRetentionSchema.safeParse(row?.value);
  return parsed.success ? parsed.data : DEFAULT_BODY_RETENTION;
}
