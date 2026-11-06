import { describe, expect, it } from "vitest";
import {
  applySetupStates,
  composeScriptPath,
  engineLogEmptyText,
  fmtEta,
  fmtRate,
  probeSeesEngine,
  ownsProbePort,
  probeableNodeIds,
  portClashMessage,
  runningEnginesFromProbes,
  sanitizeWorkerIds,
  scriptPathError,
  setupChipView,
  setupNodeLines,
  setupSubline,
  setupSummaryLine,
  sortSetupsForBoard,
  splitRecipePaths,
  stagePercent,
  stageVal,
  workerCapHint,
  type SetupInfo,
} from "../src/serve";
import type { NodeInfo } from "@irori/core";

describe("composeScriptPath / splitRecipePaths (IRI-051)", () => {
  it("composes folder plus name and normalizes trailing slashes", () => {
    expect(composeScriptPath("~/developer/recipes/X", "start-tp3.sh")).toBe("~/developer/recipes/X/start-tp3.sh");
    expect(composeScriptPath("~/developer/recipes/X/", "start.sh")).toBe("~/developer/recipes/X/start.sh");
    expect(composeScriptPath("  ~/recipes/X  ", "  stop.sh ")).toBe("~/recipes/X/stop.sh");
  });

  it("uses a path-shaped name verbatim and ignores the folder", () => {
    expect(composeScriptPath("~/other", "/opt/recipes/X/start.sh")).toBe("/opt/recipes/X/start.sh");
    expect(composeScriptPath("~/other", "~/recipes/X/start.sh")).toBe("~/recipes/X/start.sh");
    expect(composeScriptPath("~/other", "sub/dir/start.sh")).toBe("sub/dir/start.sh");
  });

  it("falls back to the bare name when the folder is empty", () => {
    expect(composeScriptPath("", "start.sh")).toBe("start.sh");
    expect(composeScriptPath("", "")).toBe("");
  });

  it("splits a shared dirname into folder plus basenames and round-trips", () => {
    const split = splitRecipePaths("~/developer/recipes/X/start-tp3.sh", "~/developer/recipes/X/stop.sh");
    expect(split).toEqual({ folder: "~/developer/recipes/X", startName: "start-tp3.sh", stopName: "stop.sh" });
    expect(composeScriptPath(split.folder, split.startName)).toBe("~/developer/recipes/X/start-tp3.sh");
    expect(composeScriptPath(split.folder, split.stopName)).toBe("~/developer/recipes/X/stop.sh");
  });

  it("falls back to full paths in the name fields when dirnames differ", () => {
    const split = splitRecipePaths("/a/start.sh", "~/b/stop.sh");
    expect(split.folder).toBe("");
    expect(split.startName).toBe("/a/start.sh");
    expect(split.stopName).toBe("~/b/stop.sh");
    expect(composeScriptPath(split.folder, split.startName)).toBe("/a/start.sh");
  });

  it("handles bare names and empty inputs", () => {
    expect(splitRecipePaths("start.sh", "stop.sh")).toEqual({ folder: "", startName: "start.sh", stopName: "stop.sh" });
    expect(splitRecipePaths("", "")).toEqual({ folder: "", startName: "", stopName: "" });
    const one = splitRecipePaths("/opt/start.sh", "");
    expect(one).toEqual({ folder: "/opt", startName: "/opt/start.sh", stopName: "" });
  });
});

function node(id: string, name: string, online: boolean): NodeInfo {
  return {
    id,
    name,
    kind: "spark",
    role: "standalone",
    host: `${name}.lan`,
    enabled: true,
    agentVersion: "0.1.0",
    online,
    lastSeenAt: null,
    sortOrder: 0,
    llmPorts: [],
    nasRoot: null,
    cacheUser: null,
    wolMac: null,
    gpuClockCapMHz: null,
    gpuClockCapPersistent: false,
    cpuClockCapMHz: null,
    cpuClockCapPersistent: false,
    createdAt: "2026-10-18T00:00:00.000Z",
    updatedAt: "2026-10-18T00:00:00.000Z",
  };
}

