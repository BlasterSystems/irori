import { z } from "zod";

/** Per-GPU sample. Nulls mean "collector could not read this metric". */
export const gpuSnapshotSchema = z.object({
  index: z.number().int().nonnegative(),
  name: z.string().min(1),
  uuid: z.string().nullable().default(null),
  usagePct: z.number().min(0).max(100).nullable(),
  tempC: z.number().nullable(),
  memUsedBytes: z.number().nonnegative().nullable(),
  memTotalBytes: z.number().nonnegative().nullable(),
  powerW: z.number().nonnegative().nullable(),
  powerLimitW: z.number().nonnegative().nullable().default(null),
  smClockMHz: z.number().nonnegative().nullable().default(null),
  smClockMaxMHz: z.number().nonnegative().nullable().default(null),
  throttleReasons: z.array(z.string()).default([]),
  processes: z
    .array(
      z.object({
        pid: z.number().int(),
        name: z.string(),
        memBytes: z.number().nonnegative().nullable(),
      }),
    )
    .default([]),
});

export type GpuSnapshot = z.infer<typeof gpuSnapshotSchema>;

/** IRI-161 (ADR-0021): interface classification reported by the agent. */
export const networkKindSchema = z.enum(["fabric", "lan", "virtual"]);
export type NetworkKind = z.infer<typeof networkKindSchema>;

/** IRI-161: RDMA port facts from /sys/class/infiniband/<dev>/ports/<n>. */
export const rdmaPortSchema = z.object({
  device: z.string(),
  port: z.number().int().positive(),
  /** "Ethernet" means RoCE; "InfiniBand" a native IB port. */
  linkLayer: z.string().nullable(),
  /** e.g. ACTIVE, DOWN, INIT (the "4: " prefix is stripped). */
  state: z.string().nullable(),
  rateGbps: z.number().nonnegative().nullable(),
});
export type RdmaPort = z.infer<typeof rdmaPortSchema>;

/** IRI-165: one prober result (ping summary) for a fabric peer. */
export const linkProbeSchema = z.object({
  iface: z.string(),
  peerIp: z.string(),
  rttMinMs: z.number().nonnegative().nullable(),
  rttAvgMs: z.number().nonnegative().nullable(),
  rttMaxMs: z.number().nonnegative().nullable(),
  mdevMs: z.number().nonnegative().nullable(),
  lossPct: z.number().min(0).max(100),
  /** Agent wall clock of the probe. */
  at: z.number(),
});
export type LinkProbe = z.infer<typeof linkProbeSchema>;

/**
 * Basic hardware snapshot (M1). Tolerant by design: every metric that a
 * collector cannot read is null rather than omitted, and unknown fields are
 * stripped — newer agents may add fields once schemaVersion is negotiated.
 */
