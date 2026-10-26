import { z } from "zod";

/**
 * Disk hygiene (M7, SPEC §11.6). The agent audits eight clutter categories
 * with a per-category safety rationale, then cleans armed per-category jobs
 * under an enforced protected set. `safe` categories are pre-checked in the
 * UI; needs-care rows are opt-in (diamond `care` chip).
 */
export const HYGIENE_CATEGORIES = [
  "docker-build-cache",
  "docker-images",
  "docker-containers",
  "hf-cache",
  "modelctl-staging",
  "compiler-caches",
  "apt-caches",
  "system-junk",
] as const;

export const hygieneCategorySchema = z.enum(HYGIENE_CATEGORIES);
export type HygieneCategory = (typeof HYGIENE_CATEGORIES)[number];

export const HYGIENE_CATEGORY_LABELS: Record<HygieneCategory, string> = {
  "docker-build-cache": "Docker build cache",
  "docker-images": "Docker old images",
  "docker-containers": "Stopped containers",
  "hf-cache": "HF cache orphans",
  "modelctl-staging": "modelctl staging",
  "compiler-caches": "Compiler/pkg caches",
  "apt-caches": "apt/pkg caches",
  "system-junk": "Journal/tmp/cores",
};

/** Categories the UI pre-checks (the rest are opt-in care rows). */
export const HYGIENE_SAFE_CATEGORIES: readonly HygieneCategory[] = [
  "docker-build-cache",
  "docker-containers",
  "compiler-caches",
  "apt-caches",
  "system-junk",
];

/**
 * One concrete target inside a category (IRI-028): an old image, an
 * unreferenced HF snapshot, a staging entry, a compiler cache dir, the
 * journal, a /tmp entry or a core-dump dir. `path` is null for command-based
 * targets (docker prune) and set for filesystem targets.
 */
export const hygieneDetailSchema = z.object({
  label: z.string().min(1),
  path: z.string().nullable().default(null),
  bytes: z.number().nonnegative(),
  items: z.number().int().nonnegative().default(1),
});

export type HygieneDetail = z.infer<typeof hygieneDetailSchema>;

/** One audited category: what is reclaimable and why it is (un)safe to clean. */
export const hygieneCategoryAuditSchema = z.object({
  category: hygieneCategorySchema,
  safe: z.boolean(),
  /** One-line safety rationale (UI copy, `--muted`). */
  rationale: z.string(),
  itemCount: z.number().int().nonnegative(),
  reclaimableBytes: z.number().nonnegative(),
  /** Per-target rows behind `reclaimableBytes`; older agents send none. */
  details: z.array(hygieneDetailSchema).default([]),
});

export type HygieneCategoryAudit = z.infer<typeof hygieneCategoryAuditSchema>;

/** Full audit report (read-only job; cached ~5 min agent-side). */
export const hygieneAuditSchema = z.object({
  generatedAtMs: z.number().nonnegative(),
  /** Disk usage at audit time, when statvfs was readable. */
  totalBytes: z.number().nonnegative().nullable(),
  freeBytes: z.number().nonnegative().nullable(),
  categories: z.array(hygieneCategoryAuditSchema),
});

export type HygieneAudit = z.infer<typeof hygieneAuditSchema>;

/** Per-category clean outcome. A failing category flips to failed/held and
 *  the remaining categories continue (SPEC §11.6 staged run). */
export const hygieneCleanOutcomeSchema = z.object({
  category: hygieneCategorySchema,
  status: z.enum(["cleaned", "skipped", "held", "failed"]),
  bytesReclaimed: z.number().nonnegative(),
  itemsRemoved: z.number().int().nonnegative(),
  error: z.string().nullable().default(null),
});

export type HygieneCleanOutcome = z.infer<typeof hygieneCleanOutcomeSchema>;

export const hygieneCleanResultSchema = z.object({
  startedAtMs: z.number().nonnegative(),
  finishedAtMs: z.number().nonnegative(),
  dryRun: z.boolean(),
  outcomes: z.array(hygieneCleanOutcomeSchema),
});

export type HygieneCleanResult = z.infer<typeof hygieneCleanResultSchema>;

/** Params for the armed clean job. Empty categories = no-op (rejected). */
export const hygieneCleanParamsSchema = z.object({
  categories: z.array(hygieneCategorySchema).min(1),
  /** Dry run: report exactly what would be removed, touch nothing. */
  dryRun: z.boolean().default(false),
});

export type HygieneCleanParams = z.infer<typeof hygieneCleanParamsSchema>;

/** Parses a hygiene job result payload by kind (audit report / clean result). */
export function hygieneResultSchemaFor(kind: "hygiene-audit" | "hygiene-clean") {
  return kind === "hygiene-audit" ? hygieneAuditSchema : hygieneCleanResultSchema;
}
