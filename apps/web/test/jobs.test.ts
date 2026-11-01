import { describe, expect, it } from "vitest";
import { activeJobFor, activeJobsByNode, blockingJobLabel, jobElapsed, jobLabel, jobLiveFromSummary, jobStreams, type JobLive } from "../src/jobs";

function job(overrides: Partial<JobLive> = {}): JobLive {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    nodeId: "00000000-0000-4000-8000-000000000002",
    kind: "sync-local",
    status: "running",
    params: {},
    progress: null,
    cancelRequestedAt: null,
    exitCode: null,
    durationMs: null,
    createdAt: "2026-10-26T06:00:00.000Z",
    startedAt: "2026-10-26T06:00:00.000Z",
    finishedAt: null,
    lastLine: null,
    ...overrides,
  };
}

describe("jobStreams + jobLabel (IR-131)", () => {
  it("counts push as 4 streams by default and honors explicit jobs", () => {
    expect(jobStreams("push", {})).toBe(4);
    expect(jobStreams("push", { jobs: 8 })).toBe(8);
    expect(jobStreams("sync-local", {})).toBe(1);
    expect(jobStreams("sync-local", { jobs: 4 })).toBe(4);
    expect(jobStreams("download", { jobs: 4 })).toBe(1);
  });

  it("labels jobs by model name or batch size", () => {
    expect(jobLabel({ name: "glm" })).toBe(" glm");
    expect(jobLabel({ downloads: [{ source: "a" }, { source: "b" }] })).toBe(" 2 models");
    expect(jobLabel({})).toBe("");
    expect(jobLabel(undefined)).toBe("");
  });
});

describe("activeJobFor + activeJobsByNode + blockingJobLabel (IR-134)", () => {
  const NODE_A = "00000000-0000-4000-8000-000000000002";
  const NODE_B = "00000000-0000-4000-8000-00000000000a";

  it("finds the queued/running job holding a node slot", () => {
    const jobs = [
      job({ nodeId: NODE_A, kind: "sync-local", status: "running", params: { name: "glm" } }),
      job({ nodeId: NODE_B, status: "succeeded" }),
    ];
    expect(activeJobFor(jobs, NODE_A)?.kind).toBe("sync-local");
    expect(activeJobFor(jobs, NODE_B)).toBeNull();
    expect(activeJobFor(jobs, "00000000-0000-4000-8000-00000000000c")).toBeNull();
  });

  it("indexes active jobs by node, ignoring settled ones", () => {
    const byNode = activeJobsByNode([
      job({ nodeId: NODE_A, kind: "push", status: "queued" }),
      job({ nodeId: NODE_A, kind: "hygiene-audit", status: "failed" }),
      job({ nodeId: NODE_B, kind: "models-inventory", status: "running" }),
    ]);
    expect([...byNode.keys()].sort()).toEqual([NODE_A, NODE_B]);
    expect(byNode.get(NODE_A)!.kind).toBe("push");
    expect(byNode.get(NODE_A)!.status).toBe("queued");
  });

  it("labels the blocker with kind, model and parsed percent", () => {
    expect(blockingJobLabel(job({ kind: "sync-local", params: { name: "GLM-x" } }))).toBe("sync-local GLM-x");
    expect(blockingJobLabel(job({ kind: "download-queue", params: { downloads: [{ name: "a" }] } }))).toBe("download-queue a");
    expect(blockingJobLabel(job({ kind: "download-queue", params: { downloads: [{ name: "a" }, { name: "b" }] } }))).toBe("download-queue 2 models");
    expect(blockingJobLabel(job({ kind: "models-inventory", params: {} }))).toBe("models-inventory");
    expect(
      blockingJobLabel(job({ kind: "push", params: { name: "m" }, progress: { bytes: 1, percent: 31.4, rateBytesPerSec: null, etaSeconds: null } })),
    ).toBe("push m, 31%");
    // percent=null (unparseable line) renders no suffix
    expect(
      blockingJobLabel(job({ kind: "push", params: { name: "m" }, progress: { bytes: null, percent: null, rateBytesPerSec: null, etaSeconds: null } })),
    ).toBe("push m");
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

describe("jobLiveFromSummary", () => {
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
