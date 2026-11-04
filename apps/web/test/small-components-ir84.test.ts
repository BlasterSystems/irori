// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import type { LensChart } from "../src/analytics";
import { fetchDownloadQueue, fetchJob, fetchModelsPage, fetchPlacement, modelNameCompare } from "../src/models";

/**
 * IRI-084: small-component mounts (CleanupDrawer, NodeModal, LensChart) and
 * models.ts fetch-wrapper contracts.
 */

vi.mock("../src/live", async () => ({ live: (await import("./live-mock")).liveMock }));
vi.mock("../src/scrim", () => ({ vScrimClose: {} }));

afterEach(() => vi.unstubAllGlobals());

const lastCall = (): string => (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as string;

const chart: LensChart = {
  paths: [{ d: "M0 10 L10 0", color: "var(--accent)", dashed: false }],
  series: [{ label: "tok/s", color: "var(--accent)", values: [1, 2, 3] } as never],
  times: [1700000000000, 1700000060000, 1700000120000],
  guides: [],
  markers: [],
  yMin: 0,
  yMax: 3,
  width: 100,
  height: 20,
};

const UUID = "11111111-1111-4111-8111-111111111111";
const okJson = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));

describe("small component mounts", () => {
  it("mounts CleanupDrawer", async () => {
    vi.stubGlobal("fetch", okJson({ categories: [], running: false }));
    const { default: CleanupDrawer } = await import("../src/components/CleanupDrawer.vue");
    const w = mount(CleanupDrawer as never, { props: { nodeId: "11111111-1111-4111-8111-111111111111", nodeName: "DGX-1" } } as never);
    await new Promise((r) => setTimeout(r, 50));
    expect(w.exists()).toBe(true);
    w.unmount();
  });

  it("mounts NodeModal in create mode", async () => {
    vi.stubGlobal("fetch", okJson({}));
    const { default: NodeModal } = await import("../src/components/NodeModal.vue");
    const w = mount(NodeModal as never, { props: { mode: "create", node: null } } as never);
    await new Promise((r) => setTimeout(r, 30));
    expect(w.exists()).toBe(true);
    w.unmount();
  });

  it("mounts LensChart with a series", async () => {
    const { default: LensChartVue } = await import("../src/components/LensChart.vue");
    const w = mount(LensChartVue as never, { props: { chart, unit: "tok/s" } } as never);
    expect(w.find("svg").exists()).toBe(true);
  });
});

describe("models.ts wrappers", () => {
  it("fetchModelsPage encodes page/query/sort", async () => {
    vi.stubGlobal("fetch", okJson({ page: 1, pageSize: 50, total: 0, models: [] }));
    await fetchModelsPage(2, "glm", "name");
    expect(lastCall()).toContain("/api/v1/models");
    expect(lastCall()).toContain("page=2");
    expect(lastCall()).toContain("q=glm");
    expect(lastCall()).toContain("sort=name");
  });

  it("fetchPlacement GETs the placement endpoint", async () => {
    vi.stubGlobal("fetch", okJson({ model: { name: "glm-5.3", bytes: 1 }, placements: [] }));
    const r = await fetchPlacement("glm-5.3");
    expect(r.model.name).toBe("glm-5.3");
    expect(lastCall()).toContain("/placement");
  });

  it("fetchJob GETs and parses the detail", async () => {
    vi.stubGlobal("fetch", okJson({ job: { id: UUID, nodeId: UUID, kind: "models-inventory", status: "queued", createdAt: new Date().toISOString(), exitCode: null, startedAt: null, finishedAt: null }, output: [{ seq: 0, line: "hi" }, { seq: 1, junk: true }] }));
    const d = await fetchJob(UUID);
    expect(d.job.id).toBe(UUID);
    expect(d.output).toEqual([{ seq: 0, line: "hi" }]);
  });

  it("fetchDownloadQueue returns entries", async () => {
    vi.stubGlobal("fetch", okJson({ entries: [] }));
    expect(await fetchDownloadQueue()).toEqual([]);
  });

  it("modelNameCompare is a stable name comparator", () => {
    expect(modelNameCompare({ name: "a" }, { name: "b" })).toBeLessThanOrEqual(0);
  });
});
