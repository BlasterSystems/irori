import { describe, expect, it } from "vitest";
import request from "supertest";
import { nodeInfoSchema } from "@irori/core";
import type { NodeStore } from "@irori/db";
import { createApp, type AppDeps } from "../src/app.js";
import { JobBusyError } from "../src/jobs-service.js";
import { createRings } from "../src/rings.js";
import { createSseHub } from "../src/sse.js";
import { makeFakeStore, makeSnapshot } from "./helpers.js";

function makeApp(opts: { store?: NodeStore | null; dbHealthy?: () => Promise<boolean>; jobs?: unknown; inventory?: unknown; hfToken?: { get: () => Promise<string | null>; set: (t: string | null) => Promise<void> }; hfQuants?: { listQuants: (repo: string, token?: string | null) => Promise<unknown> } } = {}) {
  const fake = makeFakeStore();
  const online = new Set<string>();
  const refreshed: string[] = [];
  const deps: AppDeps = {
    getStore: () => (opts.store === undefined ? fake.store : opts.store),
    getLlmStore: () => null,
    getHistory: () => null,
    getLlmHistory: () => null,
    dbHealthy: opts.dbHealthy ?? (async () => true),
    rings: createRings(),
    sse: createSseHub({ heartbeatMs: 0 }),
    getHub: () => ({
      online: () => online,
      sendToNode: () => true,
      refreshConfig: async (nodeId: string) => {
        refreshed.push(nodeId);
        return true;
      },
    }),
    getJobs: opts.jobs === undefined ? () => null : () => (opts.jobs as never),
    getInventory: opts.inventory === undefined ? () => null : () => (opts.inventory as never),
    getHfToken: () => (opts.hfToken === undefined ? null : opts.hfToken),
    hfQuants: (opts.hfQuants ?? { listQuants: async () => ({}) }) as never,
    version: "test",
    tag: null,
    staticDir: null,
  };
  return { app: createApp(deps), fake, online, refreshed, rings: deps.rings };
}

