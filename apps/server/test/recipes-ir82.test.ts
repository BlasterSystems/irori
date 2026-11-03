import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { transpileSparkrun, buildStageParams, type RecipeRow } from "../src/recipes.js";

/**
 * IRI-082 (IR-173): sparkrun v2 YAML transpilation + stage-payload building.
 * Irori never executes third-party YAML and never shells out to sparkrun —
 * the transpiler derives a start/stop script pair; the agent verifies the
 * sha256 of every staged file. AGPL bodies pass through at install time only.
 */

const YAML = `
recipe_version: "2"
model: Qwen/Qwen3.8-27B-FP8
runtime: vllm
container: ghcr.io/spark-arena/vllm:gb10
defaults:
  port: 9001
  tensor_parallel: 1
`;

describe("transpileSparkrun", () => {
  it("derives a start/stop pair from model, container and port", () => {
    const t = transpileSparkrun(YAML, "qwen38-27b")!;
    expect(t.start).toContain('PORT="${PORT:-9001}"');
    expect(t.start).toContain('MODEL="${MODEL:-Qwen/Qwen3.8-27B-FP8}"');
    expect(t.start).toContain("ghcr.io/spark-arena/vllm:gb10");
    expect(t.start).toContain("docker run -d");
    expect(t.start).toContain("# IR-151 note");
    expect(t.stop).toContain("docker stop irori-qwen38-27b");
  });

  it("returns null when the YAML has neither model nor container", () => {
    expect(transpileSparkrun("recipe_version: \"2\"\n", "x")).toBeNull();
  });
});

const entry = (over: Partial<RecipeRow>): RecipeRow =>
  ({
    id: randomUUID(),
    slug: "test-recipe",
    name: "Test recipe",
    author: "tester",
    kind: "sparkrun-transpiled",
    engine: "vllm",
    summary: "",
    upstreamUrl: "https://github.com/spark-arena/recipe-registry",
    commitSha: "a".repeat(40),
    license: "Apache-2.0",
    copyleft: false,
    defaultPort: 8000,
    modelRepo: "Qwen/Qwen3.8-27B-FP8",
    modelRevision: null,
    envKeys: [],
    nodeCountMin: 1,
    nodeCountMax: 1,
    scriptStart: "recipes/test.yaml",
    scriptStop: "stop.sh",
    provenance: { registry: "@official", recipe: "test" },
    startupTimeoutMs: 600_000,
    releaseNotesUrl: null,
    forumTopicId: null,
    measured: [],
    catalogVersion: 1,
    fetchedAt: new Date(),
    hidden: false,
    curated: true,
    behindCommits: null,
    engineReleasesBehind: null,
    ...over,
  }) as RecipeRow;

describe("buildStageParams", () => {
  it("fetches the pinned YAML, transpiles, and returns checksummed files", async () => {
    const calls: string[] = [];
    const params = await buildStageParams(entry({}), async (url) => {
      calls.push(String(url));
      return new Response(YAML, { status: 200 });
    });
    expect(params).not.toBeNull();
    expect(calls[0]).toContain("raw.githubusercontent.com/spark-arena/recipe-registry/" + "a".repeat(40) + "/recipes/test.yaml");
    expect(params!.files).toHaveLength(2);
    expect(params!.files[0]!.rel).toBe("start.sh");
    expect(params!.files[0]!.content).toContain("docker run -d");
    expect(params!.files[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(params!.dir).toBe("/opt/irori/recipes/test-recipe");
  });

  it("unpinned entries never stage (commitSha empty)", async () => {
    const params = await buildStageParams(entry({ commitSha: "" }), async () => new Response("", { status: 200 }));
    expect(params).toBeNull();
  });

  it("miaai-script entries stage start.sh/stop.sh verbatim from the pin", async () => {
    const params = await buildStageParams(
      entry({ kind: "miaai-script", scriptStart: "start.sh", scriptStop: "stop.sh" }),
      async () => new Response("#!/usr/bin/env bash\necho hi\n", { status: 200 }),
    );
    expect(params).not.toBeNull();
    expect(params!.files.map((f) => f.rel)).toEqual(["start.sh", "stop.sh"]);
    expect(params!.files[0]!.content).toContain("echo hi");
  });
});
