// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nodeInfoSchema, nodeInventorySchema } from "@irori/core";

/**
 * IR-255/IR-256: the Updates card renders the report's collection age (a
 * stale row must not pose as fresh) and firmware updates as explicit rows —
 * with fwupd's absence stated instead of an implied "up to date".
 */

vi.mock("../src/live", async () => ({ live: (await import("./live-mock")).liveMock }));
vi.mock("../src/scrim", () => ({ vScrimClose: {} }));

afterEach(() => vi.unstubAllGlobals());

const UUID = "11111111-1111-4111-8111-111111111111";

const node = nodeInfoSchema.parse({
  id: UUID,
  name: "DGX-3",
  kind: "spark",
  role: "worker",
  host: "dgx3.lan",
  enabled: true,
  agentVersion: "0.7.0",
  online: true,
  lastSeenAt: new Date().toISOString(),
  sortOrder: 0,
  llmPorts: [],
  nasRoot: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const report = nodeInventorySchema.parse({
  generatedAtMs: Date.now(),
  store: null,
  local: [],
});

const baseUpdates = { osPrettyName: "Ubuntu 24.04.5 LTS", kernelVersion: "7.0.0-1019-nvidia", dgxOsVersion: "7.6.0", nvidiaDriverVersion: "580.178.04", otaPackages: [], pendingReboot: false, unattendedUpgradesLastResult: null, upgradableCount: 0, aptPresent: true };

type UpdatesNode = Record<string, unknown>;

function makeFetchStub(updatesNode: UpdatesNode) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    let body: unknown = {};
    if (url.includes("/api/v1/updates")) body = { baseline: null, nodes: [updatesNode] };
    else if (url.includes("/history")) body = { granularity: "minute", points: [] };
    else if (url.includes("/models")) body = { report, updatedAt: new Date().toISOString() };
    else if (url.includes("/versions")) body = { agentVersion: "0.7.0", pin: null, versions: null, drift: [], updatedAt: new Date().toISOString() };
    else if (url.includes("/health/findings")) body = { findings: [] };
    else if (url.includes("/api/v1/jobs")) body = [];
    else if ([ "/setups", "/nodes", "/quants", "/api/v1/bench", "/api/v1/llm", "/cleanup" ].some((e) => url.includes(e))) body = [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
}

async function mountWith(updatesNode: UpdatesNode) {
  const { liveMock } = await import("./live-mock");
  (liveMock.nodes as Map<string, unknown>).set(UUID, node);
  const fetchStub = makeFetchStub(updatesNode);
  vi.stubGlobal("fetch", fetchStub);
  const { default: NodeDetail } = await import("../src/components/NodeDetail.vue");
  const w = mount(NodeDetail as never, { props: { nodeId: UUID } } as never);
  await new Promise((r) => setTimeout(r, 120));
  const card = w.findAll("article").find((a) => a.find(".card__head h3").text() === "Updates");
  return { w, card };
}

describe("Updates card", () => {
  it("carries the report age and posture (IR-255)", async () => {
    const { w, card } = await mountWith({ nodeId: UUID, name: "DGX-3", online: true, posture: "behind", reportAt: "2020-01-01T00:00:00.000Z", updates: { ...baseUpdates, firmwareUpdates: [], fwupdPresent: true } });
    expect(card).toBeDefined();
    expect(card!.text()).toContain("read ");
    expect(card!.text()).toContain("behind");
    w.unmount();
  });

  it("lists pending firmware updates as device rows (IR-256)", async () => {
    const { w, card } = await mountWith({ nodeId: UUID, name: "DGX-3", online: true, posture: "up to date", reportAt: new Date().toISOString(), updates: { ...baseUpdates, firmwareUpdates: [{ device: "UEFI dbx", toVersion: "371" }], fwupdPresent: true } });
    expect(card).toBeDefined();
    expect(card!.text()).toContain("Firmware · UEFI dbx");
    expect(card!.text()).toContain("371");
    w.unmount();
  });

  it("states the fwupd absence instead of implying up to date (IR-256)", async () => {
    const { w, card } = await mountWith({ nodeId: UUID, name: "DGX-3", online: true, posture: "up to date", reportAt: new Date().toISOString(), updates: { ...baseUpdates, firmwareUpdates: [], fwupdPresent: false } });
    expect(card).toBeDefined();
    expect(card!.text()).toContain("fwupd unavailable");
    w.unmount();
  });

  it("renders no firmware row when an old agent omits the flag (IR-256)", async () => {
    const { w, card } = await mountWith({ nodeId: UUID, name: "DGX-3", online: true, posture: "up to date", reportAt: new Date().toISOString(), updates: { ...baseUpdates, firmwareUpdates: [] } });
    expect(card).toBeDefined();
    expect(card!.text()).not.toContain("fwupd unavailable");
    expect(card!.text()).not.toContain("Firmware");
    w.unmount();
  });
});
