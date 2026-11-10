import { z } from "zod";

/**
 * Job kinds — each maps to modelctl verbs (ADR-0004). Destructive jobs run
 * dry-run first; the armed variant is a separate job the UI creates after
 * showing the plan.
 */
export const JOB_KINDS = [
  "modelctl-install",
  "download-queue",
  "download",
  "sync-local",
  "push",
  // ADR-0014: push dependency self-healing — destination rsync + hub-orchestrated
  // transfer keys (public material rides job output; private keys never leave
  // the node that generated them).
  "ensure-rsync",
  "transfer-key-ensure",
  "transfer-key-authorize",
  "transfer-hostkey-pin",
  "nas-delete",
  "nas-delete-apply",
  // IR-208: batch store delete — one agent job deletes several models (params
  // {names: string[]}); per-model plan → preflight → apply inside the agent.
  "nas-delete-batch",
  "delete-local",
  // Register an existing local HF cache entry after verifying it against the
  // store (modelctl 0.23 register-local) — no transfer (IR-104).
  "register-local",
  "doctor",
  "repair-active",
  "repair-active-apply",
  "staging-audit",
  "staging-tree-audit",
  "objects-audit",
  "cleanup-staging",
  "gc-objects",
  // IR-211: armed quarantine prune — per model NAME via modelctl
  // cleanup-quarantine (validates the repaired reference before deleting).
  "quarantine-prune",
  "catalog-refresh",
  "sync-cards",
  // Disk hygiene (M7, SPEC §11.6) — executed by the agent itself, not modelctl.
  "hygiene-audit",
  "hygiene-clean",
  "hygiene-prevent",
  // Per-node model inventory (IRI-028) — read-only, agent-side; the final
  // output line is the JSON report persisted into node_inventory.
  "models-inventory",
  // Agent self-update (IRI-012, ADR-0007) — the agent replaces its own bundle
  // and restarts; settlement is hello-driven, params carry `expectedVersion`.
  "agent-update",
  // Curated-recipe install (IRI-082) — the hub stages start/stop scripts
  // (sha256-verified) onto the node; settlement creates the setup draft.
  "recipe-install",
] as const;

export const recipeInstallParamsSchema = z.object({
  /** Staging dir on the node (under the agent's writable root). */
  dir: z.string().min(1).max(1024),
  files: z
    .array(
      z.object({
        rel: z.string().min(1).max(300),
        content: z.string().max(262_144),
        sha256: z.string().length(64),
      }),
    )
    .min(1)
    .max(8),
  /** Hub-side draft metadata (slug, port, model, name) echoed back at settlement. */
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type RecipeInstallParams = z.infer<typeof recipeInstallParamsSchema>;

export const jobKindSchema = z.enum(JOB_KINDS);
export type JobKind = (typeof JOB_KINDS)[number];

/** IR-211: final JSON line of a staging-tree-audit job (agent → hub → web). */
export const stagingTreeRowSchema = z.object({
  path: z.string(),
  kind: z.enum(["staging", "active-quarantine", "cleanup-quarantine", "hidden"]),
  name: z.string().nullable(),
  bytes: z.number().nullable(),
  mtimeMs: z.number().nullable(),
});
export const stagingTreeReportSchema = z.object({
  kind: z.literal("staging-tree-audit"),
  trees: z.array(stagingTreeRowSchema),
  totals: z.object({ stagingBytes: z.number(), activeQuarantineBytes: z.number(), cleanupQuarantineBytes: z.number() }),
  freeBytes: z.number().nullable(),
  timedOut: z.boolean(),
});
export type StagingTreeReport = z.infer<typeof stagingTreeReportSchema>;

/** IR-211: final JSON line of a quarantine-prune job. */
export const quarantinePruneResultSchema = z.object({
  name: z.string(),
  status: z.string(),
  paths: z.array(z.string()),
  error: z.string().optional(),
});
export const quarantinePruneSummarySchema = z.object({
  kind: z.literal("quarantine-prune"),
  armed: z.boolean(),
  freedBytes: z.number().nullable(),
  results: z.array(quarantinePruneResultSchema),
});
export type QuarantinePruneSummary = z.infer<typeof quarantinePruneSummarySchema>;

export const JOB_STATUSES = ["queued", "running", "succeeded", "failed", "canceled"] as const;
export const jobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Job record as served by the API (never includes secrets). */
export const jobInfoSchema = z.object({
  id: z.string().uuid(),
  nodeId: z.string().uuid(),
  kind: jobKindSchema,
  status: jobStatusSchema,
  /** Structured parameters (paths, model names, flags — no credentials). */
  params: z.record(z.string(), z.unknown()).default({}),
  /** IR-131: parsed transfer progress (single-stream sync-local/push). */
  progress: z
    .object({
      bytes: z.number().nullable(),
      percent: z.number().nullable(),
      rateBytesPerSec: z.number().nullable(),
      etaSeconds: z.number().nullable(),
    })
    .nullish(),
  /** IR-131: cancel requested but unconfirmed — the row is still running. */
  cancelRequestedAt: z.string().datetime({ offset: true }).nullish(),
  exitCode: z.number().int().nullable(),
  createdAt: z.string().datetime({ offset: true }),
  startedAt: z.string().datetime({ offset: true }).nullable(),
  finishedAt: z.string().datetime({ offset: true }).nullable(),
});

export type JobInfo = z.infer<typeof jobInfoSchema>;
/** UI-facing alias — the job record as shown in the web app. */
export type JobView = JobInfo;

export const jobCreateSchema = z.object({
  kind: jobKindSchema,
  params: z.record(z.string(), z.unknown()).default({}),
});

export type JobCreateInput = z.infer<typeof jobCreateSchema>;