function setup(overrides: Partial<SetupInfo>): SetupInfo {
  return {
    id: "0b6c1c26-1f1e-4a2f-9c2a-9d6a2f7b1e01",
    name: "GLM-5.3-Flash-EXL3",
    kind: "single",
    model: "GLM-5.3-Flash-EXL3",
    port: 8081,
    headNodeId: "0b6c1c26-1f1e-4a2f-9c2a-9d6a2f7b1e02",
    nodes: [],
    scriptStart: "/s/start.sh",
    scriptStop: "/s/stop.sh",
    env: { modelName: false, port: false, extraArgs: "", modelPath: false },
    status: "stopped",
    health: null,
    lastError: null,
    startupTimeoutMs: 900000,
    lastStartedAt: null,
    createdAt: "2026-10-18T00:00:00.000Z",
    updatedAt: "2026-10-18T00:00:00.000Z",
    ...overrides,
  } as SetupInfo;
}

describe("sanitizeWorkerIds", () => {
  const HEAD = "11111111-1111-4111-8111-111111111111";
  const DGX2 = "22222222-2222-4222-8222-222222222222";
  const DGX3 = "33333333-3333-4333-8333-333333333333";
  const NAS = "44444444-4444-4444-8444-444444444444";
  const inventory: NodeInfo[] = [
    node(HEAD, "DGX-1", true),
    node(DGX2, "DGX-2", true),
    node(DGX3, "DGX-3", true),
    { ...node(NAS, "NAS", true), kind: "nas" as const },
  ];

  it("dedupes keeping the first occurrence and preserves order", () => {
    expect(sanitizeWorkerIds([DGX3, DGX2, DGX3], HEAD, inventory)).toEqual([DGX3, DGX2]);
  });

  it("drops the head itself, NAS-kind nodes and unknown ids (IRI-041 corrupt row)", () => {
    const unknown = "55555555-5555-4555-8555-555555555555";
    expect(sanitizeWorkerIds([HEAD, NAS, unknown, DGX2], HEAD, inventory)).toEqual([DGX2]);
  });

  it("keeps gpu-host nodes — only nas is rejected server-side", () => {
    const gpu = { ...node("66666666-6666-4666-8666-666666666666", "GPU-1", true), kind: "gpu-host" as const };
    expect(sanitizeWorkerIds(["66666666-6666-4666-8666-666666666666"], HEAD, [...inventory, gpu])).toEqual([
      "66666666-6666-4666-8666-666666666666",
    ]);
  });
});

describe("stage lines", () => {
  it("formats the mockup's progress triple", () => {
    expect(stageVal({ status: "running", progress: { percent: 64, rateBytesPerSec: 168 * 1024 ** 2, etaSeconds: 240 }, error: null })).toBe("64% · 168 MB/s · ~4m 0s left");
    expect(stageVal({ status: "succeeded", progress: null, error: null })).toBe("done");
    expect(stageVal({ status: "failed", progress: null, error: "busy: a job is already running on this node" })).toContain("busy");
    expect(stageVal({ status: "pending", progress: null, error: null })).toBe("waiting");
  });

  it("formats rates and etas", () => {
    expect(fmtRate(96 * 1024 ** 2)).toBe("96.0 MB/s");
    expect(fmtRate(1024)).toBe("1.0 KB/s");
    expect(fmtEta(192)).toBe("3m 12s");
    expect(fmtEta(45)).toBe("45s");
  });

  it("fills bars from progress with clamping", () => {
    expect(stagePercent({ status: "succeeded", progress: null })).toBe(100);
    expect(stagePercent({ status: "running", progress: { percent: 64 } })).toBe(64);
    expect(stagePercent({ status: "running", progress: { percent: 140 } })).toBe(100);
    expect(stagePercent({ status: "running", progress: null })).toBe(0);
  });
});

