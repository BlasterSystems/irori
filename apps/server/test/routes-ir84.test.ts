import request from "supertest";
import { describe, expect, it } from "vitest";
import type { NodeStore } from "@irori/db";
import { createApp, type AppDeps } from "../src/app.js";
import { createRings } from "../src/rings.js";
import { createSseHub } from "../src/sse.js";
import { makeFakeStore } from "./helpers.js";
import type { RecipeService } from "../src/recipes.js";
import type { CommunityService } from "../src/community.js";

/**
 * IRI-084: endpoint tier for the newer routes (updates matrix, recipes,
 * community) — the deps are fakes so no db is needed; the 503 paths for a
 * missing service are part of the contract (dead source never blocks).
 */

function makeApp(opts: { recipes?: RecipeService | null; community?: CommunityService | null; baseline?: unknown; inventory?: unknown; store?: NodeStore | null } = {}) {
  const fake = makeFakeStore();
  const deps: AppDeps = {
    getStore: () => (opts.store === undefined ? fake.store : opts.store),
    getLlmStore: () => null,
    getHistory: () => null,
    getLlmHistory: () => null,
    dbHealthy: async () => true,
    rings: createRings(),
    sse: createSseHub({ heartbeatMs: 0 }),
    getHub: () => ({ online: () => new Set<string>(), sendToNode: () => true, refreshConfig: async () => true }),
    getJobs: () => null,
    getInventory: () => (opts.inventory === undefined ? null : (opts.inventory as never)),
    getBaseline: opts.baseline === undefined ? undefined : (async () => opts.baseline as never),
    getRecipes: opts.recipes === undefined ? undefined : () => (opts.recipes as never),
    getCommunity: opts.community === undefined ? undefined : () => (opts.community as never),
    getHfToken: null,
    hfQuants: { listQuants: async () => ({}) } as never,
    version: "test",
    tag: null,
    staticDir: null,
  };
  return { app: createApp(deps), fake };
}

const recipeRow = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "sparkrun-qwen3.8-27b-fp8-mtp",
  name: "Qwen3.8 27B FP8 + MTP",
  author: "spark-arena",
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
  nodeCountMax: 3,
  scriptStart: "recipes/qwen3.8-27b-fp8-mtp.yaml",
  scriptStop: "stop.sh",
  provenance: { registry: "@official", recipe: "qwen3.8-27b-fp8-mtp" },
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
};

const recipeService = (over: Partial<RecipeService> = {}): RecipeService =>
  ({
    list: async () => ({ recipes: [recipeRow], seedVersion: 1 }),
    setHidden: async () => {},
    pin: async () => "b".repeat(40),
    install: async () => "job-1",
    draft: async () => null,
    ...over,
  }) as never;

const communityService = (over: Partial<CommunityService> = {}): CommunityService =>
  ({
    view: async () => ({
      sources: [{ source: "forum:gb10-top", ok: false, failures: 5, lastFetchedAt: null, breakerOpen: true }],
      topics: [{ topic: "updates/OTA", count: 2 }],
      items: [{ id: "i1", source: "forum:gb10-top", title: "GB10 rebooting after update", summary: null, canonicalUrl: "https://x", author: null, publishedAt: "2026-11-01T00:00:00.000Z", score: 12, pinned: false, seen: false, embedOnly: false }],
      releases: [{ id: "r1", source: "atom:sparkrun-releases", title: "sparkrun 0.4.2", canonicalUrl: "https://x", publishedAt: null }],
    }),
    curate: async () => {},
    poll: async () => {},
    ...over,
  }) as never;