export const hardwareSnapshotSchema = z.object({
  schemaVersion: z.number().int().nonnegative(),
  agentVersion: z.string().min(1),
  hostname: z.string().min(1),
  transport: z.literal("ws").or(z.literal("ssh")),
  /** Agent wall clock at collection time; advisory (ADR-0006: server receive time buckets). */
  timestampMs: z.number(),
  cpu: z.object({
    model: z.string(),
    cores: z.number().int().positive(),
    usagePct: z.number().min(0).max(100).nullable(),
    tempC: z.number().nullable(),
    packagePowerW: z.number().nullable(),
    /** Per-core current frequency in kHz, /sys cpufreq order. Optional (M2). */
    perCoreClocksKHz: z.array(z.number().nonnegative()).optional(),
    /** Per-core maximum frequency in kHz (cpufreq scaling_max_freq), same order. Optional (IRI-034). */
    perCoreMaxClocksKHz: z.array(z.number().nonnegative()).optional(),
  }),
  memory: z.object({
    totalBytes: z.number().nonnegative(),
    usedBytes: z.number().nonnegative(),
    swapTotalBytes: z.number().nonnegative().nullable().default(null),
    swapUsedBytes: z.number().nonnegative().nullable().default(null),
  }),
  /** Unified-memory pool (GB10): pool = OS-visible total; gpuReservedBytes when readable. */
  unifiedMemory: z
    .object({
      poolBytes: z.number().nonnegative(),
      availableBytes: z.number().nonnegative(),
      gpuReservedBytes: z.number().nonnegative().nullable().default(null),
    })
    .nullable()
    .default(null),
  storage: z
    .array(
      z.object({
        mount: z.string(),
        fs: z.string(),
        totalBytes: z.number().nonnegative(),
        usedBytes: z.number().nonnegative(),
        /** IRI-067: block-device read rate over the sample window (null = first sample). */
        readBps: z.number().nonnegative().nullable().default(null),
        /** IRI-067: block-device write rate over the sample window. */
        writeBps: z.number().nonnegative().nullable().default(null),
        /** Device name the rates came from (/sys/block/<dev>), when known. */
        device: z.string().nullable().default(null),
      }),
    )
    .default([]),
  network: z
    .array(
      z.object({
        iface: z.string(),
        rxBps: z.number().nonnegative().nullable(),
        txBps: z.number().nonnegative().nullable(),
        /** IRI-067: negotiated link speed in Mb/s from /sys/class/net/<if>/speed. */
        speedMbps: z.number().nonnegative().nullable().default(null),
        /** IRI-067: /sys/class/net/<if>/operstate (up|down|lowerlayerdown|…). */
        operState: z.string().nullable().default(null),
        /** IRI-067: assigned addresses (v4 then v6), for the WOL/network panel. */
        addrs: z.array(z.string()).default([]),
        /** IRI-161 (ADR-0021): link-layer address, lowercase colon form. */
        mac: z.string().nullable().default(null),
        /** IRI-161: /sys/class/net/<if>/mtu. */
        mtu: z.number().int().positive().nullable().default(null),
        /** IRI-161: kernel driver (basename of device/driver), e.g. mlx5_core. */
        driver: z.string().nullable().default(null),
        /** IRI-161: classification; null = old agent (the hub infers it). */
        kind: networkKindSchema.nullable().default(null),
        /** IRI-161: assigned addresses with prefix length (v4 then v6), e.g. 10.100.112.2/24. */
        cidrs: z.array(z.string()).default([]),
        /** IRI-161: RDMA device bound to this netdev (RoCE on the CX7), null when none. */
        rdma: rdmaPortSchema.nullable().default(null),
        /** IRI-161: complete IPv4 neighbour entries (fabric interfaces only). */
        neighbors: z.array(z.object({ ip: z.string(), mac: z.string() })).max(64).default([]),
        /** IRI-161: RDMA port byte rates over the sample window (RoCE bypasses /proc/net/dev). */
        rdmaRxBps: z.number().nonnegative().nullable().default(null),
        rdmaTxBps: z.number().nonnegative().nullable().default(null),
      }),
    )
    .default([]),
  /**
   * IRI-165 (ADR-0021): latest ping result per fabric peer, from the agent's
   * prober (every netProbeIntervalS). Old agents omit it.
   */
  linkProbes: z.array(linkProbeSchema).max(64).optional(),
  gpus: z.array(gpuSnapshotSchema),
  /**
   * IRI-067: GB10 unified-memory bandwidth (nvidia-smi dmon -s B), sampled on
   * a slower cadence than the snapshot ring because each read costs a driver
   * call. Null when the tool is unavailable.
   */
  memoryBandwidth: z
    .object({
      readBps: z.number().nonnegative().nullable(),
      writeBps: z.number().nonnegative().nullable(),
      /** Agent clock of the dmon sample; older than timestampMs by design. */
      sampledAtMs: z.number().nullable().default(null),
    })
    .nullable()
    .default(null),
  /**
   * IRI-067: kernel-error counters from the journal (Xid = GPU fault lines,
   * OOM = oom-killer events), counted since boot with a dedupe key so a
   * repeating line does not inflate the count.
   */
  kernel: z
    .object({
      xidCount: z.number().int().nonnegative().default(0),
      /** Distinct recent Xid messages, newest first (bounded by the collector). */
      xidRecent: z.array(z.string().max(512)).max(20).default([]),
      oomCount: z.number().int().nonnegative().default(0),
      oomRecent: z.array(z.string().max(512)).max(20).default([]),
    })
    .nullable()
    .default(null),
  load1: z.number().nonnegative().optional(),
  uptimeS: z.number().nonnegative().optional(),
});

export type HardwareSnapshot = z.infer<typeof hardwareSnapshotSchema>;

export type NetworkEntry = HardwareSnapshot["network"][number];
