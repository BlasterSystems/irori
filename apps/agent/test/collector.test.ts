import { describe, expect, it } from "vitest";
import { hardwareSnapshotSchema } from "@irori/core";
import { collect, parseGpuCsv } from "../src/collector.js";

describe("collect", () => {
  it("produces a schema-valid snapshot on this host", async () => {
    const snapshot = await collect();

    // parse() throws if anything violates hardwareSnapshotSchema.
    const parsed = hardwareSnapshotSchema.parse(snapshot);

    expect(parsed.transport).toBe("ws");
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.agentVersion).toMatch(/^0\./);
    expect(parsed.hostname.length).toBeGreaterThan(0);
    expect(parsed.cpu.cores).toBeGreaterThan(0);
    expect(parsed.cpu.model.length).toBeGreaterThan(0);
    expect(parsed.cpu.tempC).toBeNull();
    expect(parsed.cpu.packagePowerW).toBeNull();
    expect(
      parsed.cpu.usagePct === null ||
        (parsed.cpu.usagePct >= 0 && parsed.cpu.usagePct <= 100),
    ).toBe(true);
    expect(parsed.memory.totalBytes).toBeGreaterThan(0);
    expect(parsed.memory.usedBytes).toBeGreaterThan(0);
    expect(parsed.memory.usedBytes).toBeLessThanOrEqual(parsed.memory.totalBytes);
    expect(parsed.uptimeS).toBeGreaterThanOrEqual(0);
  });

  it("reports no GPUs when nvidia-smi is unavailable (darwin host)", async () => {
    const snapshot = await collect();
    expect(snapshot.gpus).toEqual([]);
  });
});

describe("parseGpuCsv", () => {
  it("parses a realistic nvidia-smi row, converting MiB to bytes", () => {
    const gpus = parseGpuCsv("0, NVIDIA GB10, 37, 52, 2048, 12288, 25.50\n");
    expect(gpus).toHaveLength(1);
    const gpu = gpus[0]!;
    expect(gpu.index).toBe(0);
    expect(gpu.name).toBe("NVIDIA GB10");
    expect(gpu.usagePct).toBe(37);
    expect(gpu.tempC).toBe(52);
    expect(gpu.memUsedBytes).toBe(2048 * 1024 * 1024);
    expect(gpu.memTotalBytes).toBe(12288 * 1024 * 1024);
    expect(gpu.powerW).toBeCloseTo(25.5);
    expect(gpu.throttleReasons).toEqual([]);
  });

  it("maps unavailable metrics to null and skips malformed rows", () => {
    const gpus = parseGpuCsv(
      [
        '0, "NVIDIA A100", [N/A], [N/A], [N/A], [N/A], [Not Supported]',
        "garbage line with too few fields",
        "",
        "1, NVIDIA H100, 0, 30, 100, 81920, 400.00",
      ].join("\n"),
    );
    expect(gpus).toHaveLength(2);
    expect(gpus[0]!.name).toBe("NVIDIA A100");
    expect(gpus[0]!.usagePct).toBeNull();
    expect(gpus[0]!.tempC).toBeNull();
    expect(gpus[0]!.memUsedBytes).toBeNull();
    expect(gpus[0]!.memTotalBytes).toBeNull();
    expect(gpus[0]!.powerW).toBeNull();
    expect(gpus[1]!.index).toBe(1);
    expect(gpus[1]!.usagePct).toBe(0);
    expect(gpus[1]!.memTotalBytes).toBe(81920 * 1024 * 1024);
  });
});
