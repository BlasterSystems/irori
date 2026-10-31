import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAllModelsNamed, modelNameCompare } from "../src/models";

const entry = (name: string) => ({
  name,
  runtime: "vllm",
  repository: `org/${name}`,
  bytes: 1,
  firstSeenAt: "2026-10-30T00:00:00.000Z",
  updatedAt: "2026-10-30T00:00:00.000Z",
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("modelNameCompare (IRI-051)", () => {
  it("orders numerically inside names: 2.75bpw before 4bpw before 10bpw", () => {
    const sorted = ["X-10b", "X-4bpw", "X-2.75bpw"].map(entry).sort(modelNameCompare).map((e) => e.name);
    expect(sorted).toEqual(["X-2.75bpw", "X-4bpw", "X-10b"]);
  });

  it("is case-insensitive so lowercase entries stay family-adjacent", () => {
    const sorted = ["GLM-5.3-Flash-EXL3-4bpw", "glm-5.3-flash-dflash2", "GLM-5.3-EXL3-2.75bpw-TensorFold"].map(entry).sort(modelNameCompare).map((e) => e.name);
    expect(sorted).toEqual(["GLM-5.3-EXL3-2.75bpw-TensorFold", "glm-5.3-flash-dflash2", "GLM-5.3-Flash-EXL3-4bpw"]);
  });
});

describe("fetchAllModelsNamed (IRI-051)", () => {
  it("fetches every page until the server total is reached and returns a name-sorted merge", async () => {
    // 60 models in scrambled order across 3 pages of 25; page windows are
    // collation-selected server-side, so the merge must re-sort client-side.
    const catalog = Array.from({ length: 60 }, (_, i) => entry(`m-${String(59 - i).padStart(2, "0")}`));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const page = Number(/page=(\d+)/.exec(String(input))?.[1] ?? 1);
      const models = catalog.slice((page - 1) * 25, page * 25);
      return new Response(JSON.stringify({ page, pageSize: 25, total: catalog.length, models }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const all = await fetchAllModelsNamed("");
    expect(all).toHaveLength(60);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (let i = 1; i < all.length; i++) expect(modelNameCompare(all[i - 1]!, all[i]!)).toBeLessThanOrEqual(0);
    expect(all[0]!.name).toBe("m-00");
    expect(all[59]!.name).toBe("m-59");
  });

  it("stops on an empty page even when the total over-reports", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const page = Number(/page=(\d+)/.exec(String(input))?.[1] ?? 1);
      return new Response(JSON.stringify({ page, pageSize: 25, total: 999, models: page === 1 ? [entry("only-one")] : [] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const all = await fetchAllModelsNamed("");
    expect(all.map((m) => m.name)).toEqual(["only-one"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
