import { describe, expect, it } from "vitest";
import { renderPrometheus, type MetricsNode } from "../src/metrics.js";
import { loadConfig } from "../src/config.js";
import { DEFAULT_BODY_RETENTION } from "../src/usage-retention.js";

/**
 * IRI-084: unit tier for previously-untested pure modules — the /metrics
 * exposition, env config parsing and the body-retention defaults.
 */

const node = (over: Partial<MetricsNode> = {}): MetricsNode => ({
  id: "11111111-1111-1111-1111-111111111111",
  name: "dgx1",
  online: true,
  snapshot: {
    cpu: { usagePct: 12.5 },
    memory: { totalBytes: 1000, usedBytes: 500 },
    storage: [{ mount: "/", totalBytes: 2000, usedBytes: 1000 }],
    gpus: [{ index: 0, name: "GB10", utilPct: 40, memTotalBytes: 100, memUsedBytes: 50, tempC: 55, powerW: 90 }],
    ts: 1_700_000_000_000,
  } as MetricsNode["snapshot"],
  ...over,
});

describe("renderPrometheus", () => {
  it("renders base-unit families with label escaping", () => {
    const out = renderPrometheus([node(), node({ name: 'weird"node', online: false, snapshot: null })]);
    expect(out).toContain('irori_up 1');
    expect(out).toContain('irori_node_online{node="dgx1"} 1');
    expect(out).toContain('irori_node_online{node="weird\\"node"} 0');
    expect(out).toContain('irori_node_gpu_temp_celsius');
    expect(out).toContain('irori_node_gpu_power_watts{node="dgx1",gpu="0"} 90');
    expect(out).toContain('irori_node_memory_used_bytes{node="dgx1"} 500');
    expect(out).toContain('irori_node_storage_used_bytes');
  });

  it("escapes backslashes and newlines in label values", () => {
    const out = renderPrometheus([node({ name: "a\\b\nc\"d" })]);
    expect(out).toContain('node="a\\\\b\\nc\\"d"');
  });

  it("omits sample families when no node carries a snapshot", () => {
    const out = renderPrometheus([node({ snapshot: null })]);
    expect(out).not.toContain("irori_node_gpu_power_watts{");
  });
});

describe("loadConfig", () => {
  it("defaults are safe without env", () => {
    const cfg = loadConfig({});
    expect(cfg.databaseUrl).toBeNull();
    expect(cfg.cadenceMs).toBeGreaterThanOrEqual(1000);
    expect(cfg.port).toBeGreaterThan(0);
  });

  it("parses DATABASE_URL, PORT and cadence overrides", () => {
    const cfg = loadConfig({ DATABASE_URL: "postgres://x", ENCRYPTION_KEY: "k".repeat(32), PORT: "9999", CADENCE_MS: "2500" });
    expect(cfg.databaseUrl).toBe("postgres://x");
    expect(cfg.port).toBe(9999);
    expect(cfg.cadenceMs).toBe(2500);
  });

  it("requires ENCRYPTION_KEY when a database is configured (ADR-0002)", () => {
    expect(() => loadConfig({ DATABASE_URL: "postgres://x" })).toThrow(/ENCRYPTION_KEY/);
  });

  it("clamps cadence to the 1-60 s window", () => {
    expect(loadConfig({ CADENCE_MS: "5" }).cadenceMs).toBeGreaterThanOrEqual(1000);
    expect(loadConfig({ CADENCE_MS: "999999" }).cadenceMs).toBeLessThanOrEqual(60_000);
  });
});

describe("body retention defaults", () => {
  it("caps are generous but bounded (IR-52 contract)", () => {
    expect(DEFAULT_BODY_RETENTION.bodyCapBytes).toBe(16 * 1024 * 1024);
    expect(DEFAULT_BODY_RETENTION.partCapBytes).toBe(4 * 1024 * 1024);
  });
});