describe("app", () => {
  it("reports health with db status and version", async () => {
    const { app } = makeApp();
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, db: true, version: "test" });
  });

  it("reports db:false when the database is not healthy", async () => {
    const { app } = makeApp({ dbHealthy: async () => false });
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, db: false, version: "test" });
  });

  it("answers 503 on store-backed routes while degraded", async () => {
    const { app } = makeApp({ store: null });
    const res = await request(app).get("/api/v1/nodes");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "database unavailable" });
  });

  it("creates a node and returns the token once", async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post("/api/v1/nodes")
      .send({ name: "spark1", kind: "spark", role: "head", host: "spark1.local" });
    expect(res.status).toBe(201);
    expect(typeof res.body.token).toBe("string");
    const node = nodeInfoSchema.parse(res.body.node);
    expect(node).toMatchObject({ name: "spark1", kind: "spark", role: "head", enabled: true, online: false });

    // IR-68: agent-update must go through the dedicated endpoint - the
    // generic one cannot inject expectedVersion, so the job would never
    // settle and would block the node's single-active slot forever.
    const bad = await request(app)
      .post(`/api/v1/nodes/${node.id}/jobs`)
      .send({ kind: "agent-update", params: {} });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("/agent-update");
  });

  it("rejects invalid create payloads with 400", async () => {
    const { app } = makeApp();
    const res = await request(app).post("/api/v1/nodes").send({ name: "", kind: "toaster", role: "head" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid request");
    expect(Array.isArray(res.body.issues)).toBe(true);
  });

  it("lists nodes as nodeInfo DTOs with hub online flags", async () => {
    const { app, fake, online } = makeApp();
    const a = await fake.store.create({ name: "spark1", kind: "spark", role: "head", host: "spark1.local" });
    const b = await fake.store.create({ name: "spark2", kind: "spark", role: "worker", host: "spark2.local" });
    online.add(b.id);

    const res = await request(app).get("/api/v1/nodes");
    expect(res.status).toBe(200);
    const nodes = res.body.map((n: unknown) => nodeInfoSchema.parse(n));
    expect(nodes.map((n) => n.name)).toEqual(["spark1", "spark2"]);
    expect(nodes.find((n) => n.id === a.id)?.online).toBe(false);
    expect(nodes.find((n) => n.id === b.id)?.online).toBe(true);
  });

  it("patches a node and returns the updated DTO", async () => {
    const { app, fake } = makeApp();
    const { id } = await fake.store.create({ name: "spark1", kind: "spark", role: "head", host: "spark1.local" });
    const res = await request(app).patch(`/api/v1/nodes/${id}`).send({ name: "renamed", enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.node).toMatchObject({ name: "renamed", enabled: false });
  });

  it("404s patch/delete/rotate for unknown nodes and 400s malformed ids", async () => {
    const { app } = makeApp();
    const unknown = "00000000-0000-4000-8000-000000000000";
    expect((await request(app).patch(`/api/v1/nodes/${unknown}`).send({ name: "x" })).status).toBe(404);
    expect((await request(app).delete(`/api/v1/nodes/${unknown}`)).status).toBe(404);
    expect((await request(app).post(`/api/v1/nodes/${unknown}/token/rotate`)).status).toBe(404);
    expect((await request(app).patch("/api/v1/nodes/not-a-uuid").send({})).status).toBe(400);
  });

  it("rejects invalid patch payloads with 400", async () => {
    const { app, fake } = makeApp();
    const { id } = await fake.store.create({ name: "spark1", kind: "spark", role: "head", host: "spark1.local" });
    const res = await request(app).patch(`/api/v1/nodes/${id}`).send({ role: "emperor" });
    expect(res.status).toBe(400);
  });

  it("deletes a node", async () => {
    const { app, fake } = makeApp();
    const { id } = await fake.store.create({ name: "spark1", kind: "spark", role: "head", host: "spark1.local" });
    const del = await request(app).delete(`/api/v1/nodes/${id}`);
    expect(del.status).toBe(204);
    expect(await fake.store.get(id)).toBeNull();
  });

  it("rotates the agent token", async () => {
    const { app, fake } = makeApp();
    const created = await fake.store.create({ name: "spark1", kind: "spark", role: "head", host: "spark1.local" });
    const res = await request(app).post(`/api/v1/nodes/${created.id}/token/rotate`);
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe("string");
    expect(res.body.token).not.toBe(created.token);
    expect(await fake.store.verifyToken(created.token)).toBeNull();
    expect(await fake.store.verifyToken(res.body.token)).toBe(created.id);
  });

  it("serves the latest ring snapshot per node", async () => {
    const { app, fake, rings } = makeApp();
    const { id } = await fake.store.create({ name: "spark1", kind: "spark", role: "head", host: "spark1.local" });
    expect((await request(app).get(`/api/v1/nodes/${id}/snapshot`)).status).toBe(404);
    const snapshot = makeSnapshot();
    rings.push(id, snapshot);
    const res = await request(app).get(`/api/v1/nodes/${id}/snapshot`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(snapshot);
    expect((await request(app).get("/api/v1/nodes/not-a-uuid/snapshot")).status).toBe(400);
  });

  it("answers presence-only GET for the global HF token (IRI-019)", async () => {
    const tokenSvc = { get: async () => "hf_x", set: async () => {} };
    const { app } = makeApp({ hfToken: tokenSvc });
    const res = await request(app).get("/api/v1/settings/hf-token");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ configured: true }); // never the token itself
  });

  it("answers 503 for the settings routes while the token service is absent", async () => {
    const { app } = makeApp();
    expect((await request(app).get("/api/v1/settings/hf-token")).status).toBe(503);
    expect((await request(app).put("/api/v1/settings/hf-token").send({ hfToken: "hf_x" })).status).toBe(503);
  });

  it("sets the token and pushes config-refresh to every online node", async () => {
    let stored: string | null = null;
    const tokenSvc = { get: async () => stored, set: async (t: string | null) => { stored = t; } };
    const { app, fake, online, refreshed } = makeApp({ hfToken: tokenSvc });
    const { id } = await fake.store.create({ name: "spark1", kind: "spark", role: "head", host: "spark1.local" });
    online.add(id);

    const res = await request(app).put("/api/v1/settings/hf-token").send({ hfToken: "hf_x" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ configured: true });
    expect(stored).toBe("hf_x");
    expect(refreshed).toEqual([id]);

    const get = await request(app).get("/api/v1/settings/hf-token");
    expect(get.body).toEqual({ configured: true });
  });

  it("clears the token with null and still pushes", async () => {
    let stored: string | null = "hf_x";
    const tokenSvc = { get: async () => stored, set: async (t: string | null) => { stored = t; } };
    const { app, online, refreshed } = makeApp({ hfToken: tokenSvc });
    online.add("00000000-0000-4000-8000-000000000009");

    const res = await request(app).put("/api/v1/settings/hf-token").send({ hfToken: null });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ configured: false });
    expect(stored).toBeNull();
    expect(refreshed).toEqual(["00000000-0000-4000-8000-000000000009"]);
  });

  it("rejects invalid token bodies with 400", async () => {
    const { app } = makeApp({ hfToken: { get: async () => null, set: async () => {} } });
    expect((await request(app).put("/api/v1/settings/hf-token").send({ hfToken: "" })).status).toBe(400);
    expect((await request(app).put("/api/v1/settings/hf-token").send({})).status).toBe(400);
  });

  it("forwards the configured token to the quants listing (IRI-019)", async () => {
    const calls: Array<[string, string | null]> = [];
    const listQuants = async (repo: string, token?: string | null) => {
      calls.push([repo, token ?? null]);
      return { repo, modelCard: null, quants: [], companions: { mmproj: { candidates: [], default: null }, mtp: { candidates: [], default: null } } };
    };
    let stored: string | null = "hf_x";
    const tokenSvc = { get: async () => stored, set: async (t: string | null) => { stored = t; } };
    const { app } = makeApp({ hfToken: tokenSvc, hfQuants: { listQuants } });

    await request(app).get("/api/v1/hf-quants?repo=org/model");
    expect(calls).toEqual([["org/model", "hf_x"]]);

    stored = null;
    await request(app).get("/api/v1/hf-quants?repo=org/model");
    expect(calls[1]).toEqual(["org/model", null]);
  });
});

