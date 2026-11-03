import { describe, expect, it } from "vitest";
import type { HardwareSnapshot } from "@irori/core";
import {
  computeDetailData,
  formatRate,
  rangeToGranularity,
} from "../src/detail-data";
import type { HistoryPoint, HistoryResponse } from "../src/api";

const GIB = 2 ** 30;

function point(overrides: Partial<HistoryPoint> = {}): HistoryPoint {
  return {
    t: 1_760_000_000_000,
    cpu: 18,
    cpuTemp: { min: 55, avg: 62, max: 71 },
    mem: 96 * GIB,
    gpu: 34,
    gpuTemp: { min: 58, avg: 61, max: 66 },
    gpuPowerW: 74,
    gpuMem: 42.1 * GIB,
    netRx: 184.4e6,
    netTx: 12e6,
    samples: 60,
    ...overrides,
  };
}

const SNAPSHOT: HardwareSnapshot = {
  schemaVersion: 1,
  agentVersion: "0.1.0",
  hostname: "spark2",
  transport: "ws",
  timestampMs: 1_760_000_000_000,
  cpu: { model: "GB10", cores: 20, usagePct: 18, tempC: 62, packagePowerW: 41 },
  memory: {
    totalBytes: 127 * GIB,
    usedBytes: 96 * GIB,
    swapTotalBytes: 8 * GIB,
    swapUsedBytes: 2 * GIB,
  },
  unifiedMemory: {
    poolBytes: 127 * GIB,
    availableBytes: 15 * GIB,
    gpuReservedBytes: 8 * GIB,
  },
  gpus: [
    {
      index: 0,
      name: "NVIDIA GB10",
      uuid: null,
      usagePct: 34,
      tempC: 61,
      memUsedBytes: Math.round(42.1 * GIB),
      memTotalBytes: 127 * GIB,
      powerW: 74,
      powerLimitW: null,
      smClockMHz: 2190,
      smClockMaxMHz: 3003,
      throttleReasons: [],
      processes: [],
    },
  ],
  storage: [],
  network: [],
  memoryBandwidth: null,
  kernel: null,
};

const HISTORY: HistoryResponse = {
  granularity: "hour",
  points: [point(), point({ t: 1_760_003_600_000, cpu: 22 })],
};

describe("rangeToGranularity", () => {
  it("maps every range to the server's bucket enum", () => {
    expect(rangeToGranularity("1h")).toBe("minute");
    expect(rangeToGranularity("24h")).toBe("hour");
    expect(rangeToGranularity("7d")).toBe("hour");
    expect(rangeToGranularity("30d")).toBe("hour");
    expect(rangeToGranularity("90d")).toBe("day");
  });
});

describe("formatRate", () => {
  it("scales SI units and drops nulls", () => {
    expect(formatRate(null)).toBeNull();
    expect(formatRate(0)).toBe("0.0 B/s");
    expect(formatRate(999)).toBe("999.0 B/s");
    expect(formatRate(1000)).toBe("1.0 KB/s");
    expect(formatRate(184.4e6)).toBe("184.4 MB/s");
    expect(formatRate(50e9)).toBe("50.0 GB/s");
  });
});

