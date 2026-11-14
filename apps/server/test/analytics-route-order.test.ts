import { describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp, type AppDeps } from "../src/app.js";
import { createRings } from "../src/rings.js";
import { createSseHub } from "../src/sse.js";

/**
 * Regression: the /api/v1/analytics/:lens catch-all (M7) was registered
 * before the concrete /api/v1/analytics/efficiency and
 * /api/v1/analytics/token-reconciliation routes. Express matches in
 * registration order, so both answered 400 "unknown lens" and the web's
 * tokens lens could never render its reconciliation/efficiency sections
 * (defect recorded in tasks/IRI-131-overflow-sweep.md). The concrete routes
 * now precede the catch-all; these pins hold that ordering without a DB —
 * a degraded analytics service answers 503 from the concrete route, while
 * the catch-all still 400s unknown lens names.
 */
function makeApp(): Express {
  const deps = {
    getStore: () => null,
    getLlmStore: () => null,
    getHistory: () => null,
    getLlmHistory: () => null,
    getJobs: () => null,
    getSetups: () => null,
    getBench: () => null,
    getAnalytics: () => null,
    getCleanup: () => null,
    getInventory: () => null,
    getUsage: () => null,
    getUsageClients: () => null,
    getUsageChats: () => null,
    getDownloads: () => null,
    dbHealthy: async () => true,
    rings: createRings(),
    sse: createSseHub({ heartbeatMs: 0 }),
    getHub: () => null,
    version: "test",
    tag: null,
    staticDir: null,
  };
  return createApp(deps as unknown as AppDeps);
}

describe("analytics concrete routes precede the :lens catch-all", () => {
  it("GET /api/v1/analytics/efficiency reaches the concrete route (503 degraded, not 400 unknown lens)", async () => {
    const res = await request(makeApp()).get("/api/v1/analytics/efficiency?range=30d&groupBy=model");
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("database unavailable");
  });

  it("GET /api/v1/analytics/token-reconciliation reaches the concrete route (503 degraded, not 400 unknown lens)", async () => {
    const res = await request(makeApp()).get("/api/v1/analytics/token-reconciliation?range=30d");
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("database unavailable");
  });

  it("unknown lens names still 400 via the catch-all", async () => {
    const res = await request(makeApp()).get("/api/v1/analytics/bogus?range=24h");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unknown lens");
  });
});
