import { z } from "zod";

/**
 * Modelctl pin (IR-105): the hub-pinned modelctl version agents converge to.
 * Persisted as a settings row (apps/server/src/modelctl-pin.ts) — null means
 * "not configured": agents keep their IRORI_MODELCTL_PIN env default and no
 * auto-provisioning is dispatched. Carried to agents in config-update;
 * absent (old server) means no change, and older agents strip the field.
 */

export const MODELCTL_PIN_RE = /^\d+\.\d+\.\d+$/;

export const modelctlPinPutSchema = z.object({
  pin: z.string().regex(MODELCTL_PIN_RE, "pin must be semver (major.minor.patch)"),
});
export type ModelctlPinPut = z.infer<typeof modelctlPinPutSchema>;

/** GET response envelope (web client parses with this). */
export const modelctlPinResponseSchema = z.object({
  pin: z.string().regex(MODELCTL_PIN_RE).nullable(),
});
export type ModelctlPinResponse = z.infer<typeof modelctlPinResponseSchema>;
