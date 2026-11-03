import { describe, expect, it } from "vitest";
import { agentMsgSchema, hardwareSnapshotSchema, nodeCreateSchema, sseEventSchema, jobKindSchema, AGENT_UPDATE_MIN_VERSION } from "../src/index.ts";
import { compareVersions, isAgentSupported } from "../src/version.ts";

const validSnapshot = {
  schemaVersion: 1,
  agentVersion: "0.1.0",
  hostname: "spark1",
  transport: "ws",
  timestampMs: 1792252541000,
  cpu: { model: "Grace Blackwell GB10", cores: 20, usagePct: 12.5, tempC: null, packagePowerW: null },
  memory: { totalBytes: 128 * 1024 ** 3, usedBytes: 32 * 1024 ** 3, swapTotalBytes: null, swapUsedBytes: null },
  unifiedMemory: null,
  storage: [],
  network: [],
  gpus: [
    {
      index: 0,
      name: "NVIDIA GB10",
      uuid: null,
      usagePct: 0,
      tempC: 41,
      memUsedBytes: 81 * 1024 ** 3,
      memTotalBytes: 96 * 1024 ** 3,
      powerW: null,
      powerLimitW: null,
      smClockMHz: null,
      smClockMaxMHz: null,
      throttleReasons: [],
      processes: [],
    },
  ],
};

describe("hardwareSnapshotSchema", () => {
  it("accepts a full snapshot", () => {
    const s = hardwareSnapshotSchema.parse(validSnapshot);
    expect(s.gpus[0]?.name).toBe("NVIDIA GB10");
  });

  it("IRI-067: accepts OLD-agent snapshots (no new fields) and fills defaults", () => {
    const s = hardwareSnapshotSchema.parse(validSnapshot);
    expect(s.memoryBandwidth).toBeNull();
    expect(s.kernel).toBeNull();
    expect(s.storage).toEqual([]);
    expect(s.network).toEqual([]);
  });

  it("IRI-067: accepts snapshots carrying the new telemetry domains", () => {
    const s = hardwareSnapshotSchema.parse({
      ...validSnapshot,
      memoryBandwidth: { readBps: 812_400_000, writeBps: 402_100_000, sampledAtMs: 1792252541000 },
      kernel: { xidCount: 2, xidRecent: ["NVRM: Xid (PCI:0000:07:00.0): 13"], oomCount: 1, oomRecent: ["Out of memory: Killed process 4321"] },
      storage: [{ mount: "/", fs: "ext4", totalBytes: 4e12, usedBytes: 1e12, readBps: 512_000, writeBps: 256_000, device: "nvme0n1" }],
      network: [{ iface: "eth0", rxBps: 1500, txBps: 300, speedMbps: 10000, operState: "up", addrs: ["10.20.30.4"] }],
    });
    expect(s.memoryBandwidth?.readBps).toBe(812_400_000);
    expect(s.kernel?.xidCount).toBe(2);
    expect(s.storage[0]?.device).toBe("nvme0n1");
    expect(s.network[0]?.speedMbps).toBe(10000);
  });

  it("strips unknown fields (tolerant readers)", () => {
    const s = hardwareSnapshotSchema.parse({ ...validSnapshot, futureField: 1 });
    expect("futureField" in s).toBe(false);
  });

  it("rejects missing required groups", () => {
    expect(() => hardwareSnapshotSchema.parse({ ...validSnapshot, memory: undefined })).toThrow();
  });
});

describe("agent messages", () => {
  it("parses a hello", () => {
    expect(
      agentMsgSchema.parse({ type: "hello", schemaVersion: 1, agentVersion: "0.1.0", token: "t", hostname: "h" }),
    ).toMatchObject({ type: "hello" });
  });

  it("parses a snapshot envelope", () => {
    expect(agentMsgSchema.parse({ type: "snapshot", snapshot: validSnapshot })).toMatchObject({ type: "snapshot" });
  });
});

describe("sse events", () => {
  it("parses snapshot + status + heartbeat", () => {
    expect(sseEventSchema.parse({ type: "snapshot", serverTimeMs: 1, nodeId: crypto.randomUUID(), snapshot: validSnapshot })).toMatchObject({ type: "snapshot" });
    expect(sseEventSchema.parse({ type: "node-online", serverTimeMs: 1, nodeId: crypto.randomUUID(), agentVersion: "0.1.0" })).toMatchObject({ type: "node-online" });
    expect(sseEventSchema.parse({ type: "heartbeat", serverTimeMs: 1 })).toMatchObject({ type: "heartbeat" });
  });
});

describe("nodeCreateSchema", () => {
  it("defaults enabled and rejects bad kinds", () => {
    const parsed = nodeCreateSchema.parse({ name: "spark1", kind: "spark", role: "head", host: "spark1.lan" });
    expect("enabled" in parsed).toBe(false);
    expect(() => nodeCreateSchema.parse({ name: "x", kind: "minisforum", role: "head", host: "h" })).toThrow();
  });
});

describe("version gate", () => {
  it("orders versions", () => {
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("0.2.0", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("0.1.0", "1.0.0")).toBeLessThan(0);
  });
  it("gates the minimum agent", () => {
    expect(isAgentSupported("0.1.0")).toBe(true);
    expect(isAgentSupported("0.0.9")).toBe(false);
  });

  it("accepts the agent-update job kind (IRI-012)", () => {
    expect(jobKindSchema.parse("agent-update")).toBe("agent-update");
    expect(AGENT_UPDATE_MIN_VERSION).toBe("0.3.0");
  });
});
