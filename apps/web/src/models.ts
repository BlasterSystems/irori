import {
  downloadQueueEntrySchema,
  downloadQueueResponseSchema,
  jobInfoSchema,
  jobKindSchema,
  modelsPageSchema,
  placementResponseSchema,
  type DownloadQueueEntry,
  type JobView,
  type ModelsPage,
  type PlacementResponse,
} from "@irori/core";

/**
 * Models v2 + jobs API clients and pure shaping helpers. Server payloads are
 * parsed once at this boundary via the @irori/core contracts.
 */

export type { DownloadQueueEntry, JobView, ModelEntry, ModelsPage, PlacementRow, PlacementResponse } from "@irori/core";

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

export async function fetchModelsPage(page: number, q: string, sort: "recent" | "name" = "recent", signal?: AbortSignal): Promise<ModelsPage> {
  const url = `/api/v1/models?page=${page}${q.length > 0 ? `&q=${encodeURIComponent(q)}` : ""}&sort=${sort}`;
  const parsed = modelsPageSchema.safeParse(await getJson(url, signal));
  if (!parsed.success) throw new Error("malformed models response");
  return parsed.data;
}

export async function fetchPlacement(model: string, signal?: AbortSignal): Promise<PlacementResponse> {
  const parsed = placementResponseSchema.safeParse(await getJson(`/api/v1/placement?model=${encodeURIComponent(model)}`, signal));
  if (!parsed.success) throw new Error("malformed placement response");
  return parsed.data;
}

export interface JobOutputLine {
  seq: number;
  line: string;
}

function isOutputLine(o: unknown): o is JobOutputLine {
  return typeof o === "object" && o !== null && "seq" in o && "line" in o && typeof o.seq === "number" && typeof o.line === "string";
}

export function parseJobDetail(raw: unknown): JobDetail {
  if (typeof raw !== "object" || raw === null || !("job" in raw) || !("output" in raw) || !Array.isArray(raw.output)) {
    throw new Error("malformed job response");
  }
  const job = jobInfoSchema.safeParse(raw.job);
  if (!job.success) throw new Error("malformed job response");
  return { job: job.data, output: raw.output.filter(isOutputLine).map((o) => ({ seq: o.seq, line: o.line })) };
}

export async function fetchJob(id: string, signal?: AbortSignal): Promise<JobDetail> {
  return parseJobDetail(await getJson(`/api/v1/jobs/${encodeURIComponent(id)}`, signal));
}