describe("computeDetailData", () => {
  it("uses the newest readable point for the current value and band", () => {
    const d = computeDetailData(SNAPSHOT, HISTORY, "24h");
    expect(d.hasHistory).toBe(true);
    expect(d.granularity).toBe("hour");
    expect(d.pointCount).toBe(2);
    expect(d.cpu.current).toBe("22%");
    expect(d.cpu.sub).toBe("min 55°C · avg 62°C · max 71°C");
    expect(d.cpu.series).toEqual([18, 22]);
  });

  it("shapes the memory panel from snapshot absolutes and history bytes", () => {
    const d = computeDetailData(SNAPSHOT, HISTORY, "24h");
    expect(d.memory.current).toBe("96.0 / 127.0 GB");
    expect(d.memory.sub).toBe("swap 2.0 / 8.0 GB");
    expect(d.memory.notes).toEqual([
      "unified memory · 127.0 GB pool · 15.0 GB available · 8.0 GB reserved",
    ]);
    expect(d.memory.series).toEqual([96 * GIB, 96 * GIB]);
  });

  it("shapes the gpu panel with band, power, gpu mem and clocks", () => {
    const d = computeDetailData(SNAPSHOT, HISTORY, "24h");
    expect(d.gpu.current).toBe("34%");
    expect(d.gpu.sub).toBe("min 58°C · avg 61°C · max 66°C · 74 W");
    expect(d.gpu.notes).toEqual([
      "gpu mem 42.1 GB",
      "sm 2,190 / 3,003 MHz",
    ]);
    expect(d.gpu.series).toEqual([34, 34]);
  });

  it("shapes the network panel with rx/tx series", () => {
    const d = computeDetailData(SNAPSHOT, HISTORY, "24h");
    expect(d.network.current).toBe("184.4 MB/s");
    expect(d.network.sub).toBe("12.0 MB/s");
    expect(d.network.series).toEqual([184.4e6, 184.4e6]);
    expect(d.network.series2).toEqual([12e6, 12e6]);
  });

  it("falls back to history bytes when the snapshot is absent", () => {
    const d = computeDetailData(null, HISTORY, "24h");
    expect(d.memory.current).toBe("96.0 GB");
    expect(d.memory.notes).toEqual([]); // unified pool is a snapshot fact
    expect(d.gpu.notes).toEqual(["gpu mem 42.1 GB"]); // gpu mem is a history fact
  });

  it("renders empty panels for a missing or empty history", () => {
    const empty: HistoryResponse = { granularity: "hour", points: [] };
    for (const history of [null, empty]) {
      const d = computeDetailData(SNAPSHOT, history, "1h");
      expect(d.hasHistory).toBe(false);
      for (const panel of [d.cpu, d.memory, d.gpu, d.network]) {
        expect(panel.current).toBe("");
        expect(panel.sub).toBeNull();
        expect(panel.notes).toEqual([]);
        expect(panel.series).toEqual([]);
      }
      expect(d.network.series2).toEqual([]);
    }
  });

  it("falls back to the range mapping only when history is absent", () => {
    expect(computeDetailData(SNAPSHOT, null, "1h").granularity).toBe("minute");
    expect(computeDetailData(SNAPSHOT, { granularity: "day", points: [] }, "1h").granularity).toBe("day");
  });

  it("keeps panels quiet when every value in the range is unreadable", () => {
    const d = computeDetailData(
      SNAPSHOT,
      {
        granularity: "hour",
        points: [
          point({ cpu: null, gpu: null, netRx: null, netTx: null }),
          point({ t: 2, cpu: null, gpu: null, netRx: null, netTx: null }),
        ],
      },
      "24h",
    );
    expect(d.cpu.current).toBe("");
    expect(d.gpu.current).toBe("");
    expect(d.network.current).toBe("");
    expect(d.network.sub).toBeNull();
    // memory still has a readable series (bytes are never null in these points)
    expect(d.memory.current).toBe("96.0 / 127.0 GB");
  });

  it("adds a cpu clock note from the live snapshot (IRI-034)", () => {
    const snapshot: HardwareSnapshot = {
      ...SNAPSHOT,
      cpu: { ...SNAPSHOT.cpu, perCoreClocksKHz: [1_800_000, 2_000_000] },
    };
    const d = computeDetailData(snapshot, HISTORY, "24h");
    expect(d.cpu.notes).toEqual(["cpu 2,000 MHz"]);
  });

  it("mirrors the gpu note shape when the agent reports max clocks (IRI-034)", () => {
    const snapshot: HardwareSnapshot = {
      ...SNAPSHOT,
      cpu: { ...SNAPSHOT.cpu, perCoreClocksKHz: [2_000_000], perCoreMaxClocksKHz: [2_000_000] },
    };
    const d = computeDetailData(snapshot, HISTORY, "24h");
    expect(d.cpu.notes).toEqual(["cpu 2,000 / 2,000 MHz"]);
  });

  it("keeps cpu notes empty without a live snapshot (IRI-034)", () => {
    const d = computeDetailData(null, HISTORY, "24h");
    expect(d.cpu.notes).toEqual([]);
  });
});
