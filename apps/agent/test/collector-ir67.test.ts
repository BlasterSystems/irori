import { describe, expect, it } from "vitest";
import { parseClocksCsv } from "../src/clocks.js";
import {
  blockRatesOf,
  networkRates,
  parseDmonBw,
  parseKernelJournal,
  resolveBlockDev,
} from "../src/collector.js";

/**
 * IRI-067 (IR-158) collector parsers: block-device stat deltas, dmon
 * bandwidth, journal Xid/OOM counters, link detail plumbing, and the clocks
 * CSV contract. Pure parsers — no filesystem or tool dependencies.
 */

describe("parseDmonBw (nvidia-smi dmon -s B)", () => {
  it("parses read/write MB/s from the last data row (sparkDash shape)", () => {
    // dmon -c 1 -d 1 -s B data row: gpu index, then read MB/s and write MB/s
    // in columns 2/3 (sparkDash-proven field order).
    const out = ["# gpu  fb  read  write", "  0   120  812.4   402.1"].join("\n");
    expect(parseDmonBw(out)).toEqual({ readBps: 812_400_000, writeBps: 402_100_000 });
  });

  it("ignores header rows and uses the LAST data row", () => {
    const out = ["# header", "0 1 10 5", "0 1 20 7"].join("\n");
    expect(parseDmonBw(out)).toEqual({ readBps: 20_000_000, writeBps: 7_000_000 });
  });

  it("returns null for garbage, truncated rows, and all-zero reads", () => {
    expect(parseDmonBw("")).toBeNull();
    expect(parseDmonBw("# only a header")).toBeNull();
    expect(parseDmonBw("0 1 2")).toBeNull();
    expect(parseDmonBw("0 1 x y")).toBeNull();
    expect(parseDmonBw("0 1 0 0")).toBeNull();
  });
});

describe("parseKernelJournal (Xid/OOM counters)", () => {
  it("counts Xid and OOM lines newest-first and dedupes across re-reads", () => {
    const seen = new Set<string>();
    const first = parseKernelJournal(
      [
        "1700000000.000 localhost kernel: NVRM: Xid (PCI:0000:07:00.0): 13, pid=1234, Graphics Exception",
        "1700000001.000 localhost kernel: Out of memory: Killed process 4321 (python) total-vm:1000kB",
        "1700000002.000 localhost kernel: usb 1-1: new high-speed USB device", // not counted
      ].join("\n"),
      seen,
    );
    expect(first.xidCount).toBe(1);
    expect(first.oomCount).toBe(1);
    expect(first.xidRecent[0]).toContain("Xid (PCI:0000:07:00.0): 13");
    expect(first.oomRecent[0]).toContain("Killed process 4321");

    // A refresh re-reads the whole boot journal: same lines must not inflate.
    const second = parseKernelJournal(
      [
        "1700000000.000 localhost kernel: NVRM: Xid (PCI:0000:07:00.0): 13, pid=1234, Graphics Exception",
        "1700000005.000 localhost kernel: NVRM: Xid (PCI:0000:07:00.0): 31, pid=999, Channel ID error",
      ].join("\n"),
      seen,
    );
    expect(second.xidCount).toBe(1); // only the NEW line
    expect(second.xidRecent[0]).toContain("31");
  });

  it("bounds the recent list at 20 and lines at 512 chars", () => {
    const seen = new Set<string>();
    const lines = Array.from({ length: 30 }, (_, i) => `17000000${String(i).padStart(3, "0")}.0 k: Xid (PCI:0000:07:00.0): ${i}, x`.repeat(10));
    const parsed = parseKernelJournal(lines.join("\n"), seen);
    expect(parsed.xidCount).toBe(30);
    expect(parsed.xidRecent).toHaveLength(20);
    expect(parsed.xidRecent[0]!.length).toBeLessThanOrEqual(512);
  });
});

describe("block device mapping and rates", () => {
  it("resolves mount devices to /sys/block entries (partition suffix stripped)", () => {
    const known = new Set(["nvme0n1", "sda", "mmcblk0"]);
    expect(resolveBlockDev("/dev/nvme0n1p2", known)).toBe("nvme0n1");
    expect(resolveBlockDev("/dev/sda2", known)).toBe("sda");
    expect(resolveBlockDev("/dev/mmcblk0p1", known)).toBe("mmcblk0");
    expect(resolveBlockDev("/dev/nvme0n1", known)).toBe("nvme0n1"); // whole disk
    expect(resolveBlockDev("/dev/sdz9", known)).toBeNull();
    expect(resolveBlockDev("tmpfs", known)).toBeNull();
  });

  it("computes byte rates from sector deltas (512 B/sector) over the window", () => {
    const rates = blockRatesOf({
      block0: new Map([["nvme0n1", { readSectors: 1000, writeSectors: 500 }]]),
      block1: new Map([["nvme0n1", { readSectors: 2000, writeSectors: 1000 }]]),
      dtMs: 1000,
    });
    expect(rates.get("nvme0n1")).toEqual({ readBps: 512_000, writeBps: 256_000 });
  });

  it("yields empty rates without both samples or a non-positive window", () => {
    expect(blockRatesOf({ block0: null, block1: null, dtMs: 1000 }).size).toBe(0);
    expect(
      blockRatesOf({
        block0: new Map([["sda", { readSectors: 1, writeSectors: 1 }]]),
        block1: new Map([["sda", { readSectors: 2, writeSectors: 2 }]]),
        dtMs: 0,
      }).size,
    ).toBe(0);
  });
});

describe("networkRates with link detail (IRI-067)", () => {
  it("attaches speed, operstate and addresses per interface", () => {
    const net0 = new Map([["eth0", { rx: 0, tx: 0 }], ["lo", { rx: 0, tx: 0 }]]);
    const net1 = new Map([["eth0", { rx: 1500, tx: 300 }], ["lo", { rx: 0, tx: 0 }]]);
    const link = new Map([["eth0", { speedMbps: 1000, operState: "up", addrs: ["10.20.30.4"] }]]);
    const rates = networkRates(net0, net1, 1000, link);
    expect(rates).toHaveLength(1); // lo skipped
    expect(rates[0]).toMatchObject({ iface: "eth0", rxBps: 1500, txBps: 300, speedMbps: 1000, operState: "up", addrs: ["10.20.30.4"] });
  });

  it("keeps nulls when no link detail is available (old shape)", () => {
    const rates = networkRates(new Map([["eth0", { rx: 0, tx: 0 }]]), new Map([["eth0", { rx: 10, tx: 10 }]]), 1000);
    expect(rates[0]?.speedMbps).toBeNull();
    expect(rates[0]?.operState).toBeNull();
    expect(rates[0]?.addrs).toEqual([]);
  });
});

describe("parseClocksCsv (agent clocks verb)", () => {
  it("parses the 7-field row set with [N/A] as null", () => {
    const csv = [
      "0, GB10, 1201, 2100, 2130, 9250, [N/A]",
      "1, GB10, 999, 2100, [N/A], [N/A], 1500",
    ].join("\n");
    const gpus = parseClocksCsv(csv);
    expect(gpus).toEqual([
      { index: 0, name: "GB10", smMHz: 1201, smMaxMHz: 2100, memMHz: 2130, memMaxMHz: 9250, smCapMHz: null },
      { index: 1, name: "GB10", smMHz: 999, smMaxMHz: 2100, memMHz: null, memMaxMHz: null, smCapMHz: 1500 },
    ]);
  });
});
