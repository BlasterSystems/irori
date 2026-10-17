import { describe, expect, it } from "vitest";
import request from "supertest";
import { nodeInfoSchema } from "@irori/core";
import type { NodeStore } from "@irori/db";
import { createApp, type AppDeps } from "../src/app.js";
import { createRings } from "../src/rings.js";
import { createSseHub } from "../src/sse.js";
import { makeFakeStore, makeSnapshot } from "./helpers.js";

function makeApp(opts: { store?: NodeStore | null; dbHealthy?: () => Promise<boolean> } = {}) {
  const fake = makeFakeStore();
  const online = new Set<string>();
  const deps: AppDeps = {
    getStore: () => (opts.store === undefined ? fake.store : opts.store),
    dbHealthy: opts.dbHealthy ?? (async () => true),
    rings: createRings(),
    sse: createSseHub({ heartbeatMs: 0 }),
    getHub: () => ({ online: () => online }),
    version: "test",
    staticDir: null,
  };
  return { app: createApp(deps), fake, online, rings: deps.rings };
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
});