describe("node model inventory + activity routes (IRI-028)", () => {
  const report = {
    generatedAtMs: 1,
    store: { root: "/mnt/llms", source: "catalog", warning: null, models: [{ name: "glm", repository: "org/glm", runtime: "vllm", bytes: 10 }], leftovers: [] },
    local: [],
  };

  it("serves the cached inventory and 404s unknown nodes", async () => {
    const fake = makeFakeStore();
    const { id } = await fake.store.create({ name: "spark1", kind: "spark", role: "head", host: "spark1.local" });
    const inventory = { get: async (nodeId: string) => (nodeId === id ? { report, updatedAt: "2026-10-26T06:00:00.000Z" } : null) };
    const { app } = makeApp({ inventory, store: fake.store });
    const res = await request(app).get(`/api/v1/nodes/${id}/models`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ updatedAt: "2026-10-26T06:00:00.000Z", report: { store: { root: "/mnt/llms" } } });

    const missing = await request(app).get("/api/v1/nodes/00000000-0000-4000-8000-000000000099/models");
    expect(missing.status).toBe(404);
  });

  it("answers 503 when the inventory service is unavailable", async () => {
    const { app, fake } = makeApp();
    const { id } = await fake.store.create({ name: "spark1", kind: "spark", role: "head", host: "spark1.local" });
    expect((await request(app).get(`/api/v1/nodes/${id}/models`)).status).toBe(503);
  });

  it("dispatches models-inventory on refresh and maps busy to 409", async () => {
    const created: Array<{ nodeId: string; kind: string }> = [];
    const jobs = {
      create: async (nodeId: string, kind: string) => {
        created.push({ nodeId, kind });
        return {
          id: "00000000-0000-4000-8000-000000000010",
          nodeId,
          kind,
          status: "running",
          params: {},
          exitCode: null,
          createdAt: new Date("2026-10-26T06:00:00.000Z"),
          startedAt: new Date("2026-10-26T06:00:00.000Z"),
          finishedAt: null,
        };
      },
    };
    const { app, fake } = makeApp({ jobs });
    const { id } = await fake.store.create({ name: "spark1", kind: "spark", role: "head", host: "spark1.local" });
    const res = await request(app).post(`/api/v1/nodes/${id}/models/refresh`);
    expect(res.status).toBe(202);
    expect(res.body.job).toMatchObject({ kind: "models-inventory", status: "running" });
    expect(created).toEqual([{ nodeId: id, kind: "models-inventory" }]);

    const busyJobs = {
      create: async () => {
        throw new JobBusyError("node already has an active job");
      },
    };
    const busy = makeApp({ jobs: busyJobs, store: fake.store });
    expect((await request(busy.app).post(`/api/v1/nodes/${id}/models/refresh`)).status).toBe(409);
  });

  it("lists recent jobs across nodes with the last output line", async () => {
    const jobs = {
      listAll: async (limit: number) => {
        expect(limit).toBe(5);
        return [
          {
            id: "00000000-0000-4000-8000-000000000010",
            nodeId: "00000000-0000-4000-8000-000000000001",
            kind: "sync-local",
            status: "running",
            params: { name: "glm" },
            exitCode: null,
            createdAt: new Date("2026-10-26T06:00:00.000Z"),
            startedAt: new Date("2026-10-26T06:00:01.000Z"),
            finishedAt: null,
            lastLine: "1.2 GB/s",
          },
        ];
      },
    };
    const { app } = makeApp({ jobs });
    const res = await request(app).get("/api/v1/jobs?limit=5");
    expect(res.status).toBe(200);
    expect(res.body.jobs).toEqual([
      {
        id: "00000000-0000-4000-8000-000000000010",
        nodeId: "00000000-0000-4000-8000-000000000001",
        kind: "sync-local",
        status: "running",
        params: { name: "glm" },
        exitCode: null,
        createdAt: "2026-10-26T06:00:00.000Z",
        startedAt: "2026-10-26T06:00:01.000Z",
        finishedAt: null,
        lastLine: "1.2 GB/s",
      },
    ]);
  });
});
