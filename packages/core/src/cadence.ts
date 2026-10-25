import { z } from "zod";

/**
 * Snapshot cadence bounds (ms): 1 s .. 60 s. The default lives in the server
 * config (CADENCE_MS env); the persisted setting overrides it per deployment
 * and reaches agents via hello-ok / config-update.
 */
export const CADENCE_MIN_MS = 1000;
export const CADENCE_MAX_MS = 60_000;

export const cadencePutSchema = z.object({
  cadenceMs: z.number().int().min(CADENCE_MIN_MS).max(CADENCE_MAX_MS),
});
export type CadencePut = z.infer<typeof cadencePutSchema>;