describe("setup cards", () => {
  it("renders honest chips: failed distinct from stopped, foreign as wrong engine (IR-152)", () => {
    const healthy = setupChipView(setup({ status: "running", health: "healthy" }), { probeSees: false });
    expect(healthy).toMatchObject({ label: "healthy", cls: "chip--ok", dot: "dot--ok" });
    const foreign = setupChipView(setup({ status: "running", health: "foreign" }), { probeSees: false });
    expect(foreign).toMatchObject({ label: "wrong engine", cls: "chip--warn" });
    const failed = setupChipView(setup({ status: "failed", lastError: "boom" }), { probeSees: false });
    const stopped = setupChipView(setup({ status: "stopped", lastStartedAt: "2026-10-16T00:00:00.000Z" }), { probeSees: false });
    const never = setupChipView(setup({ status: "stopped" }), { probeSees: false });
    expect(failed.label).toBe("failed");
    expect(failed.cls).toBe("chip--warn");
    // P2: failed must not be visually identical to stopped.
    expect(failed.cls).not.toBe(stopped.cls);
    expect(stopped).toMatchObject({ label: "stopped", cls: "chip--muted" });
    // One word covered three realities: never-started reads differently.
    expect(never.label).toBe("never started");
    // The IR-151 escape hatch: a falsely-stopped row says what is true.
    const servingWhileStopped = setupChipView(setup({ status: "stopped" }), { probeSees: true });
    expect(servingWhileStopped).toMatchObject({ label: "serving :8081", cls: "chip--warn" });
  });

  it("renders per-node lines: head probe state, worker join state", () => {
    const s = setup({
      kind: "cluster",
      nodes: [{ nodeId: "0b6c1c26-1f1e-4a2f-9c2a-9d6a2f7b1e03", role: "worker" }],
      status: "running",
      health: "healthy",
    });
    const lines = setupNodeLines(s, [
      node(s.headNodeId, "dgx1", true),
      node("0b6c1c26-1f1e-4a2f-9c2a-9d6a2f7b1e03", "spark2", true),
    ], { decodeTps: 142.3 });
    expect(lines[0]!.label).toContain("dgx1 · head · :8081");
    expect(lines[0]!.detail).toBe("142.3 tok/s");
    expect(lines[0]!.cls).toBe("chip--ok");
    expect(lines[1]!.label).toContain("spark2 · worker");
    expect(lines[1]!.detail).toBe("joined");
  });

  it("renders IDLE node chips for stopped/failed setups — no green JOINED on a dead cluster (IR-152 P1)", () => {
    const s = setup({
      kind: "cluster",
      nodes: [{ nodeId: "0b6c1c26-1f1e-4a2f-9c2a-9d6a2f7b1e03", role: "worker" }],
      status: "stopped",
      lastStartedAt: "2026-10-16T00:00:00.000Z",
    });
    const nodesArr = [node(s.headNodeId, "dgx1", true), node("0b6c1c26-1f1e-4a2f-9c2a-9d6a2f7b1e03", "spark2", true)];
    const lines = setupNodeLines(s, nodesArr, { decodeTps: null, probeSees: false });
    expect(lines[0]!.cls).toBe("chip--muted");
    expect(lines[0]!.detail).toBe("idle");
    expect(lines[1]!.cls).toBe("chip--muted");
    expect(lines[1]!.detail).toBe("idle");
    // An offline worker under a stopped setup still says offline.
    expect(setupNodeLines(s, [nodesArr[0]!, node("0b6c1c26-1f1e-4a2f-9c2a-9d6a2f7b1e03", "spark2", false)], null)[1]!.detail).toBe("offline");
    // The escape hatch keeps a falsely-stopped head line honest.
    const hatch = setupNodeLines(s, nodesArr, { decodeTps: 87.4, probeSees: true });
    expect(hatch[0]!.cls).toBe("chip--ok");
    expect(hatch[0]!.detail).toBe("87.4 tok/s");
  });

  it("explains foreign ports and stopped setups", () => {
    expect(setupSubline(setup({ status: "running", health: "foreign", port: 8100 }))).toContain("another process took the port");
    expect(setupSubline(setup({ status: "stopped", lastStartedAt: "2026-10-16T00:00:00.000Z" }))).toContain("last start");
    expect(setupSubline(setup({ status: "failed", lastError: "start script exited with code 3" }))).toContain("code 3");
  });
});

