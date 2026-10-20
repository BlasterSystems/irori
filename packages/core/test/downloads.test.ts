import { describe, expect, it } from "vitest";
import { deriveDownloadName, downloadBatchCreateSchema, downloadCreateSchema, pickStoreNode } from "../src/downloads.js";

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
});
