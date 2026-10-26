import { z } from "zod";
import { CACHE_USER_PATTERN } from "./node.js";

/** Models v2 + placement + jobs API payload contracts (M4). */

export const modelEntrySchema = z.object({
  name: z.string().min(1),
  runtime: z.string().min(1),
  repository: z.string().min(1),
  bytes: z.number().nonnegative(),
  /** When Irori first saw the model — drives the default "recently added" sort. */
  firstSeenAt: z.string().optional().default(""),
  updatedAt: z.string().optional().default(""),
});

export const modelsPageSchema = z.object({
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  models: z.array(modelEntrySchema),
});

export type ModelEntry = z.infer<typeof modelEntrySchema>;
export type ModelsPage = z.infer<typeof modelsPageSchema>;

export const placementActionSchema = z.enum(["present", "sync", "push", "unavailable"]);

export const placementRowSchema = z.object({
  node: z.object({
    id: z.string().uuid(),
    name: z.string(),
    kind: z.string(),
    role: z.string(),
    /** Push destination as the source agent should dial it (user@host or host). */
    host: z.string(),
    /** IR-101: cache owner of the destination (null = the agent user). */
    cacheUser: z.string().regex(CACHE_USER_PATTERN).nullable().default(null),
    online: z.boolean().default(false),
  }),
  action: placementActionSchema,
  reason: z.string().nullable().default(null),
  bytes: z.number().nonnegative().nullable().default(null),
  viaNodeIds: z.array(z.string()).default([]),
});

export const placementResponseSchema = z.object({
  model: z.object({ name: z.string(), bytes: z.number().nonnegative() }),
  placements: z.array(placementRowSchema),
});

export type PlacementResponse = z.infer<typeof placementResponseSchema>;
export type PlacementRow = z.infer<typeof placementRowSchema>;
