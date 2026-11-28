import { z } from "zod";
import type { InventoryStore } from "./inventory.js";

/** modelctl's draft spec-type grammar (drafts.py `_SPEC_TYPE_RE`). */
export const DRAFT_SPEC_TYPE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * Download queue (IRI-014): adding a download from HF always forms a
 * server-side queue entry. Entries dispatch to the store node (NAS-preferred,
 * `pickStoreNode`) as ONE `download-queue` batch — modelctl's queue is an
 * invocation-scoped YAML (ADR-0004), so the durable queue lives in Irori.
 */

/** Entry fields accepted from the UI (the modal's form). */
export const downloadCreateSchema = z.object({
  /** HF repo id or URL (`owner/model`). */
  source: z.string().trim().min(1).max(255),
  /** Store name; defaults to the repo tail (deriveDownloadName). */
  name: z.string().trim().min(1).max(128).optional(),
  /** GGUF quantization substring (modelctl --quantization); absent = single/auto. */
  quantization: z.string().trim().min(1).max(64).optional(),
  /** Explicit MTP/draft companion path (modelctl --mtp); absent = modelctl auto-selects. */
  mtp: z.string().trim().min(1).max(255).optional(),
  /**
   * IRI-152: llama.cpp --spec-type for the draft (modelctl draft_spec_type);
   * absent = modelctl derives it from the draft kind (mtp/dspark).
   */
  draftSpecType: z.string().trim().regex(DRAFT_SPEC_TYPE_RE, "draftSpecType must be lowercase letters, digits and '-' (max 32)").optional(),
  /** IRI-017: replace an existing manifest with different settings (modelctl per-entry force). */
  force: z.boolean().optional(),
  /** modelctl batch concurrency inside one dispatch (1–16). */
  jobs: z.number().int().min(1).max(16).default(4),
});

export type DownloadCreateInput = z.infer<typeof downloadCreateSchema>;

/** Hard cap per batch submission — preflight validates each entry remotely. */
export const DOWNLOAD_BATCH_MAX_ENTRIES = 50;

/** Bulk submission (IRI-015): N entries + one batch concurrency value. */
export const downloadBatchCreateSchema = z.object({
  downloads: z
    .array(downloadCreateSchema.pick({ source: true, name: true, quantization: true, mtp: true, draftSpecType: true, force: true }))
    .min(1)
    .max(DOWNLOAD_BATCH_MAX_ENTRIES),
  jobs: z.number().int().min(1).max(16).default(4),
});

export type DownloadBatchCreateInput = z.infer<typeof downloadBatchCreateSchema>;

export const DOWNLOAD_QUEUE_STATUSES = ["pending", "running", "succeeded", "failed", "canceled", "removed"] as const;
export const downloadQueueStatusSchema = z.enum(DOWNLOAD_QUEUE_STATUSES);
export type DownloadQueueStatus = (typeof DOWNLOAD_QUEUE_STATUSES)[number];