/** Enqueue + dispatch a job; 409/404 surface as errors with the server message. */
export async function createJob(nodeId: string, kind: string, params: Record<string, unknown>): Promise<JobView> {
  const res = await fetch(`/api/v1/nodes/${encodeURIComponent(nodeId)}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind, params }),
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
    throw new Error(message);
  }
  const job = jobInfoSchema.safeParse(typeof body === "object" && body !== null && "job" in body ? body.job : undefined);
  if (!job.success) throw new Error("malformed job response");
  return job.data;
}

export async function cancelJob(id: string): Promise<void> {
  const res = await fetch(`/api/v1/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  if (!res.ok && res.status !== 204) throw new Error(`cancel failed (${res.status})`);
}

/** Server error text from an `{ error }` body, with an HTTP fallback. */
async function errorFrom(res: Response): Promise<string> {
  const body: unknown = await res.json().catch(() => null);
  if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") return body.error;
  return `HTTP ${res.status}`;
}

/**
 * IRI-014: queue a HF download. The server ALWAYS queues (never starts a
 * one-off job); it picks the store node (NAS-preferred) and drains pending
 * entries as one `download-queue` batch whenever that node is idle.
 */
export async function enqueueDownload(input: { source: string; name?: string; jobs: number }, signal?: AbortSignal): Promise<DownloadQueueEntry> {
  const res = await fetch("/api/v1/downloads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  if (!res.ok) throw new Error(await errorFrom(res));
  const body: unknown = await res.json().catch(() => null);
  const raw = typeof body === "object" && body !== null && "entry" in body ? body.entry : undefined;
  const entry = downloadQueueEntrySchema.safeParse(raw);
  if (!entry.success) throw new Error("malformed download queue response");
  return entry.data;
}

export async function fetchDownloadQueue(signal?: AbortSignal): Promise<DownloadQueueEntry[]> {
  const parsed = downloadQueueResponseSchema.safeParse(await getJson("/api/v1/downloads", signal));
  if (!parsed.success) throw new Error("malformed download queue response");
  return parsed.data.entries;
}

/** IRI-015: queue N downloads in ONE atomic submission. */
export async function enqueueDownloadsBatch(
  input: { downloads: Array<{ source: string; name?: string }>; jobs: number },
  signal?: AbortSignal,
): Promise<DownloadQueueEntry[]> {
  const res = await fetch("/api/v1/downloads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  if (!res.ok) throw new Error(await errorFrom(res));
  const body: unknown = await res.json().catch(() => null);
  const raw = typeof body === "object" && body !== null && "entries" in body && Array.isArray(body.entries) ? body.entries : [];
  const entries: DownloadQueueEntry[] = [];
  for (const item of raw) {
    const parsed = downloadQueueEntrySchema.safeParse(item);
    if (!parsed.success) throw new Error("malformed download queue response");
    entries.push(parsed.data);
  }
  return entries;
}

/** Removes a pending or terminal entry; the running batch must settle first. */
export async function removeDownload(id: string): Promise<void> {
  const res = await fetch(`/api/v1/downloads/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok && res.status !== 204) throw new Error(await errorFrom(res));
}

/** Re-queues a failed/canceled entry; the server drains when idle. */
export async function retryDownload(id: string): Promise<DownloadQueueEntry> {
  const res = await fetch(`/api/v1/downloads/${encodeURIComponent(id)}/retry`, { method: "POST" });
  if (!res.ok) throw new Error(await errorFrom(res));
  const body: unknown = await res.json().catch(() => null);
  const raw = typeof body === "object" && body !== null && "entry" in body ? body.entry : undefined;
  const entry = downloadQueueEntrySchema.safeParse(raw);
  if (!entry.success) throw new Error("malformed download queue response");
  return entry.data;
}

/** Pure: download queue status → chip label + class. */
export function downloadStatusChip(status: DownloadQueueEntry["status"]): { label: string; cls: string } {
  switch (status) {
    case "succeeded":
      return { label: "downloaded", cls: "chip--ok" };
    case "failed":
      return { label: "failed", cls: "chip--warn" };
    case "canceled":
    case "removed":
      return { label: status, cls: "chip" };
    default:
      return { label: status, cls: "chip--accent" };
  }
}

/**
 * IRI-012: dispatch an agent self-update to the hub's own version. The
 * server refuses (409) while the node has an active job/bench/running setup
 * or the agent predates the agent-update kind.
 */
export async function startAgentUpdate(nodeId: string): Promise<JobView> {
  const res = await fetch(`/api/v1/nodes/${encodeURIComponent(nodeId)}/agent-update`, { method: "POST" });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
    throw new Error(message);
  }
  const job = jobInfoSchema.safeParse(typeof body === "object" && body !== null && "job" in body ? body.job : undefined);
  if (!job.success) throw new Error("malformed job response");
  return job.data;
}

/** Verbs the UI offers, with their human labels and destructive marking. */
export const JOB_VERBS: Array<{ kind: string; label: string; destructive: boolean }> = [
  { kind: "download-queue", label: "Download to NAS", destructive: false },
  { kind: "sync-local", label: "Sync from NAS", destructive: false },
  { kind: "push", label: "Push to node", destructive: false },
  { kind: "nas-delete", label: "Delete from NAS (dry run)", destructive: false },
  { kind: "nas-delete-apply", label: "Delete from NAS (APPLY)", destructive: true },
  { kind: "doctor", label: "Doctor", destructive: false },
  { kind: "repair-active", label: "Repair check", destructive: false },
  { kind: "repair-active-apply", label: "Repair (APPLY)", destructive: true },
  { kind: "catalog-refresh", label: "Refresh catalog", destructive: false },
  { kind: "modelctl-install", label: "Install modelctl", destructive: false },
];

export interface JobDetail {
  job: JobView;
  output: JobOutputLine[];
}

/** Pure: formats bytes as GiB with 1 decimal. */
export function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

/** Pure: placement action → chip label + class per the DS thread budget. */
export function placementChip(action: "present" | "sync" | "push" | "unavailable"): { label: string; cls: string } {
  switch (action) {
    case "present":
      return { label: "present", cls: "chip--ok" };
    case "sync":
      return { label: "sync from NAS", cls: "chip--accent" };
    case "push":
      return { label: "push", cls: "chip--accent" };
    default:
      return { label: "unavailable", cls: "chip--warn" };
  }
}

/** Pure: job status → chip class. */
export function jobStatusChip(status: JobView["status"]): { label: string; cls: string } {
  switch (status) {
    case "succeeded":
      return { label: "succeeded", cls: "chip--ok" };
    case "failed":
      return { label: "failed", cls: "chip--warn" };
    case "canceled":
      return { label: "canceled", cls: "chip" };
    default:
      return { label: status, cls: "chip--accent" };
  }
}

export function isValidJobKind(kind: string): boolean {
  return jobKindSchema.safeParse(kind).success;
}
