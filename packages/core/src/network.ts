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

// ---------------------------------------------------------------------------
// IRI-164 (ADR-0021): opt-in live RoCE rates — leased, SSE-only.
// ---------------------------------------------------------------------------

/** Rates the card offers; 250 ms is the floor. */
export const NET_LIVE_INTERVALS_MS = [1000, 500, 250] as const;
export const NET_LIVE_FLOOR_MS = 250;
/** A lease lives this long unless renewed. */
export const NET_LIVE_LEASE_MS = 60_000;
/** A lease ends this long after it was taken, renewed or not. */
export const NET_LIVE_MAX_LEASE_MS = 10 * 60_000;
/** Upper bound an agent accepts for one net-live frame. */
export const NET_LIVE_MAX_DURATION_MS = 10 * 60_000;

/**
 * Hub → agent: stream fabric rates every intervalMs for durationMs (relative,
 * so clock skew cannot stretch it). intervalMs 0 or durationMs 0 = stop.
 */
export const netLiveMsgSchema = z.object({
  type: z.literal("net-live"),
  intervalMs: z.number().int().refine((v) => v === 0 || (v >= NET_LIVE_FLOOR_MS && v <= 10_000), "0 or 250–10000 ms"),
  durationMs: z.number().int().min(0).max(NET_LIVE_MAX_DURATION_MS),
});
export type NetLiveMsg = z.infer<typeof netLiveMsgSchema>;

export const netRateSchema = z.object({
  iface: z.string().max(15),
  rxBps: z.number().nonnegative().nullable(),
  txBps: z.number().nonnegative().nullable(),
  rdmaRxBps: z.number().nonnegative().nullable(),
  rdmaTxBps: z.number().nonnegative().nullable(),
});
export type NetRate = z.infer<typeof netRateSchema>;

/** Agent → hub: one live sample of the fabric interfaces. Never buffered. */
export const netRatesMsgSchema = z.object({
  type: z.literal("net-rates"),
  intervalMs: z.number().int().positive(),
  ifaces: z.array(netRateSchema).max(16),
});
export type NetRatesMsg = z.infer<typeof netRatesMsgSchema>;

/** Hub → browser (SSE): never journaled, never stored. */
export const netRatesEventSchema = z.object({
  type: z.literal("net-rates"),
  serverTimeMs: z.number(),
  nodeId: z.string().uuid(),
  intervalMs: z.number().int().positive(),
  ifaces: z.array(netRateSchema).max(16),
});
export type NetRatesEvent = z.infer<typeof netRatesEventSchema>;

export const netLiveLeaseRequestSchema = z.object({
  intervalMs: z.union([z.literal(1000), z.literal(500), z.literal(250)]),
  /** Renew this lease; absent = take a new one. */
  leaseId: z.string().uuid().optional(),
});
export type NetLiveLeaseRequest = z.infer<typeof netLiveLeaseRequestSchema>;

export interface NetLiveLease {
  leaseId: string;
  intervalMs: number;
  /** The shared stream's rate: the fastest active lease. */
  effectiveIntervalMs: number;
  expiresAt: string;
  /** The lease's hard end (NET_LIVE_MAX_LEASE_MS after it was taken). */
  endsAt: string;
}
