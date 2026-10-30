import { describe, expect, it } from "vitest";
import { configUpdateMsgSchema, deriveNodeRoles, diffNodeRoles, nodeCreateSchema, nodeInfoSchema, nodePatchSchema, type NodeRole } from "../src/index.js";

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
    expect(nodeCreateSchema.safeParse({ name: "n", kind: "spark", role: "worker", host: "h", cacheUser: "piresbruno" }).success).toBe(true);
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
    expect(configUpdateMsgSchema.parse({ ...frame, cacheUser: "piresbruno" }).cacheUser).toBe("piresbruno");
    expect(configUpdateMsgSchema.parse(frame).cacheUser).toBeNull();
  });
});

describe("node role derivation (IRI-050)", () => {
  const ids = { a: "00000000-0000-4000-8000-00000000000a", b: "00000000-0000-4000-8000-00000000000b", c: "00000000-0000-4000-8000-00000000000c", d: "00000000-0000-4000-8000-00000000000d" };
  const dangling = "00000000-0000-4000-8000-00000000000e";

  it("derives head over worker over standalone, ignoring dangling ids", () => {
    const derived = deriveNodeRoles(
      [
        { headNodeId: ids.a, nodes: [{ nodeId: ids.b }, { nodeId: dangling }] },
        { headNodeId: ids.c, nodes: [] },
      ],
      new Set([ids.a, ids.b, ids.c, ids.d]),
    );
    expect(derived.get(ids.a)).toBe("head");
    expect(derived.get(ids.b)).toBe("worker");
    expect(derived.get(ids.c)).toBe("head");
    expect(derived.get(ids.d)).toBe("standalone");
    expect(derived.has(dangling)).toBe(false);
  });

  it("resolves multi-membership with head precedence", () => {
    // a heads setup 1 and works in setup 2 — head wins.
    const derived = deriveNodeRoles(
      [
        { headNodeId: ids.a, nodes: [] },
        { headNodeId: ids.b, nodes: [{ nodeId: ids.a }, { nodeId: ids.c }] },
      ],
      new Set([ids.a, ids.b, ids.c]),
    );
    expect(derived.get(ids.a)).toBe("head");
    expect(derived.get(ids.b)).toBe("head");
    expect(derived.get(ids.c)).toBe("worker");
  });

  it("is idempotent and order-independent", () => {
    const memberships = [
      { headNodeId: ids.a, nodes: [{ nodeId: ids.b }] },
      { headNodeId: ids.c, nodes: [{ nodeId: ids.b }, { nodeId: ids.a }] },
    ];
    const nodeIds = new Set([ids.a, ids.b, ids.c]);
    expect(deriveNodeRoles(memberships, nodeIds)).toEqual(deriveNodeRoles([...memberships].reverse(), nodeIds));
    expect(deriveNodeRoles(memberships, nodeIds)).toEqual(deriveNodeRoles(memberships, nodeIds));
  });

  it("diff emits only changed roles, limited to the requested scope", () => {
    const derived = new Map<string, NodeRole>([
      [ids.a, "head"],
      [ids.b, "worker"],
      [ids.c, "standalone"],
    ]);
    const current = new Map<string, NodeRole>([
      [ids.a, "standalone"],
      [ids.b, "worker"],
      [ids.c, "worker"],
    ]);
    expect(diffNodeRoles(derived, current)).toEqual(new Map([[ids.a, "head"], [ids.c, "standalone"]]));
    // Scope (the caller's affected set) keeps unrelated manual overrides out.
    expect(diffNodeRoles(derived, current, new Set([ids.a]))).toEqual(new Map([[ids.a, "head"]]));
    // Unknown current role counts as changed.
    expect(diffNodeRoles(derived, new Map(), new Set([ids.b]))).toEqual(new Map([[ids.b, "worker"]]));
  });
});
