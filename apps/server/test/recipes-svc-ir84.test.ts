import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createDbHandle, jobs, jobOutput, nodes, recipeCatalog, type Db } from "@irori/db";
import { eq } from "drizzle-orm";
import { buildStageParams, createRecipesService, type RecipeRow } from "../src/recipes.js";

/**
 * IRI-084: db-gated tier for the recipe service — install staging job
 * params (meta + checksummed files), the settled-job draft, unpinned
 * filtering and hide curation. The upstream fetch is faked.
 */

const url = process.env.IRORI_TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

const YAML = 'model: Qwen/Qwen3.8-27B-FP8\ncontainer: ghcr.io/x:v1\nport: 9001\n';

const entry = (over: Partial<RecipeRow>): RecipeRow =>
  ({
    id: randomUUID(),
    slug: "svc-recipe",
    name: "Svc recipe",
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
    scriptStart: "recipes/svc.yaml",
    scriptStop: "stop.sh",
    provenance: { registry: "@official", recipe: "svc" },
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

d("recipe service (db)", () => {
  const fakeFetch = (async () => new Response(YAML, { status: 200 })) as unknown as typeof fetch;

  let db: Db;
  let nodeId: string;

  beforeAll(async () => {
    const handle = createDbHandle(url!);
    await handle.migrate();
    db = handle.db;
    nodeId = randomUUID();
    await db.insert(nodes).values({ id: nodeId, name: `svc-${nodeId.slice(0, 8)}`, kind: "spark", role: "standalone", host: "localhost", agentTokenHash: "x", agentTokenEnc: "x" });
  });

  it("install stages checksummed files and returns a job id", async () => {
    const row = entry({ slug: "svc-recipe-" + randomUUID().slice(0, 8) });
    await db.insert(recipeCatalog).values(row);
    const captured: Array<{ nodeId: string; kind: string; params: unknown }> = [];
    const svc = createRecipesService(db, { createJob: async (n, k, p) => { captured.push({ nodeId: n, kind: k, params: p }); return { id: "job-svc-1" }; }, fetchImpl: fakeFetch });
    const jobId = await svc.install(row.id, { headNodeId: nodeId, port: 9100 });
    expect(jobId).toBe("job-svc-1");
    expect(captured[0]!.nodeId).toBe(nodeId);
    expect(captured[0]!.kind).toBe("recipe-install");
    const params = captured[0]!.params as { files: Array<{ rel: string; sha256: string }>; meta: { slug: string; port: number; model: string } };
    expect(params.files.map((f) => f.rel)).toEqual(["start.sh", "stop.sh"]);
    expect(params.meta).toMatchObject({ port: 9100, model: "Qwen/Qwen3.8-27B-FP8" });
  });

  it("a settled recipe-install job yields the wizard draft", async () => {
    const jobId = randomUUID();
    await db.insert(jobs).values({ id: jobId, nodeId, kind: "recipe-install", status: "succeeded", params: { dir: "/opt/irori/recipes/svc-recipe", files: [], meta: { recipeId: randomUUID(), slug: "svc-recipe", name: "Svc recipe", port: 8000, model: "m", minNodes: 1, startupTimeoutMs: 600_000 } } });
    await db.insert(jobOutput).values({ jobId, seq: 1, line: JSON.stringify({ paths: ["/opt/irori/recipes/svc-recipe/start.sh", "/opt/irori/recipes/svc-recipe/stop.sh"] }) });
    const svc = createRecipesService(db, { createJob: async () => ({ id: "x" }), fetchImpl: fakeFetch });
    const draft = await svc.draft(jobId);
    expect(draft).not.toBeNull();
    expect(draft!.name).toBe("Svc recipe");
    expect(draft!.kind).toBe("single");
    expect(draft!.scriptStart).toBe("/opt/irori/recipes/svc-recipe/start.sh");
  });

  it("list filters unpinned rows; hide curation sticks", async () => {
    const runSlug = "svc-" + randomUUID().slice(0, 8);
    const unpinnedSlug = runSlug + "-unpinned";
    await db.insert(recipeCatalog).values(entry({ id: randomUUID(), slug: runSlug + "-pinned", commitSha: "a".repeat(40) }));
    await db.insert(recipeCatalog).values(entry({ id: randomUUID(), slug: unpinnedSlug, commitSha: "" }));
    const svc = createRecipesService(db, { createJob: async () => ({ id: "x" }), fetchImpl: fakeFetch });
    const { recipes } = await svc.list();
    expect(recipes.some((r) => r.slug === unpinnedSlug)).toBe(false); // unpinned hidden
    const hidden = recipes.find((r) => r.slug === runSlug + "-pinned")!;
    expect(hidden).toBeDefined();
    await svc.setHidden(hidden.id, true);
    const after = await svc.list();
    expect(after.recipes.some((r) => r.slug === runSlug + "-pinned")).toBe(false); // hide sticks
  });

  it("buildStageParams needs a pinned sha", async () => {
    expect(await buildStageParams(entry({ commitSha: "" }), async () => new Response(YAML))).toBeNull();
    const params = await buildStageParams(entry({}), async () => new Response(YAML));
    expect(params!.files[0]!.content).toContain("docker run -d");
  });
});
