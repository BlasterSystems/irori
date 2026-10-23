import { describe, expect, it } from "vitest";
import type { DownloadQueueEntry } from "@irori/core";
import { downloadBytesLine, downloadProgressPct, downloadSpeedView } from "../src/models";

/** IRI-017: progress/speed view helpers over the queue DTO. */

const GIB = 2 ** 30;

function entry(overrides: Partial<DownloadQueueEntry> = {}): DownloadQueueEntry {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    source: "Mia-AiLab/GLM-5.3-Flash-EXL3-4bpw-TensorFold",
    name: "GLM-5.3-Flash-EXL3-4bpw-TensorFold",
    status: "running",
    jobId: null,
    error: null,
    createdAt: "2026-10-22T00:00:00.000Z",
    updatedAt: "2026-10-22T00:00:00.000Z",
    ...overrides,
  };
}

describe("downloadProgressPct", () => {
  it("clamps 0–100 from done/total", () => {
    expect(downloadProgressPct(entry({ bytesDone: 1 * GIB, bytesTotal: 4 * GIB }))).toBe(25);
    expect(downloadProgressPct(entry({ bytesDone: 9 * GIB, bytesTotal: 4 * GIB }))).toBe(100);
    expect(downloadProgressPct(entry({ bytesDone: 0, bytesTotal: 4 * GIB }))).toBe(0);
  });

  it("is null without bytes, total, or on non-running rows", () => {
    expect(downloadProgressPct(entry({}))).toBeNull();
    expect(downloadProgressPct(entry({ bytesDone: 1, bytesTotal: 0 }))).toBeNull();
    expect(downloadProgressPct(entry({ status: "pending", bytesDone: 1, bytesTotal: 2 }))).toBeNull();
  });
});

describe("downloadSpeedView", () => {
  it("formats network bits per second with buckets", () => {
    expect(downloadSpeedView(entry({ speedBps: 5_000_000 }))).toEqual({ label: "40 Mb/s", bucket: "slow" });
    expect(downloadSpeedView(entry({ speedBps: 50_000_000 }))).toEqual({ label: "400 Mb/s", bucket: "ok" });
    expect(downloadSpeedView(entry({ speedBps: 62_500_000 }))).toEqual({ label: "500 Mb/s", bucket: "ok" });
    expect(downloadSpeedView(entry({ speedBps: 250_000_000 }))).toEqual({ label: "2.0 Gb/s", bucket: "fast" });
    expect(downloadSpeedView(entry({ speedBps: 25_000_000_000 }))).toEqual({ label: "200.0 Gb/s", bucket: "fast" });
    expect(downloadSpeedView(entry({ speedBps: 500_000 }))).toEqual({ label: "4 Mb/s", bucket: "slow" });
  });

  it("is null without a speed or on non-running rows", () => {
    expect(downloadSpeedView(entry({}))).toBeNull();
    expect(downloadSpeedView(entry({ status: "succeeded", speedBps: 1 }))).toBeNull();
  });
});

describe("downloadBytesLine", () => {
  it("formats done/total and bare totals", () => {
    expect(downloadBytesLine(entry({ bytesDone: 1 * GIB, bytesTotal: 4 * GIB }))).toBe("1.0 GiB / 4.0 GiB");
    expect(downloadBytesLine(entry({ bytesDone: 3 * GIB }))).toBe("3.0 GiB");
  });

  it("is null without bytes or on non-running rows", () => {
    expect(downloadBytesLine(entry({}))).toBeNull();
    expect(downloadBytesLine(entry({ status: "failed", bytesDone: 1 }))).toBeNull();
  });
});
