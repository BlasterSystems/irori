import { describe, expect, it } from "vitest";
import { transferSummaryLine } from "../src/models";

const output = (lines: string[]) => lines.map((line, i) => ({ seq: i, line }));

describe("transferSummaryLine (IRI-051)", () => {
  it("returns null for multi-stream jobs (push) even with parsed progress", () => {
    const progress = { bytes: 1000, percent: 10, rateBytesPerSec: 500, etaSeconds: 60 };
    expect(transferSummaryLine("push", { jobs: 4 }, progress, [], 100_000)).toBeNull();
    expect(transferSummaryLine("push", { jobs: 4 }, null, output(["469.82M 0% 45.07MB/s 1:03:17"]), 100_000)).toBeNull();
  });

  it("summarizes hub-parsed progress for single-stream sync-local", () => {
    const line = transferSummaryLine(
      "sync-local",
      {},
      { bytes: 493_284_674, percent: 0.3, rateBytesPerSec: 45_070_000, etaSeconds: 3_797 },
      [],
      175_634_507_264,
    );
    expect(line).toContain("of 163.6 GiB");
    expect(line).toContain("0%");
    expect(line).toContain("Mb/s");
    expect(line).toContain("eta");
  });

  it("derives the percent from bytes against the model size when absent", () => {
    const line = transferSummaryLine("sync-local", {}, { bytes: 87_817_253_632, percent: null, rateBytesPerSec: null, etaSeconds: null }, [], 175_634_507_264);
    expect(line).toContain("50%");
  });

  it("falls back to the last parseable progress2 output line for pre-IR-131 rows", () => {
    const line = transferSummaryLine(
      "sync-local",
      {},
      null,
      output(["sync-local: transferring 92 files (163.65 GiB) to cache staging", "6.96K 0% 0.00kB/s 0:00:00", "469.82M 0% 45.07MB/s 1:03:17"]),
      null,
    );
    expect(line).toContain("0.5 GiB");
    expect(line).toContain("0%");
    expect(line).toContain("378 Mb/s");
    expect(line).toContain("eta 1h 03m");
  });

  it("returns null when nothing is parseable", () => {
    expect(transferSummaryLine("sync-local", {}, null, output(["starting up…"]), null)).toBeNull();
    expect(transferSummaryLine("sync-local", {}, null, [], null)).toBeNull();
  });

  it("respects a jobs param override on sync-local", () => {
    expect(transferSummaryLine("sync-local", { jobs: 4 }, { bytes: 1, percent: 1, rateBytesPerSec: null, etaSeconds: null }, [], null)).toBeNull();
  });
});
