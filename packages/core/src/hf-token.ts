import { z } from "zod";

/**
 * IRI-019: global HF token, set from the UI (ADR-0009 addendum). The token
 * lives in the hub's settings table and is pushed to agents via
 * config-update; it is ALWAYS optional — absence is never an error path.
 */

/** GET /api/v1/settings/hf-token response — presence only, never the token. */
export const hfTokenStatusSchema = z.object({
  configured: z.boolean(),
});
export type HfTokenStatus = z.infer<typeof hfTokenStatusSchema>;

/** PUT /api/v1/settings/hf-token body: a string sets the token, null clears. */
export const hfTokenPutSchema = z.object({
  hfToken: z.string().min(1).nullable(),
});
export type HfTokenPut = z.infer<typeof hfTokenPutSchema>;
