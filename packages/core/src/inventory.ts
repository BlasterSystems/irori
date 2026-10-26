import { z } from "zod";

/**
 * Per-node model inventory (IRI-028). A read-only projection produced by the
 * agent's `models-inventory` job: the modelctl store (when the node has a
 * `nasRoot`) and every local HF-cache registration, per user — modelctl's
 * local state lives in the invoking user's home, so a root agent must list
 * each cache owner separately (research brief §1).
 */

/** One model row; `bytes` is null when the source cannot measure it. */
export const inventoryModelSchema = z.object({
  name: z.string().min(1),
  repository: z.string(),
  runtime: z.string(),
  bytes: z.number().nonnegative().nullable(),
});

export type InventoryModel = z.infer<typeof inventoryModelSchema>;

/** A store object left behind by a failed `modelctl delete` (journal FAILED). */
export const inventoryLeftoverSchema = z.object({
  /** Model name from the journal file name, when parseable. */
  name: z.string().nullable(),
  /** Absolute object path as recorded by modelctl (may use a foreign mount). */
  object: z.string().min(1),
  /** `ORG/REPO/COMMIT--SELECTION` for `modelctl gc-objects`; null when underivable. */
  target: z.string().nullable(),
  error: z.string().nullable(),
  failedAt: z.string().nullable(),
  bytes: z.number().nonnegative().nullable(),
});

export type InventoryLeftover = z.infer<typeof inventoryLeftoverSchema>;

/** Store view — present only when the node has a modelctl store root. */
export const inventoryStoreSchema = z.object({
  root: z.string().min(1),
  source: z.enum(["catalog", "scan"]),
  warning: z.string().nullable(),
  models: z.array(inventoryModelSchema),
  leftovers: z.array(inventoryLeftoverSchema),
});

export type InventoryStore = z.infer<typeof inventoryStoreSchema>;

/** One user's local HF cache (modelctl registrations). */
export const inventoryLocalCacheSchema = z.object({
  user: z.string().min(1),
  home: z.string().min(1),
  /** The hub cache dir (`<home>/.cache/huggingface/hub`). */
  cacheDir: z.string().min(1),
  modelctlVersion: z.string().nullable(),
  /** Non-null when this cache could not be listed (binary missing, timeout). */
  error: z.string().nullable(),
  models: z.array(inventoryModelSchema),
});

export type InventoryLocalCache = z.infer<typeof inventoryLocalCacheSchema>;

export const nodeInventorySchema = z.object({
  generatedAtMs: z.number().nonnegative(),
  store: inventoryStoreSchema.nullable(),
  local: z.array(inventoryLocalCacheSchema),
});

export type NodeInventory = z.infer<typeof nodeInventorySchema>;

/** Store delete targets accepted by the `delete-local` job (agent derives the
 *  binary/home/cache dir; the hub never sends paths). */
export const deleteLocalParamsSchema = z.object({
  name: z.string().min(1),
  /** Cache owner; omitted/root = the agent's own cache. */
  user: z.string().min(1).optional(),
});

export type DeleteLocalParams = z.infer<typeof deleteLocalParamsSchema>;
