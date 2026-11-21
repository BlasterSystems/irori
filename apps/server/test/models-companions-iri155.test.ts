import { describe, expect, it } from "vitest";
import { storedCompanions } from "../src/app.js";

/** IRI-155: `/api/v1/models` lifts `model_meta.meta.companions`, re-validated. */
describe("storedCompanions", () => {
  const companions = { mmproj: { path: "mmproj-F16.gguf", bytes: 1 }, draft: null };

  it("lifts a stored value and known-none", () => {
    expect(storedCompanions({ source: "catalog", companions })).toEqual(companions);
    expect(storedCompanions({ source: "catalog", companions: null })).toBeNull();
    expect(storedCompanions({ source: "catalog", companions: { unreadable: true } })).toEqual({ unreadable: true });
  });

  it("is undefined (unknown) when never reported or not valid", () => {
    expect(storedCompanions({ source: "catalog" })).toBeUndefined();
    expect(storedCompanions(null)).toBeUndefined();
    expect(storedCompanions("x")).toBeUndefined();
    expect(storedCompanions({ companions: { mmproj: { path: "../../etc/passwd", bytes: 1 }, draft: null } })).toBeUndefined();
  });
});
