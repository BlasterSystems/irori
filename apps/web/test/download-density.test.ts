import { describe, expect, it } from "vitest";
import type { DownloadQueueEntry } from "@irori/core";
import {
  downloadBatchTotals,
  downloadEntryEta,
  downloadJobSummary,
  downloadRowActions,
  downloadSpeedLabel,
  formatEta,
} from "../src/models";

/** IRI-020: batch totals, per-state row actions, and the collapsed job summary. */

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

describe("downloadBatchTotals", () => {
  it("sums running speeds only and settles succeeded bytes", () => {
    const t = downloadBatchTotals([
      entry({ bytesDone: 1 * GIB, bytesTotal: 2 * GIB, speedBps: 100_000_000 }),
      entry({ id: "00000000-0000-4000-8000-000000000002", status: "succeeded", bytesTotal: 4 * GIB }),
      entry({ id: "00000000-0000-4000-8000-000000000003", status: "failed", bytesDone: 1 * GIB, bytesTotal: 4 * GIB }),
    ]);
    expect(t.entries).toBe(3);
    expect(t.active).toBe(1);
    expect(t.bytesDone).toBe(6 * GIB); // 1 running + 4 settled + 1 partial failed
    expect(t.bytesTotal).toBe(10 * GIB);
    expect(t.speedBps).toBe(100_000_000);
    expect(t.pct).toBe(60);
  });

  it("computes eta from remaining over combined", () => {
    const t = downloadBatchTotals([entry({ bytesDone: 1 * GIB, bytesTotal: 3 * GIB, speedBps: 100_000_000 })]);
    expect(t.etaSeconds).toBe(Math.round((2 * GIB) / 100_000_000));
  });

  it("hides parts when there is no data", () => {
    const t = downloadBatchTotals([entry({}), entry({ id: "00000000-0000-4000-8000-000000000002", status: "pending" })]);
    expect(t.pct).toBeNull();
    expect(t.speedBps).toBeNull();
    expect(t.etaSeconds).toBeNull();
    expect(downloadBatchTotals([]).pct).toBeNull();
    expect(downloadBatchTotals([]).active).toBe(0);
  });

  it("excludes bytes with no matching total from the numerator", () => {
    // A running row may report bytesDone with bytesTotal unknown (parseProgressLine
    // contract) — counting it would inflate the strip and can clamp 100% mid-flight.
    const t = downloadBatchTotals([
      entry({ id: "00000000-0000-4000-8000-000000000002", bytesDone: 0.5 * GIB, bytesTotal: undefined }),
      entry({ id: "00000000-0000-4000-8000-000000000003", bytesDone: 1 * GIB, bytesTotal: 4 * GIB }),
    ]);
    expect(t.bytesDone).toBe(1 * GIB);
    expect(t.bytesTotal).toBe(4 * GIB);
    expect(t.pct).toBe(25);
  });
});

describe("downloadRowActions", () => {
  it("matches the per-state menus", () => {
    expect(downloadRowActions("running", true)).toEqual([
      { act: "job", label: "Job output" },
      { act: "cancel-job", label: "Cancel job…" },
    ]);
    expect(downloadRowActions("running", false)).toEqual([{ act: "cancel-job", label: "Cancel job…" }]);
    expect(downloadRowActions("pending", false)).toEqual([{ act: "remove", label: "Remove…" }]);
    expect(downloadRowActions("succeeded", true)).toEqual([
      { act: "job", label: "Job output" },
      { act: "remove", label: "Remove…" },
    ]);
    expect(downloadRowActions("failed", true).map((i) => i.act)).toEqual(["job", "retry", "retry-force", "remove"]);
    expect(downloadRowActions("canceled", false).map((i) => i.act)).toEqual(["retry", "retry-force", "remove"]);
  });
});

describe("downloadEntryEta / formatEta", () => {
  it("derives per-entry eta from bytes and speed", () => {
    expect(downloadEntryEta(entry({ bytesDone: 1 * GIB, bytesTotal: 3 * GIB, speedBps: 100_000_000 }))).toBe(
      Math.round((2 * GIB) / 100_000_000),
    );
    expect(downloadEntryEta(entry({}))).toBeNull();
    expect(downloadEntryEta(entry({ status: "failed", speedBps: 1, bytesDone: 1, bytesTotal: 2 }))).toBeNull();
  });

  it("formats eta scales", () => {
    expect(formatEta(45)).toBe("45s");
    expect(formatEta(60)).toBe("1:00");
    expect(formatEta(74)).toBe("1:14");
    expect(formatEta(13_540)).toBe("3h 45m");
  });
});

describe("downloadSpeedLabel", () => {
  it("keeps the network-convention buckets", () => {
    expect(downloadSpeedLabel(5_000_000)).toEqual({ label: "40 Mb/s", bucket: "slow" });
    expect(downloadSpeedLabel(250_000_000)).toEqual({ label: "2.0 Gb/s", bucket: "fast" });
  });
});

describe("downloadJobSummary", () => {
  it("renders one line per entry plus a total line", () => {
    const s = downloadJobSummary([
      entry({ name: "GLM", bytesDone: 0.5 * GIB, bytesTotal: 1 * GIB, speedBps: 50_000_000 }),
      entry({ id: "00000000-0000-4000-8000-000000000002", name: "DeepSeek", status: "pending" }),
      entry({
        id: "00000000-0000-4000-8000-000000000003",
        name: "Flint",
        status: "succeeded",
        bytesTotal: 2 * GIB,
        createdAt: "2026-10-22T00:00:00.000Z",
        updatedAt: "2026-10-22T00:04:00.000Z",
      }),
      entry({ id: "00000000-0000-4000-8000-000000000004", name: "Broken", status: "failed", error: "IO Error: Host is down (os error 112)" }),
    ]);
    const lines = s.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain("[1/4] ▸");
    expect(lines[0]).toContain("50%");
    expect(lines[0]).toContain("0.5 GiB / 1.0 GiB");
    expect(lines[0]).toContain("400 Mb/s");
    expect(lines[0]).toContain("eta 11s");
    expect(lines[1]).toContain("DeepSeek");
    expect(lines[1]).toContain("waiting");
    expect(lines[2]).toContain("2.0 GiB downloaded");
    expect(lines[2]).toContain("avg 72 Mb/s"); // 2 GiB over 240s
    expect(lines[3]).toContain("failed — IO Error: Host is down (os error 112)");
    expect(lines[4]).toContain("total");
    expect(lines[4]).toContain("2.5 GiB / 3.0 GiB");
    expect(lines[4]).toContain("400 Mb/s combined");
  });

  it("omits the total line for an empty batch", () => {
    expect(downloadJobSummary([])).toBe("");
  });
});