describe("board ordering and summary (IR-152)", () => {
  const row = (name: string, status: SetupInfo["status"]) => ({ id: name, name, status, health: null, lastError: null, updatedAt: "2026-10-18T00:00:00.000Z" });

  it("sorts running first, then failed, then idle; name-stable", () => {
    const board = sortSetupsForBoard([
      row("alpha-stopped", "stopped"),
      row("bravo-running", "running"),
      row("charlie-failed", "failed"),
      row("delta-stopped", "stopped"),
      row("echo-starting", "starting"),
    ]);
    expect(board.map((s) => s.name)).toEqual(["bravo-running", "echo-starting", "charlie-failed", "alpha-stopped", "delta-stopped"]);
  });

  it("counts the summary line", () => {
    expect(setupSummaryLine([
      row("a", "running"),
      row("b", "stopped"),
      row("c", "stopped"),
      row("d", "failed"),
      row("e", "starting"),
    ])).toBe("2 running · 2 stopped · 1 failed");
  });

  it("overlays only fresh setup-state SSE frames (IR-152 instant chips)", () => {
    const rows = [row("a", "stopped")];
    // The ring survives mounts; a frame older than the row's own write never
    // reverts it (the poll is the convergent source).
    const stale = [{ setupId: "a", status: "running" as const, health: "healthy" as const, lastError: null, serverTimeMs: Date.parse("2026-10-17T00:00:00.000Z") }];
    expect(applySetupStates(rows, stale)).toEqual(rows);
    const fresh = [{ setupId: "a", status: "running" as const, health: "healthy" as const, lastError: null, serverTimeMs: Date.parse("2026-10-19T00:00:00.000Z") }];
    expect(applySetupStates(rows, fresh)[0]).toMatchObject({ status: "running", health: "healthy" });
    // Newest frame wins per setup.
    const older = fresh[0]!;
    const newer = { ...older, status: "failed" as const, health: null, serverTimeMs: older.serverTimeMs + 1000 };
    expect(applySetupStates(rows, [older, newer])[0]).toMatchObject({ status: "failed" });
  });
});

describe("script path rules and cluster cap (IR-152)", () => {
  it("rejects tilde and relative paths with actionable messages", () => {
    expect(scriptPathError("~/developer/recipes/start.sh")).toContain("expand ~");
    expect(scriptPathError("recipes/start.sh")).toContain("absolute");
    expect(scriptPathError("/home/you/start.sh")).toBeNull();
    expect(scriptPathError("/" + "a".repeat(1024))).toContain("too long");
  });

  it("only hints at the cap for a full cluster", () => {
    expect(workerCapHint(0, "single")).toBeNull();
    expect(workerCapHint(6, "cluster")).toBeNull();
    expect(workerCapHint(7, "cluster")).toContain("cluster cap");
  });
});

describe("engine log empty states (IR-152)", () => {
  it("explains each state instead of bare 'no output yet'", () => {
    expect(engineLogEmptyText({ status: "running", lastError: null, lastStartedAt: null })).toContain("waiting for engine output");
    expect(engineLogEmptyText({ status: "starting", lastError: null, lastStartedAt: null })).toContain("starting");
    expect(engineLogEmptyText({ status: "failed", lastError: "script exited 3", lastStartedAt: null })).toBe("script exited 3");
    expect(engineLogEmptyText({ status: "stopped", lastError: null, lastStartedAt: null })).toContain("never started");
    expect(engineLogEmptyText({ status: "stopped", lastError: null, lastStartedAt: "2026-10-16T00:00:00.000Z" })).toContain("start it again");
  });
});

describe("runningEnginesFromProbes (IR-152 Running now)", () => {
  const headId = "0b6c1c26-1f1e-4a2f-9c2a-9d6a2f7b1e02";
  const otherId = "0b6c1c26-1f1e-4a2f-9c2a-9d6a2f7b1e03";
  const p = (port: number, detected: boolean, model: string | null = "glm", decodeTps: number | null = 40) =>
    ({ port, detected, backend: "tensorfold", model, decodeTps });

  it("lists detected engines only, managed first, unmanaged last", () => {
    const rows = runningEnginesFromProbes(
      [
        { nodeId: headId, ports: [p(8081, true), p(8090, false)] },
        { nodeId: otherId, ports: [p(8123, true, "qwen3-8b")] },
      ],
      [node(headId, "dgx1", true), node(otherId, "spark2", true)],
      [{ id: "s1", name: "GLM prod", headNodeId: headId, port: 8081 }],
    );
    expect(rows.map((r) => r.key)).toEqual([`${headId}:8081`, `${otherId}:8123`]);
    expect(rows[0]).toMatchObject({ managedSetupId: "s1", managedName: "GLM prod", backend: "tensorfold", decodeTps: 40 });
    expect(rows[1]).toMatchObject({ managedSetupId: null, managedName: null, model: "qwen3-8b", nodeName: "spark2" });
  });

  it("dedupes node+port and falls back to a short id for unknown nodes", () => {
    const rows = runningEnginesFromProbes(
      [
        { nodeId: otherId, ports: [p(8123, true)] },
        { nodeId: otherId, ports: [p(8123, true)] },
      ],
      [],
      [],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.nodeName).toBe(otherId.slice(0, 8));
  });

  it("attributes a duplicated head port to the row that owns it (IR-155)", () => {
    // Pre-guard shape: three rows declare the same head port; only one ever ran.
    const rows = runningEnginesFromProbes(
      [{ nodeId: headId, ports: [p(8081, true, "glm-5.3-flash-exl3", 84.5)] }],
      [node(headId, "dgx1", true)],
      [
        { id: "phantom", name: "phantom", headNodeId: headId, port: 8081, status: "stopped", lastStartedAt: null },
        { id: "owner", name: "owner", headNodeId: headId, port: 8081, status: "running", lastStartedAt: "2026-11-02T01:00:00.000Z" },
        { id: "successor", name: "successor", headNodeId: headId, port: 8081, status: "stopped", lastStartedAt: null },
      ],
    );
    expect(rows[0]).toMatchObject({ managedSetupId: "owner", managedName: "owner" });

    // Two live starters: the most recent start owns the engine.
    const both = runningEnginesFromProbes(
      [{ nodeId: headId, ports: [p(8081, true)] }],
      [node(headId, "dgx1", true)],
      [
        { id: "older", name: "older", headNodeId: headId, port: 8081, status: "running", lastStartedAt: "2026-11-02T01:00:00.000Z" },
        { id: "newer", name: "newer", headNodeId: headId, port: 8081, status: "running", lastStartedAt: "2026-11-02T05:00:00.000Z" },
      ],
    );
    expect(both[0]).toMatchObject({ managedSetupId: "newer" });
  });
});

