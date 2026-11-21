import { z } from "zod";

/**
 * IRI-016 wire contracts for the download modal's "Expand quants" flow:
 * the hub endpoint `GET /api/v1/hf-quants?repo=` (server-side HF API listing
 * grouped like modelctl's `_gguf_groups`) and the HF API response shape the
 * server parses. The server owns the grouping logic; only contracts live here.
 */

/** One quantization group of a GGUF repo. */
export const hfQuantGroupSchema = z.object({
  /** Substring needle passed to modelctl --quantization (unique across groups). */
  tag: z.string().min(1),
  /** Repo paths of the group's GGUF files (all shards, in order). */
  files: z.array(z.string().min(1)).min(1),
  sharded: z.boolean(),
  shards: z.number().int().positive().nullable(),
  bytes: z.number().nonnegative().nullable(),
  /** True when no unique substring needle could be derived (UI disables the row). */
  ambiguous: z.boolean(),
});
export type HfQuantGroup = z.infer<typeof hfQuantGroupSchema>;

/** IRI-152: speculative draft kinds (modelctl drafts.py `draft_kind`). */
export const HF_DRAFT_KINDS = ["mtp", "dspark", "dflash", "dflash2"] as const;
export const hfDraftKindSchema = z.enum(HF_DRAFT_KINDS);
export type HfDraftKind = z.infer<typeof hfDraftKindSchema>;

export const hfCompanionCandidateSchema = z.object({
  path: z.string().min(1),
  bytes: z.number().nonnegative().nullable(),
  /** IRI-152: draft kind for `companions.mtp` candidates; absent for mmproj and on older hubs. */
  kind: hfDraftKindSchema.nullish(),
});
export type HfCompanionCandidate = z.infer<typeof hfCompanionCandidateSchema>;

export const hfCompanionInfoSchema = z.object({
  candidates: z.array(hfCompanionCandidateSchema),
  /** modelctl's auto-pick (single f16 mmproj / single root draft, else the single root Q8_0 draft); null = must choose explicitly. */
  default: z.string().nullable(),
});
export type HfCompanionInfo = z.infer<typeof hfCompanionInfoSchema>;

/**
 * IRI-153 (ADR-0020): run hints parsed from the repo README or an
 * allow-listed docs page. Every path names a file in the repo listing; they
 * are UI preselections only. `error` is a best-effort note, never fatal.
 */
export const hfRunHintsSchema = z.object({
  draft: z.string().nullable(),
  mmproj: z.string().nullable(),
  specType: z.string().nullable(),
  source: z.enum(["readme", "docs"]).nullable(),
  url: z.string().nullable(),
  error: z.string().nullable(),
});
export type HfRunHints = z.infer<typeof hfRunHintsSchema>;

/** GET /api/v1/hf-quants response body. */
export const hfQuantsResultSchema = z.object({
  repo: z.string().min(1),
  modelCard: z.string().nullable(),
  quants: z.array(hfQuantGroupSchema),
  companions: z.object({ mmproj: hfCompanionInfoSchema, mtp: hfCompanionInfoSchema }),
  /** IRI-153: absent on older hubs and when hints were not computed. */
  hints: hfRunHintsSchema.nullish(),
});
export type HfQuantsResult = z.infer<typeof hfQuantsResultSchema>;

/** Server-side file entry consumed by the grouping port. */
export interface HfFile {
  path: string;
  bytes: number | null;
}

/** Subset of `GET https://huggingface.co/api/models/{repo}?blobs=true` the server consumes. */
export const hfModelInfoSchema = z.object({
  /** IRI-153: resolved commit; the README for hints is read at this revision. */
  sha: z.string().regex(/^[0-9a-f]{40}$/).nullish().catch(null),
  siblings: z
    .array(z.object({ rfilename: z.string(), size: z.number().positive().nullish() }))
    .default([]),
});
export type HfModelInfo = z.infer<typeof hfModelInfoSchema>;

/** HF listing failures (invalid repo, upstream unreachable, unusable response). */
export class HfQuantsError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
