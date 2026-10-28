import { describe, expect, it } from "vitest";
import {
  fmtEta,
  fmtRate,
  sanitizeWorkerIds,
  setupChipCls,
  setupNodeLines,
  setupSubline,
  stagePercent,
  stageVal,
  type SetupInfo,
} from "../src/serve";
import type { NodeInfo } from "@irori/core";

function node(id: string, name: string, online: boolean): NodeInfo {
  return {
    id,
    name,
    kind: "spark",
    role: "standalone",
    host: `${name}.lan`,
    enabled: true,
    agentVersion: "0.1.0",
    online,
    lastSeenAt: null,
    sortOrder: 0,
    llmPorts: [],
    nasRoot: null,
    cacheUser: null,
    createdAt: "2026-10-18T00:00:00.000Z",
    updatedAt: "2026-10-18T00:00:00.000Z",
  } as NodeInfo;
}

function setup(overrides: Partial<SetupInfo>): SetupInfo {
  return {
    id: "0b6c1c26-1f1e-4a2f-9c2a-9d6a2f7b1e01",
    name: "GLM-5.3-Flash-EXL3",
    kind: "single",
    model: "GLM-5.3-Flash-EXL3",
    port: 8081,
    headNodeId: "0b6c1c26-1f1e-4a2f-9c2a-9d6a2f7b1e02",
    nodes: [],
    scriptStart: "/s/start.sh",
    scriptStop: "/s/stop.sh",
    env: { modelName: false, port: false, extraArgs: "", modelPath: false },
    status: "stopped",
    health: null,
    lastError: null,
    startupTimeoutMs: 900000,
    lastStartedAt: null,
    createdAt: "2026-10-18T00:00:00.000Z",
    updatedAt: "2026-10-18T00:00:00.000Z",
    ...overrides,
  } as SetupInfo;
}

describe("sanitizeWorkerIds", () => {
  const HEAD = "11111111-1111-4111-8111-111111111111";
  const DGX2 = "22222222-2222-4222-8222-222222222222";
  const DGX3 = "33333333-3333-4333-8333-333333333333";
  const NAS = "44444444-4444-4444-8444-444444444444";
  const inventory: NodeInfo[] = [
    node(HEAD, "DGX-1", true),
    node(DGX2, "DGX-2", true),
    node(DGX3, "DGX-3", true),
    { ...node(NAS, "NAS", true), kind: "nas" as const },
  ];

  it("dedupes keeping the first occurrence and preserves order", () => {
    expect(sanitizeWorkerIds([DGX3, DGX2, DGX3], HEAD, inventory)).toEqual([DGX3, DGX2]);
  });

  it("drops the head itself, NAS-kind nodes and unknown ids (IRI-041 corrupt row)", () => {
    const unknown = "55555555-5555-4555-8555-555555555555";
    expect(sanitizeWorkerIds([HEAD, NAS, unknown, DGX2], HEAD, inventory)).toEqual([DGX2]);
  });

  it("keeps gpu-host nodes — only nas is rejected server-side", () => {
    const gpu = { ...node("66666666-6666-4666-8666-666666666666", "GPU-1", true), kind: "gpu-host" as const };
    expect(sanitizeWorkerIds(["66666666-6666-4666-8666-666666666666"], HEAD, [...inventory, gpu])).toEqual([
      "66666666-6666-4666-8666-666666666666",
    ]);
  });
});

describe("stage lines", () => {
  it("formats the mockup's progress triple", () => {
    expect(stageVal({ status: "running", progress: { percent: 64, rateBytesPerSec: 168 * 1024 ** 2, etaSeconds: 240 }, error: null })).toBe("64% · 168 MB/s · ~4m 0s left");
    expect(stageVal({ status: "succeeded", progress: null, error: null })).toBe("done");
    expect(stageVal({ status: "failed", progress: null, error: "busy: a job is already running on this node" })).toContain("busy");
    expect(stageVal({ status: "pending", progress: null, error: null })).toBe("waiting");
  });

  it("formats rates and etas", () => {
    expect(fmtRate(96 * 1024 ** 2)).toBe("96.0 MB/s");
    expect(fmtRate(1024)).toBe("1.0 KB/s");
    expect(fmtEta(192)).toBe("3m 12s");
    expect(fmtEta(45)).toBe("45s");
  });

  it("fills bars from progress with clamping", () => {
    expect(stagePercent({ status: "succeeded", progress: null })).toBe(100);
    expect(stagePercent({ status: "running", progress: { percent: 64 } })).toBe(64);
    expect(stagePercent({ status: "running", progress: { percent: 140 } })).toBe(100);
    expect(stagePercent({ status: "running", progress: null })).toBe(0);
  });
});

describe("setup cards", () => {
  it("maps chips to DS classes", () => {
    expect(setupChipCls("healthy")).toBe("chip--ok");
    expect(setupChipCls("foreign")).toBe("chip--warn");
    expect(setupChipCls("failed")).toBe("chip--halt");
    expect(setupChipCls("starting")).toBe("chip--run");
  });

  it("renders per-node lines: head probe state, worker join state", () => {
    const s = setup({
      kind: "cluster",
      nodes: [{ nodeId: "0b6c1c26-1f1e-4a2f-9c2a-9d6a2f7b1e03", role: "worker" }],
      status: "running",
      health: "healthy",
    });
    const lines = setupNodeLines(s, [
      node(s.headNodeId, "dgx1", true),
      node("0b6c1c26-1f1e-4a2f-9c2a-9d6a2f7b1e03", "spark2", true),
    ], { decodeTps: 142.3 });
    expect(lines[0]!.label).toContain("dgx1 · head · :8081");
    expect(lines[0]!.detail).toBe("142.3 tok/s");
    expect(lines[0]!.cls).toBe("chip--ok");
    expect(lines[1]!.label).toContain("spark2 · worker");
    expect(lines[1]!.detail).toBe("joined");
  });

  it("explains foreign ports and stopped setups", () => {
    expect(setupSubline(setup({ status: "running", health: "foreign", port: 8100 }))).toContain("another process took the port");
    expect(setupSubline(setup({ status: "stopped", lastStartedAt: "2026-10-16T00:00:00.000Z" }))).toContain("last start");
    expect(setupSubline(setup({ status: "failed", lastError: "start script exited with code 3" }))).toContain("code 3");
  });
});
