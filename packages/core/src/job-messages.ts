import { z } from "zod";
import { storeModelSchema } from "./catalog.js";
import { benchProgressMsgSchema, benchDoneMsgSchema } from "./bench.js";
import { usageBatchMsgSchema, bodyRetentionSchema } from "./usage.js";
import { logBatchMsgSchema } from "./logs.js";

/** Server → agent: run one job (one active per node enforced by the server). */
export const jobRequestMsgSchema = z.object({
  type: z.literal("job"),
  jobId: z.string().uuid(),
  kind: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
});

export const jobCancelMsgSchema = z.object({
  type: z.literal("job-cancel"),
  jobId: z.string().uuid(),
});

/** Server → agent: refresh + report the store catalog (read-only). */
export const catalogRequestMsgSchema = z.object({
  type: z.literal("catalog-request"),
});

/** Agent → server: one output line for a running job. */
export const jobOutputMsgSchema = z.object({
  type: z.literal("job-output"),
  jobId: z.string().uuid(),
  seq: z.number().int().nonnegative(),
  line: z.string(),
});

/** Agent → server: job finished. */
export const jobDoneMsgSchema = z.object({
  type: z.literal("job-done"),
  jobId: z.string().uuid(),
  status: z.enum(["succeeded", "failed", "canceled"]),
  exitCode: z.number().int().nullable(),
});

/** Agent → server: store catalog entries (catalog.json or live scan). */
export const catalogMsgSchema = z.object({
  type: z.literal("catalog"),
  source: z.enum(["catalog", "scan"]),
  /** IRI-155: entries may carry `companions` (see storeCompanionsStateSchema; absent = unknown). */
  entries: z.array(storeModelSchema),
});

/**
 * Setup supervision frames (M5, SPEC §7). The start/stop pair runs on the
 * head agent as a detached process group; state and logs flow back as events.
 */

export const setupStartMsgSchema = z.object({
  type: z.literal("setup-start"),
  setupId: z.string().uuid(),
  /** Server-generated run id — echoed in events and persisted with the run. */
  runId: z.string().uuid(),
  scriptStart: z.string().min(1),
  scriptStop: z.string().min(1),
  /** Env exports for the script (MODEL_NAME/PORT/EXTRA_ARGS). */
  env: z.record(z.string(), z.string()).default({}),
  /** When set, the agent resolves MODEL_PATH via `modelctl path --local`. */
  modelPathName: z.string().nullable().default(null),
  /** M8 capture proxy: the agent binds this port and forwards to a loopback
   *  engine port it picks (injected as $PORT at spawn — ADR-0008 §7). IR-52:
   *  `retention` opts this setup's proxy into content-addressed body capture. */
  capture: z
    .object({
      proxyPort: z.number().int().positive(),
      retention: bodyRetentionSchema.nullable().default(null),
    })
    .nullable()
    .default(null),
});

export const setupStopMsgSchema = z.object({
  type: z.literal("setup-stop"),
  setupId: z.string().uuid(),
  /** Grace for the stop script before the process-group fallback kills. */
  gracefulMs: z.number().int().positive().default(30_000),
});

export const setupStatusMsgSchema = z.object({
  type: z.literal("setup-status"),
  setupId: z.string().uuid(),
});

export const setupLogAttachMsgSchema = z.object({
  type: z.literal("setup-log-attach"),
  setupId: z.string().uuid(),
  /** Replay the current run's ring after this seq (0 = from the start). */
  lastSeq: z.number().int().nonnegative(),
});

export const setupAckMsgSchema = z.object({
  type: z.literal("setup-ack"),
  setupId: z.string().uuid(),
  ok: z.boolean(),
  error: z.string().nullable().default(null),
});

export const setupEventMsgSchema = z.object({
  type: z.literal("setup-event"),
  setupId: z.string().uuid(),
  runId: z.string().uuid().nullable().default(null),
  state: z.enum(["starting", "running", "stopping", "stopped", "failed"]),
  exitCode: z.number().int().nullable().default(null),
  pid: z.number().int().nullable().default(null),
  pgid: z.number().int().nullable().default(null),
  error: z.string().nullable().default(null),
});

