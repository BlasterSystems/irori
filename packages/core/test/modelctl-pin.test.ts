import { describe, expect, it } from "vitest";
import { configUpdateMsgSchema, modelctlPinPutSchema, modelctlPinResponseSchema } from "../src/index.js";

describe("modelctl pin schemas (IR-105)", () => {
  it("accepts a valid semver pin and rejects anything else", () => {
    expect(modelctlPinPutSchema.parse({ pin: "0.23.0" })).toEqual({ pin: "0.23.0" });
    for (const bad of ["0.23", "v0.23.0", "0.23.0-rc1", "", "latest"]) {
      expect(modelctlPinPutSchema.safeParse({ pin: bad }).success).toBe(false);
    }
    expect(modelctlPinResponseSchema.parse({ pin: null })).toEqual({ pin: null });
  });

  it("keeps modelctlPin in config-update (string, null, absent)", () => {
    const base = { type: "config-update", cadenceMs: 2000 };
    expect(configUpdateMsgSchema.parse({ ...base, modelctlPin: "0.23.0" }).modelctlPin).toBe("0.23.0");
    expect(configUpdateMsgSchema.parse({ ...base, modelctlPin: null }).modelctlPin).toBeNull();
    expect(configUpdateMsgSchema.parse(base).modelctlPin).toBeUndefined();
    expect(() => configUpdateMsgSchema.parse({ ...base, modelctlPin: "latest" })).toThrow();
  });
});
