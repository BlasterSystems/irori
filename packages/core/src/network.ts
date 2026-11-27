import { z } from "zod";

/**
 * ADR-0021 network contracts shared by hub, agent and web: the settings row
 * (kill switches + prober interval). Live-stream and link-test contracts
 * join this module in S3b/S5.
 */

export const networkSettingsSchema = z.object({
  /** S5/S7: on-demand link tests. */
  testsEnabled: z.boolean(),
  /** S3b: the leased high-rate stream. */
  liveEnabled: z.boolean(),
  /** S4: agent prober interval in seconds; 0 disables it. */
  probeIntervalS: z.number().int().min(0).max(3600),
});
export type NetworkSettings = z.infer<typeof networkSettingsSchema>;

export const networkSettingsPatchSchema = networkSettingsSchema.partial().strict();

export const NETWORK_SETTINGS_DEFAULTS: NetworkSettings = { testsEnabled: true, liveEnabled: true, probeIntervalS: 10 };
