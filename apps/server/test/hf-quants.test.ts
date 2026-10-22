import { describe, expect, it, vi } from "vitest";
import { createHfQuantsService, groupRepoFiles, isMtpArtifact } from "../src/hf-quants.js";
import { HfQuantsError } from "@irori/core";

/**
 * IRI-016: the TS port of modelctl's `_gguf_groups`/`_select_mmproj`/`_select_mtp`,
 * pinned against the REAL file lists of unsloth/flint-GGUF and
 * unsloth/gemma-4-31B-it-GGUF (HF API, 2026-10-21 — research brief §3), plus
 * needle-disambiguation and endpoint error-mapping cases.
 */

/** Real `unsloth/flint-GGUF` siblings (trimmed to the load-bearing entries). */
const FLINT_FILES = [
  { path: ".gitattributes", bytes: null },
  { path: "README.md", bytes: null },
  { path: "assets/flint-logo.png", bytes: null },
  { path: "imatrix_unsloth.gguf_file", bytes: null },
  { path: "BF16/flint-preview-BF16-00001-of-00003.gguf", bytes: 5_500_000_000 },
  { path: "BF16/flint-preview-BF16-00002-of-00003.gguf", bytes: 46_500_000_000 },
  { path: "BF16/flint-preview-BF16-00003-of-00003.gguf", bytes: 27_600_000_000 },
  { path: "flint-preview-Q8_0.gguf", bytes: 42_300_000_000 },
  { path: "flint-preview-UD-IQ1_M.gguf", bytes: 11_400_000_000 },
  { path: "flint-preview-UD-IQ2_XXS.gguf", bytes: 11_900_000_000 },
  { path: "flint-preview-UD-IQ3_XXS.gguf", bytes: 14_500_000_000 },
  { path: "flint-preview-UD-Q2_K_XL.gguf", bytes: 13_600_000_000 },
  { path: "flint-preview-UD-Q3_K_XL.gguf", bytes: 18_500_000_000 },
  { path: "flint-preview-UD-Q4_K_XL.gguf", bytes: 25_100_000_000 },
  { path: "flint-preview-UD-Q5_K_XL.gguf", bytes: 29_900_000_000 },
  { path: "flint-preview-UD-Q6_K_XL.gguf", bytes: 36_300_000_000 },
];

/** Real `unsloth/gemma-4-31B-it-GGUF` siblings (the owner's MTP example). */
const GEMMA31_FILES = [
  { path: "README.md", bytes: null },
  { path: "MTP/README.md", bytes: null },
  { path: "config.json", bytes: null },
  { path: "imatrix_unsloth.gguf_file", bytes: null },
  { path: "BF16/gemma-4-31B-it-BF16-00001-of-00002.gguf", bytes: 31_000_000_000 },
  { path: "BF16/gemma-4-31B-it-BF16-00002-of-00002.gguf", bytes: 31_000_000_000 },
  { path: "MTP/mtp-gemma-4-31B-it-BF16.gguf", bytes: 1_000_000_000 },
  { path: "MTP/mtp-gemma-4-31B-it-F16.gguf", bytes: 1_000_000_000 },
  { path: "MTP/mtp-gemma-4-31B-it-Q8_0.gguf", bytes: 600_000_000 },
  { path: "gemma-4-31B-it-IQ4_NL.gguf", bytes: 18_000_000_000 },
  { path: "gemma-4-31B-it-Q4_K_M.gguf", bytes: 19_000_000_000 },
  { path: "gemma-4-31B-it-UD-Q4_K_XL.gguf", bytes: 20_000_000_000 },
  { path: "mmproj-BF16.gguf", bytes: 2_000_000_000 },
  { path: "mmproj-F16.gguf", bytes: 1_900_000_000 },
  { path: "mmproj-F32.gguf", bytes: 3_800_000_000 },
  { path: "mtp-gemma-4-31B-it.gguf", bytes: 1_100_000_000 },
];

describe("groupRepoFiles (flint-GGUF real layout)", () => {
  const result = groupRepoFiles("unsloth/flint-GGUF", FLINT_FILES);

  it("groups every quantization, shards included, and skips companions", () => {
    expect(result.quants).toHaveLength(10); // 9 root + sharded BF16 set
    const bf16 = result.quants.find((q) => q.sharded);
    expect(bf16).toMatchObject({ tag: "BF16", shards: 3, sharded: true });
    expect(bf16?.files).toEqual([
      "BF16/flint-preview-BF16-00001-of-00003.gguf",
      "BF16/flint-preview-BF16-00002-of-00003.gguf",
      "BF16/flint-preview-BF16-00003-of-00003.gguf",
    ]);
    expect(bf16?.bytes).toBe(5_500_000_000 + 46_500_000_000 + 27_600_000_000);
    // The .gguf_file stub is not a GGUF; assets are not grouped either.
    expect(result.quants.map((q) => q.tag)).not.toContain("file");
    expect(result.quants.every((q) => !q.ambiguous)).toBe(true);
    // Needle is a unique substring of the tag's own basename (modelctl matching).
    for (const q of result.quants) {
      const own = q.files.every((f) => f.toLowerCase().includes(q.tag.toLowerCase()));
      expect(own).toBe(true);
    }
  });

  it("keeps the model card and no companions", () => {
    expect(result.modelCard).toBe("README.md");
    expect(result.companions.mmproj.candidates).toHaveLength(0);
    expect(result.companions.mtp.candidates).toHaveLength(0);
  });
});

