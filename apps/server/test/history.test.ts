import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp, type AppDeps, type HistoryBuilder } from "../src/app.js";
import { historyGranularity, isHistoryRange } from "../src/history.js";
import { createRings } from "../src/rings.js";
import { createSseHub } from "../src/sse.js";
import { makeFakeStore } from "./helpers.js";
import { randomUUID } from "node:crypto";

describe("history granularity selection", () => {
  it("maps each range to its bucket granularity", () => {
    expect(historyGranularity("1h")).toBe("minute");
    expect(historyGranularity("24h")).toBe("hour");
    expect(historyGranularity("7d")).toBe("hour");
    expect(historyGranularity("30d")).toBe("hour");
    expect(historyGranularity("90d")).toBe("day");
  });

  it("isHistoryRange is a narrowing type guard", () => {
    for (const range of ["1h", "24h", "7d", "30d", "90d"]) expect(isHistoryRange(range)).toBe(true);
    expect(isHistoryRange("3h")).toBe(false);
    expect(isHistoryRange("")).toBe(false);
    expect(isHistoryRange("1H")).toBe(false);
  });
});

describe("history route", () => {
  function makeHistoryApp(opts: { store: AppDeps["getStore"]; history: HistoryBuilder | null }) {
    return createApp({
      getStore: opts.store,
      getHistory: () => opts.history,
      dbHealthy: async () => true,
      rings: createRings(),
      sse: createSseHub({ heartbeatMs: 0 }),
      getHub: () => null,
      version: "test",
      staticDir: null,
    });
  }

  it("answers 400 for an invalid node id and an unknown range", async () => {
    const app = makeHistoryApp({ store: () => makeFakeStore().store, history: null });
    const badId = await request(app).get("/api/v1/nodes/nope/history").query({ range: "1h" });
    expect(badId.status).toBe(400);
    expect(badId.body).toEqual({ error: "invalid node id" });

    const badRange = await request(app)
      .get(`/api/v1/nodes/${randomUUID()}/history`)
      .query({ range: "3h" });
    expect(badRange.status).toBe(400);
    expect(badRange.body).toEqual({ error: "unknown range" });
  });

  it("answers 404 for an unknown node", async () => {
    const app = makeHistoryApp({ store: () => makeFakeStore().store, history: null });
    const res = await request(app).get(`/api/v1/nodes/${randomUUID()}/history`).query({ range: "1h" });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "node not found" });
  });

  it("answers 503 while degraded", async () => {
    const app = makeHistoryApp({ store: () => null, history: null });
    const res = await request(app).get(`/api/v1/nodes/${randomUUID()}/history`).query({ range: "1h" });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "database unavailable" });
  });

  it("returns the builder response for a known node", async () => {
    const fake = makeFakeStore();
    const { id } = await fake.store.create({ name: "spark1", kind: "spark", role: "head", host: "spark1.lan" });
    const builder: HistoryBuilder = async () => ({ granularity: "minute", points: [] });
    const app = makeHistoryApp({ store: () => fake.store, history: builder });
    const res = await request(app).get(`/api/v1/nodes/${id}/history`).query({ range: "1h" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ granularity: "minute", points: [] });
  });
});
