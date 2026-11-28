import { describe, expect, it } from "vitest";
import { deriveDownloadName, downloadBatchCreateSchema, downloadCreateSchema, downloadQueueEntrySchema, pickStoreNode, storeViewSafeForWrites, isStoreWrite } from "../src/downloads.js";
import type { InventoryStore } from "../src/inventory.js";
import { JOB_KINDS, type JobKind } from "../src/jobs.js";

const WRITE_SIDE = new Set<string>([
  "download-queue", "nas-delete", "nas-delete-apply", "nas-delete-batch", "catalog-refresh", "repair-active-apply",
  "gc-objects", "cleanup-staging", "sync-cards", "quarantine-prune", "prune-cleanup-quarantine", "hygiene-clean", "download",
]);
/** Kinds decided to be reads or cache/host-side work. A new kind must be added here or above. */
const READ_SIDE = [
  "modelctl-install", "sync-local", "push", "ensure-rsync", "transfer-key-ensure", "transfer-key-authorize", "transfer-hostkey-pin",
  "delete-local", "register-local", "doctor", "repair-active", "staging-audit", "staging-tree-audit", "objects-audit",
  "hygiene-audit", "hygiene-prevent", "models-inventory", "agent-update", "recipe-install", "net-tool-ensure", "net-test-server", "net-test-client",
];

/** IRI-014 contracts: store-node policy, name fallback, payload validation. */

function node(id: string, overrides: Partial<{ kind: string; nasRoot: string | null; enabled: boolean; online: boolean }> = {}) {
  return { id, kind: "spark", nasRoot: null, enabled: true, online: true, ...overrides };
}

describe("pickStoreNode", () => {
  it("prefers the NAS-kind node over a spark with the store mounted", () => {
    const nodes = [node("head-1", { kind: "spark", nasRoot: "/mnt/nas" }), node("nas-1", { kind: "nas", nasRoot: "/mnt/llms" })];
    expect(pickStoreNode(nodes)?.id).toBe("nas-1");
  });

  it("falls back to a mounted spark when no NAS-kind node qualifies", () => {
    const nodes = [node("head-1", { kind: "spark", nasRoot: "/mnt/nas" }), node("nas-1", { kind: "nas", nasRoot: null })];
    expect(pickStoreNode(nodes)?.id).toBe("head-1");
  });

  it("ignores disabled and offline nodes", () => {
    const nodes = [
      node("nas-off", { kind: "nas", nasRoot: "/mnt/llms", enabled: false }),
      node("spark-off", { nasRoot: "/mnt/nas", online: false }),
    ];
    expect(pickStoreNode(nodes)).toBeNull();
    // An explicit online set overrides the API flag.
    expect(pickStoreNode(nodes, new Set(["spark-off"]))?.id).toBe("spark-off");
  });

  it("honors the online set over the API flag", () => {
    const nodes = [node("nas-1", { kind: "nas", nasRoot: "/mnt/llms", online: true })];
    expect(pickStoreNode(nodes, new Set())?.id).toBeUndefined();
  });
});