describe("GET /api/v1/recipes", () => {
  it("lists the catalog with seedVersion", async () => {
    const { app } = makeApp({ recipes: recipeService() });
    const res = await request(app).get("/api/v1/recipes");
    expect(res.status).toBe(200);
    expect(res.body.seedVersion).toBe(1);
    expect(res.body.recipes[0].slug).toBe("sparkrun-qwen3.8-27b-fp8-mtp");
    expect(res.body.recipes[0].commitSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("503s when the catalog service is unavailable", async () => {
    const { app } = makeApp({ recipes: null });
    expect((await request(app).get("/api/v1/recipes")).status).toBe(503);
  });
});

describe("POST /api/v1/recipes/:id/install", () => {
  it("validates the body and returns the job id", async () => {
    let captured: unknown = null;
    const svc = recipeService({ install: (async (_id: string, req: unknown) => { captured = req; return "job-9"; }) as never });
    const { app } = makeApp({ recipes: svc });
    const bad = await request(app).post(`/api/v1/recipes/11111111-1111-4111-8111-111111111111/install`).send({ headNodeId: "nope" });
    expect(bad.status).toBe(400);
    const ok = await request(app).post(`/api/v1/recipes/11111111-1111-4111-8111-111111111111/install`).send({ headNodeId: "11111111-1111-4111-8111-111111111111", port: 9000 });
    expect(ok.status).toBe(202);
    expect((ok.body as { jobId: string }).jobId).toBe("job-9");
    expect(captured).toMatchObject({ headNodeId: "11111111-1111-4111-8111-111111111111", port: 9000 });
  });

  it("surfaces staging failures as 409", async () => {
    const { app } = makeApp({ recipes: recipeService({ install: (async () => { throw new Error("recipe staging failed (upstream fetch)"); }) as never }) });
    const res = await request(app).post(`/api/v1/recipes/11111111-1111-4111-8111-111111111111/install`).send({ headNodeId: "11111111-1111-4111-8111-111111111111" });
    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toContain("staging failed");
  });
});

describe("GET /api/v1/recipes/drafts/:jobId", () => {
  it("404s until the job settles", async () => {
    const { app } = makeApp({ recipes: recipeService({ draft: async () => null }) });
    expect((await request(app).get("/api/v1/recipes/drafts/job-1")).status).toBe(404);
  });

  it("returns the draft when settled", async () => {
    const { app } = makeApp({
      recipes: recipeService({
        draft: (async () => ({ name: "Qwen3.8 27B FP8 + MTP", port: 8000, kind: "single", headNodeId: "11111111-1111-4111-8111-111111111111", workerNodeIds: [], envExports: {}, captureProxy: true, bodyRetention: false, startupTimeoutMs: 600_000, scriptStart: "/opt/irori/recipes/x/start.sh", scriptStop: "/opt/irori/recipes/x/stop.sh", recipeId: "11111111-1111-4111-8111-111111111111" })) as never,
      }),
    });
    const res = await request(app).get("/api/v1/recipes/drafts/job-1");
    expect(res.status).toBe(200);
    expect((res.body as { scriptStart: string }).scriptStart).toContain("/opt/irori/recipes");
  });
});

describe("GET /api/v1/community", () => {
  it("serves the view with a degraded source flagged", async () => {
    const { app } = makeApp({ community: communityService() });
    const res = await request(app).get("/api/v1/community");
    expect(res.status).toBe(200);
    expect((res.body as { sources: Array<{ breakerOpen: boolean }> }).sources[0]!.breakerOpen).toBe(true);
    expect((res.body as { topics: Array<{ topic: string }> }).topics[0]!.topic).toBe("updates/OTA");
  });

  it("503s without the service (dead source never blocks)", async () => {
    const { app } = makeApp({ community: null });
    expect((await request(app).get("/api/v1/community")).status).toBe(503);
  });
});

describe("POST /api/v1/community/:id", () => {
  it("persists curation flags", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { app } = makeApp({ community: communityService({ curate: (async (id: string, patch: Record<string, unknown>) => { seen.push({ id, ...patch }); }) as never }) });
    const res = await request(app).post("/api/v1/community/i1").send({ hidden: true, pinned: true });
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ id: "i1", hidden: true, pinned: true }]);
  });
});

