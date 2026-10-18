import { describe, expect, it } from "vitest";
import type { LlmPortSnapshot, NodeInfo } from "@irori/core";
import {
  backendLabel,
  engineMetaRows,
  formatKvPct,
  formatMs,
  formatQueue,
  formatTps,
  groupNodes,
  kvBarPct,
  llmSummaryLine,
  nodeLlmPorts,
  shapeLlmPort,
} from "../src/llm-data";

function portFixture(overrides: Partial<LlmPortSnapshot> = {}): LlmPortSnapshot {
  return {
    port: 8000,
    host: "127.0.0.1",
    backend: "exl3",
    detected: true,
    model: "GLM-5.3-Flash-EXL3",
    decodeTps: 142.3,
    prefillTps: 3214,
    queueRunning: 3,
    queueWaiting: 12,
    kvCachePct: 78.4,
    ttftP95Ms: 84.2,
    e2eP95Ms: 1240,
    itlP95Ms: 18.4,
    engineMeta: null,
    probedAtMs: 1_760_000_000_000,
    ...overrides,
  };
}

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

describe("backend labels", () => {
  it("maps enum backends to display names", () => {
    expect(backendLabel("exl3")).toBe("EXL3");
    expect(backendLabel("vllm")).toBe("vLLM");
    expect(backendLabel("tensorfold")).toBe("TensorFold");
    expect(backendLabel("llama.cpp")).toBe("llama.cpp");
    expect(backendLabel("unknown")).toBe("unknown");
  });
});

describe("metric formatting", () => {
  it("formats tok/s with one decimal and thousands grouping", () => {
    expect(formatTps(null)).toBe("—");
    expect(formatTps(0)).toBe("0.0 tok/s");
    expect(formatTps(142.34)).toBe("142.3 tok/s");
    expect(formatTps(3214)).toBe("3,214.0 tok/s");
  });

  it("formats the queue as running · waiting, omitting null sides", () => {
    expect(formatQueue(3, 12)).toBe("3 running · 12 waiting");
    expect(formatQueue(0, 0)).toBe("0 running · 0 waiting");
    expect(formatQueue(3, null)).toBe("3 running");
    expect(formatQueue(null, 12)).toBe("12 waiting");
    expect(formatQueue(null, null)).toBe("—");
  });

  it("formats latencies and percentages, nulls as em dash", () => {
    expect(formatMs(null)).toBe("—");
    expect(formatMs(84.2)).toBe("84 ms");
    expect(formatKvPct(null)).toBe("—");
    expect(formatKvPct(78.4)).toBe("78%");
    expect(kvBarPct(null)).toBeNull();
    expect(kvBarPct(78.4)).toBe(78.4);
    expect(kvBarPct(140)).toBe(100);
    expect(kvBarPct(-5)).toBe(0);
  });
});

describe("engineMetaRows", () => {
  it("returns no rows for null/absent meta", () => {
    expect(engineMetaRows(null)).toEqual([]);
    expect(engineMetaRows(undefined)).toEqual([]);
  });

  it("flattens nested blocks one level and stringifies leaves", () => {
    const rows = engineMetaRows({
      live: { decode_tokens_per_second: 142.3, connections: 2 },
      backend: "tensorfold",
      cached_tokens_total: 12,
    });
    expect(rows).toEqual([
      { key: "live.decode_tokens_per_second", value: "142.3" },
      { key: "live.connections", value: "2" },
      { key: "backend", value: "tensorfold" },
      { key: "cached_tokens_total", value: "12" },
    ]);
  });

  it("renders arrays and booleans as JSON", () => {
    expect(engineMetaRows({ streams: { decoding: true }, ids: [1, 2] })).toEqual([
      { key: "streams.decoding", value: "true" },
      { key: "ids", value: "[1,2]" },
    ]);
  });
});

