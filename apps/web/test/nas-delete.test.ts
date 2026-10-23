import { describe, expect, it } from "vitest";
import { armableNasDelete, setupServingModel } from "../src/models";

/** IRI-018: NAS delete flow gating — arm only from a succeeded same-name dry-run. */

function job(overrides: Partial<{ kind: string; status: string; nodeId: string; params: Record<string, unknown> }> = {}) {
  return { kind: "nas-delete", status: "succeeded", nodeId: "node-1", params: { name: "flint" }, ...overrides };
}

describe("armableNasDelete", () => {
  it("arms from a succeeded dry-run carrying a name", () => {
    expect(armableNasDelete(job())).toEqual({ nodeId: "node-1", name: "flint" });
  });

  it("refuses non-succeeded jobs, other kinds, and missing names", () => {
    expect(armableNasDelete(job({ status: "running" }))).toBeNull();
    expect(armableNasDelete(job({ status: "failed" }))).toBeNull();
    expect(armableNasDelete(job({ kind: "nas-delete-apply" }))).toBeNull();
    expect(armableNasDelete(job({ params: {} }))).toBeNull();
    expect(armableNasDelete(job({ params: { name: "" } }))).toBeNull();
    expect(armableNasDelete(null)).toBeNull();
    expect(armableNasDelete(undefined)).toBeNull();
  });
});

describe("setupServingModel", () => {
  const setups = [
    { name: "glm-main", model: "Mia-AiLab/GLM-5.3-Flash-EXL3-4bpw-TensorFold" },
    { name: "flint-serve", model: "RecursiveSI/flint" },
  ];

  it("returns the first setup referencing the model", () => {
    expect(setupServingModel(setups, "RecursiveSI/flint")).toBe("flint-serve");
  });

  it("is null when nothing serves the model", () => {
    expect(setupServingModel(setups, "unsloth/flint-GGUF")).toBeNull();
    // Exact equality, not substring: "flint" is contained in RecursiveSI/flint.
    expect(setupServingModel(setups, "flint")).toBeNull();
  });
});