describe("groupRepoFiles (gemma-4-31B-it-GGUF real layout)", () => {
  const result = groupRepoFiles("unsloth/gemma-4-31B-it-GGUF", GEMMA31_FILES);

  it("excludes mmproj and MTP artifacts (both mtp- prefix and MTP/ dir) from quant groups", () => {
    const tags = result.quants.map((q) => q.tag);
    expect(tags).toEqual(expect.arrayContaining(["BF16", "IQ4_NL", "Q4_K_M", "Q4_K_XL"]));
    expect(tags).toHaveLength(4); // 3 root + BF16 set
    for (const q of result.quants) {
      for (const f of q.files) {
        expect(isMtpArtifact(f)).toBe(false);
        expect(f.startsWith("mmproj")).toBe(false);
      }
    }
  });

  it("defaults companions like modelctl: the single f16 mmproj and the single root mtp", () => {
    expect(result.companions.mmproj.default).toBe("mmproj-F16.gguf");
    expect(result.companions.mmproj.candidates.map((c) => c.path)).toEqual(["mmproj-BF16.gguf", "mmproj-F16.gguf", "mmproj-F32.gguf"]);
    expect(result.companions.mtp.default).toBe("mtp-gemma-4-31B-it.gguf");
    expect(result.companions.mtp.candidates.map((c) => c.path)).toEqual([
      "mtp-gemma-4-31B-it.gguf",
      "MTP/mtp-gemma-4-31B-it-BF16.gguf",
      "MTP/mtp-gemma-4-31B-it-F16.gguf",
      "MTP/mtp-gemma-4-31B-it-Q8_0.gguf",
    ]);
  });
});

describe("groupRepoFiles (needle disambiguation)", () => {
  it("widens the needle when a tag is a substring of another group's basename", () => {
    const result = groupRepoFiles("org/dual", [
      { path: "model-Q4_K_M.gguf", bytes: 1 },
      { path: "model-UD-Q4_K_M.gguf", bytes: 2 },
    ]);
    expect(result.quants.map((q) => [q.tag, q.ambiguous])).toEqual([
      ["model-Q4_K_M", false],
      ["UD-Q4_K_M", false],
    ]);
  });

  it("flags ambiguous groups when even the full stem clashes", () => {
    const result = groupRepoFiles("org/twin", [
      { path: "a/model-Q4_K_M.gguf", bytes: 1 },
      { path: "b/model-Q4_K_M.gguf", bytes: 1 },
    ]);
    expect(result.quants).toHaveLength(2);
    expect(result.quants.every((q) => q.ambiguous)).toBe(true);
  });

  it("throws on incomplete shard groups like modelctl", () => {
    expect(() =>
      groupRepoFiles("org/broken", [
        { path: "m-00001-of-00003.gguf", bytes: 1 },
        { path: "m-00003-of-00003.gguf", bytes: 1 },
      ]),
    ).toThrow(HfQuantsError);
  });
});

describe("createHfQuantsService", () => {
  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("parses the HF API response into grouped quants", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ siblings: FLINT_FILES.map((f) => ({ rfilename: f.path, size: f.bytes ?? undefined })) }));
    const service = createHfQuantsService({ fetchImpl });
    const result = await service.listQuants("unsloth/flint-GGUF");
    expect(fetchImpl).toHaveBeenCalledWith("https://huggingface.co/api/models/unsloth/flint-GGUF?blobs=true", expect.anything());
    expect(result.quants).toHaveLength(10);
  });

  it("maps HF 404/401 to a 404 HfQuantsError and 500s to 502", async () => {
    const notFound = createHfQuantsService({ fetchImpl: vi.fn().mockResolvedValue(jsonResponse({}, 404)) });
    await expect(notFound.listQuants("org/missing")).rejects.toMatchObject({ status: 404 });
    const boom = createHfQuantsService({ fetchImpl: vi.fn().mockResolvedValue(jsonResponse({}, 500)) });
    await expect(boom.listQuants("org/m")).rejects.toMatchObject({ status: 502 });
  });

  it("rejects malformed repo ids before any network call", async () => {
    const fetchImpl = vi.fn();
    const service = createHfQuantsService({ fetchImpl });
    await expect(service.listQuants("../etc/passwd")).rejects.toMatchObject({ status: 400 });
    await expect(service.listQuants("org/a..b")).rejects.toMatchObject({ status: 400 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
