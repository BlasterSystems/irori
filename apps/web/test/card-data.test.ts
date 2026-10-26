import { describe, expect, it } from "vitest";
import type { HardwareSnapshot, LlmPortSnapshot, NodeInfo } from "@irori/core";
import { computeCardData, isHotTemp } from "../src/card-data";

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
    llmPorts: [],
    nasRoot: null,
    cacheUser: null,
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

  it("formats cpu, memory and gpu rows in importance order (GPU → CPU → MEM → PKG)", () => {
    const card = computeCardData(nodeFixture(), SNAPSHOT);
    expect(card.hasSnapshot).toBe(true);
    expect(card.rows.map((r) => r.key)).toEqual(["gpu0", "cpu", "mem", "pkg"]);
    const [gpu, cpu, mem, pkg] = card.rows;
    expect(cpu?.line).toBe("18%");
    expect(cpu?.tempC).toBe(62);
    expect(mem?.line).toBe("96.0 / 127.0 GB");
    expect(mem?.barPct).toBeCloseTo((96 / 127) * 100);
    expect(gpu?.label).toBe("GPU0");
    expect(gpu?.line).toBe("NVIDIA GB10 · 34% · 74 W · 42.1 / 127.0 GB");
    expect(gpu?.tempC).toBe(61);
    expect(gpu?.barPct).toBe(34);
    // package power scaled against the documented GB10 SOC TDP (140 W)
    expect(pkg?.label).toBe("PKG");
    expect(pkg?.line).toBe("41 W");
    expect(pkg?.barPct).toBeCloseTo((41 / 140) * 100);
    expect(pkg?.tempC).toBeNull();
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
    const [gpu, cpu] = card.rows;
    expect(cpu?.line).toBe("");
    expect(cpu?.tempC).toBe(62);
    // memory is never nullable in the schema, so its line stays readable
    expect(card.rows[2]?.line).toBe("96.0 / 127.0 GB");
    // the gpu name is always readable — only the metric segments drop out
    expect(gpu?.line).toBe("NVIDIA GB10");
    expect(gpu?.tempC).toBeNull();
  });

  it("reports the waiting state when no snapshot has arrived", () => {
    const card = computeCardData(nodeFixture(), null);
    expect(card.hasSnapshot).toBe(false);
    expect(card.rows).toEqual([]);
    expect(card.agentVersion).toBe("0.1.0");
  });

  it("puts disk first on NAS cards, from the largest real mount", () => {
    const storage: HardwareSnapshot["storage"] = [
      { mount: "/", fs: "ext4", totalBytes: 21_171_355_648, usedBytes: 4_802_015_232 },
      { mount: "/mnt/nas", fs: "ext4", totalBytes: 18_108_599_115_776, usedBytes: 11_603_944_087_552 },
      { mount: "/mnt/llms", fs: "cifs", totalBytes: 18_108_599_115_776, usedBytes: 11_604_497_735_680 },
    ];
    const card = computeCardData(nodeFixture({ kind: "nas", role: "standalone" }), { ...SNAPSHOT, gpus: [], storage });
    expect(card.rows.map((r) => r.key)).toEqual(["disk", "mem", "cpu"]);
    expect(card.rows[0]?.label).toBe("DISK");
    expect(card.rows[0]?.line).toBe("11.6 TB / 18.1 TB");
    expect(card.rows[0]?.barPct).toBeCloseTo((11_603_944_087_552 / 18_108_599_115_776) * 100);
    expect(card.rows[0]?.freePct).toBeCloseTo(100 - (11_603_944_087_552 / 18_108_599_115_776) * 100);
  });

  it("shows the device disk on sparks, ignoring mounted volumes (IR-98)", () => {
    const storage: HardwareSnapshot["storage"] = [
      { mount: "/", fs: "ext4", totalBytes: 3_999_872_163_840, usedBytes: 3_599_884_947_456 },
      { mount: "/mnt/nas", fs: "nfs4", totalBytes: 18_108_599_115_776, usedBytes: 14_236_433_331_200 },
    ];
    const card = computeCardData(nodeFixture(), { ...SNAPSHOT, storage });
    const disk = card.rows.find((r) => r.key === "disk");
    // the 18.1 TB NAS share must not win the row — the root device does
    expect(disk?.line).toBe("3.6 TB / 4 TB");
    expect(disk?.barPct).toBeCloseTo((3_599_884_947_456 / 3_999_872_163_840) * 100);
    expect(disk?.freePct).toBeCloseTo(100 - (3_599_884_947_456 / 3_999_872_163_840) * 100);
    expect(disk?.warn).toBe(true); // 90 % — the row text still warns at the app tier
    // sparks surface package power + disk after MEM (overview mockup round 5)
    expect(card.rows.map((r) => r.key)).toEqual(["gpu0", "cpu", "mem", "pkg", "disk"]);
  });

  it("falls back to the largest mount when the snapshot has no / entry", () => {
    const storage: HardwareSnapshot["storage"] = [
      { mount: "/mnt/nas", fs: "nfs4", totalBytes: 18_108_599_115_776, usedBytes: 14_236_433_331_200 },
    ];
    const card = computeCardData(nodeFixture(), { ...SNAPSHOT, storage });
    expect(card.rows.find((r) => r.key === "disk")?.line).toBe("14.2 TB / 18.1 TB");
  });

  it("omits the disk row when a NAS has no readable storage", () => {
    const card = computeCardData(nodeFixture({ kind: "nas", role: "standalone" }), { ...SNAPSHOT, gpus: [] });
    expect(card.rows.map((r) => r.key)).toEqual(["mem", "cpu"]);
  });

  it("flags hot temps at the app-wide warn tier (70 °C)", () => {
    expect(isHotTemp(null)).toBe(false);
    expect(isHotTemp(69)).toBe(false);
    expect(isHotTemp(70)).toBe(true);
    expect(isHotTemp(91)).toBe(true);
  });

  it("warns when the disk mount is at or above 80 % usage", () => {
    const total = 18_108_599_115_776;
    const hot: HardwareSnapshot["storage"] = [{ mount: "/mnt/nas", fs: "ext4", totalBytes: total, usedBytes: 15_000_000_000_000 }];
    const cool: HardwareSnapshot["storage"] = [{ mount: "/mnt/nas", fs: "ext4", totalBytes: total, usedBytes: 11_603_944_087_552 }];
    const hotCard = computeCardData(nodeFixture({ kind: "nas", role: "standalone" }), { ...SNAPSHOT, gpus: [], storage: hot });
    const coolCard = computeCardData(nodeFixture({ kind: "nas", role: "standalone" }), { ...SNAPSHOT, gpus: [], storage: cool });
    expect(hotCard.rows[0]?.warn).toBe(true);
    expect(coolCard.rows[0]?.warn).toBe(false);
  });

  it("shows the inference summary line on head cards only", () => {
    const ports = [
      { port: 8000, host: "127.0.0.1", backend: "exl3", detected: true, model: "GLM", decodeTps: 142.3, prefillTps: null, queueRunning: null, queueWaiting: null, kvCachePct: null, ttftP95Ms: null, e2eP95Ms: null, itlP95Ms: null, engineMeta: null, probedAtMs: 1 },
      { port: 8001, host: "127.0.0.1", backend: "unknown", detected: false, model: null, decodeTps: null, prefillTps: null, queueRunning: null, queueWaiting: null, kvCachePct: null, ttftP95Ms: null, e2eP95Ms: null, itlP95Ms: null, engineMeta: null, probedAtMs: 1 },
    ] as LlmPortSnapshot[];
    const head = computeCardData(nodeFixture({ role: "head" }), SNAPSHOT, { ports });
    expect(head.inferenceLine).toBe(":8000 EXL3 · :8001 idle");

    const headWithoutProbes = computeCardData(nodeFixture({ role: "head" }), SNAPSHOT);
    expect(headWithoutProbes.inferenceLine).toBeNull();

    const worker = computeCardData(nodeFixture(), SNAPSHOT, { ports });
    expect(worker.inferenceLine).toBeNull();
  });
});
