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

/** A live-scan entry (agent-side scan of active/ + manifests), same shape as a catalog model. */
export type ScannedModel = CatalogModel;

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

/** Placement decision for one (model, node) pair. */
export type PlacementAction = "present" | "sync" | "push" | "unavailable";

export interface PlacementNode {
  id: string;
  name: string;
  kind: "spark" | "gpu-host" | "nas";
  role: "head" | "worker" | "standalone";
  /** Node is a model-ops node with the NAS store mounted at nasRoot. */
  hasNasRoot: boolean;
  /** Node is a valid push destination (agent online + modelctl-capable). */
  pushCapable: boolean;
  diskFreeBytes: number | null;
}

export interface PlacementInput {
  /** Which node currently holds the model (NAS root counts as the source). */
  availableOn: Array<{ nodeId: string; bytes: number }>;
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
 * "present" = the node already holds the model (or IS the store); "sync" =
 * the node mounts the store and the model is on it (plain rsync); "push" =
 * some node holding the model locally must ssh it over.
 */
export function planPlacement(input: PlacementInput): PlacementResult {
  const needs = input.availableOn.find((a) => a.bytes > 0)?.bytes ?? 0;
  const onNas = input.availableOn.find((a) => a.nodeId === "nas");
  if (input.target.kind === "nas") return { action: "present" };
  const local = input.availableOn.find((a) => a.nodeId === input.target.id);
  if (local) return { action: "present" };

  const cannotServe = (reason: string): PlacementResult => ({ action: "unavailable", reason });
  const viaNodeIds = input.availableOn.filter((a) => a.nodeId !== input.target.id && a.nodeId !== "nas").map((a) => a.nodeId);
  const blocked = (reason: string): PlacementResult =>
    viaNodeIds.length > 0 ? { action: "unavailable", reason, viaNodeIds } : { action: "unavailable", reason };
  if (!input.target.pushCapable) return blocked("node is offline or not modelctl-capable");
  const free = input.target.diskFreeBytes;
  if (free === null) return blocked("disk usage not reported");
  if (free - input.reserveBytes < needs) {
    return blocked(`needs ${needs} bytes, only ${Math.max(0, free - input.reserveBytes)} free`);
  }
  if (input.availableOn.length === 0) return blocked("model not present on any node");

  // The node mounts the store and the model is on it: a plain sync-local.
  if (input.target.hasNasRoot && onNas) return { action: "sync", bytes: needs };

  // Otherwise the model must arrive from a node that holds it locally.
  if (viaNodeIds.length === 0) {
    return cannotServe("model is on the NAS but no node holds it locally to push from");
  }
  return { action: "push", bytes: needs, viaNodeIds };
}
