import { z } from "zod";

/** modelctl catalog.json, schema 3 (read-only for Irori — ADR-0004). */
export const catalogModelSchema = z.object({
  name: z.string().min(1),
  runtime: z.string().min(1),
  repository: z.string().min(1),
  bytes: z.number().nonnegative(),
});

export const catalogSchema = z.object({
  schema: z.number().int(),
  generation: z.number().int().nonnegative().optional(),
  generated_at: z.string().optional(),
  active_fingerprint: z.string().optional(),
  content_sha256: z.string().optional(),
  seq: z.number().int().nonnegative().optional(),
  models: z.array(catalogModelSchema),
});

export type CatalogModel = z.infer<typeof catalogModelSchema>;
export type Catalog = z.infer<typeof catalogSchema>;

export class CatalogFormatError extends Error {}

/**
 * Parses a modelctl catalog. Throws CatalogFormatError when the payload is
 * not a catalog (callers treat that as "fall back to a live scan").
 */
export function parseCatalog(json: string): Catalog {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new CatalogFormatError("catalog.json is not valid JSON");
  }
  const parsed = catalogSchema.safeParse(raw);
  if (!parsed.success) throw new CatalogFormatError("catalog.json failed schema validation");
  return parsed.data;
}

/**
 * IRI-155: a companion path as recorded in the object's `.modelctl.json`:
 * relative to the object dir, never absolute, never `..`, no `\` or NUL.
 */
export const companionPathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((p) => !p.startsWith("/") && !/[\\\0]/.test(p) && !p.split("/").some((s) => s === ".." || s === "." || s === ""), {
    message: "companion path must be a plain relative path",
  });

/** modelctl `drafts.validate_spec_type` (lowercase, digits, '-', at most 32 chars). */
export const DRAFT_SPEC_TYPE_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export const storeCompanionFileSchema = z.object({
  path: companionPathSchema,
  /** From the object's `files[]`; null when not recorded. */
  bytes: z.number().int().nonnegative().nullable(),
});

/**
 * Installed companions of a store model (ADR-0020), read from the published
 * object, not the manifest.
 */
export const storeCompanionsSchema = z.object({
  mmproj: storeCompanionFileSchema.nullable(),
  /** The `mtp` companion key: any speculative draft (MTP, DSpark, DFlash). */
  draft: storeCompanionFileSchema
    .extend({
      /** The object's recorded `draft_spec_type`; null = modelctl's kind default applies. */
      specType: z.string().regex(DRAFT_SPEC_TYPE_PATTERN).nullable(),
    })
    .nullable(),
});

export type StoreCompanions = z.infer<typeof storeCompanionsSchema>;

/** The agent could not read the installed object's metadata (timeout, I/O error, corrupt, refused). */
export const companionsUnreadableSchema = z.object({ unreadable: z.literal(true) });
export const COMPANIONS_UNREADABLE = { unreadable: true } as const;

/**
 * What a store entry reports: the companions, `null` (known, none: no
 * companions recorded, or no metadata file at all), or `{unreadable: true}`.
 * Unreadable REPLACES a previously stored value (owner decision, IRI-155):
 * the page never shows companions it could not confirm on the last read.
 */
export const storeCompanionsStateSchema = z.union([storeCompanionsSchema, companionsUnreadableSchema]).nullable();
export type StoreCompanionsState = z.infer<typeof storeCompanionsStateSchema>;

export function isCompanionsUnreadable(c: StoreCompanionsState | undefined): c is { unreadable: true } {
  return typeof c === "object" && c !== null && "unreadable" in c && c.unreadable === true;
}

/**
 * Agent → hub store entry: a catalog model and optional companions. Kept apart
 * from `catalogModelSchema` (which parses modelctl's own catalog.json) so a
 * future modelctl catalog field can never fail Irori's catalog parse.
 */
export const storeModelSchema = catalogModelSchema.extend({
  /**
   * Absent = unknown (an agent older than IRI-155): the hub keeps what it
   * stored. A shape this build doesn't know (a future agent) also degrades to
   * unknown instead of failing, and so dropping, the whole catalog frame.
   */
  companions: storeCompanionsStateSchema.optional().catch(undefined),
});

/** A store entry as the agent reports it (catalog.json or a live scan of active/). */
export type ScannedModel = z.infer<typeof storeModelSchema>;

/** Store-sourced entry with provenance (catalog vs live scan vs node-local registration). */
export interface StoreModelEntry {
  name: string;
  runtime: string;
  repository: string;
  bytes: number;
  source: "catalog" | "scan" | "local";
}

export function catalogToEntries(catalog: Catalog): StoreModelEntry[] {
  return catalog.models.map((m) => ({ ...m, source: "catalog" as const }));
}

