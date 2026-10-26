import { describe, expect, it } from "vitest";
import {
  hygieneCategoryAuditSchema,
  jobKindSchema,
  nodeInventorySchema,
  sseEventSchema,
} from "../src/index.ts";

const MODEL = { name: "glm-4", repository: "org/glm-4", runtime: "vllm", bytes: 1024 };

describe("nodeInventorySchema", () => {
  it("parses a full report (store + per-user local caches + leftovers)", () => {
    const report = nodeInventorySchema.parse({
      generatedAtMs: 1,
      store: {
        root: "/mnt/llms",
        source: "catalog",
        warning: null,
        models: [MODEL],
        leftovers: [
          {
            name: "old-model",
            object: "/mnt/llms/models/org/repo/abc--def",
            target: "org/repo/abc--def",
            error: "PermissionError: [Errno 13]",
            failedAt: "2026-10-26T05:29:27Z",
            bytes: 2048,
          },
        ],
      },
      local: [
        {
          user: "piresbruno",
          home: "/home/piresbruno",
          cacheDir: "/home/piresbruno/.cache/huggingface/hub",
          modelctlVersion: "0.20.1",
          error: null,
          models: [{ ...MODEL, bytes: null }],
        },
      ],
    });
    expect(report.store?.models[0]?.name).toBe("glm-4");
    expect(report.store?.leftovers[0]?.target).toBe("org/repo/abc--def");
    expect(report.local[0]?.user).toBe("piresbruno");
    expect(report.local[0]?.models[0]?.bytes).toBeNull();
  });

  it("allows a node with no store (local-only)", () => {
    const report = nodeInventorySchema.parse({ generatedAtMs: 1, store: null, local: [] });
    expect(report.store).toBeNull();
  });

  it("rejects negative sizes and missing store roots", () => {
    expect(nodeInventorySchema.safeParse({ generatedAtMs: 1, store: null, local: [{ user: "root", home: "/root", cacheDir: "/root/.cache/huggingface/hub", modelctlVersion: null, error: null, models: [{ ...MODEL, bytes: -1 }] }] }).success).toBe(false);
    expect(nodeInventorySchema.safeParse({ generatedAtMs: 1, store: { root: "", source: "catalog", warning: null, models: [], leftovers: [] }, local: [] }).success).toBe(false);
  });
});

describe("hygiene details", () => {
  it("defaults details to an empty list for older agents", () => {
    const row = hygieneCategoryAuditSchema.parse({
      category: "docker-build-cache",
      safe: true,
      rationale: "rebuildable",
      itemCount: 1,
      reclaimableBytes: 10,
    });
    expect(row.details).toEqual([]);
  });

  it("parses per-target rows", () => {
    const row = hygieneCategoryAuditSchema.parse({
      category: "docker-images",
      safe: false,
      rationale: "old",
      itemCount: 1,
      reclaimableBytes: 10,
      details: [{ label: "irori:v1", path: null, bytes: 10 }],
    });
    expect(row.details[0]).toEqual({ label: "irori:v1", path: null, bytes: 10, items: 1 });
  });
});

describe("models-inventory job + activity events", () => {
  it("accepts the new job kind", () => {
    expect(jobKindSchema.parse("models-inventory")).toBe("models-inventory");
  });

  it("accepts a running job frame and a progress frame", () => {
    const job = sseEventSchema.parse({
      type: "job",
      serverTimeMs: 1,
      nodeId: "00000000-0000-4000-8000-000000000001",
      jobId: "00000000-0000-4000-8000-000000000002",
      kind: "sync-local",
      status: "running",
      exitCode: null,
      durationMs: null,
    });
    expect(job.type).toBe("job");

    const progress = sseEventSchema.parse({
      type: "job-progress",
      serverTimeMs: 2,
      nodeId: "00000000-0000-4000-8000-000000000001",
      jobId: "00000000-0000-4000-8000-000000000002",
      seq: 7,
      line: "  1.2 GB/s",
    });
    expect(progress.type).toBe("job-progress");
  });

  it("rejects a progress frame with a non-uuid job id", () => {
    expect(
      sseEventSchema.safeParse({
        type: "job-progress",
        serverTimeMs: 2,
        nodeId: "00000000-0000-4000-8000-000000000001",
        jobId: "nope",
        seq: 1,
        line: "x",
      }).success,
    ).toBe(false);
  });
});
