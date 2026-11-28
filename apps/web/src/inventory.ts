import {
  jobInfoSchema,
  nodeInventorySchema,
  pickSyncModelctlVersion,
  syncNeedsVisibleLink,
  MODELCTL_SYNC_WITHOUT_SYMLINK,
  type InventoryLeftover,
  type InventoryLocalCache,
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

/** Dispatches the read-only inventory job; 409 while the node is busy.
 *  IR-248: a fresh report (< 60 s) short-circuits server-side — the response
 *  carries `{reused: true, report, updatedAt}` and no job is dispatched. */
export type InventoryRefreshResult = { job: JobView } | { reused: true; report: NodeInventoryState };

export async function refreshNodeInventory(nodeId: string): Promise<InventoryRefreshResult> {
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
  const o = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  if (o.reused === true) {
    const parsed = nodeInventorySchema.safeParse(o.report);
    return { reused: true, report: { report: parsed.success ? parsed.data : null, updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : null } };
  }
  const job = o.job;
  const parsed = jobInfoSchema.safeParse(job);
  if (!parsed.success) throw new Error("malformed job response");
  return { job: parsed.data };
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

/** IR-133: a resume-transfer request for a partial (resumable) sync-local.
 *  Same name + cache user as the Register flow; the agent re-runs
 *  `modelctl sync-local`, whose deterministic staging dir plus rsync
 *  --partial makes completed files skip — it continues instead of re-copying. */
export interface ResumeRequest {
  kind: "sync-local";
  params: { name: string; user: string };
}

export function resumeRequestFor(repo: string, user: string): ResumeRequest {
  return { kind: "sync-local", params: { name: repo, user } };
}

/** Human title/body for the resume confirm card. */
export function resumeCopy(repo: string): { title: string; body: string; danger: string } {
  return {
    title: `Resume transferring ${repo}?`,
    body: "Continues the interrupted transfer from the staging area into this cache. Files already copied are not re-transferred.",
    danger: "Resume transfer",
  };
}

/** Per-state hint under the orphan row (IR-133). The table header copy stays
 *  register-specific; resumable rows get the staging-resume explanation. */
export function orphanHint(state: "adoptable" | "resumable" | "unknown"): string | null {
  return state === "resumable" ? "partial transfer — Resume continues from staging; completed files are not re-copied" : null;
}

/** Orphan rows with their adoption state (IR-133). Reports from
 *  pre-classification agents carry no states, so every row falls back to
 *  `unknown` — the Register-only behavior they shipped with. */
export function orphanRowsFor(cache: Pick<InventoryLocalCache, "orphans" | "orphanStates">): Array<{ repo: string; state: "adoptable" | "resumable" | "unknown" }> {
  const states = new Map(cache.orphanStates.map((s) => [s.repo, s.state]));
  return cache.orphans.map((repo) => ({ repo, state: states.get(repo) ?? "unknown" }));
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

/**
 * IRI-175: what to say about a Spark's view of the NAS store. A mount that
 * hides the store's symlinks (SMB) is only a problem when the modelctl that
 * runs the sync is older than 0.25.1; on a newer one it is a quiet note,
 * not a warning. Any other store warning is shown as it is.
 */
export function storeLinkNote(
  inventory: Pick<NodeInventory, "store" | "local">,
  cacheUser: string | null,
): { tone: "warn" | "note"; text: string } | null {
  const store = inventory.store;
  if (store === null) return null;
  const hidden = store.unlinkedActive?.length ?? 0;
  const aboutLinks = store.warning === null || /not visible as symlinks/.test(store.warning);
  if (hidden === 0 || !aboutLinks) return store.warning === null ? null : { tone: "warn", text: store.warning };
  const version = pickSyncModelctlVersion(inventory.local.map((l) => ({ user: l.user, version: l.modelctlVersion })), cacheUser);
  const links = hidden === 1 ? "1 of the store's links as a directory" : `${hidden} of the store's links as directories`;
  if (!syncNeedsVisibleLink(version)) {
    return { tone: "note", text: `this mount shows ${links} (SMB). Syncing from the store works here: modelctl ${version} reads the store's update journal instead.` };
  }
  if (version === null) {
    // Unknown is not "old": the pin may already be right. Send the reader to
    // the cache row that failed to report, not to the pin.
    return {
      tone: "warn",
      text: `this mount shows ${links} (SMB), and this node's modelctl version could not be read, so syncing from the store is held back. Refresh the inventory, and check the model cache user's row below for an error.`,
    };
  }
  return {
    tone: "warn",
    text: `this mount shows ${links} (SMB), so syncing from the store will not work here with modelctl ${version}. Raise the hub's modelctl pin to ${MODELCTL_SYNC_WITHOUT_SYMLINK} or newer and refresh, or mount the store over NFS.`,
  };
}
