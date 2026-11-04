import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { clocksGetResultMsgSchema, clocksSetMsgSchema, nodeInfoSchema } from "../src/index.js";

/**
 * IRI-124: the clocks wire contract. The CPU half must be additive — an old
 * agent (no cpu support) and an old hub (smMaxMHz only) both have to keep
 * parsing, which is what the optional/absent-field cases pin here.
 */

const id = randomUUID();

describe("clocks-set frame", () => {
  it("accepts a GPU-only cap (the pre-IRI-124 shape)", () => {
    const parsed = clocksSetMsgSchema.parse({ type: "clocks-set", id, smMaxMHz: 2000 });
    expect(parsed.smMaxMHz).toBe(2000);
    expect(parsed.cpuMaxMHz).toBeUndefined();
  });

  it("accepts a CPU-only cap without touching the GPU side", () => {
    const parsed = clocksSetMsgSchema.parse({ type: "clocks-set", id, cpuMaxMHz: 1400, persist: true });
    expect(parsed.cpuMaxMHz).toBe(1400);
    expect(parsed.smMaxMHz).toBeUndefined();
    expect(parsed.persist).toBe(true);
  });

  it("carries both caps and a null clear in one frame", () => {
    const parsed = clocksSetMsgSchema.parse({ type: "clocks-set", id, smMaxMHz: null, cpuMaxMHz: 2800 });
    expect(parsed.smMaxMHz).toBeNull();
    expect(parsed.cpuMaxMHz).toBe(2800);
  });

  it("rejects a zero or negative CPU cap", () => {
    expect(clocksSetMsgSchema.safeParse({ type: "clocks-set", id, cpuMaxMHz: 0 }).success).toBe(false);
    expect(clocksSetMsgSchema.safeParse({ type: "clocks-set", id, cpuMaxMHz: -1 }).success).toBe(false);
  });
});

describe("clocks-get-result frame", () => {
  it("parses the CPU block with per-cluster policies", () => {
    const parsed = clocksGetResultMsgSchema.parse({
      type: "clocks-get-result",
      id,
      ok: true,
      gpus: [],
      cpu: {
        capMHz: 2000,
        policies: [
          { cpus: [0, 1, 2, 3, 4, 10, 11, 12, 13, 14], minKHz: 338_000, maxKHz: 2_808_000, curMaxKHz: 2_000_000 },
          { cpus: [5, 6, 7, 8, 9, 15, 16, 17, 18, 19], minKHz: 1_378_000, maxKHz: 3_900_000, curMaxKHz: 2_000_000 },
        ],
      },
      error: null,
    });
    expect(parsed.cpu?.policies).toHaveLength(2);
    expect(parsed.cpu?.policies[0]?.maxKHz).toBe(2_808_000);
  });

  it("stays optional so an old agent's reply parses", () => {
    const parsed = clocksGetResultMsgSchema.parse({ type: "clocks-get-result", id, ok: true, gpus: [], error: null });
    expect(parsed.cpu).toBeUndefined();
  });

  it("distinguishes 'no cpufreq here' (null) from 'agent predates it' (absent)", () => {
    const parsed = clocksGetResultMsgSchema.parse({ type: "clocks-get-result", id, ok: true, gpus: [], cpu: null, error: null });
    expect(parsed.cpu).toBeNull();
  });
});

describe("node clock-cap fields", () => {
  const base = {
    id,
    name: "dgx1",
    kind: "spark",
    role: "head",
    host: "10.0.10.4",
    enabled: true,
    agentVersion: null,
    online: false,
    lastSeenAt: null,
    sortOrder: 0,
    createdAt: "2026-11-04T00:00:00.000Z",
    updatedAt: "2026-11-04T00:00:00.000Z",
  };

  it("defaults both caps to none and non-persistent", () => {
    const parsed = nodeInfoSchema.parse(base);
    expect(parsed.cpuClockCapMHz).toBeNull();
    expect(parsed.cpuClockCapPersistent).toBe(false);
    expect(parsed.gpuClockCapMHz).toBeNull();
  });
});
