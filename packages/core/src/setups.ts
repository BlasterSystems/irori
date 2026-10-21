import { z } from "zod";

/**
 * Serving setups (M5, SPEC §7): one script pair on the head owns ports and
 * engine config; Irori validates, stages model transfers, supervises, and
 * streams logs. Irori never edits the scripts.
 */

export const setupKindSchema = z.enum(["single", "cluster"]);
export type SetupKind = z.infer<typeof setupKindSchema>;

/** Driver axis (agent truth): the start script's process lifecycle. */
export const setupStatusSchema = z.enum(["stopped", "starting", "running", "stopping", "failed"]);
export type SetupStatus = z.infer<typeof setupStatusSchema>;

/** Health axis (server-computed from the node's LLM probe on the setup port). */
export const setupHealthSchema = z.enum(["starting", "healthy", "foreign", "timeout"]);
export type SetupHealth = z.infer<typeof setupHealthSchema>;

/**
 * Optional env exports for scripts that want them (SPEC §7). modelName/port/
 * modelPath are opt-in flags; extraArgs is exported when non-empty.
 */
export const envExportsSchema = z.object({
  modelName: z.boolean().default(false),
  port: z.boolean().default(false),
  extraArgs: z.string().default(""),
  modelPath: z.boolean().default(false),
});
export type EnvExports = z.infer<typeof envExportsSchema>;

/** Cluster membership beyond the head (head is a column of its own). */
export const setupNodeSchema = z.object({
  nodeId: z.string().uuid(),
  role: z.enum(["worker"]),
});
export type SetupNode = z.infer<typeof setupNodeSchema>;

export const MAX_SETUP_NODES = 8;

/** Setup record as served by the API. */
export const setupInfoSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  kind: setupKindSchema,
  /** Catalog model name (NAS catalog or local registration). */
  model: z.string().min(1),
  /** Script-defined serving port on the head — probed for health + env PORT. */
  port: z.number().int().positive(),
  headNodeId: z.string().uuid(),
  /** Workers of a cluster setup; single-node setups have none. */
  nodes: z.array(setupNodeSchema).max(MAX_SETUP_NODES - 1).default([]),
  scriptStart: z.string().min(1),
  scriptStop: z.string().min(1),
  env: envExportsSchema.default({ modelName: false, port: false, extraArgs: "", modelPath: false }),
  /** M8: engine traffic is served through the agent's capture proxy. */
  captureProxy: z.boolean().default(false),
  /** IR-52: store (deduped) request/response bodies for captured requests. */
  bodyRetention: z.boolean().default(false),
  status: setupStatusSchema,
  health: setupHealthSchema.nullable(),
  lastError: z.string().nullable(),
  /** 15 min default per the wizard review step. */
  startupTimeoutMs: z.number().int().positive().default(15 * 60_000),
  lastStartedAt: z.string().datetime({ offset: true }).nullable().default(null),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type SetupInfo = z.infer<typeof setupInfoSchema>;

export const setupCreateSchema = z.object({
  name: z.string().min(1).max(120),
  kind: setupKindSchema,
  model: z.string().min(1).max(300),
  port: z.number().int().positive().max(65535),
  headNodeId: z.string().uuid(),
  nodes: z.array(setupNodeSchema).max(MAX_SETUP_NODES - 1).default([]),
  scriptStart: z.string().min(1).max(1024),
  scriptStop: z.string().min(1).max(1024),
  env: envExportsSchema.default({ modelName: false, port: false, extraArgs: "", modelPath: false }),
  /** M8: route the declared port through the agent capture proxy (ADR-0008). */
  captureProxy: z.boolean().default(false),
  /** IR-52: store deduped request/response bodies (requires captureProxy). */
  bodyRetention: z.boolean().default(false),
});
export type SetupCreateInput = z.infer<typeof setupCreateSchema>;

export const setupPatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  port: z.number().int().positive().max(65535).optional(),
  nodes: z.array(setupNodeSchema).max(MAX_SETUP_NODES - 1).optional(),
  scriptStart: z.string().min(1).max(1024).optional(),
  scriptStop: z.string().min(1).max(1024).optional(),
  env: envExportsSchema.optional(),
  captureProxy: z.boolean().optional(),
  bodyRetention: z.boolean().optional(),
});
export type SetupPatchInput = z.infer<typeof setupPatchSchema>;

/** Agent-reported driver state for one setup (survives server restarts). */
export const setupDriverStateSchema = z.object({
  setupId: z.string().uuid(),
  runId: z.string().uuid().nullable(),
  status: setupStatusSchema,
  exitCode: z.number().int().nullable().default(null),
  pid: z.number().int().positive().nullable().default(null),
  pgid: z.number().int().positive().nullable().default(null),
  startedAt: z.number().nullable().default(null),
  error: z.string().nullable().default(null),
});
export type SetupDriverState = z.infer<typeof setupDriverStateSchema>;

