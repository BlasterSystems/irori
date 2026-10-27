import {
  jobInfoSchema,
  nodeInventorySchema,
  type InventoryLeftover,
  type InventoryModel,
  type NodeInventory,
} from "@irori/core";
import type { JobView } from "./models";
import { fmtBytes } from "./analytics";

/**
 * Node model inventory client + pure shaping helpers (IRI-028). The report is
 * built by the agent's read-only `models-inventory` job and cached by the hub;
 * the page refreshes it through POST …/models/refresh.
 */

export interface NodeInventoryState {
  report: NodeInventory | null;
  updatedAt: string | null;
}

export async function fetchNodeInventory(nodeId: string, signal?: AbortSignal): Promise<NodeInventoryState> {
  const res = await fetch(`/api/v1/nodes/${encodeURIComponent(nodeId)}/models`, {
    headers: { accept: "application/json" },
    signal,
  });
  if (!res.ok) throw new Error(`GET /api/v1/nodes/${nodeId}/models failed: HTTP ${res.status}`);
  const body: unknown = await res.json();
  const o = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const parsed = nodeInventorySchema.safeParse(o.report);
  return {
    report: parsed.success ? parsed.data : null,
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : null,
  };
}

/** Dispatches the read-only inventory job; 409 while the node is busy. */
export async function refreshNodeInventory(nodeId: string): Promise<JobView> {
  const res = await fetch(`/api/v1/nodes/${encodeURIComponent(nodeId)}/models/refresh`, {
    method: "POST",
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    const message = typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string"
      ? (body as { error: string }).error
      : `HTTP ${res.status}`;
    throw new Error(message);
  }
  const body: unknown = await res.json();
  const job = typeof body === "object" && body !== null ? (body as { job?: unknown }).job : null;
  const parsed = jobInfoSchema.safeParse(job);
  if (!parsed.success) throw new Error("malformed job response");
  return parsed.data;
}

/** Which storage class a row belongs to (drives the delete verb). */
export type InventoryScope = "store" | "local" | "leftover";

export type DeleteTarget =
  | { scope: "store"; name: string; repository: string; bytes: number | null }
  | { scope: "local"; name: string; repository: string; bytes: number | null; user: string; cacheDir: string }
  | { scope: "leftover"; name: string | null; object: string; target: string; bytes: number | null; error: string | null };

export interface DeleteRequest {
  kind: "nas-delete-apply" | "delete-local" | "gc-objects";
  params: Record<string, unknown>;
}

/**
 * Maps a row to its job. Store models run `nas-delete-apply`; local rows run
 * `delete-local` as the cache owner (modelctl state is per user); leftovers run
 * `gc-objects` with the three-part audited path. Null when a leftover has no
 * derivable gc target.
 */
export function deleteRequestFor(target: DeleteTarget): DeleteRequest | null {
  switch (target.scope) {
    case "store":
      return { kind: "nas-delete-apply", params: { name: target.name } };
    case "local":
      return { kind: "delete-local", params: { name: target.name, user: target.user } };
    case "leftover":
      return target.target.length === 0 ? null : { kind: "gc-objects", params: { targets: [target.target], apply: true } };
  }
}

/** Human title/body for the delete confirm card. */
export function deleteConfirmCopy(target: DeleteTarget): { title: string; body: string; danger: string } {
  switch (target.scope) {
    case "store":
      return {
        title: `Delete ${target.name} from the store?`,
        body: "Removes the active reference, staging and unreferenced objects from the modelctl store on this node. A running setup keeps its open files until restart, then fails to start.",
        danger: "Delete from store",
      };
    case "local":
      return {
        title: `Delete ${target.name} from ${target.user}'s cache?`,
        body: `Removes this registration's snapshots, refs and blobs from ${target.cacheDir} via modelctl delete-local as ${target.user}. The store is untouched.`,
        danger: "Delete local copy",
      };
    case "leftover":
      return {
        title: `Remove leftover object?`,
        body: "Revalidates that no active model references this object, then deletes it from the store via modelctl gc-objects. Use this after a delete failed on permissions.",
        danger: "Remove leftover",
      };
  }
}

/** IR-104: a register-local request for an unregistered cache dir. */
export interface RegisterRequest {
  kind: "register-local";
  params: { name: string; user: string };
}

export function registerRequestFor(repo: string, user: string): RegisterRequest {
  return { kind: "register-local", params: { name: repo, user } };
}

/** Human title/body for the register confirm card. */
export function registerCopy(repo: string): { title: string; body: string; danger: string } {
  return {
    title: `Register ${repo} from the local cache?`,
    body: "Verifies this cache entry against the NAS object by hash (blob identity plus small-file hashes) and writes the registration. Nothing is transferred; any mismatch refuses the registration.",
    danger: "Register",
  };
}

/** The snapshot storage entry backing a store root (mount prefix, longest wins). */
export function storeMountLabel(
  nasRoot: string,
  storage: Array<{ mount: string; fs: string }> | null | undefined,
): string {
  if (storage === null || storage === undefined) return nasRoot;
  let best: { mount: string; fs: string } | null = null;
  for (const entry of storage) {
    // "/" would match every path; only report it for the root itself.
    if (entry.mount === "/") continue;
    const prefix = `${entry.mount.replace(/\/$/, "")}/`;
    if (nasRoot === entry.mount || nasRoot.startsWith(prefix)) {
      if (best === null || entry.mount.length > best.mount.length) best = entry;
    }
  }
  return best === null ? nasRoot : `${best.mount} · ${best.fs}`;
}

/** Case-insensitive name/repository filter shared by the tables. */
export function filterModels(models: InventoryModel[], query: string): InventoryModel[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return models;
  return models.filter((m) => m.name.toLowerCase().includes(needle) || m.repository.toLowerCase().includes(needle));
}

/** "3 models · 1.2 TB" style summary; null bytes are ignored. */
export function inventorySummary(models: InventoryModel[]): string {
  const total = models.reduce((sum, m) => sum + (m.bytes ?? 0), 0);
  return `${models.length} model${models.length === 1 ? "" : "s"}${total > 0 ? ` · ${fmtBytes(total)}` : ""}`;
}

export function leftoverLabel(leftover: InventoryLeftover): string {
  return leftover.name ?? leftover.object.split("/").filter((part) => part.length > 0).pop() ?? leftover.object;
}
