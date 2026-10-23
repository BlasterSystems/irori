import { describe, expect, it } from "vitest";
import { configUpdateMsgSchema } from "../src/agent-messages.js";
import { hfTokenPutSchema, hfTokenStatusSchema } from "../src/hf-token.js";

/**
 * IRI-019: global HF token wire contracts. The token rides config-update
 * (set/clear/absent) and the settings API (presence-only GET, nullable PUT).
 * It is always optional — absence is never an error.
 */
describe("hfToken wire contracts", () => {
  const frame = { type: "config-update", cadenceMs: 2000, llmPorts: [], llmCadenceMs: 0, llmDetectOnly: false, nasRoot: null };

  it("carries set and clear values on config-update", () => {
    expect(configUpdateMsgSchema.parse({ ...frame, hfToken: "hf_x" }).hfToken).toBe("hf_x");
    expect(configUpdateMsgSchema.parse({ ...frame, hfToken: null }).hfToken).toBeNull();
  });

  it("keeps hfToken absent for old-server frames (agent env fallback applies)", () => {
    const parsed = configUpdateMsgSchema.parse(frame);
    expect(parsed.hfToken).toBeUndefined();
    expect("hfToken" in parsed).toBe(false);
  });

  it("rejects an empty token on the frame", () => {
    expect(configUpdateMsgSchema.safeParse({ ...frame, hfToken: "" }).success).toBe(false);
  });

  it("validates the presence-only status body", () => {
    expect(hfTokenStatusSchema.parse({ configured: true })).toEqual({ configured: true });
    expect(hfTokenStatusSchema.safeParse({ configured: "yes" }).success).toBe(false);
  });

  it("validates the put body (string sets, null clears, empty rejected)", () => {
    expect(hfTokenPutSchema.safeParse({ hfToken: "hf_x" }).success).toBe(true);
    expect(hfTokenPutSchema.safeParse({ hfToken: null }).success).toBe(true);
    expect(hfTokenPutSchema.safeParse({ hfToken: "" }).success).toBe(false);
    expect(hfTokenPutSchema.safeParse({}).success).toBe(false);
  });
});
