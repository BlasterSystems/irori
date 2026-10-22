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

export const hfCompanionCandidateSchema = z.object({
  path: z.string().min(1),
  bytes: z.number().nonnegative().nullable(),
});
export type HfCompanionCandidate = z.infer<typeof hfCompanionCandidateSchema>;

export const hfCompanionInfoSchema = z.object({
  candidates: z.array(hfCompanionCandidateSchema),
  /** modelctl's auto-pick (single f16 mmproj / single root mtp-*.gguf); null = must choose explicitly. */
  default: z.string().nullable(),
});
export type HfCompanionInfo = z.infer<typeof hfCompanionInfoSchema>;

/** GET /api/v1/hf-quants response body. */
export const hfQuantsResultSchema = z.object({
  repo: z.string().min(1),
  modelCard: z.string().nullable(),
  quants: z.array(hfQuantGroupSchema),
  companions: z.object({ mmproj: hfCompanionInfoSchema, mtp: hfCompanionInfoSchema }),
});
export type HfQuantsResult = z.infer<typeof hfQuantsResultSchema>;

/** Server-side file entry consumed by the grouping port. */
export interface HfFile {
  path: string;
  bytes: number | null;
}

/** Subset of `GET https://huggingface.co/api/models/{repo}?blobs=true` the server consumes. */
export const hfModelInfoSchema = z.object({
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