/**
 * One parsed rsync progress2 chunk (" 2,713,533  45%  1.00MB/s  0:00:03").
 * All fields nullable: modelctl prints completion lines without progress
 * (with --jobs ≥ 2) and some lines carry only a subset.
 */
export interface TransferProgress {
  bytes: number | null;
  percent: number | null;
  rateBytesPerSec: number | null;
  etaSeconds: number | null;
}

const NUM_RE = /^[\d.,]+[kKMGT]?$/;

function parseSize(raw: string): number | null {
  const m = /^([\d.,]+)([kKMGT]?)$/.exec(raw);
  if (m === null) return null;
  const value = Number(m[1]!.replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  const mult = { "": 1, k: 1024, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[m[2]!]!;
  return Math.round(value * mult);
}

function parseEta(raw: string): number | null {
  const m = /^(\d+):(\d{2}):(\d{2})$/.exec(raw);
  if (m === null) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

const RATE_RE = /^([\d.]+)([kKMGT]?)B\/s$/;

/**
 * Parses one transfer progress line emitted by modelctl's rsync invocations
 * (`--info=progress2 --human-readable`). Returns null for any other line
 * (phase banners, completion lines, plain text) — callers just skip those.
 */
export function parseTransferProgress(line: string): TransferProgress | null {
  const tokens = line.trim().split(/\s+/);
  if (tokens.length === 0 || tokens.length > 4) return null;
  const progress: TransferProgress = { bytes: null, percent: null, rateBytesPerSec: null, etaSeconds: null };
  let sawNumber = false;
  for (const token of tokens) {
    if (/^\d{1,3}%$/.test(token)) {
      progress.percent = Number(token.slice(0, -1));
      sawNumber = true;
      continue;
    }
    if (token.endsWith("B/s")) {
      const rate = RATE_RE.exec(token);
      if (rate === null) return null;
      const value = parseSize(rate[1]! + rate[2]!);
      if (value === null) return null;
      progress.rateBytesPerSec = value;
      sawNumber = true;
      continue;
    }
    if (/^\d+:\d{2}:\d{2}$/.test(token)) {
      const eta = parseEta(token);
      if (eta === null) return null;
      progress.etaSeconds = eta;
      sawNumber = true;
      continue;
    }
    if (NUM_RE.test(token)) {
      const size = parseSize(token);
      if (size === null) return null;
      progress.bytes = size;
      sawNumber = true;
      continue;
    }
    return null;
  }
  return sawNumber ? progress : null;
}

/** True when the probe-reported model id refers to the setup's model. */
export function modelIdMatches(probeModel: string | null | undefined, setupModel: string): boolean {
  if (!probeModel) return false;
  const a = probeModel.trim().toLowerCase();
  const b = setupModel.trim().toLowerCase();
  return a.length > 0 && b.length > 0 && (a.includes(b) || b.includes(a));
}

/**
 * Chip state shown on cards: the driver axis crossed with health. `failed`
 * covers both a dead driver and a startup timeout; `foreign` means another
 * engine answers the port (nothing was stopped).
 */
export type SetupChip = "healthy" | "starting" | "stopping" | "stopped" | "failed" | "foreign";

export function setupChip(setup: { status: SetupStatus; health: SetupHealth | null }): SetupChip {
  switch (setup.status) {
    case "stopped":
      return "stopped";
    case "failed":
      return "failed";
    case "stopping":
      return "stopping";
    case "starting":
      return "starting";
    case "running":
      if (setup.health === "healthy") return "healthy";
      if (setup.health === "foreign") return "foreign";
      if (setup.health === "timeout") return "failed";
      return "starting";
  }
}

/* ── Staged transfers (wizard placement + card progress) ─────────────────── */

export const transferStageStatusSchema = z.enum([
  "pending",
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled",
  "skipped",
]);
export type TransferStageStatus = z.infer<typeof transferStageStatusSchema>;

export const transferStageSchema = z.object({
  label: z.string(),
  /** Node the model lands on (null for pure store stages). */
  targetId: z.string().uuid().nullable().default(null),
  nodeId: z.string().uuid(),
  kind: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
  jobId: z.string().uuid().nullable().default(null),
  status: transferStageStatusSchema,
  progress: z
    .object({
      bytes: z.number().nullable(),
      percent: z.number().nullable(),
      rateBytesPerSec: z.number().nullable(),
      etaSeconds: z.number().nullable(),
    })
    .nullable()
    .default(null),
  error: z.string().nullable().default(null),
});
export type TransferStage = z.infer<typeof transferStageSchema>;

export const setupTransferSchema = z.object({
  id: z.string().uuid(),
  setupId: z.string().uuid(),
  status: z.enum(["running", "succeeded", "failed", "canceled"]),
  stages: z.array(transferStageSchema),
  createdAt: z.string().datetime({ offset: true }),
  finishedAt: z.string().datetime({ offset: true }).nullable(),
});
export type SetupTransfer = z.infer<typeof setupTransferSchema>;
