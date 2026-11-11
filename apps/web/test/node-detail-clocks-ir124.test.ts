// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { hardwareSnapshotSchema, nodeInfoSchema, SCHEMA_VERSION } from "@irori/core";

/**
 * IRI-124: the node page's clock-cap tier — GPU presets (with a non-preset
 * current option), the CPU select with its effective per-cluster line, and
 * the temperature overlay on the history cards. Mounts the real component
 * over the live-store fake; every fetch is stubbed.
 */

vi.mock("../src/live", async () => ({ live: (await import("./live-mock")).liveMock }));
vi.mock("../src/scrim", () => ({ vScrimClose: {} }));

afterEach(() => vi.unstubAllGlobals());

const UUID = "22222222-2222-4222-8222-222222222222";

const node = nodeInfoSchema.parse({
  id: UUID,
  name: "DGX-1",
  kind: "spark",
  role: "head",
  host: "dgx1.as267.com",
  enabled: true,
  agentVersion: "0.6.0",
  online: true,
  lastSeenAt: new Date().toISOString(),
  sortOrder: 0,
  llmPorts: [],
  nasRoot: null,
  gpuClockCapMHz: 2400, // not a preset → must appear as the current option
  gpuClockCapPersistent: true,
  cpuClockCapMHz: 2000,
  cpuClockCapPersistent: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const snapshot = hardwareSnapshotSchema.parse({
  schemaVersion: SCHEMA_VERSION,
  agentVersion: "0.6.0",
  hostname: "dgx1",
  transport: "ws",
  timestampMs: Date.now(),
  cpu: {
    model: "GB10 SoC",
    cores: 20,
    usagePct: 7,
    tempC: 45,
    packagePowerW: 30,
    perCoreClocksKHz: Array.from({ length: 20 }, () => 2_000_000),
    perCoreMaxClocksKHz: Array.from({ length: 20 }, () => 2_000_000),
  },
  memory: { totalBytes: 128e9, usedBytes: 6e9, swapTotalBytes: null, swapUsedBytes: null },
  unifiedMemory: null,
  storage: [{ mount: "/", fs: "ext4", totalBytes: 3.8e12, usedBytes: 1.9e12 }],
  network: [
    {
      iface: "enP7s7",
      rxBps: 37_600,
      txBps: 20_400,
      speedMbps: 1000,
      operState: "up",
      addrs: [
        "10.0.10.4",
        "fdd3:cc60:6821:4395:929:f8cc:acdf:5346",
        "fdd3:cc60:6821:4395:7983:6860:ade:7da7",
        "fdd3:cc60:6821:4395:e2f8:57c8:af66:2dd0",
        "fe80::f8d0:3402:ec11:f64c",
      ],
    },
  ],
  memoryBandwidth: null,
  kernel: null,
  gpus: [
    { index: 0, name: "GB10", uuid: null, usagePct: 12, tempC: 43, memUsedBytes: 1e9, memTotalBytes: 120e9, powerW: 8, powerLimitW: null, smClockMHz: 214, smClockMaxMHz: 3003, throttleReasons: [], processes: [] },
  ],
});

const history = {
  granularity: "hour",
  points: [
    { t: Date.now() - 3_600_000, cpu: 6, cpuTemp: { min: 44, avg: 45, max: 46 }, mem: 6e9, gpu: 9, gpuTemp: { min: 42, avg: 43, max: 44 }, gpuPowerW: 8, gpuMem: 1e9, netRx: 1e5, netTx: 5e4, samples: 60 },
    { t: Date.now(), cpu: 7, cpuTemp: { min: 45, avg: 45, max: 46 }, mem: 6e9, gpu: 12, gpuTemp: { min: 42, avg: 43, max: 43 }, gpuPowerW: 8, gpuMem: 1e9, netRx: 1e5, netTx: 5e4, samples: 60 },
  ],
};

const cpuClocks = {
  gpus: [{ index: 0, name: "GB10", smMHz: 214, smMaxMHz: 3003, memMHz: null, memMaxMHz: null, smCapMHz: 2400 }],
  cpu: {
    capMHz: 2000,
    policies: [
      { cpus: [0, 1, 2, 3, 4, 10, 11, 12, 13, 14], minKHz: 338_000, maxKHz: 2_808_000, curMaxKHz: 2_000_000 },
      { cpus: [5, 6, 7, 8, 9, 15, 16, 17, 18, 19], minKHz: 1_378_000, maxKHz: 3_900_000, curMaxKHz: 2_000_000 },
    ],
  },
};

const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  let body: unknown = {};
  if (url.includes("/history")) body = history;
  else if (url.endsWith("/clocks")) body = cpuClocks;
  else if (url.includes("/inventory")) body = { report: null, updatedAt: new Date().toISOString() };
  else if (url.includes("/versions")) body = { agentVersion: "0.6.0", pin: null, versions: null, drift: [], updatedAt: new Date().toISOString() };
  else if (url.includes("/api/v1/updates")) body = { baseline: null, nodes: [] };
  else if (url.includes("/health/findings")) body = { findings: [] };
  else if (url.includes("/cleanup")) body = { categories: [], running: false, prevention: null };
  else if (url.includes("/api/v1/llm")) body = {};
  else if (["/setups", "/nodes", "/jobs", "/quants", "/api/v1/bench"].some((e) => url.includes(e))) body = [];
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
});

