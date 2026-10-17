import { z } from "zod";

/** Per-GPU sample. Nulls mean "collector could not read this metric". */
export const gpuSnapshotSchema = z.object({
  index: z.number().int().nonnegative(),
  name: z.string().min(1),
  usagePct: z.number().min(0).max(100).nullable(),
  tempC: z.number().nullable(),
  memUsedBytes: z.number().nonnegative().nullable(),
  memTotalBytes: z.number().nonnegative().nullable(),
  powerW: z.number().nonnegative().nullable(),
  throttleReasons: z.array(z.string()).default([]),
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
  }),
  memory: z.object({
    totalBytes: z.number().nonnegative(),
    usedBytes: z.number().nonnegative(),
  }),
  gpus: z.array(gpuSnapshotSchema),
  load1: z.number().nonnegative().optional(),
  uptimeS: z.number().nonnegative().optional(),
});

export type HardwareSnapshot = z.infer<typeof hardwareSnapshotSchema>;
