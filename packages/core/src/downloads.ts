import { z } from "zod";

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
  /** modelctl batch concurrency inside one dispatch (1–16). */
  jobs: z.number().int().min(1).max(16).default(4),
});

export type DownloadCreateInput = z.infer<typeof downloadCreateSchema>;

/** Hard cap per batch submission — preflight validates each entry remotely. */
export const DOWNLOAD_BATCH_MAX_ENTRIES = 50;

/** Bulk submission (IRI-015): N entries + one batch concurrency value. */
export const downloadBatchCreateSchema = z.object({
  downloads: z
    .array(downloadCreateSchema.pick({ source: true, name: true }))
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
export function deriveDownloadName(source: string): string {
  const tail = source.split("/").pop() ?? source;
  return tail.trim().length > 0 ? tail.trim() : source;
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
 * Store-node selection policy (IRI-014): the NAS-kind node wins — the store
 * is local there, so HF bytes never cross a network mount. Falls back to any
 * other node with the NAS root mounted (the CIFS route) when no NAS-kind
 * node qualifies. When `online` is given, only nodes in the set qualify.
 * Mirrors the setups-service NAS preference (IRI-005) as one shared policy.
 */
export function pickStoreNode<T extends StoreNodeCandidate>(nodes: T[], online?: ReadonlySet<string>): T | null {
  const qualifies = (n: T): boolean =>
    n.enabled && n.nasRoot !== null && (online === undefined ? n.online !== false : online.has(n.id));
  return (
    nodes.find((n) => n.kind === "nas" && qualifies(n)) ??
    nodes.find((n) => n.kind !== "nas" && qualifies(n)) ??
    null
  );
}
