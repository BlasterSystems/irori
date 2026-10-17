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
      }),
    )
    .default([]),
  network: z
    .array(
      z.object({
        iface: z.string(),
        rxBps: z.number().nonnegative().nullable(),
        txBps: z.number().nonnegative().nullable(),
      }),
    )
    .default([]),
  gpus: z.array(gpuSnapshotSchema),
  load1: z.number().nonnegative().optional(),
  uptimeS: z.number().nonnegative().optional(),
});

export type HardwareSnapshot = z.infer<typeof hardwareSnapshotSchema>;