describe("probeSeesEngine (IR-151)", () => {
  const headId = "0b6c1c26-1f1e-4a2f-9c2a-9d6a2f7b1e02";
  const port = (detected: boolean, model: string | null) => ({ port: 8081, detected, model });

  it("only true when the declared engine answers the declared port", () => {
    const s = setup({});
    expect(probeSeesEngine(s, new Map([[headId, { ports: [port(true, "glm-5.3-flash-exl3")] }]]))).toBe(true);
    // Unknown port, a different engine, no snapshot, null snapshot, absent node.
    expect(probeSeesEngine(s, new Map([[headId, { ports: [{ ...port(true, "glm-5.3-flash-exl3"), port: 9999 }] }]]))).toBe(false);
    expect(probeSeesEngine(s, new Map([[headId, { ports: [port(true, "qwen3-8b")] }]]))).toBe(false);
    expect(probeSeesEngine(s, new Map([[headId, { ports: [port(false, null)] }]]))).toBe(false);
    expect(probeSeesEngine(s, new Map([[headId, null]]))).toBe(false);
    expect(probeSeesEngine(s, new Map())).toBe(false);
  });
});

describe("ownsProbePort (IR-155)", () => {
  const HEAD = "0b6c1c26-1f1e-4a2f-9c2a-9d6a2f7b1e02";
  const OTHER = "33333333-3333-4333-8333-333333333333";
  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const row = (id: string, o: Partial<SetupInfo> = {}): SetupInfo =>
    setup({ id, headNodeId: HEAD, port: 8081, ...o });

  it("a row that never started owns nothing while a sibling has run", () => {
    const never = row(A, { lastStartedAt: null, status: "stopped" });
    const ran = row(B, { lastStartedAt: "2026-11-02T01:00:00.000Z", status: "running" });
    expect(ownsProbePort(never, [never, ran])).toBe(false);
    expect(ownsProbePort(ran, [never, ran])).toBe(true);
  });

  it("the most recent start owns the port", () => {
    const first = row(A, { lastStartedAt: "2026-11-02T01:00:00.000Z", status: "running" });
    const later = row(B, { lastStartedAt: "2026-11-02T03:00:00.000Z", status: "running" });
    expect(ownsProbePort(first, [first, later])).toBe(false);
    expect(ownsProbePort(later, [first, later])).toBe(true);
  });

  it("a stopped sibling that started later still owns the port (IR-191)", () => {
    const mine = row(A, { lastStartedAt: "2026-11-02T01:00:00.000Z", status: "stopped" });
    const stoppedLater = row(B, { lastStartedAt: "2026-11-02T05:00:00.000Z", status: "stopped" });
    const otherHead = row(C, { headNodeId: OTHER, lastStartedAt: "2026-11-02T05:00:00.000Z", status: "running" });
    const otherPort = row("dddddddd-dddd-4ddd-8ddd-dddddddddddd", { port: 8082, lastStartedAt: "2026-11-02T05:00:00.000Z", status: "running" });
    // The later start owns the port even after its row is stopped: its engine
    // may still be winding down and the probe snapshot can predate the stop.
    // Other heads/ports never outrank.
    expect(ownsProbePort(mine, [mine, stoppedLater, otherHead, otherPort])).toBe(false);
    expect(ownsProbePort(stoppedLater, [mine, stoppedLater, otherHead, otherPort])).toBe(true);
  });

  it("a lone row always owns its port, including with two never-started rows", () => {
    const alone = row(A, { lastStartedAt: null });
    expect(ownsProbePort(alone, [alone])).toBe(true);
    const p1 = row(A, { lastStartedAt: null });
    const p2 = row(B, { lastStartedAt: null });
    expect(ownsProbePort(p1, [p1, p2])).toBe(true);
    expect(ownsProbePort(p2, [p1, p2])).toBe(true);
  });
});

