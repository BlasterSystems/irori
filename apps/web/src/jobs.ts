import { jobInfoSchema, type JobInfo } from "@irori/core";

/**
 * Recent-job client + pure helpers (IRI-028). The Activity drawer seeds from
 * GET /api/v1/jobs and then follows the SSE `job` / `job-progress` frames.
 */

export interface JobSummary extends JobInfo {
  lastLine: string | null;
}

/** Live view of a job in the Activity drawer (SSE-updated, seedable). */
export interface JobLive {
  id: string;
  nodeId: string;
  kind: string;
  status: JobInfo["status"];
  params: Record<string, unknown>;
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
    exitCode: summary.exitCode,
    durationMs: null,
    createdAt: summary.createdAt,
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt,
    lastLine: summary.lastLine,
  };
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

export function isActiveJob(job: Pick<JobLive, "status">): boolean {
  return job.status === "queued" || job.status === "running";
}

/** Running jobs first (newest started), then settled ones by creation desc. */
export function sortJobs<T extends { status: string; createdAt: string }>(jobs: T[]): T[] {
  return [...jobs].sort((a, b) => {
    const aActive = a.status === "queued" || a.status === "running";
    const bActive = b.status === "queued" || b.status === "running";
    if (aActive !== bActive) return aActive ? -1 : 1;
    return Date.parse(b.createdAt) - Date.parse(a.createdAt);
  });
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

export function runningJobCount(jobs: JobLive[]): number {
  return jobs.filter((job) => isActiveJob(job)).length;
}
