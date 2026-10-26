import { describe, expect, it } from "vitest";
import { jobElapsed, jobLiveFromSummary, runningJobCount, sortJobs, type JobLive } from "../src/jobs";

function job(overrides: Partial<JobLive> = {}): JobLive {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    nodeId: "00000000-0000-4000-8000-000000000002",
    kind: "sync-local",
    status: "running",
    params: {},
    exitCode: null,
    durationMs: null,
    createdAt: "2026-10-26T06:00:00.000Z",
    startedAt: "2026-10-26T06:00:00.000Z",
    finishedAt: null,
    lastLine: null,
    ...overrides,
  };
}

describe("sortJobs", () => {
  it("puts active jobs first, then newest created", () => {
    const active = job({ id: "a", status: "running", createdAt: "2026-10-26T06:00:00.000Z" });
    const doneNew = job({ id: "b", status: "succeeded", createdAt: "2026-10-26T07:00:00.000Z" });
    const doneOld = job({ id: "c", status: "failed", createdAt: "2026-10-26T05:00:00.000Z" });
    expect(sortJobs([doneOld, doneNew, active]).map((j) => j.id)).toEqual(["a", "b", "c"]);
  });
});

describe("jobElapsed", () => {
  const now = Date.parse("2026-10-26T06:05:00.000Z");

  it("counts live jobs up to now", () => {
    expect(jobElapsed(job(), now)).toBe("5m 00s");
    expect(jobElapsed(job({ startedAt: "2026-10-26T06:04:30.000Z" }), now)).toBe("30s");
  });

  it("freezes settled jobs at finishedAt", () => {
    expect(
      jobElapsed(job({ status: "succeeded", finishedAt: "2026-10-26T06:02:00.000Z" }), now),
    ).toBe("2m 00s");
  });
});

describe("runningJobCount + jobLiveFromSummary", () => {
  it("counts queued and running jobs", () => {
    expect(runningJobCount([job(), job({ status: "queued" }), job({ status: "succeeded" })])).toBe(2);
  });

  it("maps a REST summary into the live shape", () => {
    const live = jobLiveFromSummary({
      id: "00000000-0000-4000-8000-000000000001",
      nodeId: "00000000-0000-4000-8000-000000000002",
      kind: "download-queue",
      status: "running",
      params: { jobs: 4 },
      exitCode: null,
      createdAt: "2026-10-26T06:00:00.000Z",
      startedAt: "2026-10-26T06:00:01.000Z",
      finishedAt: null,
      lastLine: "1.2 GB/s",
    });
    expect(live).toMatchObject({ kind: "download-queue", status: "running", lastLine: "1.2 GB/s", durationMs: null });
  });
});