describe("probeableNodeIds (IR-192)", () => {
  const HEAD = "0b6c1c26-1f1e-4a2f-9c2a-9d6a2f7b1e02";
  const NAS = "44444444-4444-4444-8444-444444444444";
  const OFFLINE = "55555555-5555-4555-8555-555555555555";

  it("skips the NAS and offline agents, keeps serving nodes", () => {
    const nodes = [
      node(HEAD, "DGX-1", true),
      { ...node(NAS, "NAS", true), kind: "nas" as const },
      node(OFFLINE, "DGX-2", false),
    ];
    expect(probeableNodeIds(nodes, [])).toEqual([HEAD]);
  });

  it("adds a setup head the registry does not know yet, but never a NAS head", () => {
    const unknownHead = "66666666-6666-4666-8666-666666666666";
    const nodes = [{ ...node(NAS, "NAS", true), kind: "nas" as const }];
    expect(probeableNodeIds(nodes, [{ headNodeId: unknownHead }])).toEqual([unknownHead]);
    expect(probeableNodeIds(nodes, [{ headNodeId: NAS }])).toEqual([]);
  });
});

describe("portClashMessage (IR-155)", () => {
  const HEAD = "0b6c1c26-1f1e-4a2f-9c2a-9d6a2f7b1e02";
  const OTHER_HEAD = "22222222-2222-4222-8222-222222222222";
  const nameOf = (id: string): string => (id === HEAD ? "DGX-1" : id);
  const draft = (o: Partial<{ editId: string | null; headNodeId: string; port: number }>) => ({
    editId: null,
    headNodeId: HEAD,
    port: 8081,
    ...o,
  });

  it("warns when a live setup already serves the head port", () => {
    for (const status of ["starting", "running", "stopping"] as const) {
      const msg = portClashMessage([setup({ headNodeId: HEAD, port: 8081, status })], draft({}), nameOf);
      expect(msg).toContain("port 8081 on DGX-1");
      expect(msg).toContain("GLM-5.3-Flash-EXL3");
    }
  });

  it("stays quiet for a stopped sibling, another head, another port, or a bad port", () => {
    const live = setup({ headNodeId: HEAD, port: 8081, status: "running" });
    expect(portClashMessage([setup({ headNodeId: HEAD, port: 8081, status: "stopped" })], draft({}), nameOf)).toBeNull();
    expect(portClashMessage([setup({ headNodeId: HEAD, port: 8081, status: "failed" })], draft({}), nameOf)).toBeNull();
    expect(portClashMessage([live], draft({ headNodeId: OTHER_HEAD }), nameOf)).toBeNull();
    expect(portClashMessage([live], draft({ port: 8082 }), nameOf)).toBeNull();
    expect(portClashMessage([live], draft({ port: 0 }), nameOf)).toBeNull();
    expect(portClashMessage([live], draft({ port: 8081.5 }), nameOf)).toBeNull();
    expect(portClashMessage([live], draft({ headNodeId: "" }), nameOf)).toBeNull();
  });

  it("never warns about the row being edited, and flags the sibling among many", () => {
    const mine = setup({ headNodeId: HEAD, port: 8081, status: "running" });
    expect(portClashMessage([mine], draft({ editId: mine.id }), nameOf)).toBeNull();
    const other = setup({ headNodeId: HEAD, port: 8081, status: "running" });
    expect(portClashMessage([mine, other], draft({}), nameOf)).toContain("already served by");
  });
});