describe("GET /api/v1/updates", () => {
  const seedNode = async (fake: ReturnType<typeof makeFakeStore>["fake"]): Promise<string> =>
    (await fake.store.create({ name: "dgx1", kind: "spark", role: "standalone", host: "localhost" } as never)).id;

  it("builds the fleet matrix from inventory reports + baseline", async () => {
    const { app, fake } = makeApp({ inventory: { get: async () => ({ report: { updates: { dgxOsVersion: "7.6.0", nvidiaDriverVersion: "580.178.04", pendingReboot: false, upgradableCount: 0, aptPresent: true } } }) }, baseline: { dgxOs: "7.6.0", driver: "580.178.04", kernel: null, uefi: null, ec: null, soc: null, source: "live", fetchedAtMs: Date.now() } });
    await seedNode(fake);
    const res = await request(app).get("/api/v1/updates");
    expect(res.status).toBe(200);
    expect((res.body as { nodes: Array<{ posture: string }> }).nodes[0]!.posture).toBe("up to date");
    expect((res.body as { baseline: { source: string } }).baseline.source).toBe("live");
  });

  it("flags pending reboot ahead of the baseline comparison", async () => {
    const { app, fake } = makeApp({ inventory: { get: async () => ({ report: { updates: { dgxOsVersion: "7.6.0", nvidiaDriverVersion: "580.178.04", pendingReboot: true, upgradableCount: 0, aptPresent: true } } }) }, baseline: { dgxOs: null, driver: null, kernel: null, uefi: null, ec: null, soc: null, source: "cache", fetchedAtMs: null } });
    await seedNode(fake);
    const res = await request(app).get("/api/v1/updates");
    expect((res.body as { nodes: Array<{ posture: string }> }).nodes[0]!.posture).toBe("pending reboot");
  });

  it("does not count generic apt upgradables as behind (IR-243)", async () => {
    const { app, fake } = makeApp({ inventory: { get: async () => ({ report: { updates: { dgxOsVersion: "7.6.0", nvidiaDriverVersion: "580.178.04", pendingReboot: false, upgradableCount: 125, aptPresent: true } } }) }, baseline: { dgxOs: "7.6.0", driver: "580.178.04", kernel: null, uefi: null, ec: null, soc: null, source: "live", fetchedAtMs: Date.now() } });
    await seedNode(fake);
    const res = await request(app).get("/api/v1/updates");
    expect((res.body as { nodes: Array<{ posture: string }> }).nodes[0]!.posture).toBe("up to date");
  });

  it("flags behind only on a version mismatch with the baseline", async () => {
    const { app, fake } = makeApp({ inventory: { get: async () => ({ report: { updates: { dgxOsVersion: "7.5.0", nvidiaDriverVersion: "580.178.04", pendingReboot: false, upgradableCount: 0, aptPresent: true } } }) }, baseline: { dgxOs: "7.6.0", driver: "580.178.04", kernel: null, uefi: null, ec: null, soc: null, source: "live", fetchedAtMs: Date.now() } });
    await seedNode(fake);
    const res = await request(app).get("/api/v1/updates");
    expect((res.body as { nodes: Array<{ posture: string }> }).nodes[0]!.posture).toBe("behind");
  });

  it("flags behind on pending NVIDIA/DGX packages even when the baseline matches (IR-258)", async () => {
    const { app, fake } = makeApp({ inventory: { get: async () => ({ report: { updates: { dgxOsVersion: "7.6.0", nvidiaDriverVersion: "580.178.04", pendingReboot: false, upgradableCount: 125, nvidiaDgxPending: 17, aptPresent: true } } }) }, baseline: { dgxOs: "7.6.0", driver: "580.178.04", kernel: null, uefi: null, ec: null, soc: null, source: "live", fetchedAtMs: Date.now() } });
    await seedNode(fake);
    const res = await request(app).get("/api/v1/updates");
    expect((res.body as { nodes: Array<{ posture: string }> }).nodes[0]!.posture).toBe("behind");
  });

  it("keeps generic upgradable counts non-verdict (IR-243) — no nvidia subset means up to date", async () => {
    const { app, fake } = makeApp({ inventory: { get: async () => ({ report: { updates: { dgxOsVersion: "7.6.0", nvidiaDriverVersion: "580.178.04", pendingReboot: false, upgradableCount: 240, aptPresent: true } } }) }, baseline: { dgxOs: "7.6.0", driver: "580.178.04", kernel: null, uefi: null, ec: null, soc: null, source: "live", fetchedAtMs: Date.now() } });
    await seedNode(fake);
    const res = await request(app).get("/api/v1/updates");
    expect((res.body as { nodes: Array<{ posture: string }> }).nodes[0]!.posture).toBe("up to date");
  });

  it("treats a missing updates block as unknown", async () => {
    const { app, fake } = makeApp({ inventory: { get: async () => ({ report: {} }) }, baseline: null });
    await seedNode(fake);
    const res = await request(app).get("/api/v1/updates");
    expect((res.body as { nodes: Array<{ posture: string }> }).nodes[0]!.posture).toBe("unknown");
  });

  it("carries the report's collection time for the age label (IR-255)", async () => {
    const { app, fake } = makeApp({
      inventory: { get: async () => ({ report: { updates: { dgxOsVersion: "7.6.0", nvidiaDriverVersion: "580.178.04", pendingReboot: false, upgradableCount: 0, aptPresent: true } }, updatedAt: "2026-11-15T10:00:00.000Z" }) },
      baseline: { dgxOs: "7.6.0", driver: "580.178.04", kernel: null, uefi: null, ec: null, soc: null, source: "live", fetchedAtMs: Date.now() },
    });
    await seedNode(fake);
    const res = await request(app).get("/api/v1/updates");
    expect(res.status).toBe(200);
    expect((res.body as { nodes: Array<{ reportAt: string | null }> }).nodes[0]!.reportAt).toBe("2026-11-15T10:00:00.000Z");
  });

  it("nulls reportAt when the node has no inventory row (IR-255)", async () => {
    const { app, fake } = makeApp({ inventory: { get: async () => null }, baseline: null });
    await seedNode(fake);
    const res = await request(app).get("/api/v1/updates");
    expect(res.status).toBe(200);
    expect((res.body as { nodes: Array<{ reportAt: string | null }> }).nodes[0]!.reportAt).toBeNull();
  });
});
