import {
  downloadQueueEntrySchema,
  downloadQueueResponseSchema,
  hfQuantsResultSchema,
  jobInfoSchema,
  jobKindSchema,
  modelsPageSchema,
  placementResponseSchema,
  type DownloadQueueEntry,
  type JobView,
  type ModelsPage,
  type PlacementResponse,
  type HfQuantsResult,
} from "@irori/core";

/**
 * Models v2 + jobs API clients and pure shaping helpers. Server payloads are
 * parsed once at this boundary via the @irori/core contracts.
 */

export type { DownloadQueueEntry, HfQuantsResult, JobView, ModelEntry, ModelsPage, PlacementRow, PlacementResponse } from "@irori/core";

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
export async function enqueueDownload(
  input: { source: string; name?: string; quantization?: string; mtp?: string; force?: boolean; jobs: number },
  signal?: AbortSignal,
): Promise<DownloadQueueEntry> {
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
  input: { downloads: Array<{ source: string; name?: string; quantization?: string; mtp?: string; force?: boolean }>; jobs: number },
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

/**
 * IRI-016: GGUF quantization/companion listing for the expand-quants flow.
 * Server-side proxy of the HF API; errors surface with the server message.
 */
export async function fetchHfQuants(repo: string, signal?: AbortSignal): Promise<HfQuantsResult> {
  const res = await fetch(`/api/v1/hf-quants?repo=${encodeURIComponent(repo)}`, { signal });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") {
      throw new Error(body.error);
    }
    throw new Error(`GET /api/v1/hf-quants -> ${res.status}`);
  }
  const parsed = hfQuantsResultSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error("malformed hf-quants response");
  return parsed.data;
}

