import { describe, expect, it, vi } from "vitest";
import { createHfQuantsService, draftKind, groupRepoFiles, isDraftArtifact } from "../src/hf-quants.js";
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
        expect(isDraftArtifact(f)).toBe(false);
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

/**
 * IRI-152: real layouts from the HF API (2026-11-21), mirrored 1:1 by the
 * modelctl fixtures in tests/test_drafts.py so the two ports cannot drift.
 */
const INKLING_FILES = [
  "README.md",
  "Inkling-2-Mini-UD-IQ1_M.gguf",
  "Inkling-2-Mini-UD-Q4_K_M.gguf",
  "Inkling-2-Mini-UD-Q4_K_XL.gguf",
  "Inkling-2-Mini-UD-Q8_K_XL.gguf",
  "Mainline_Support/Inkling-2-Mini-UD-Q4_K_XL.gguf_file",
  "Mainline_Support/README.md",
  "dspark-Inkling-2-Mini-Q8_0.gguf",
  "dspark/README.md",
  "dspark/dspark-Inkling-2-Mini-BF16.gguf",
  "mmproj-BF16.gguf",
  "mmproj-F16.gguf",
  "mmproj-F32.gguf",
].map((path) => ({ path, bytes: null }));
const UNSLOTH_GEMMA26_FILES = [
  "BF16/gemma-4-26B-A4B-it-BF16-00001-of-00002.gguf",
  "BF16/gemma-4-26B-A4B-it-BF16-00002-of-00002.gguf",
  "MTP/mtp-gemma-4-26B-A4B-it-BF16.gguf",
  "MTP/mtp-gemma-4-26B-A4B-it-F16.gguf",
  "MTP/mtp-gemma-4-26B-A4B-it-Q8_0.gguf",
  "gemma-4-26B-A4B-it-Q8_0.gguf",
  "gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf",
  "imatrix_unsloth.gguf_file",
  "mmproj-BF16.gguf",
  "mmproj-F16.gguf",
  "mmproj-F32.gguf",
  "mtp-gemma-4-26B-A4B-it.gguf",
].map((path) => ({ path, bytes: null }));
const BARTOWSKI_GEMMA26_FILES = [
  "google_gemma-4-26B-A4B-it-Q4_K_M.gguf",
  "google_gemma-4-26B-A4B-it-Q8_0.gguf",
  "google_gemma-4-26B-A4B-it-bf16/google_gemma-4-26B-A4B-it-bf16-00001-of-00002.gguf",
  "google_gemma-4-26B-A4B-it-bf16/google_gemma-4-26B-A4B-it-bf16-00002-of-00002.gguf",
  "google_gemma-4-26B-A4B-it-imatrix.gguf",
  "mmproj-google_gemma-4-26B-A4B-it-bf16.gguf",
  "mmproj-google_gemma-4-26B-A4B-it-f16.gguf",
  "mtp-google_gemma-4-26B-A4B-it-Q4_0.gguf",
  "mtp-google_gemma-4-26B-A4B-it-Q8_0.gguf",
].map((path) => ({ path, bytes: null }));

describe("draftKind (modelctl drafts.py parity)", () => {
  it.each([
    ["mtp-gemma.gguf", "mtp"],
    ["MTP/gemma-4-12B-it-MTP-Q8_0.gguf", "mtp"],
    ["dspark-Inkling-2-Mini-Q8_0.gguf", "dspark"],
    ["dspark/dspark-Inkling-2-Mini-BF16.gguf", "dspark"],
    ["DSPARK-x.gguf", "dspark"],
    ["dflash-Muse-Glimmer-30B-Q4_K_M.gguf", "dflash"],
    ["dflash2-model-Q8_0.gguf", "dflash2"],
    ["DFlash2/model-Q8_0.gguf", "dflash2"],
    ["gemma-4-Q4_K_M.gguf", null],
    ["dspark/README.md", null],
    ["dsparkle-model.gguf", null],
    ["BF16/model-BF16-00001-of-00002.gguf", null],
  ])("%s → %s", (path, kind) => {
    expect(draftKind(path)).toBe(kind);
  });
});