describe("download create contract", () => {
  it("derives the store name from the repo tail", () => {
    expect(deriveDownloadName("unsloth/GLM-5.3-Flash-EXL3")).toBe("GLM-5.3-Flash-EXL3");
    expect(deriveDownloadName("bare-name")).toBe("bare-name");
  });

  it("defaults batch jobs to 4 and bounds them", () => {
    expect(downloadCreateSchema.parse({ source: "org/m" })).toMatchObject({ source: "org/m", jobs: 4 });
    expect(downloadCreateSchema.safeParse({ source: "org/m", jobs: 0 }).success).toBe(false);
    expect(downloadCreateSchema.safeParse({ source: "org/m", jobs: 17 }).success).toBe(false);
  });

  it("bounds the bulk submission shape (IRI-015)", () => {
    const ok = downloadBatchCreateSchema.parse({
      downloads: [{ source: "org/a" }, { source: "org/b", name: "b" }],
      jobs: 2,
    });
    expect(ok.downloads).toHaveLength(2);
    expect(ok.jobs).toBe(2);
    expect(downloadBatchCreateSchema.safeParse({ downloads: [] }).success).toBe(false);
    expect(
      downloadBatchCreateSchema.safeParse({
        downloads: Array.from({ length: 51 }, (_, i) => ({ source: `org/m${i}` })),
      }).success,
    ).toBe(false);
    expect(downloadBatchCreateSchema.safeParse({ downloads: [{ source: "" }] }).success).toBe(false);
  });

  it("passes quantization/mtp through both shapes and trims them (IRI-016)", () => {
    const single = downloadCreateSchema.parse({ source: "unsloth/flint-GGUF", quantization: " UD-Q4_K_XL ", mtp: " MTP/mtp-x.gguf " });
    expect(single.quantization).toBe("UD-Q4_K_XL");
    expect(single.mtp).toBe("MTP/mtp-x.gguf");
    const batch = downloadBatchCreateSchema.parse({
      downloads: [{ source: "unsloth/flint-GGUF", quantization: "bf16" }, { source: "org/m" }],
    });
    expect(batch.downloads[0]).toMatchObject({ quantization: "bf16" });
    expect(batch.downloads[1]).not.toHaveProperty("quantization");
    // Whitespace-only values are rejected rather than leaking to the YAML.
    expect(downloadCreateSchema.safeParse({ source: "org/m", quantization: "   " }).success).toBe(false);
    // Absent fields stay optional (back-compat).
    expect(downloadCreateSchema.safeParse({ source: "org/m" }).success).toBe(true);
  });

  it("passes draftSpecType through both shapes and enforces modelctl's grammar (IRI-152)", () => {
    expect(downloadCreateSchema.parse({ source: "org/m", mtp: "dflash-m.gguf", draftSpecType: " draft-dflash " }).draftSpecType).toBe("draft-dflash");
    const batch = downloadBatchCreateSchema.parse({ downloads: [{ source: "org/m", draftSpecType: "draft-dspark" }, { source: "org/n" }] });
    expect(batch.downloads[0]).toMatchObject({ draftSpecType: "draft-dspark" });
    expect(batch.downloads[1]).not.toHaveProperty("draftSpecType");
    for (const bad of ["Draft-MTP", "a b", "--host", "x;rm", "a".repeat(33), "  "]) {
      expect(downloadCreateSchema.safeParse({ source: "org/m", draftSpecType: bad }).success).toBe(false);
    }
    // Pre-0029 hub responses (no field) still parse.
    expect(downloadQueueEntrySchema.shape.draftSpecType.safeParse(undefined).success).toBe(true);
  });

  it("suffixes quantization into derived store names (IRI-016)", () => {
    expect(deriveDownloadName("unsloth/flint-GGUF", "UD-Q4_K_XL")).toBe("flint-GGUF-UD-Q4_K_XL");
    expect(deriveDownloadName("unsloth/flint-GGUF", "  ")).toBe("flint-GGUF");
    expect(deriveDownloadName("unsloth/flint-GGUF")).toBe("flint-GGUF");
  });

  it("passes force through both shapes and leaves it absent by default (IRI-017)", () => {
    const single = downloadCreateSchema.parse({ source: " org/model ", force: true });
    expect(single.source).toBe("org/model");
    expect(single.force).toBe(true);
    const batch = downloadBatchCreateSchema.parse({
      downloads: [{ source: "org/model", force: true }, { source: "org/other" }],
      jobs: 2,
    });
    expect(batch.downloads[0]!.force).toBe(true);
    expect(batch.downloads[1]!.force).toBeUndefined();
    // Absent force stays absent (never a batch-wide default).
    expect(downloadCreateSchema.safeParse({ source: "org/m" }).success).toBe(true);
    expect(downloadCreateSchema.parse({ source: "org/m" }).force).toBeUndefined();
  });

  it("parses pre-0016 queue responses without the new DTO fields", () => {
    const old = {
      id: "0b8b6f47-0b8b-4b0b-8b0b-0b8b6f470001",
      source: "unsloth/flint-GGUF",
      name: "flint-GGUF",
      status: "pending",
      jobId: null,
      error: null,
      createdAt: "2026-10-21T00:00:00.000Z",
      updatedAt: "2026-10-21T00:00:00.000Z",
    };
    expect(downloadQueueEntrySchema.safeParse(old).success).toBe(true);
    expect(downloadQueueEntrySchema.safeParse({ ...old, quantization: "bf16", mtp: null }).success).toBe(true);
  });

  it("parses IRI-017 force and progress fields on queue entries, tolerating their absence", () => {
    const base = {
      id: "0b8b6f47-0b8b-4b0b-8b0b-0b8b6f470002",
      source: "Mia-AiLab/GLM-5.3-Flash-EXL3-4bpw-TensorFold",
      name: "GLM-5.3-Flash-EXL3-4bpw-TensorFold",
      status: "running",
      jobId: null,
      error: null,
      createdAt: "2026-10-22T00:00:00.000Z",
      updatedAt: "2026-10-22T00:00:00.000Z",
    };
    const full = downloadQueueEntrySchema.parse({ ...base, force: true, bytesDone: 1024, bytesTotal: 2048, speedBps: 5_000_000 });
    expect(full.force).toBe(true);
    expect(full.bytesDone).toBe(1024);
    expect(full.bytesTotal).toBe(2048);
    expect(full.speedBps).toBe(5_000_000);
    const bare = downloadQueueEntrySchema.parse(base);
    expect(bare.force).toBeUndefined();
    expect(bare.bytesDone).toBeUndefined();
  });
});

