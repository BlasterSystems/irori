import { describe, expect, it } from "vitest";
import { configUpdateMsgSchema, nodeCreateSchema, nodeInfoSchema, nodePatchSchema } from "../src/index.js";

const base = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "dgx1",
  kind: "spark",
  role: "head",
  host: "dgx1.lan",
  enabled: true,
  agentVersion: null,
  online: false,
  lastSeenAt: null,
  sortOrder: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("node cache user (IR-101)", () => {
  it("defaults to null on NodeInfo", () => {
    expect(nodeInfoSchema.parse(base).cacheUser).toBeNull();
  });

  it("accepts a valid username on create and patch, null clears", () => {
    expect(nodeCreateSchema.safeParse({ name: "n", kind: "spark", role: "worker", host: "h", cacheUser: "operator" }).success).toBe(true);
    expect(nodePatchSchema.safeParse({ cacheUser: null }).success).toBe(true);
    expect(nodePatchSchema.safeParse({ cacheUser: "a-b_2" }).success).toBe(true);
  });

  it("rejects usernames that could smuggle flags or shells", () => {
    for (const bad of ["-root", "a b", "root;rm", "x$(id)", "x".repeat(33), "", "Ünix"]) {
      expect(nodeCreateSchema.safeParse({ name: "n", kind: "spark", role: "worker", host: "h", cacheUser: bad }).success).toBe(false);
    }
  });

  it("carries cacheUser on config-update frames; absent resolves to null", () => {
    const frame = { type: "config-update", cadenceMs: 2000, llmPorts: [], llmCadenceMs: 0, llmDetectOnly: false, nasRoot: null };
    expect(configUpdateMsgSchema.parse({ ...frame, cacheUser: "operator" }).cacheUser).toBe("operator");
    expect(configUpdateMsgSchema.parse(frame).cacheUser).toBeNull();
  });
});
