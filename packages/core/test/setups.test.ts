import { describe, expect, it } from "vitest";
import {
  envExportsSchema,
  modelIdMatches,
  parseTransferProgress,
  setupChip,
  setupInfoSchema,
  setupTransferSchema,
  transferStageSchema,
} from "@irori/core";

describe("parseTransferProgress (rsync --info=progress2 over \\r)", () => {
  it("parses the full progress2 chunk", () => {
    expect(parseTransferProgress(" 2,713,533   45%    1.00MB/s    0:00:03")).toEqual({
      bytes: 2713533,
      percent: 45,
      rateBytesPerSec: 1024 * 1024,
      etaSeconds: 3,
    });
  });

  it("parses human-readable sizes and rates", () => {
    const p = parseTransferProgress("2.71G  45%  234.56MB/s  0:03:12");
    expect(p).toEqual({
      bytes: Math.round(2.71 * 1024 ** 3),
      percent: 45,
      rateBytesPerSec: Math.round(234.56 * 1024 ** 2),
      etaSeconds: 3 * 60 + 12,
    });
  });

  it("parses a subset (percent only)", () => {
    expect(parseTransferProgress("45%")).toEqual({ bytes: null, percent: 45, rateBytesPerSec: null, etaSeconds: null });
  });

  it("rejects phase banners and prose", () => {
    expect(parseTransferProgress("push: transferring 12 files (+3 metadata files) to spark2")).toBeNull();
    expect(parseTransferProgress("sync-local: publishing blobs")).toBeNull();
    expect(parseTransferProgress("")).toBeNull();
  });
});

describe("modelIdMatches", () => {
  it("matches case-insensitively in both directions", () => {
    expect(modelIdMatches("glm-5.3-flash-exl3", "GLM-5.3-Flash-EXL3")).toBe(true);
    expect(modelIdMatches("GLM-5.3-Flash-EXL3-snapshot", "GLM-5.3-Flash")).toBe(true);
    expect(modelIdMatches("qwen3-8b", "GLM-5.3")).toBe(false);
    expect(modelIdMatches(null, "GLM-5.3")).toBe(false);
  });
});

describe("setupChip", () => {
  it("derives the card chip from driver and health", () => {
    expect(setupChip({ status: "running", health: "healthy" })).toBe("healthy");
    expect(setupChip({ status: "running", health: "foreign" })).toBe("foreign");
    expect(setupChip({ status: "running", health: "timeout" })).toBe("failed");
    expect(setupChip({ status: "running", health: null })).toBe("starting");
    expect(setupChip({ status: "starting", health: null })).toBe("starting");
    expect(setupChip({ status: "stopping", health: null })).toBe("stopping");
    expect(setupChip({ status: "stopped", health: null })).toBe("stopped");
    expect(setupChip({ status: "failed", health: null })).toBe("failed");
  });
});

describe("contracts", () => {
  it("round-trips a setup info payload", () => {
    const info = setupInfoSchema.parse({
      id: "0b6c1c26-1f1e-4a2f-9c2a-9d6a2f7b1e01",
      name: "GLM-5.3-Flash-EXL3",
      kind: "cluster",
      model: "GLM-5.3-Flash-EXL3",
      port: 8081,
      headNodeId: "0b6c1c26-1f1e-4a2f-9c2a-9d6a2f7b1e02",
      nodes: [{ nodeId: "0b6c1c26-1f1e-4a2f-9c2a-9d6a2f7b1e03", role: "worker" }],
      scriptStart: "/home/me/glm/start.sh",
      scriptStop: "/home/me/glm/stop.sh",
      status: "starting",
      health: "starting",
      lastError: null,
      createdAt: "2026-10-18T10:00:00.000Z",
      updatedAt: "2026-10-18T10:00:00.000Z",
    });
    expect(info.startupTimeoutMs).toBe(15 * 60_000);
    expect(info.env).toEqual({ modelName: false, port: false, extraArgs: "", modelPath: false });
    // >8 nodes total is refused at the contract boundary.
    const tooMany = setupInfoSchema.safeParse({
      ...info,
      nodes: Array.from({ length: 8 }, (_, i) => ({
        nodeId: `0b6c1c26-1f1e-4a2f-9c2a-9d6a2f7b1e1${i}`,
        role: "worker",
      })),
    });
    expect(tooMany.success).toBe(false);
  });

  it("defaults env exports and validates them", () => {
    expect(envExportsSchema.parse({})).toEqual({ modelName: false, port: false, extraArgs: "", modelPath: false });
    expect(envExportsSchema.parse({ extraArgs: "--thinking" }).extraArgs).toBe("--thinking");
  });

  it("round-trips a staged transfer with progress", () => {
    const transfer = setupTransferSchema.parse({
      id: "0b6c1c26-1f1e-4a2f-9c2a-9d6a2f7b1e10",
      setupId: "0b6c1c26-1f1e-4a2f-9c2a-9d6a2f7b1e01",
      status: "running",
      stages: [
        { label: "NAS → spark2 (sync)", targetId: "0b6c1c26-1f1e-4a2f-9c2a-9d6a2f7b1e03", nodeId: "0b6c1c26-1f1e-4a2f-9c2a-9d6a2f7b1e02", kind: "sync-local", status: "running", progress: { bytes: 1000, percent: 64, rateBytesPerSec: 1024, etaSeconds: 12 } },
        { label: "HF → nas (download)", targetId: "0b6c1c26-1f1e-4a2f-9c2a-9d6a2f7b1e03", nodeId: "0b6c1c26-1f1e-4a2f-9c2a-9d6a2f7b1e04", kind: "download-queue", status: "pending" },
      ],
      createdAt: "2026-10-18T10:00:00.000Z",
      finishedAt: null,
    });
    expect(transfer.stages[0]!.progress!.percent).toBe(64);
    expect(transfer.stages[1]!.jobId).toBeNull();
    const bad = transferStageSchema.safeParse({ label: "x", nodeId: "not-a-uuid", kind: "sync-local", status: "pending" });
    expect(bad.success).toBe(false);
  });
});