describe("shapeLlmPort", () => {
  it("shapes a detected port with rates, queue, kv and ttft", () => {
    const view = shapeLlmPort(portFixture(), 8000);
    expect(view).toMatchObject({
      header: ":8000",
      backendLabel: "EXL3",
      backendChipClass: "chip--ok",
      stateLabel: "detected",
      detected: true,
      model: "GLM-5.3-Flash-EXL3",
      decodeLine: "142.3 tok/s",
      prefillLine: "3,214.0 tok/s",
      queueLine: "3 running · 12 waiting",
      kvBarPct: 78.4,
      kvLine: "78%",
      ttftLine: "84 ms",
      engineMetaRows: [],
      detectOnly: false,
    });
  });

  it("shapes an idle port with muted chip and em dashes", () => {
    const view = shapeLlmPort(
      portFixture({
        detected: false,
        decodeTps: null,
        prefillTps: null,
        queueRunning: null,
        queueWaiting: null,
        kvCachePct: null,
        ttftP95Ms: null,
      }),
      8001,
    );
    expect(view.backendChipClass).toBe("chip--muted");
    expect(view.stateLabel).toBe("idle");
    expect(view.decodeLine).toBe("—");
    expect(view.prefillLine).toBe("—");
    expect(view.queueLine).toBe("—");
    expect(view.kvBarPct).toBeNull();
    expect(view.kvLine).toBe("—");
    expect(view.ttftLine).toBe("—");
  });

  it("renders the idle placeholder when no probe has answered yet", () => {
    const view = shapeLlmPort(null, 8001);
    expect(view.header).toBe(":8001");
    expect(view.backendLabel).toBe("unknown");
    expect(view.detected).toBe(false);
    expect(view.decodeLine).toBe("—");
  });

  it("propagates the detection-only flag for worker probes", () => {
    expect(shapeLlmPort(portFixture(), 8000, { detectOnly: true }).detectOnly).toBe(true);
    expect(shapeLlmPort(portFixture(), 8000).detectOnly).toBe(false);
  });

  it("exposes engine meta rows on the view", () => {
    const view = shapeLlmPort(
      portFixture({ engineMeta: { live: { decode_tokens_per_second: 142.3 } } }),
      8000,
    );
    expect(view.engineMetaRows).toEqual([
      { key: "live.decode_tokens_per_second", value: "142.3" },
    ]);
  });
});

describe("nodeLlmPorts", () => {
  it("returns [] when the registry payload omits llmPorts", () => {
    expect(nodeLlmPorts(nodeFixture())).toEqual([]);
  });

  it("keeps positive integers and drops the rest", () => {
    const node = {
      ...nodeFixture(),
      llmPorts: [8000, 8001, 0, -1, 8080.5, "x"],
    } as unknown as NodeInfo;
    expect(nodeLlmPorts(node)).toEqual([8000, 8001]);
  });
});

describe("groupNodes", () => {
  it("buckets heads, workers and standalone, sorted by sortOrder then name", () => {
    const headB = nodeFixture({ id: "00000000-0000-4000-8000-000000000002", name: "b", role: "head", sortOrder: 2 });
    const headA = nodeFixture({ id: "00000000-0000-4000-8000-000000000003", name: "a", role: "head", sortOrder: 2 });
    const worker = nodeFixture({ id: "00000000-0000-4000-8000-000000000004", name: "w", role: "worker", sortOrder: 1 });
    const solo = nodeFixture({ id: "00000000-0000-4000-8000-000000000005", name: "s", role: "standalone", sortOrder: 9 });

    const groups = groupNodes([headB, solo, headA, worker]);
    expect(groups.heads.map((n) => n.name)).toEqual(["a", "b"]);
    expect(groups.workers.map((n) => n.name)).toEqual(["w"]);
    expect(groups.standalone.map((n) => n.name)).toEqual(["s"]);
  });

  it("does not mutate the input array", () => {
    const input = [nodeFixture({ sortOrder: 5 }), nodeFixture({ id: "00000000-0000-4000-8000-000000000002", sortOrder: 1 })];
    groupNodes(input);
    expect(input[0]?.sortOrder).toBe(5);
  });
});

describe("llmSummaryLine", () => {
  it("joins ports with detected backends and idle markers", () => {
    const ports = [
      portFixture({ port: 8000 }),
      portFixture({ port: 8001, detected: false, backend: "llama.cpp" }),
    ];
    expect(llmSummaryLine(ports, [8000, 8001])).toBe(":8000 EXL3 · :8001 idle");
  });

  it("lists configured ports bare when no probe has arrived", () => {
    expect(llmSummaryLine(null, [8000, 8001])).toBe(":8000 · :8001");
  });

  it("appends hot-added ports missing from the registry", () => {
    const ports = [portFixture({ port: 8081, backend: "tensorfold" })];
    expect(llmSummaryLine(ports, [])).toBe(":8081 TensorFold");
    expect(llmSummaryLine(ports, [8000])).toBe(":8000 · :8081 TensorFold");
  });

  it("returns null when there is nothing to show", () => {
    expect(llmSummaryLine([], [])).toBeNull();
  });
});
