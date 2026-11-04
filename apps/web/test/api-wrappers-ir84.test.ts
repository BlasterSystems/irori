import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchNodes,
  deleteNode,
  wakeNode,
  setClockCap,
  fetchUpdates,
  fetchCommunity,
  fetchRecipes,
  installRecipe,
  fetchRecipeDraft,
  fetchHealthFindings,
  isHistoryRange,
} from "../src/api";

/**
 * IRI-084: api.ts fetch-wrapper contracts — URL/method shapes per endpoint,
 * success envelopes, and error propagation. fetch is stubbed per call.
 */

const lastCall = (): string => (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as string;

afterEach(() => vi.unstubAllGlobals());

const okJson = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
const fail = (status: number) => vi.fn(async () => new Response("no", { status }));

describe("api wrappers", () => {
  it("fetchNodes GETs the registry", async () => {
    vi.stubGlobal("fetch", okJson([]));
    expect(await fetchNodes()).toEqual([]);
    expect(lastCall()).toBe("/api/v1/nodes");
  });

  it("deleteNode sends DELETE", async () => {
    vi.stubGlobal("fetch", okJson({ ok: true }));
    await deleteNode("n1");
    expect(lastCall()).toContain("/api/v1/nodes/n1");
  });

  it("wakeNode POSTs and setClockCap PUTs the cap", async () => {
    vi.stubGlobal("fetch", okJson({ ok: true }));
    await wakeNode("n1");
    expect(lastCall()).toContain("/wake");
    await setClockCap("n1", 1200, true);
    expect(lastCall()).toContain("/clock-cap");
  });

  it("fetchUpdates GETs the matrix", async () => {
    vi.stubGlobal("fetch", okJson({ baseline: null, nodes: [] }));
    const r = await fetchUpdates();
    expect(r.nodes).toEqual([]);
    expect(lastCall()).toBe("/api/v1/updates");
  });

  it("fetchCommunity GETs the view", async () => {
    vi.stubGlobal("fetch", okJson({ sources: [], topics: [], items: [], releases: [] }));
    const r = await fetchCommunity();
    expect(r.topics).toEqual([]);
    expect(lastCall()).toBe("/api/v1/community");
  });

  it("fetchRecipes GETs the catalog", async () => {
    vi.stubGlobal("fetch", okJson({ recipes: [], seedVersion: 1 }));
    const r = await fetchRecipes();
    expect(r.seedVersion).toBe(1);
    expect(lastCall()).toBe("/api/v1/recipes");
  });

  it("installRecipe POSTs and returns the job id", async () => {
    vi.stubGlobal("fetch", okJson({ jobId: "j1" }));
    expect(await installRecipe("r1", "n1")).toBe("j1");
    expect(lastCall()).toContain("/api/v1/recipes/r1/install");
  });

  it("installRecipe surfaces the server error message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "recipe staging failed" }), { status: 409 })));
    await expect(installRecipe("r1", "n1")).rejects.toThrow(/staging failed/);
  });

  it("fetchRecipeDraft GETs the settled draft", async () => {
    vi.stubGlobal("fetch", okJson({ name: "d", port: 8000, kind: "single", headNodeId: "n", workerNodeIds: [], startupTimeoutMs: 1, scriptStart: "/a", scriptStop: "/b", recipeId: "r" }));
    const d = await fetchRecipeDraft("j1");
    expect(d.name).toBe("d");
    expect(lastCall()).toBe("/api/v1/recipes/drafts/j1");
  });

  it("fetchHealthFindings GETs the findings envelope", async () => {
    vi.stubGlobal("fetch", okJson({ findings: [] }));
    expect(await fetchHealthFindings()).toEqual([]);
  });

  it("error statuses propagate with the code", async () => {
    vi.stubGlobal("fetch", fail(503));
    await expect(fetchNodes()).rejects.toThrow(/503/);
    await expect(fetchUpdates()).rejects.toThrow(/503/);
  });

  it("isHistoryRange narrows the known ranges", () => {
    expect(isHistoryRange("24h")).toBe(true);
    expect(isHistoryRange("nope")).toBe(false);
  });
});