export const setupLogMsgSchema = z.object({
  type: z.literal("setup-log"),
  setupId: z.string().uuid(),
  seq: z.number().int().nonnegative(),
  line: z.string(),
  ts: z.number(),
});

/** Server → agent: test -x the given script paths (create-time validation). */
export const setupValidateMsgSchema = z.object({
  type: z.literal("setup-validate"),
  validateId: z.string().uuid(),
  scripts: z.array(z.string().min(1)).min(1).max(8),
});

/** Agent → server: one result per requested script, in order. */
export const setupValidateResultMsgSchema = z.object({
  type: z.literal("setup-validate-result"),
  validateId: z.string().uuid(),
  results: z.array(z.object({ script: z.string(), ok: z.boolean(), error: z.string().nullable() })),
});

/** Agent → server: the job-cancel frame was received and the kill signal
 *  (SIGTERM to the process group) has been issued (IR-131). The terminal
 *  `job-done {canceled}` follows once the process is actually gone; a hub
 *  that receives neither (agent death) settles via the reaper or the hello
 *  reconcile. Absent on pre-ack agents — the hub falls back to job-done. */
export const jobCancelAckMsgSchema = z.object({
  type: z.literal("job-cancel-ack"),
  jobId: z.string().uuid(),
});

/** Server → agent: read per-GPU clocks + application clock cap (IRI-067). */
export const clocksGetMsgSchema = z.object({
  type: z.literal("clocks-get"),
  id: z.string().uuid(),
});

export const clocksGpuSchema = z.object({
  index: z.number().int().nonnegative(),
  name: z.string().nullable(),
  smMHz: z.number().int().nonnegative().nullable(),
  smMaxMHz: z.number().int().nonnegative().nullable(),
  memMHz: z.number().int().nonnegative().nullable(),
  memMaxMHz: z.number().int().nonnegative().nullable(),
  /** Applied application clock cap (nvidia-smi clocks.applications.sm); null = default. */
  smCapMHz: z.number().int().nonnegative().nullable(),
});

/** One cpufreq policy cluster (IRI-124). GB10 exposes one policy per CPU. */
export const clocksCpuPolicySchema = z.object({
  /** CPU indices sharing this policy. */
  cpus: z.array(z.number().int().nonnegative()),
  minKHz: z.number().int().nonnegative(),
  /** cpuinfo_max_freq — what a cleared cap restores. */
  maxKHz: z.number().int().nonnegative(),
  /** Current scaling_max_freq — the ceiling in force right now. */
  curMaxKHz: z.number().int().nonnegative(),
});

/** Applied CPU ceiling plus per-policy truth (IRI-124). */
export const clocksCpuSchema = z.object({
  /** Requested ceiling in MHz; null when the policies are not uniformly capped. */
  capMHz: z.number().int().nonnegative().nullable(),
  policies: z.array(clocksCpuPolicySchema).default([]),
});

/** Agent → server: clocks reading; ok=false carries the tool error. */
export const clocksGetResultMsgSchema = z.object({
  type: z.literal("clocks-get-result"),
  id: z.string().uuid(),
  ok: z.boolean(),
  gpus: z.array(clocksGpuSchema).default([]),
  /** Absent on agents that predate IRI-124 (no CPU clock control). */
  cpu: clocksCpuSchema.nullable().optional(),
  error: z.string().nullable().default(null),
});

/** Server → agent: apply clock caps (null resets: -rgc for the GPU, every
 *  policy's cpuinfo_max_freq for the CPU). A cap field that is absent means
 *  "leave that side alone" — IRI-124 lets the two halves move independently.
 *  `persist` (IRI-068/IRI-124) installs or removes the matching systemd
 *  oneshot; with a null cap it removes it. */
