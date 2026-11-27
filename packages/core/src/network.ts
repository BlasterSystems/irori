import { z } from "zod";
import { IPV4_RE } from "./network-topology.js";

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

// ---------------------------------------------------------------------------
// IRI-166 (ADR-0021): on-demand link tests (iperf3; RDMA perftest in S7).
// ---------------------------------------------------------------------------

const ipv4 = z.string().regex(IPV4_RE);

export const NET_TEST_TOOLS = ["iperf3"] as const;
export const netTestToolSchema = z.enum(NET_TEST_TOOLS);
export type NetTestTool = z.infer<typeof netTestToolSchema>;

/** iperf3 listener ports a test may use. */
export const NET_TEST_PORT_MIN = 5201;
export const NET_TEST_PORT_MAX = 5210;
export const NET_TEST_MAX_DURATION_S = 30;

/** Printed by net-test-server once its listener is bound. */
export const NET_LISTENING_MARKER = "IRORI_NET_LISTENING";
/** Prefix of net-test-client's single JSON result line. */
export const NET_RESULT_MARKER = "IRORI_NET_RESULT=";

/** One-shot listener bound to a verified local fabric address. */
export const netTestServerParamsSchema = z
  .object({
    tool: netTestToolSchema.default("iperf3"),
    bindIp: ipv4,
    port: z.number().int().min(NET_TEST_PORT_MIN).max(NET_TEST_PORT_MAX),
    /** One-shot runs to serve (forward + reverse = 2). */
    runs: z.number().int().min(1).max(4),
    /** Hard end of the listener, whatever happens. */
    timeoutS: z.number().int().min(10).max(120),
  })
  .strict();
export type NetTestServerParams = z.infer<typeof netTestServerParamsSchema>;

export const netTestClientParamsSchema = z
  .object({
    tool: netTestToolSchema.default("iperf3"),
    bindIp: ipv4,
    targetIp: ipv4,
    port: z.number().int().min(NET_TEST_PORT_MIN).max(NET_TEST_PORT_MAX),
    durationS: z.number().int().min(1).max(NET_TEST_MAX_DURATION_S),
    streams: z.number().int().min(1).max(8),
    /** Also measure B → A (iperf3 -R). */
    reverse: z.boolean(),
    /** Latency burst size after the throughput runs (0 = skip). */
    pings: z.number().int().min(0).max(200),
  })
  .strict();
export type NetTestClientParams = z.infer<typeof netTestClientParamsSchema>;

export const netTestResultSchema = z.object({
  tool: netTestToolSchema,
  /** A → B (the client's send direction), Gb/s as the receiver saw it. */
  forwardGbps: z.number().nonnegative().nullable(),
  /** B → A, null when reverse was not run or failed. */
  reverseGbps: z.number().nonnegative().nullable(),
  retransmits: z.number().int().nonnegative().nullable(),
  rttP50Ms: z.number().nonnegative().nullable(),
  rttP99Ms: z.number().nonnegative().nullable(),
  lossPct: z.number().min(0).max(100).nullable(),
  durationS: z.number().int().positive(),
  streams: z.number().int().positive(),
  /** Per-direction failures, e.g. "reverse: unable to connect". */
  errors: z.array(z.string().max(300)).max(4).default([]),
});
export type NetTestResult = z.infer<typeof netTestResultSchema>;

export const NETWORK_TEST_STATUSES = ["running", "succeeded", "failed"] as const;
export type NetworkTestStatus = (typeof NETWORK_TEST_STATUSES)[number];

/** A persisted test as the API serves it (network_tests row). */
export interface NetworkTestView {
  id: string;
  /** `${a}|${b}` with a < b, as in the topology. */
  linkId: string;
  /** Client side (A → B is "forward"). */
  aNodeId: string;
  bNodeId: string;
  aIface: string;
  bIface: string;
  aIp: string;
  bIp: string;
  tool: NetTestTool;
  status: NetworkTestStatus;
  /** Current step while running: ensure, listen, measure. */
  stage: string | null;
  override: boolean;
  forwardGbps: number | null;
  reverseGbps: number | null;
  retransmits: number | null;
  rttP50Ms: number | null;
  rttP99Ms: number | null;
  lossPct: number | null;
  durationS: number;
  streams: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export const networkTestRequestSchema = z
  .object({
    aNodeId: z.string().uuid(),
    bNodeId: z.string().uuid(),
    /** Run even while an endpoint serves a setup or runs a transfer. */
    override: z.boolean().default(false),
    tool: netTestToolSchema.default("iperf3"),
  })
  .strict();
export type NetworkTestRequest = z.infer<typeof networkTestRequestSchema>;

export const networkTestAllRequestSchema = z
  .object({ override: z.boolean().default(false), tool: netTestToolSchema.default("iperf3") })
  .strict();
