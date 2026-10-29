import { jobInfoSchema, type JobInfo } from "@irori/core";

/**
 * Recent-job client + pure helpers (IRI-028). The jobs map is seeded from
 * GET /api/v1/jobs and kept current by the SSE `job` / `job-progress` frames;
 * IR-102: job output streams into the Overview Telemetry feed (the Activity
 * drawer is gone), and the seed keeps node/kind context available there.
 */

export interface JobSummary extends JobInfo {
  lastLine: string | null;
}

/** Live view of a job (SSE-updated, seedable). */
export interface JobLive {
  id: string;
  nodeId: string;
  kind: string;
  status: JobInfo["status"];
  params: Record<string, unknown>;
  /** IR-131: parsed transfer progress when the hub could parse the line. */
  progress: JobInfo["progress"];
  /** IR-131: cancel requested but unconfirmed — the job is still running. */
  cancelRequestedAt: string | null;
  exitCode: number | null;
  durationMs: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastLine: string | null;
}

export function jobLiveFromSummary(summary: JobSummary): JobLive {
  return {
    id: summary.id,
    nodeId: summary.nodeId,
    kind: summary.kind,
    status: summary.status,
    params: summary.params,
    progress: summary.progress ?? null,
    cancelRequestedAt: summary.cancelRequestedAt ?? null,
    exitCode: summary.exitCode,
    durationMs: null,
    createdAt: summary.createdAt,
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt,
    lastLine: summary.lastLine,
  };
}

/** IR-121: the human suffix for a job — the model name when params carry one,
 *  the download-queue batch size otherwise; "" when the job is unlabeled.
 *  Shared by the Overview feed, the transfer op bar and the dock. */
export function jobLabel(params: Record<string, unknown> | undefined): string {
  if (params === undefined) return "";
  const name = params.name;
  if (typeof name === "string" && name.length > 0) return ` ${name}`;
  const downloads = params.downloads;
  if (Array.isArray(downloads) && downloads.length > 0) {
    if (downloads.length === 1) {
      const d = downloads[0];
      const n = typeof d === "object" && d !== null && typeof (d as { name?: unknown }).name === "string" ? (d as { name: string }).name : null;
      return n !== null && n.length > 0 ? ` ${n}` : "";
    }
    return ` ${downloads.length} models`;
  }
  return "";
}

/** IR-131: rsync streams a transfer job runs with — push defaults to 4 (the
 *  IR-121 fleet default), sync-local to 1. Multi-stream output interleaves
 *  per-stream progress2 lines, so the UI must not parse a percent of one
 *  stream; the dock renders an explicit "no progress" state instead. */
export function jobStreams(kind: string, params: Record<string, unknown> | undefined): number {
  if (kind !== "sync-local" && kind !== "push") return 1;
  const jobsParam = (params ?? {}).jobs;
  if (typeof jobsParam === "number" && Number.isFinite(jobsParam) && jobsParam >= 1) return Math.floor(jobsParam);
  return kind === "push" ? 4 : 1;
}

export async function fetchRecentJobs(limit = 20, signal?: AbortSignal): Promise<JobSummary[]> {
  const res = await fetch(`/api/v1/jobs?limit=${encodeURIComponent(String(limit))}`, {
    headers: { accept: "application/json" },
    signal,
  });
  if (!res.ok) throw new Error(`GET /api/v1/jobs failed: HTTP ${res.status}`);
  const body: unknown = await res.json();
  const rows = typeof body === "object" && body !== null && Array.isArray((body as { jobs?: unknown }).jobs)
    ? ((body as { jobs: unknown[] }).jobs)
    : [];
  const jobs: JobSummary[] = [];
  for (const row of rows) {
    const parsed = jobInfoSchema.safeParse(row);
    if (!parsed.success) continue;
    const lastLine = typeof row === "object" && row !== null && typeof (row as { lastLine?: unknown }).lastLine === "string"
      ? (row as { lastLine: string }).lastLine
      : null;
    jobs.push({ ...parsed.data, lastLine });
  }
  return jobs;
}

/** "12s" / "3m 4s" / "1h 02m" — elapsed for a job row. */
export function jobElapsed(job: Pick<JobLive, "createdAt" | "startedAt" | "finishedAt" | "status">, now: number): string {
  const start = Date.parse(job.startedAt ?? job.createdAt);
  const end = job.status === "queued" || job.status === "running" ? now : job.finishedAt === null ? now : Date.parse(job.finishedAt);
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
