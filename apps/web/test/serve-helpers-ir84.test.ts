import { describe, expect, it } from "vitest";
import {
  engineLogEmptyText,
  sanitizeWorkerIds,
  scriptPathError,
  setupChipView,
  setupSummaryLine,
  sortSetupsForBoard,
  probeSeesEngine,
} from "../src/serve";

/**
 * IRI-084: pure-helper contracts for the serve board — the IR-152 chip
 * mapping, IR-151 probe escape hatch, board ordering, and input validation.
 */

const node = (id: string, kind = "spark"): { id: string; kind: string } => ({ id, kind });

describe("sanitizeWorkerIds", () => {
  it("drops duplicates, the head itself, and NAS nodes", () => {
    const nodes = [node("head"), node("w1"), node("w2", "nas")] as never[];
    expect(sanitizeWorkerIds(["w1", "w1", "head", "w2", "ghost"], "head", nodes as never)).toEqual(["w1"]);
  });
});

describe("setupChipView (IR-152)", () => {
  const base = { status: "running", health: "healthy", lastStartedAt: "t", port: 8080 } as never;
  it("maps health variants for a running row", () => {
    expect(setupChipView(base, { probeSees: false })).toMatchObject({ label: "healthy", cls: "chip--ok" });
    expect(setupChipView({ ...base, health: "foreign" }, { probeSees: false })).toMatchObject({ label: "wrong engine", cls: "chip--warn" });
    expect(setupChipView({ ...base, health: "timeout" }, { probeSees: false })).toMatchObject({ label: "failed" });
  });

  it("a stopped row whose probe sees the engine reads 'serving :port' (IR-151)", () => {
    expect(setupChipView({ status: "stopped", health: null, lastStartedAt: "t", port: 9000 } as never, { probeSees: true })).toMatchObject({ label: "serving :9000", cls: "chip--warn" });
    expect(setupChipView({ status: "stopped", health: null, lastStartedAt: null, port: 9000 } as never, { probeSees: false })).toMatchObject({ label: "never started" });
  });

  it("failed and transition rows carry warn/run chips", () => {
    expect(setupChipView({ status: "failed", health: null, lastStartedAt: null, port: 1 } as never, { probeSees: false }).cls).toBe("chip--warn");
    expect(setupChipView({ status: "starting", health: null, lastStartedAt: null, port: 1 } as never, { probeSees: false }).dot).toBe("dot--run");
  });
});

describe("sortSetupsForBoard + setupSummaryLine", () => {
  it("orders live work first, failures, then idle; name-stable", () => {
    const out = sortSetupsForBoard([
      { status: "stopped", name: "z" },
      { status: "running", name: "b" },
      { status: "failed", name: "a" },
      { status: "running", name: "a" },
    ]);
    expect(out.map((s) => s.name)).toEqual(["a", "b", "a", "z"]);
  });

  it("summarizes live/failed/idle counts", () => {
    expect(setupSummaryLine([{ status: "running" }, { status: "starting" }, { status: "failed" }, { status: "stopped" }] as never)).toContain("2");
  });
});

describe("probeSeesEngine (IR-151)", () => {
  const llm = new Map([["head", { ports: [{ port: 9000, detected: true, model: "glm-5.3" }] }]]);

  it("true only when the probe detects the declared port+model", () => {
    expect(probeSeesEngine({ headNodeId: "head", port: 9000, model: "glm-5.3" } as never, llm)).toBe(true);
    expect(probeSeesEngine({ headNodeId: "head", port: 9001, model: "glm-5.3" } as never, llm)).toBe(false);
    expect(probeSeesEngine({ headNodeId: "absent", port: 9000, model: "glm-5.3" } as never, llm)).toBe(false);
  });
});

describe("scriptPathError + engineLogEmptyText", () => {
  it("rejects traversal and relative paths; accepts absolute", () => {
    expect(scriptPathError("../etc/passwd")).not.toBeNull();
    expect(scriptPathError("scripts/start.sh")).not.toBeNull();
    expect(scriptPathError("/opt/irori/recipes/x/start.sh")).toBeNull();
  });

  it("empty-log text reflects the row state", () => {
    expect(engineLogEmptyText({ status: "stopped", lastError: null, lastStartedAt: null })).toContain("never");
    expect(engineLogEmptyText({ status: "failed", lastError: "boom", lastStartedAt: null })).toContain("boom");
  });
});
