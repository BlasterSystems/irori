import { describe, expect, it } from "vitest";
import {
  hygieneCategoryAuditSchema,
  jobKindSchema,
  nodeInventorySchema,
  sseEventSchema,
  storeLinkVisible,
  syncNeedsVisibleLink,
  pickSyncModelctlVersion,
  MODELCTL_SYNC_WITHOUT_SYMLINK,
  type InventoryStore,
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
          user: "operator",
          home: "/home/operator",
          cacheDir: "/home/operator/.cache/huggingface/hub",
          modelctlVersion: "0.20.1",
          error: null,
          models: [{ ...MODEL, bytes: null }],
        },
      ],
    });
    expect(report.store?.models[0]?.name).toBe("glm-4");
    expect(report.store?.leftovers[0]?.target).toBe("org/repo/abc--def");
    expect(report.local[0]?.user).toBe("operator");
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

describe("storeLinkVisible (IRI-173)", () => {
  const store = (unlinkedActive?: string[], names: string[] = ["a", "b"]): InventoryStore => ({
    root: "/mnt/nas",
    source: "catalog",
    warning: null,
    models: names.map((name) => ({ ...MODEL, name })),
    leftovers: [],
    ...(unlinkedActive === undefined ? {} : { unlinkedActive }),
  });

  it("is unknown without a report or from an agent that does not list links", () => {
    expect(storeLinkVisible(null, "a")).toBeUndefined();
    expect(storeLinkVisible(undefined, "a")).toBeUndefined();
    expect(storeLinkVisible(store(), "a")).toBeUndefined();
  });

  it("is false for an entry the node sees as a directory, true for a listed link", () => {
    expect(storeLinkVisible(store(["a"]), "a")).toBe(false);
    expect(storeLinkVisible(store(["a"]), "b")).toBe(true);
    expect(storeLinkVisible(store([]), "a")).toBe(true);
  });

  it("judges a model the node does not list yet by the rest of the view", () => {
    // every listed entry is hidden (SMB): the next download will be too
    expect(storeLinkVisible(store(["a", "b"]), "new")).toBe(false);
    // one stray directory copy says nothing about a new model
    expect(storeLinkVisible(store(["a"]), "new")).toBeUndefined();
    expect(storeLinkVisible(store([]), "new")).toBeUndefined();
    // stray directories that are not models never decide it
    expect(storeLinkVisible(store(["stray1", "stray2"]), "new")).toBeUndefined();
    expect(storeLinkVisible(store(["stray"], []), "new")).toBeUndefined();
  });

  it("round-trips the optional field through the report schema", () => {
    const parsed = nodeInventorySchema.parse({ generatedAtMs: 1, store: store(["a"]), local: [] });
    expect(parsed.store?.unlinkedActive).toEqual(["a"]);
    expect(nodeInventorySchema.parse({ generatedAtMs: 1, store: store(), local: [] }).store?.unlinkedActive).toBeUndefined();
  });
});

describe("syncNeedsVisibleLink (IRI-175)", () => {
  it("needs the link unless the node's reported modelctl reads the journal", () => {
    expect(syncNeedsVisibleLink(null)).toBe(true);
    expect(syncNeedsVisibleLink("0.25.0")).toBe(true);
    expect(syncNeedsVisibleLink(MODELCTL_SYNC_WITHOUT_SYMLINK)).toBe(false);
    expect(syncNeedsVisibleLink("0.26.0")).toBe(false);
    expect(syncNeedsVisibleLink("1.0.0")).toBe(false);
  });

  it("treats anything that is not a plain version as unknown", () => {
    for (const odd of ["", "latest", "v0.25.1", "0.25.1-rc1", "modelctl 0.25.1"]) {
      expect(syncNeedsVisibleLink(odd), odd).toBe(true);
    }
  });
});

describe("pickSyncModelctlVersion (IRI-175)", () => {
  const users = [
    { user: "root", version: "0.25.1" },
    { user: "operator", version: "0.25.0" },
  ];
  it("takes the cache user's version when one is set", () => {
    expect(pickSyncModelctlVersion(users, "operator")).toBe("0.25.0");
    expect(pickSyncModelctlVersion(users, "nobody")).toBeNull();
  });
  it("without a cache user takes root, or the only user, else unknown", () => {
    expect(pickSyncModelctlVersion(users, null)).toBe("0.25.1");
    expect(pickSyncModelctlVersion([{ user: "agent", version: "0.25.1" }], null)).toBe("0.25.1");
    expect(pickSyncModelctlVersion([{ user: "a", version: "0.25.1" }, { user: "b", version: "0.25.1" }], null)).toBeNull();
    expect(pickSyncModelctlVersion([], null)).toBeNull();
  });
});
