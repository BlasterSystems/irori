import { describe, expect, it } from "vitest";
import type { HfQuantsResult } from "@irori/core";
import {
  defaultDraftSpecType,
  draftKindLabel,
  draftSpecTypeToSend,
  effectiveDraftSpecType,
  hintProvenance,
  mmprojNote,
  preselectDraft,
  safeHref,
} from "../src/draft-choice.js";

/** Shapes mirror the live /api/v1/hf-quants answers of 2026-11-21 (IRI-153 smoke). */
function listing(over: Partial<HfQuantsResult> = {}): HfQuantsResult {
  return {
    repo: "unsloth/Inkling-2-Mini-GGUF",
    modelCard: "README.md",
    quants: [],
    companions: {
      mmproj: { candidates: [{ path: "mmproj-F16.gguf", bytes: null }], default: "mmproj-F16.gguf" },
      mtp: {
        candidates: [
          { path: "dspark-Inkling-2-Mini-Q8_0.gguf", bytes: null, kind: "dspark" },
          { path: "dspark/dspark-Inkling-2-Mini-BF16.gguf", bytes: null, kind: "dspark" },
        ],
        default: "dspark-Inkling-2-Mini-Q8_0.gguf",
      },
    },
    hints: {
      draft: "dspark-Inkling-2-Mini-Q8_0.gguf",
      mmproj: "mmproj-F16.gguf",
      specType: "draft-dspark",
      source: "docs",
      url: "https://unsloth.ai/docs/models/inkling-2-mini",
      error: null,
    },
    ...over,
  };
}

describe("defaultDraftSpecType (modelctl drafts.default_spec_type parity)", () => {
  it.each([
    ["mtp-gemma.gguf", "draft-mtp"],
    ["MTP/mtp-gemma-Q8_0.gguf", "draft-mtp"],
    ["MTP/dflash-x.gguf", "draft-mtp"],
    ["dspark-x-Q8_0.gguf", "draft-dspark"],
    ["dspark/dspark-x-BF16.gguf", "draft-dspark"],
    ["dflash-x.gguf", null],
    ["DFlash2/x.gguf", null],
    ["draft.gguf", "draft-mtp"],
    // modelctl classifies only .gguf files (review F4).
    ["dspark-x.bin", "draft-mtp"],
    ["dflash/x.txt", "draft-mtp"],
    ["dspark/.gguf", "draft-mtp"],
  ])("%s → %s", (path, expected) => {
    expect(defaultDraftSpecType(path)).toBe(expected);
  });
});

describe("preselectDraft", () => {
  it("prefers the run hint, then modelctl's default, then nothing", () => {
    expect(preselectDraft(listing())).toEqual({ mtp: "dspark-Inkling-2-Mini-Q8_0.gguf", origin: "hint" });
    const hintedSubdir = listing({ hints: { ...listing().hints!, draft: "dspark/dspark-Inkling-2-Mini-BF16.gguf" } });
    expect(preselectDraft(hintedSubdir)).toEqual({ mtp: "dspark/dspark-Inkling-2-Mini-BF16.gguf", origin: "hint" });
    expect(preselectDraft(listing({ hints: null }))).toEqual({ mtp: "dspark-Inkling-2-Mini-Q8_0.gguf", origin: "default" });
    const none = listing({ hints: null, companions: { ...listing().companions, mtp: { candidates: [], default: null } } });
    expect(preselectDraft(none)).toEqual({ mtp: "", origin: "none" });
  });

  it("ignores a hint that names no listed candidate", () => {
    const stray = listing({ hints: { ...listing().hints!, draft: "elsewhere.gguf" } });
    expect(preselectDraft(stray).origin).toBe("default");
  });
});

describe("draftSpecTypeToSend / effectiveDraftSpecType", () => {
  it("omits a hint equal to the kind default (Inkling draft-dspark)", () => {
    expect(draftSpecTypeToSend(listing(), "dspark-Inkling-2-Mini-Q8_0.gguf")).toBeUndefined();
    expect(effectiveDraftSpecType(listing(), "dspark-Inkling-2-Mini-Q8_0.gguf")).toBe("draft-dspark");
  });

  it("sends a non-default hint only for the hinted draft", () => {
    const dflash = listing({
      companions: {
        ...listing().companions,
        mtp: { candidates: [{ path: "dflash-m-Q8_0.gguf", bytes: null, kind: "dflash" }, { path: "dflash-m-Q4_0.gguf", bytes: null, kind: "dflash" }], default: "dflash-m-Q8_0.gguf" },
      },
      hints: { ...listing().hints!, draft: "dflash-m-Q8_0.gguf", specType: "draft-dflash" },
    });
    expect(draftSpecTypeToSend(dflash, "dflash-m-Q8_0.gguf")).toBe("draft-dflash");
    // The operator switched drafts: the hint no longer applies.
    expect(draftSpecTypeToSend(dflash, "dflash-m-Q4_0.gguf")).toBeUndefined();
    expect(effectiveDraftSpecType(dflash, "dflash-m-Q4_0.gguf")).toBeNull();
    expect(effectiveDraftSpecType(dflash, "")).toBeNull();
  });
});

describe("labels and links", () => {
  it("names kinds and provenance", () => {
    expect(draftKindLabel("dspark")).toBe("DSpark");
    expect(draftKindLabel(undefined)).toBe("draft");
    expect(hintProvenance(listing())).toEqual({ label: "docs · unsloth.ai", url: "https://unsloth.ai/docs/models/inkling-2-mini" });
    expect(hintProvenance(listing({ hints: { ...listing().hints!, source: "readme", url: "https://huggingface.co/unsloth/Inkling-2-Mini-GGUF" } }))?.label).toBe("repo README");
    expect(hintProvenance(listing({ hints: null }))).toBeNull();
  });

  it("binds only https links", () => {
    expect(safeHref("https://unsloth.ai/docs")).toBe("https://unsloth.ai/docs");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("http://unsloth.ai")).toBeNull();
    expect(safeHref(null)).toBeNull();
  });

  it("notes a model-card projector that differs from modelctl's pick", () => {
    expect(mmprojNote(listing())).toBeNull();
    const gemma = listing({ hints: { ...listing().hints!, mmproj: "mmproj-BF16.gguf" } });
    expect(mmprojNote(gemma)).toBe("the run instructions use mmproj-BF16.gguf; modelctl will download mmproj-F16.gguf");
    const noCandidates = listing({
      companions: { ...listing().companions, mmproj: { candidates: [], default: null } },
      hints: { ...listing().hints!, mmproj: "vision-proj.gguf" },
    });
    expect(mmprojNote(noCandidates)).toBe("the run instructions use vision-proj.gguf; modelctl will not download a projector");
  });
});
