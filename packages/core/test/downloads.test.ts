import { describe, expect, it } from "vitest";
import { deriveDownloadName, downloadBatchCreateSchema, downloadCreateSchema, downloadQueueEntrySchema, pickStoreNode } from "../src/downloads.js";

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
