import { describe, expect, it } from "vitest";
import { bulkDeleteTotalBytes, setupServingModel, setupServingNames } from "../src/models";

/** Delete-advisory helper: which serving setup references the model. */

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

/** IR-210: bulk-delete helpers — setup advisory across a selection and catalog-sourced totals. */

describe("setupServingNames", () => {
  const setups = [
    { name: "glm-main", model: "Mia-AiLab/GLM-5.3-Flash-EXL3-4bpw-TensorFold" },
    { name: "flint-serve", model: "RecursiveSI/flint" },
    { name: "flint-serve-2", model: "RecursiveSI/flint" },
    { name: "idle", model: "org/other" },
  ];

  it("returns each setup serving any selected model, deduped in first-seen order", () => {
    expect(setupServingNames(setups, ["RecursiveSI/flint", "Mia-AiLab/GLM-5.3-Flash-EXL3-4bpw-TensorFold"])).toEqual([
      "glm-main",
      "flint-serve",
      "flint-serve-2",
    ]);
  });

  it("is empty when nothing serves the selection", () => {
    expect(setupServingNames(setups, ["unsloth/flint-GGUF"])).toEqual([]);
    expect(setupServingNames(setups, [])).toEqual([]);
  });
});

describe("bulkDeleteTotalBytes", () => {
  const entries = [
    { name: "a", bytes: 1024 ** 3 },
    { name: "b", bytes: 2 * 1024 ** 3 },
  ];

  it("sums the selected rows' catalog bytes", () => {
    expect(bulkDeleteTotalBytes(entries, ["a", "b"])).toBe(3 * 1024 ** 3);
    expect(bulkDeleteTotalBytes(entries, ["a"])).toBe(1024 ** 3);
    expect(bulkDeleteTotalBytes(entries, [])).toBe(0);
  });

  it("counts names absent from the current page as 0 (stale selection survives a refresh)", () => {
    expect(bulkDeleteTotalBytes(entries, ["a", "vanished"])).toBe(1024 ** 3);
  });
});
