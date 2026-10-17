import { describe, expect, it } from "vitest";
import type { HardwareSnapshot, NodeInfo } from "@irori/core";
import { computeCardData } from "../src/card-data";

const GIB = 2 ** 30;

function nodeFixture(overrides: Partial<NodeInfo> = {}): NodeInfo {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    name: "spark2",
    kind: "spark",
    role: "worker",
    host: "10.50.50.21",
    enabled: true,
    agentVersion: "0.1.0",
    online: true,
    lastSeenAt: null,
    sortOrder: 1,
    createdAt: "2026-10-16T09:00:00.000Z",
    updatedAt: "2026-10-17T12:00:00.000Z",
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
    swapTotalBytes: null,
    swapUsedBytes: null,
  },
  unifiedMemory: null,
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
      smClockMHz: null,
      smClockMaxMHz: null,
      throttleReasons: [],
      processes: [],
    },
  ],
  storage: [],
  network: [],
};

describe("computeCardData", () => {
  it("uses the DS dot vocabulary: open circle online, halt offline", () => {
    const online = computeCardData(nodeFixture(), SNAPSHOT);
    expect(online.dotClass).toBe("dot dot--run");
    expect(online.statusText).toBe("online");

    const offline = computeCardData(nodeFixture({ online: false }), SNAPSHOT);
    expect(offline.dotClass).toBe("dot dot--halt");
    expect(offline.statusText).toBe("offline");
  });

  it("formats cpu, memory and gpu lines from the snapshot", () => {
    const card = computeCardData(nodeFixture(), SNAPSHOT);
    expect(card.hasSnapshot).toBe(true);
    expect(card.cpuLine).toBe("18% · 62°C");
    expect(card.memLine).toBe("96.0 / 127.0 GB");
    expect(card.memBarPct).toBeCloseTo((96 / 127) * 100);
    expect(card.gpus).toHaveLength(1);
    expect(card.gpus[0]?.name).toBe("NVIDIA GB10");
    expect(card.gpus[0]?.line).toBe("34% · 61°C · 42.1 / 127.0 GB");
    expect(card.gpus[0]?.barPct).toBe(34);
  });

  it("omits unreadable segments instead of printing nulls", () => {
    const partial: HardwareSnapshot = {
      ...SNAPSHOT,
      cpu: { model: "GB10", cores: 20, usagePct: null, tempC: 62, packagePowerW: null },
      gpus: [
        { index: 0, name: "NVIDIA GB10", uuid: null, usagePct: null, tempC: null, memUsedBytes: null, memTotalBytes: null, powerW: null, powerLimitW: null, smClockMHz: null, smClockMaxMHz: null, throttleReasons: [], processes: [] },
      ],
    };
    const card = computeCardData(nodeFixture(), partial);
    expect(card.cpuLine).toBe("62°C");
    // memory is never nullable in the schema, so its line stays readable
    expect(card.memLine).toBe("96.0 / 127.0 GB");
    expect(card.gpus[0]?.line).toBe("");
  });

  it("reports the waiting state when no snapshot has arrived", () => {
    const card = computeCardData(nodeFixture(), null);
    expect(card.hasSnapshot).toBe(false);
    expect(card.cpuLine).toBe("");
    expect(card.gpus).toEqual([]);
    expect(card.agentVersion).toBe("0.1.0");
  });
});
