// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { hardwareSnapshotSchema, llmPortSnapshotSchema, nodeInfoSchema, SCHEMA_VERSION } from "@irori/core";

/**
 * IRI-084: NodeDetail shaped-data tier — the node/snapshot/llm live maps are
 * seeded (schema-parsed fixtures) so the card data, power, clocks, models
 * and LLM sections render; inventory/versions/updates/health stubs settle.
 */

vi.mock("../src/live", async () => ({ live: (await import("./live-mock")).liveMock }));
vi.mock("../src/scrim", () => ({ vScrimClose: {} }));

afterEach(() => vi.unstubAllGlobals());

const UUID = "11111111-1111-4111-8111-111111111111";

const node = nodeInfoSchema.parse({
  id: UUID,
  name: "DGX-1",
  kind: "spark",
  role: "head",
  host: "dgx1.lan",
  enabled: true,
  agentVersion: "0.4.0",
  online: true,
  lastSeenAt: new Date().toISOString(),
  sortOrder: 0,
  llmPorts: [8081],
  nasRoot: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const snapshot = hardwareSnapshotSchema.parse({
  schemaVersion: SCHEMA_VERSION,
  agentVersion: "0.4.0",
  hostname: "dgx1",
  transport: "ws",
  timestampMs: Date.now(),
  cpu: { model: "GB10 SoC", cores: 20, usagePct: 12.5, tempC: 45, packagePowerW: 30 },
  memory: { totalBytes: 128e9, usedBytes: 64e9, swapTotalBytes: null, swapUsedBytes: null },
  unifiedMemory: null,
  storage: [{ mount: "/", fs: "ext4", totalBytes: 3.8e12, usedBytes: 1.9e12, readBytesPerSec: null, writeBytesPerSec: null }],
  network: [],
  memoryBandwidth: null,
  kernel: null,
  gpus: [
    { index: 0, name: "GB10", uuid: null, usagePct: 30, tempC: 55, memUsedBytes: 1e9, memTotalBytes: 120e9, powerW: 40, powerLimitW: null, smClockMHz: null, smClockMaxMHz: null, throttleReasons: [], processes: [] },
  ],
});

const llm = { ports: [llmPortSnapshotSchema.parse({ port: 8081, backend: "tensorfold", probedAtMs: Date.now(), detected: true, model: "GLM-5.3-Flash-EXL3", kvCachePct: 99, decodeTps: 42.5, queueRunning: 2, queueWaiting: 0 })], ts: Date.now() };

const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  let body: unknown = {};
  if (url.includes("/inventory")) body = { report: null, updatedAt: new Date().toISOString() };
  else if (url.includes("/versions")) body = { agentVersion: "0.4.0", pin: null, versions: null, drift: [], updatedAt: new Date().toISOString() };
  else if (url.includes("/api/v1/updates")) body = { baseline: null, nodes: [] };
  else if (url.includes("/health/findings")) body = { findings: [] };
  else if (url.includes("/cleanup")) body = { categories: [], running: false, prevention: null };
  else if (url.includes("/api/v1/llm")) body = {};
  else if ([ "/setups", "/nodes", "/jobs", "/quants", "/api/v1/bench" ].some((e) => url.includes(e))) body = [];
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
});

describe("NodeDetail shaped-data tier", () => {
  it("renders the node cards from live maps (compute, storage, LLM ports)", async () => {
    const { liveMock } = await import("./live-mock");
    (liveMock.nodes as Map<string, unknown>).set(UUID, node);
    (liveMock.snapshots as Map<string, unknown>).set(UUID, snapshot);
    (liveMock as unknown as { llm: Map<string, unknown> }).llm = new Map([[UUID, llm]]);
    vi.stubGlobal("fetch", fetchStub);
    const { default: NodeDetail } = await import("../src/components/NodeDetail.vue");
    const w = mount(NodeDetail as never, { props: { nodeId: UUID } } as never);
    await new Promise((r) => setTimeout(r, 120));
    const text = w.text();
    expect(text).toContain("DGX-1");
    expect(text).toContain("GB10 · 30%"); // GPU card from the snapshot
    expect(text).toContain("1.9 TB / 3.8 TB"); // disk
    expect(text).toContain("TensorFold"); // LLM probe backend
    expect(text).toContain("GLM-5.3-Flash-EXL3");
    expect(text).toContain("KV cache");
    w.unmount();
  });
});