describe("NodeDetail clock caps + temperature overlay (IRI-124)", () => {
  it("renders GPU presets with the stored non-preset cap as current", async () => {
    const { liveMock } = await import("./live-mock");
    (liveMock.nodes as Map<string, unknown>).set(UUID, node);
    (liveMock.snapshots as Map<string, unknown>).set(UUID, snapshot);
    vi.stubGlobal("fetch", fetchStub);
    const { default: NodeDetail } = await import("../src/components/NodeDetail.vue");
    const w = mount(NodeDetail as never, { props: { nodeId: UUID } } as never);
    // Deterministic wait: the selects render once the clocks fetch resolves.
    await vi.waitFor(() => expect(w.findAll("select").length).toBeGreaterThanOrEqual(2), { timeout: 10_000 });

    const selects = w.findAll("select");
    const gpuSelect = selects.find((s) => s.attributes("aria-label") === "GPU SM clock cap in MHz")!;
    expect(gpuSelect).toBeTruthy();
    const gpuOptions = gpuSelect.findAll("option").map((o) => o.text());
    expect(gpuOptions).toEqual(["pick a cap", "1800 MHz", "2000 MHz", "2200 MHz", "3000 MHz", "2400 MHz (current)"]);

    const cpuSelect = selects.find((s) => s.attributes("aria-label") === "CPU clock cap in MHz")!;
    expect(cpuSelect).toBeTruthy();
    expect(cpuSelect.findAll("option").map((o) => o.text())).toEqual(["pick a cap", "1400 MHz", "2000 MHz", "2800 MHz"]);
    expect(w.text()).toContain("effective 10 cores 2,000 MHz · 10 cores 2,000 MHz");
    expect(w.text()).toContain("keep after reboot");
    // IRI-124: interface rows carry the wrap-capable variant; the long IPv6
    // list is fully present (no truncation).
    const netRows = w.findAll(".barrow--net");
    expect(netRows).toHaveLength(1);
    expect(netRows[0]!.find(".val").text()).toContain("fe80::f8d0:3402:ec11:f64c");
    expect(netRows.at(-1)!.text()).toContain("fe80::f8d0:3402:ec11:f64c");
    w.unmount();
  });

  it("draws the temperature overlay and legend on the CPU and GPU charts", async () => {
    const { liveMock } = await import("./live-mock");
    (liveMock.nodes as Map<string, unknown>).set(UUID, node);
    (liveMock.snapshots as Map<string, unknown>).set(UUID, snapshot);
    vi.stubGlobal("fetch", fetchStub);
    const { default: NodeDetail } = await import("../src/components/NodeDetail.vue");
    const w = mount(NodeDetail as never, { props: { nodeId: UUID } } as never);
    // Deterministic wait: the overlay copy renders once the clocks fetch lands.
    await vi.waitFor(() => expect(w.text()).toContain("min 45°C · avg 45°C · max 46°C"), { timeout: 10_000 });

    const text = w.text();
    expect(text).toContain("usage");
    expect(text).toContain("temp °C");
    // The CPU card head shows the utilisation headline; the band stays as sub.
    expect(text).toContain("min 45°C · avg 45°C · max 46°C");
    w.unmount();
  });

  it("distinguishes a cpufreq-less platform from an old agent", async () => {
    const { liveMock } = await import("./live-mock");
    (liveMock.nodes as Map<string, unknown>).set(UUID, node);
    (liveMock.snapshots as Map<string, unknown>).set(UUID, snapshot);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      let body: unknown = {};
      // cpu: null = the agent CAN cap clocks, this box just has no cpufreq.
      if (url.endsWith("/clocks")) body = { gpus: [], cpu: null };
      else if (url.includes("/history")) body = history;
      else if (url.includes("/inventory")) body = { report: null, updatedAt: new Date().toISOString() };
      else if (url.includes("/versions")) body = { agentVersion: "0.6.0", pin: null, versions: null, drift: [], updatedAt: new Date().toISOString() };
      else if (url.includes("/api/v1/updates")) body = { baseline: null, nodes: [] };
      else if (url.includes("/health/findings")) body = { findings: [] };
      else if (url.includes("/cleanup")) body = { categories: [], running: false, prevention: null };
      else if (url.includes("/api/v1/llm")) body = {};
      else if (["/setups", "/nodes", "/jobs", "/quants", "/api/v1/bench"].some((e) => url.includes(e))) body = [];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const { default: NodeDetail } = await import("../src/components/NodeDetail.vue");
    const w = mount(NodeDetail as never, { props: { nodeId: UUID } } as never);
    await vi.waitFor(() => expect(w.text()).toContain("no cpufreq on this node — CPU caps unavailable"), { timeout: 10_000 });

    const text = w.text();
    expect(text).toContain("no cpufreq on this node — CPU caps unavailable");
    expect(text).not.toContain("agent too old");
    w.unmount();
  });

  it("hides the CPU control and explains when the agent predates IRI-124", async () => {
    const { liveMock } = await import("./live-mock");
    (liveMock.nodes as Map<string, unknown>).set(UUID, node);
    (liveMock.snapshots as Map<string, unknown>).set(UUID, snapshot);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      let body: unknown = {};
      if (url.endsWith("/clocks")) body = { gpus: [] }; // no cpu block → old agent
      else if (url.includes("/history")) body = history;
      else if (url.includes("/inventory")) body = { report: null, updatedAt: new Date().toISOString() };
      else if (url.includes("/versions")) body = { agentVersion: "0.4.0", pin: null, versions: null, drift: [], updatedAt: new Date().toISOString() };
      else if (url.includes("/api/v1/updates")) body = { baseline: null, nodes: [] };
      else if (url.includes("/health/findings")) body = { findings: [] };
      else if (url.includes("/cleanup")) body = { categories: [], running: false, prevention: null };
      else if (url.includes("/api/v1/llm")) body = {};
      else if (["/setups", "/nodes", "/jobs", "/quants", "/api/v1/bench"].some((e) => url.includes(e))) body = [];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const { default: NodeDetail } = await import("../src/components/NodeDetail.vue");
    const w = mount(NodeDetail as never, { props: { nodeId: UUID } } as never);
    await vi.waitFor(() => expect(w.text()).toContain("agent too old for CPU caps — update the agent"), { timeout: 10_000 });

    const text = w.text();
    expect(text).toContain("agent too old for CPU caps — update the agent");
    expect(w.findAll("select").some((s) => s.attributes("aria-label") === "CPU clock cap in MHz")).toBe(false);
    // The GPU select stays usable regardless of the agent's CPU support.
    expect(w.findAll("select").some((s) => s.attributes("aria-label") === "GPU SM clock cap in MHz")).toBe(true);
    w.unmount();
  });
});