/** Queue entry as served by the API (never includes secrets). */
export const downloadQueueEntrySchema = z.object({
  id: z.string().uuid(),
  source: z.string(),
  name: z.string(),
  // IRI-016: absent on pre-0015 server responses — nullish keeps old hubs parseable.
  quantization: z.string().nullish(),
  mtp: z.string().nullish(),
  /** IRI-152: absent on pre-0029 server responses. */
  draftSpecType: z.string().nullish(),
  /** IRI-017: per-entry manifest replace (modelctl force). */
  force: z.boolean().nullish(),
  /** IRI-017 progress (modelctl progress events; null until the pinned modelctl emits them). */
  bytesDone: z.number().nullish(),
  bytesTotal: z.number().nullish(),
  speedBps: z.number().nullish(),
  status: downloadQueueStatusSchema,
  /** Batch job that carried this entry (null until dispatched). */
  jobId: z.string().uuid().nullable(),
  /** Failure detail (reconciled from the batch output / catalog). */
  error: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

export type DownloadQueueEntry = z.infer<typeof downloadQueueEntrySchema>;

/** Wire payload for POST /api/v1/downloads (INPUT type: defaults optional). */
export type DownloadCreatePayload = z.input<typeof downloadCreateSchema>;

/** Wire payload for GET /api/v1/downloads. */
export const downloadQueueResponseSchema = z.object({ entries: z.array(downloadQueueEntrySchema) });
export type DownloadQueueResponse = z.infer<typeof downloadQueueResponseSchema>;

/** Store name fallback: the repo tail of `owner/model` (mirrors the old modal). */
/** IRI-016: a quantization tag appends `-{TAG}` so same-repo quants don't collide. */
export function deriveDownloadName(source: string, quantization?: string): string {
  const tail = source.split("/").pop() ?? source;
  const base = tail.trim().length > 0 ? tail.trim() : source;
  const tag = quantization?.trim() ?? "";
  return tag.length > 0 ? `${base}-${tag}` : base;
}

interface StoreNodeCandidate {
  id: string;
  kind: string;
  enabled: boolean;
  /** NAS store root; null on nodes without the store mounted. */
  nasRoot: string | null;
  /** API flag (web); server rows pass an `online` set instead. */
  online?: boolean;
}

/**
 * IRI-174 (ADR-0023): may a node that only MOUNTS the store run store-mutating
 * jobs (downloads, deletes, repair, hygiene)? The NAS-kind node never asks —
 * the store is its local filesystem. A mounted Spark is the fallback writer
 * when the NAS node is offline, and it writes through a network mount.
 *
 * `store` is that node's latest inventory store view; null/undefined = no
 * report. `unlinkedActive` lists the active entries the node sees as
 * directories (absent = an older agent that does not report it).
 */
export function storeViewSafeForWrites(store: InventoryStore | null | undefined): boolean {
  // Strict (owner decision, 2026-11-28): the node must have reported a clean
  // catalog view that lists at least one model, with no active entry seen as
  // a directory. An empty view proves nothing about the mount, and one stray
  // directory would have modelctl's update path repair it through the mount.
  if (store === null || store === undefined) return false;
  if (store.unlinkedActive === undefined || store.unlinkedActive.length > 0) return false;
  return store.source === "catalog" && store.warning === null && store.models.length > 0;
}

/**
 * Store-node selection policy (IRI-014): the NAS-kind node wins — the store
 * is local there, so HF bytes never cross a network mount. Falls back to any
 * other node with the NAS root mounted (the CIFS route) when no NAS-kind
 * node qualifies. When `online` is given, only nodes in the set qualify.
 * Mirrors the setups-service NAS preference (IRI-005) as one shared policy.
 *
 * IRI-174 (ADR-0023): pass `writeSafe` when the pick will run a
 * store-mutating job. The fallback node must then satisfy it; the NAS-kind
 * node is exempt. Without it the pick is for reading or display only.
 */
export function pickStoreNode<T extends StoreNodeCandidate>(
  nodes: T[],
  online?: ReadonlySet<string>,
  writeSafe?: (node: T) => boolean,
): T | null {
  const qualifies = (n: T): boolean =>
    n.enabled && n.nasRoot !== null && (online === undefined ? n.online !== false : online.has(n.id));
  return (
    nodes.find((n) => n.kind === "nas" && qualifies(n)) ??
    nodes.find((n) => n.kind !== "nas" && qualifies(n) && (writeSafe === undefined || writeSafe(n))) ??
    null
  );
}

/** IRI-174: why store writes are waiting when no node may run them. */
export const STORE_WRITER_UNAVAILABLE_REASON = "no node can safely write the store right now (the NAS node is offline or not set up)";

/**
 * IRI-174 (ADR-0023): job kinds that always change the modelctl store. See
 * `isStoreWrite` for the two that depend on their params or the node.
 */
export const STORE_WRITE_KINDS: ReadonlySet<string> = new Set([
  "download-queue",
  "nas-delete",
  "nas-delete-apply",
  "nas-delete-batch",
  "catalog-refresh",
  "repair-active-apply",
  "gc-objects",
  "cleanup-staging",
  "sync-cards",
  "quarantine-prune",
  "prune-cleanup-quarantine",
]);

/**
 * IRI-174 (ADR-0023): does this job change the modelctl store? The hub
 * refuses such a job on a node that only mounts the store unless that node's
 * view is write-safe.
 *
 * - `hygiene-clean` writes the store only for its `modelctl-staging` category.
 * - `download` writes to modelctl's configured root. On a node that mounts
 *   the store that is the store; a node without a store root keeps its own.
 */
export function isStoreWrite(kind: string, params: Record<string, unknown>, node: { nasRoot: string | null }): boolean {
  if (STORE_WRITE_KINDS.has(kind)) return true;
  if (kind === "hygiene-clean") return Array.isArray(params.categories) && params.categories.includes("modelctl-staging");
  if (kind === "download" || kind === "install") return node.nasRoot !== null;
  return false;
}

/** Wire payload for GET /api/v1/store-writer (IRI-174). */
export const storeWriterResponseSchema = z.object({
  /** The node store-mutating jobs go to right now; null = none may write. */
  nodeId: z.string().nullable(),
  /** Why no node may write (null when one can). */
  reason: z.string().nullable(),
});
export type StoreWriterResponse = z.infer<typeof storeWriterResponseSchema>;