describe("groupRepoFiles (IRI-152 draft companions, real layouts)", () => {
  it("Inkling-2-Mini: dspark files are drafts, not quants; the root dspark is the default", () => {
    const r = groupRepoFiles("unsloth/Inkling-2-Mini-GGUF", INKLING_FILES);
    const tags = r.quants.map((q) => q.tag);
    expect(tags).toEqual(["IQ1_M", "Q4_K_M", "Q4_K_XL", "Q8_K_XL"]);
    for (const q of r.quants) for (const f of q.files) expect(isDraftArtifact(f)).toBe(false);
    expect(r.companions.mtp.default).toBe("dspark-Inkling-2-Mini-Q8_0.gguf");
    expect(r.companions.mtp.candidates).toEqual([
      { path: "dspark-Inkling-2-Mini-Q8_0.gguf", bytes: null, kind: "dspark" },
      { path: "dspark/dspark-Inkling-2-Mini-BF16.gguf", bytes: null, kind: "dspark" },
    ]);
    expect(r.companions.mmproj.default).toBe("mmproj-F16.gguf");
    expect(r.companions.mmproj.candidates.every((c) => !("kind" in c))).toBe(true);
  });

  it("unsloth gemma-4-26B: unchanged — root mtp default, MTP/ variants explicit", () => {
    const r = groupRepoFiles("unsloth/gemma-4-26B-A4B-it-GGUF", UNSLOTH_GEMMA26_FILES);
    expect(r.quants.map((q) => q.tag).sort()).toEqual(["BF16", "Q4_K_XL", "Q8_0"]);
    expect(r.companions.mtp.default).toBe("mtp-gemma-4-26B-A4B-it.gguf");
    expect(r.companions.mtp.candidates.map((c) => c.kind)).toEqual(["mtp", "mtp", "mtp", "mtp"]);
  });

  it("bartowski gemma-4-26B: the single root Q8_0 draft wins; imatrix is not a quant", () => {
    const r = groupRepoFiles("bartowski/google_gemma-4-26B-A4B-it-GGUF", BARTOWSKI_GEMMA26_FILES);
    expect(r.companions.mtp.default).toBe("mtp-google_gemma-4-26B-A4B-it-Q8_0.gguf");
    expect(r.companions.mmproj.default).toBe("mmproj-google_gemma-4-26B-A4B-it-f16.gguf");
    for (const q of r.quants) for (const f of q.files) expect(f).not.toContain("imatrix");
    expect(r.quants).toHaveLength(3); // Q4_K_M, Q8_0, bf16 set
    expect(r.quants.every((q) => !q.ambiguous)).toBe(true);
  });

  it("a lone nested draft or non-f16 mmproj is still modelctl's auto-pick (review F3)", () => {
    const r = groupRepoFiles("org/m-GGUF", [
      { path: "m-Q4_K_M.gguf", bytes: null },
      { path: "dspark/m-BF16.gguf", bytes: null },
      { path: "mmproj-BF16.gguf", bytes: null },
    ]);
    expect(r.companions.mtp.default).toBe("dspark/m-BF16.gguf");
    expect(r.companions.mmproj.default).toBe("mmproj-BF16.gguf");
  });

  it("several root drafts without a single Q8_0 leave the choice explicit", () => {
    const r = groupRepoFiles("org/m-GGUF", [
      { path: "m-Q4_K_M.gguf", bytes: null },
      { path: "mtp-m-Q4_0.gguf", bytes: null },
      { path: "mtp-m-F16.gguf", bytes: null },
    ]);
    expect(r.companions.mtp.default).toBeNull();
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

  it("sends the Authorization header only when a token is configured (IRI-019)", async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      seen.push({ ...(init?.headers ?? {}) });
      return jsonResponse({ siblings: FLINT_FILES.map((f) => ({ rfilename: f.path, size: f.bytes ?? undefined })) });
    });
    const service = createHfQuantsService({ fetchImpl });

    await service.listQuants("unsloth/flint-GGUF");
    expect(seen[0]).toEqual({ accept: "application/json" });

    await service.listQuants("unsloth/flint-GGUF", "hf_x");
    expect(seen[1]).toEqual({ accept: "application/json", authorization: "Bearer hf_x" });

    await service.listQuants("unsloth/flint-GGUF", null);
    expect(seen[2]).toEqual({ accept: "application/json" });
  });
});