describe("store writes need a safe store view (IRI-174)", () => {
  const nas = { id: "nas-1", kind: "nas", enabled: true, nasRoot: "/mnt/llms" };
  const spark = { id: "head-1", kind: "spark", enabled: true, nasRoot: "/mnt/nas" };

  it("never asks the NAS-kind node: the store is its local filesystem", () => {
    expect(pickStoreNode([spark, nas], new Set(["nas-1", "head-1"]), () => false)?.id).toBe("nas-1");
  });

  it("falls back to a mounted node only when it is write-safe", () => {
    const online = new Set(["head-1"]);
    expect(pickStoreNode([nas, spark], online, () => true)?.id).toBe("head-1");
    expect(pickStoreNode([nas, spark], online, () => false)).toBeNull();
    // Without the predicate the pick is for reading/display: unchanged.
    expect(pickStoreNode([nas, spark], online)?.id).toBe("head-1");
  });

  const view = (unlinkedActive: string[] | undefined, names: string[]): InventoryStore => ({
    root: "/mnt/nas",
    source: "catalog",
    warning: null,
    models: names.map((name) => ({ name, repository: `org/${name}`, runtime: "vllm", bytes: 1 })),
    leftovers: [],
    ...(unlinkedActive === undefined ? {} : { unlinkedActive }),
  });

  it("is unsafe without a report, from an agent that does not report links, or when every link is hidden", () => {
    expect(storeViewSafeForWrites(null)).toBe(false);
    expect(storeViewSafeForWrites(undefined)).toBe(false);
    expect(storeViewSafeForWrites(view(undefined, ["a", "b"]))).toBe(false);
    expect(storeViewSafeForWrites(view(["a", "b"], ["a", "b"]))).toBe(false);
  });

  it("is safe for a clean catalog view where every link is visible", () => {
    expect(storeViewSafeForWrites(view([], ["a", "b"]))).toBe(true);
  });

  it("needs positive evidence: an empty view proves nothing about the mount", () => {
    expect(storeViewSafeForWrites(view([], []))).toBe(false);
  });

  it("classifies every job kind as a store write or not", () => {
    const mounted = { nasRoot: "/mnt/nas" };
    const bare = { nasRoot: null };
    // always | never | params (hygiene-clean) | node (download)
    const expected: Record<JobKind, "always" | "never" | "params" | "node"> = {
      "download-queue": "always",
      "nas-delete": "always",
      "nas-delete-apply": "always",
      "nas-delete-batch": "always",
      "catalog-refresh": "always",
      "repair-active-apply": "always",
      "gc-objects": "always",
      "cleanup-staging": "always",
      "sync-cards": "always",
      "quarantine-prune": "always",
      "prune-cleanup-quarantine": "always",
      "hygiene-clean": "params",
      download: "node",
      ...Object.fromEntries(JOB_KINDS.filter((k) => !WRITE_SIDE.has(k)).map((k) => [k, "never" as const])),
    } as Record<JobKind, "always" | "never" | "params" | "node">;
    // A new job kind lands in "never" above only if it is absent from
    // WRITE_SIDE; this pins the read-side list so adding a kind fails here
    // until someone decides which side it is on.
    expect(JOB_KINDS.filter((k) => expected[k] === "never").sort()).toEqual([...READ_SIDE].sort());
    for (const kind of JOB_KINDS) {
      const want = expected[kind];
      if (want === "always") expect(isStoreWrite(kind, {}, bare), kind).toBe(true);
      if (want === "never") expect(isStoreWrite(kind, { categories: ["modelctl-staging"] }, mounted), kind).toBe(false);
    }
    // hygiene-clean only for the store's staging category
    expect(isStoreWrite("hygiene-clean", { categories: ["docker-build-cache", "modelctl-staging"] }, mounted)).toBe(true);
    expect(isStoreWrite("hygiene-clean", { categories: ["docker-build-cache"] }, mounted)).toBe(false);
    // download writes modelctl's root: the store on a node that mounts it
    expect(isStoreWrite("download", { name: "m" }, mounted)).toBe(true);
    expect(isStoreWrite("download", { name: "m" }, bare)).toBe(false);
  });

  it("is strict: one hidden entry, a warning, or a scanned view blocks the fallback", () => {
    expect(storeViewSafeForWrites(view(["a"], ["a", "b", "c"]))).toBe(false);
    expect(storeViewSafeForWrites({ ...view([], ["a"]), warning: "catalog unreadable; scanned active/" })).toBe(false);
    expect(storeViewSafeForWrites({ ...view([], ["a"]), source: "scan" })).toBe(false);
  });
});
