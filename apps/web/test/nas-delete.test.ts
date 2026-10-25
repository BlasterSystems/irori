import { describe, expect, it } from "vitest";
import { setupServingModel } from "../src/models";

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