/** Removes a pending or terminal entry; the running batch must settle first. */
export async function removeDownload(id: string): Promise<void> {
  const res = await fetch(`/api/v1/downloads/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok && res.status !== 204) throw new Error(await errorFrom(res));
}

/** Re-queues a failed/canceled entry; the server drains when idle. IRI-017: force=true opts into manifest replacement. */
export async function retryDownload(id: string, force = false): Promise<DownloadQueueEntry> {
  const res = await fetch(`/api/v1/downloads/${encodeURIComponent(id)}/retry`, {
    method: "POST",
    ...(force ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ force: true }) } : {}),
  });
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

/** Pure: 0–100 progress for a running entry; null when bytes are unknown. */
export function downloadProgressPct(e: DownloadQueueEntry): number | null {
  if (e.status !== "running" || e.bytesDone === null || e.bytesDone === undefined) return null;
  if (e.bytesTotal === null || e.bytesTotal === undefined || e.bytesTotal <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((e.bytesDone / e.bytesTotal) * 100)));
}

/** Pure: human speed label + animation bucket from a raw bytes/s figure.
 *  Speed is shown in bits (network convention: Mb/s). */
export function downloadSpeedLabel(speedBps: number): { label: string; bucket: "slow" | "ok" | "fast" } {
  const mbps = (speedBps * 8) / 1_000_000;
  const label =
    mbps >= 1000 ? `${(mbps / 1000).toFixed(1)} Gb/s` : mbps >= 1 ? `${Math.round(mbps)} Mb/s` : `${Math.max(1, Math.round((speedBps * 8) / 1000))} kb/s`;
  const bucket = mbps >= 1000 ? "fast" : mbps >= 100 ? "ok" : "slow";
  return { label, bucket };
}

/** Pure: human speed label + animation bucket (drives the bar/speed color); null when unknown. */
export function downloadSpeedView(e: DownloadQueueEntry): { label: string; bucket: "slow" | "ok" | "fast" } | null {
  if (e.status !== "running" || e.speedBps === null || e.speedBps === undefined) return null;
  return downloadSpeedLabel(e.speedBps);
}

/** Pure: human bytes line ("12.3 GiB / 45.6 GiB") for a running entry; null when unknown. */
export function downloadBytesLine(e: DownloadQueueEntry): string | null {
  if (e.status !== "running" || e.bytesDone === null || e.bytesDone === undefined) return null;
  if (e.bytesTotal === null || e.bytesTotal === undefined || e.bytesTotal <= 0) return formatGiB(e.bytesDone);
  return `${formatGiB(e.bytesDone)} / ${formatGiB(e.bytesTotal)}`;
}

/** Pure: seconds remaining for a running entry; null when unknown. */
export function downloadEntryEta(e: DownloadQueueEntry): number | null {
  if (e.status !== "running" || e.speedBps === null || e.speedBps === undefined || e.speedBps <= 0) return null;
  if (e.bytesDone === null || e.bytesDone === undefined || e.bytesTotal === null || e.bytesTotal === undefined) return null;
  if (e.bytesTotal <= e.bytesDone) return 0;
  return Math.round((e.bytesTotal - e.bytesDone) / e.speedBps);
}

/** Pure: average rate of a settled entry from its timestamps; null when unknowable. */
export function downloadAvgSpeedBps(e: DownloadQueueEntry): number | null {
  if (e.bytesTotal === null || e.bytesTotal === undefined || e.bytesTotal <= 0) return null;
  const start = Date.parse(e.createdAt);
  const end = Date.parse(e.updatedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return e.bytesTotal / ((end - start) / 1000);
}

/** Pure: "45s" under a minute, "m:ss" under an hour, "Hh MMm" beyond. */
export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}:${String(s % 60).padStart(2, "0")}`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Aggregated batch state over the queue DTO (IRI-020): combined rate, overall
 *  bytes + %, and ETA. Terminal rows count their settled bytes so finished
 *  entries keep contributing to the strip; nulls mean "not enough data" and
 *  callers hide the part. */
export interface DownloadBatchTotals {
  entries: number;
  active: number;
  bytesDone: number;
  bytesTotal: number;
  pct: number | null;
  speedBps: number | null;
  etaSeconds: number | null;
}

export function downloadBatchTotals(entries: DownloadQueueEntry[]): DownloadBatchTotals {
  let bytesDone = 0;
  let bytesTotal = 0;
  let speedBps = 0;
  let active = 0;
  for (const e of entries) {
    if (e.status === "running" || e.status === "pending") active += 1;
    // Bytes count toward the strip only when the row carries a matching
    // denominator — a bytesDone with unknown total would otherwise inflate
    // the numerator and can clamp the strip to 100% mid-flight.
    if (e.bytesTotal !== null && e.bytesTotal !== undefined) {
      bytesTotal += e.bytesTotal;
      if (e.status === "succeeded") bytesDone += e.bytesTotal;
      else if (e.bytesDone !== null && e.bytesDone !== undefined) bytesDone += e.bytesDone;
    }
    if (e.status === "running" && e.speedBps !== null && e.speedBps !== undefined) speedBps += e.speedBps;
  }
  return {
    entries: entries.length,
    active,
    bytesDone,
    bytesTotal,
    pct: bytesTotal > 0 ? Math.max(0, Math.min(100, Math.round((bytesDone / bytesTotal) * 100))) : null,
    speedBps: speedBps > 0 ? speedBps : null,
    etaSeconds: speedBps > 0 && bytesTotal > bytesDone ? Math.round((bytesTotal - bytesDone) / speedBps) : null,
  };
}

/** Pure: ⋯-menu actions per queue-row state, in display order (IRI-020). */
export type DownloadRowAction = "job" | "cancel-job" | "retry" | "retry-force" | "remove";

export function downloadRowActions(status: DownloadQueueEntry["status"], hasJob: boolean): Array<{ act: DownloadRowAction; label: string }> {
  const items: Array<{ act: DownloadRowAction; label: string }> = [];
  if (hasJob) items.push({ act: "job", label: "Job output" });
  if (status === "running") items.push({ act: "cancel-job", label: "Cancel job…" });
  if (status === "failed" || status === "canceled") {
    items.push({ act: "retry", label: "Retry" });
    items.push({ act: "retry-force", label: "Retry with force…" });
  }
  if (status !== "running") items.push({ act: "remove", label: "Remove…" });
  return items;
}

/** Pure: the job drawer's collapsed log (IRI-020) — one line per entry plus a
 *  total line, name column padded to the longest entry for monospace rendering. */
export function downloadJobSummary(entries: DownloadQueueEntry[]): string {
  const n = entries.length;
  const nameW = Math.max(0, ...entries.map((e) => e.name.length));
  const lines = entries.map((e, i) => {
    const idx = `[${i + 1}/${n}]`;
    const name = e.name.padEnd(nameW);
    if (e.status === "running") {
      const pct = downloadProgressPct(e);
      const segs = [pct !== null ? `${pct}%` : "", downloadBytesLine(e) ?? "", downloadSpeedView(e)?.label ?? ""];
      const eta = downloadEntryEta(e);
      if (eta !== null) segs.push(`eta ${formatEta(eta)}`);
      return `${idx} ▸ ${[name, ...segs.filter((s) => s.length > 0)].join("  ")}`;
    }
    if (e.status === "succeeded") {
      const total = e.bytesTotal ?? e.bytesDone ?? null;
      const segs = [total !== null ? `${formatGiB(total)} downloaded` : "downloaded"];
      const avg = downloadAvgSpeedBps(e);
      if (avg !== null) segs.push(`avg ${downloadSpeedLabel(avg).label}`);
      return `${idx} ✓ ${[name, ...segs].join("  ")}`;
    }
    if (e.status === "failed") return `${idx} ✗ ${name}  failed — ${(e.error ?? "error").replace(/\s+/g, " ")}`;
    if (e.status === "canceled") return `${idx} ✗ ${name}  canceled`;
    return `${idx} · ${name}  ${e.status === "pending" ? "waiting" : e.status}`;
  });
  const t = downloadBatchTotals(entries);
  const tsegs: string[] = [];
  if (t.pct !== null) tsegs.push(`${t.pct}%`);
  if (t.bytesTotal > 0) tsegs.push(`${formatGiB(t.bytesDone)} / ${formatGiB(t.bytesTotal)}`);
  if (t.speedBps !== null) tsegs.push(`${downloadSpeedLabel(t.speedBps).label} combined`);
  if (t.etaSeconds !== null) tsegs.push(`eta ${formatEta(t.etaSeconds)}`);
  if (tsegs.length > 0) lines.push(`total  ${tsegs.join("  ")}`);
  return lines.join("\n");
}

/** Pure: name of the first serving setup that references the model (delete advisory); null when none. */
export function setupServingModel(setups: Array<{ name: string; model: string }>, model: string): string | null {
  return setups.find((s) => s.model === model)?.name ?? null;
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
  { kind: "nas-delete-apply", label: "Delete from NAS", destructive: true },
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