/** IRI-173: placement reason when a node mounts the store but sees the
 *  model's `active/` link as a directory (SMB hides server-side symlinks). */
export const STORE_LINK_HIDDEN_REASON = "store link not visible on this node's mount — check the NAS share settings";

/** Placement decision for one (model, node) pair. */
export type PlacementAction = "present" | "sync" | "push" | "unavailable";

export interface PlacementNode {
  id: string;
  name: string;
  kind: "spark" | "gpu-host" | "nas";
  role: "head" | "worker" | "standalone";
  /** Node is a model-ops node with the NAS store mounted at nasRoot. */
  hasNasRoot: boolean;
  /** IRI-173: `false` = the node sees the model's store link as a directory,
   *  so `sync-local` cannot work there. Absent = unknown (treated as fine). */
  storeLinkVisible?: boolean;
  /** Node is a valid push destination (agent online + modelctl-capable). */
  pushCapable: boolean;
  diskFreeBytes: number | null;
}

export interface PlacementInput {
  /** Which node currently holds the model (NAS root counts as the source). */
  availableOn: Array<{
    nodeId: string;
    bytes: number;
    /** The holder's agent is reachable (online). Omitted on the NAS pseudo-entry. */
    online?: boolean;
  }>;
  target: PlacementNode;
  reserveBytes: number;
}

export type PlacementResult =
  | { action: "present" }
  | { action: "sync"; bytes: number }
  | { action: "push"; bytes: number; viaNodeIds: string[] }
  | { action: "unavailable"; reason: string; viaNodeIds?: string[] };

/**
 * Pure planner: model × node → present|sync|push|unavailable with capacity
 * math free = diskFree − reserve; needs = model bytes.
 *
 * "present" = the node already holds the model (or IS the store); "push" =
 * some node holding the model locally must ssh it over — preferred whenever a
 * reachable holder exists, because the CX7 fabric beats the SMB store hop;
 * "sync" = fallback: the node mounts the store and the model is on it but no
 * reachable holder exists (plain rsync from the store).
 */
export function planPlacement(input: PlacementInput): PlacementResult {
  const needs = input.availableOn.find((a) => a.bytes > 0)?.bytes ?? 0;
  const onNas = input.availableOn.find((a) => a.nodeId === "nas");
  if (input.target.kind === "nas") return { action: "present" };
  const local = input.availableOn.find((a) => a.nodeId === input.target.id);
  if (local) return { action: "present" };

  const cannotServe = (reason: string): PlacementResult => ({ action: "unavailable", reason });
  // Local holders (NAS excluded), reachable ones first — callers dispatch the
  // push job on viaNodeIds[0].
  const onlineIds = new Set(input.availableOn.filter((a) => a.online === true).map((a) => a.nodeId));
  const holderIds = input.availableOn.filter((a) => a.nodeId !== input.target.id && a.nodeId !== "nas").map((a) => a.nodeId);
  const viaNodeIds = [...holderIds.filter((id) => onlineIds.has(id)), ...holderIds.filter((id) => !onlineIds.has(id))];
  const blocked = (reason: string): PlacementResult =>
    viaNodeIds.length > 0 ? { action: "unavailable", reason, viaNodeIds } : { action: "unavailable", reason };
  if (!input.target.pushCapable) return blocked("node is offline or not modelctl-capable");
  const free = input.target.diskFreeBytes;
  if (free === null) return blocked("disk usage not reported");
  if (free - input.reserveBytes < needs) {
    return blocked(`needs ${needs} bytes, only ${Math.max(0, free - input.reserveBytes)} free`);
  }
  if (input.availableOn.length === 0) return blocked("model not present on any node");

  // A reachable local holder pushes over the CX7 fabric (IR-100): node → node
  // beats the SMB store hop. The NAS sync is the fallback when every holder
  // is unreachable, and the offline-holder push remains the last resort for
  // store-less models (it dispatches when the holder reconnects).
  if (viaNodeIds.some((id) => onlineIds.has(id))) return { action: "push", bytes: needs, viaNodeIds };

  // No reachable holder, but the node mounts the store and the model is on
  // it: a plain sync-local — unless the node cannot see the store link
  // (IRI-173), in which case the sync would fail inside modelctl.
  const linkHidden = input.target.hasNasRoot && onNas !== undefined && input.target.storeLinkVisible === false;
  if (input.target.hasNasRoot && onNas && !linkHidden) return { action: "sync", bytes: needs };

  if (viaNodeIds.length === 0) {
    return cannotServe(linkHidden ? STORE_LINK_HIDDEN_REASON : "model is on the NAS but no node holds it locally to push from");
  }
  return { action: "push", bytes: needs, viaNodeIds };
}