export const clocksSetMsgSchema = z.object({
  type: z.literal("clocks-set"),
  id: z.string().uuid(),
  smMaxMHz: z.number().int().positive().nullable().optional(),
  cpuMaxMHz: z.number().int().positive().nullable().optional(),
  persist: z.boolean().optional(),
});

/** Server → agent: power the node off (armed confirm already checked hub-side).
 *  The agent logs the origin, acks, waits the grace period, then powers off. */
export const nodeShutdownMsgSchema = z.object({
  type: z.literal("node-shutdown"),
  id: z.string().uuid(),
  graceS: z.number().int().positive().max(300),
  origin: z.string().min(1).max(200),
});

/** Agent → server: shutdown frame accepted (the poweroff follows the grace). */
export const nodeShutdownAckMsgSchema = z.object({
  type: z.literal("node-shutdown-ack"),
  id: z.string().uuid(),
  ok: z.boolean(),
  error: z.string().nullable().default(null),
});

/** Agent → server: cap application outcome. */
export const clocksSetResultMsgSchema = z.object({
  type: z.literal("clocks-set-result"),
  id: z.string().uuid(),
  ok: z.boolean(),
  error: z.string().nullable().default(null),
});

export const agentServerMsgSchema = z.discriminatedUnion("type", [
  jobOutputMsgSchema,
  jobDoneMsgSchema,
  jobCancelAckMsgSchema,
  catalogMsgSchema,
  benchProgressMsgSchema,
  benchDoneMsgSchema,
  setupAckMsgSchema,
  setupEventMsgSchema,
  setupLogMsgSchema,
  setupValidateResultMsgSchema,
  usageBatchMsgSchema,
  logBatchMsgSchema,
  clocksGetResultMsgSchema,
  clocksSetResultMsgSchema,
  nodeShutdownAckMsgSchema,
]);

export type ClocksGetMsg = z.infer<typeof clocksGetMsgSchema>;
export type ClocksGpu = z.infer<typeof clocksGpuSchema>;
export type ClocksCpuPolicy = z.infer<typeof clocksCpuPolicySchema>;
export type ClocksCpu = z.infer<typeof clocksCpuSchema>;
export type ClocksGetResultMsg = z.infer<typeof clocksGetResultMsgSchema>;
export type ClocksSetMsg = z.infer<typeof clocksSetMsgSchema>;
export type ClocksSetResultMsg = z.infer<typeof clocksSetResultMsgSchema>;
export type NodeShutdownMsg = z.infer<typeof nodeShutdownMsgSchema>;
export type NodeShutdownAckMsg = z.infer<typeof nodeShutdownAckMsgSchema>;
export type AgentServerMsg = z.infer<typeof agentServerMsgSchema>;
export type JobRequestMsg = z.infer<typeof jobRequestMsgSchema>;
export type JobCancelMsg = z.infer<typeof jobCancelMsgSchema>;
export type JobCancelAckMsg = z.infer<typeof jobCancelAckMsgSchema>;
export type CatalogRequestMsg = z.infer<typeof catalogRequestMsgSchema>;
export type JobOutputMsg = z.infer<typeof jobOutputMsgSchema>;
export type JobDoneMsg = z.infer<typeof jobDoneMsgSchema>;
export type CatalogMsg = z.infer<typeof catalogMsgSchema>;
export type SetupStartMsg = z.infer<typeof setupStartMsgSchema>;
export type SetupStopMsg = z.infer<typeof setupStopMsgSchema>;
export type SetupStatusMsg = z.infer<typeof setupStatusMsgSchema>;
export type SetupLogAttachMsg = z.infer<typeof setupLogAttachMsgSchema>;
export type SetupAckMsg = z.infer<typeof setupAckMsgSchema>;
export type SetupEventMsg = z.infer<typeof setupEventMsgSchema>;
export type SetupLogMsg = z.infer<typeof setupLogMsgSchema>;
export type SetupValidateMsg = z.infer<typeof setupValidateMsgSchema>;
export type SetupValidateResultMsg = z.infer<typeof setupValidateResultMsgSchema>;
