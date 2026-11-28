import { z } from "zod";
import { compareVersions } from "./version.js";

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

/**
 * IRI-175: the first modelctl whose `sync-local` works when the node sees
 * the store's `active/` links as directories (an SMB mount). It resolves the
 * object from the update journal instead of the symlink. A node known to
 * run this version or newer may sync through a hidden link.
 */
export const MODELCTL_SYNC_WITHOUT_SYMLINK = "0.25.1";

/**
 * IRI-175: does a NAS sync on this node still need the store link to be a
 * visible symlink? Not when the modelctl that will run it is known to be
 * 0.25.1 or newer. `version` is the node's REPORTED modelctl for the user
 * the sync runs as; null = unknown, and unknown still needs the link. The
 * hub pin is deliberately not used: a node can stay below the pin (failed
 * install, offline during the bump).
 */
export function syncNeedsVisibleLink(version: string | null): boolean {
  return version === null || !MODELCTL_PIN_RE.test(version) || compareVersions(version, MODELCTL_SYNC_WITHOUT_SYMLINK) < 0;
}
