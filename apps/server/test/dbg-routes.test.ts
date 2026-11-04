import request from "supertest";
import { it } from "vitest";
import type { AppDeps } from "../src/app.js";
import { createApp } from "../src/app.js";
import { createRings } from "../src/rings.js";
import { createSseHub } from "../src/sse.js";
import { makeFakeStore } from "./helpers.js";
import type { RecipeService } from "../src/recipes.js";

const svc: RecipeService = {
  list: async () => ({ recipes: [], seedVersion: 1 }),
  setHidden: async () => {},
  pin: async () => null,
  install: async () => "job-1",
  draft: async () => null,
} as never;

const deps = {
  getStore: () => makeFakeStore().store,
  getLlmStore: () => null,
  getHistory: () => null,
  getLlmHistory: () => null,
  dbHealthy: async () => true,
  rings: createRings(),
  sse: createSseHub({ heartbeatMs: 0 }),
  getHub: () => ({ online: () => new Set<string>(), sendToNode: () => true, refreshConfig: async () => true }),
  getJobs: () => null,
  getInventory: () => null,
  getRecipes: () => svc,
  hfQuants: { listQuants: async () => ({}) } as never,
  version: "test",
  tag: null,
  staticDir: null,
} as unknown as AppDeps;

it("dbg", async () => {
  const res = await request(createApp(deps)).post("/api/v1/recipes/11111111-1111-1111-1111-111111111111/install").send({ headNodeId: "11111111-1111-1111-1111-111111111111" });
  console.log("STATUS", res.status, JSON.stringify(res.body));
});
