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
  "delete-local",
  // Register an existing local HF cache entry after verifying it against the
  // store (modelctl 0.23 register-local) — no transfer (IR-104).
  "register-local",
  "doctor",
  "repair-active",
  "repair-active-apply",
  "staging-audit",
  "objects-audit",
  "cleanup-staging",
  "gc-objects",
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
] as const;

export const jobKindSchema = z.enum(JOB_KINDS);
export type JobKind = (typeof JOB_KINDS)[number];

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
