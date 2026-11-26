import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { AGENT_UPDATE_MIN_VERSION } from "@irori/core";
import type { NodeRecord, NodeStore } from "@irori/db";
import { createApp, type AppDeps } from "../src/app.js";
import { createRings } from "../src/rings.js";
import { createSseHub } from "../src/sse.js";
import { JobBusyError, JobDispatchError, type JobRow, type JobsService } from "../src/jobs-service.js";
import type { BenchService } from "../src/bench-service.js";
import type { SetupsService } from "../src/setups-service.js";
import { makeFakeStore } from "./helpers.js";

/**
 * IRI-011/012 route tests — artifact serving + the agent-update dispatch
 * guards. No DB: stores/services are stubs at the AppDeps seam.
 */

/** The repo copies the monorepo resolver serves (apps/server/test → apps/agent). */
const REPO_INSTALLER = new URL("../../agent/install-agent.sh", import.meta.url).pathname;
const REPO_UNIT = new URL("../../agent/irori-agent.service", import.meta.url).pathname;
const REPO_ARTIFACTS = { installer: REPO_INSTALLER, unit: REPO_UNIT, bundle: REPO_UNIT };

const OLD_NODE: NodeRecord = {
  id: randomUUID(),
  name: "old-agent",
  kind: "spark",
  role: "standalone",
  host: "localhost",
  enabled: true,
  agentTokenHash: "x",
  agentTokenEnc: "x",
  agentVersion: "0.2.0",
  sortOrder: 0,
  llmPorts: [],
  nasRoot: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function stubStore(record: NodeRecord | null): NodeStore {
  return {
    get: async (id: string) => (record !== null && id === record.id ? record : null),
  } as unknown as NodeStore;
}

function stubJobs(create: JobsService["create"]): JobsService {
  return { create } as unknown as JobsService;
}

const UPDATE_ROW = (nodeId: string): JobRow => ({
  id: randomUUID(),
  nodeId,
  kind: "agent-update",
  status: "running",
  params: { expectedVersion: "9.9.9" },
  exitCode: null,
  createdAt: new Date(),
  startedAt: new Date(),
  finishedAt: null,
});

function makeApp(overrides: Partial<AppDeps> = {}) {
  const fake = makeFakeStore();
  const deps: AppDeps = {
    getStore: () => fake.store,
    getLlmStore: () => null,
    getHistory: () => null,
    getLlmHistory: () => null,
    getJobs: () => null,
    getSetups: () => null,
    getBench: () => null,
    getAnalytics: () => null,
    getCleanup: () => null,
    dbHealthy: async () => true,
    rings: createRings(),
    sse: createSseHub({ heartbeatMs: 0 }),
    getHub: () => ({ online: () => new Set<string>(), sendToNode: () => false, isScopeCapable: () => false }),
    version: "9.9.9",
    tag: "dev-0.3.0-dev.4",
    staticDir: null,
    agentArtifacts: null,
    ...overrides,
  };
  return { app: createApp(deps), deps, fake };
}

describe("agent artifact routes (IRI-011)", () => {
  it("serves the repo installer byte-identically with download headers", async () => {
    const { app } = makeApp({ agentArtifacts: REPO_ARTIFACTS });
    const res = await request(app).get("/install-agent.sh").buffer(true).parse(rawBody);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/x-shellscript");
    expect(res.headers["content-disposition"]).toContain("install-agent.sh");
    expect(res.body.toString()).toEqual(readFileSync(REPO_INSTALLER, "utf8"));
  });

  it("IRI-156: the served installer restarts the unit and only trusts post-restart journal lines", async () => {
    const { app } = makeApp({ agentArtifacts: REPO_ARTIFACTS });
    const script = (await request(app).get("/install-agent.sh").buffer(true).parse(rawBody)).body.toString();
    // `enable --now` is a no-op on a running unit — a re-run must restart it.
    expect(script).toContain("systemctl restart irori-agent.service");
    expect(script).not.toMatch(/^systemctl enable --now/m);
    // Success/error lines are read after a cursor taken before the restart.
    expect(script.indexOf("START_CURSOR=")).toBeLessThan(script.indexOf("systemctl restart irori-agent.service"));
    expect(script).toContain('--after-cursor "$START_CURSOR"');
    expect(script).not.toContain('--since "-2 min"');
    // Warn-only WebSocket preflight (TLS proxy 301 / stripped Upgrade).
    expect(script).toContain("preflight_ws");
  });

  it("serves the unit file", async () => {
    const { app } = makeApp({ agentArtifacts: REPO_ARTIFACTS });
    const res = await request(app).get("/irori-agent.service").buffer(true).parse(rawBody);
    expect(res.status).toBe(200);
    expect(res.body.toString()).toEqual(readFileSync(REPO_UNIT, "utf8"));
  });

  it("IRI-157: serves artifacts installed under a hidden directory", async () => {
    // send() 404s any dot-segment in an absolute path unless the dot part is
    // the root — a hub checked out under e.g. ~/.herdr/ answered 500 here.
    const dir = join(mkdtempSync(join(tmpdir(), "irori-iri157-")), ".hidden", "agent");
    mkdirSync(dir, { recursive: true });
    const installer = join(dir, "install-agent.sh");
    const unit = join(dir, "irori-agent.service");
    copyFileSync(REPO_INSTALLER, installer);
    copyFileSync(REPO_UNIT, unit);
    const { app } = makeApp({ agentArtifacts: { installer, unit, bundle: unit } });
    for (const [path, src] of [["/install-agent.sh", REPO_INSTALLER], ["/irori-agent.service", REPO_UNIT], ["/agent/irori-agent.mjs", REPO_UNIT]] as const) {
      const res = await request(app).get(path).buffer(true).parse(rawBody);
      expect(res.status, path).toBe(200);
      expect(res.body.toString()).toEqual(readFileSync(src, "utf8"));
    }
  });

  it("answers 503 when artifacts are unavailable", async () => {
    const { app } = makeApp();
    for (const path of ["/install-agent.sh", "/irori-agent.service", "/agent/irori-agent.mjs"]) {
      const res = await request(app).get(path);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: "agent artifacts not available" });
    }
  });

  it("reports the hub version", async () => {
    const { app } = makeApp();
    const res = await request(app).get("/api/v1/version");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ version: "9.9.9", tag: "dev-0.3.0-dev.4" });
  });
});

describe("POST /api/v1/nodes/:id/agent-update (IRI-012)", () => {
  it("400s malformed ids and 404s unknown nodes", async () => {
    const { app } = makeApp();
    expect((await request(app).post("/api/v1/nodes/nope/agent-update")).status).toBe(400);
    expect((await request(app).post(`/api/v1/nodes/${randomUUID()}/agent-update`)).status).toBe(404);
  });

  it("dispatches an agent-update job carrying the hub version", async () => {
    const calls: Array<{ nodeId: string; kind: string; params: Record<string, unknown> }> = [];
    const { app, fake } = makeApp({
      getJobs: () =>
        stubJobs(async (nodeId, kind, params) => {
          calls.push({ nodeId, kind, params });
          return UPDATE_ROW(nodeId);
        }),
    });
    const created = await fake.store.create({ name: "spark1", kind: "spark", role: "head", host: "s1" });
    const res = await request(app).post(`/api/v1/nodes/${created.id}/agent-update`);
    expect(res.status).toBe(202);
    expect(res.body.job).toMatchObject({ kind: "agent-update", params: { expectedVersion: "9.9.9" } });
    expect(calls).toEqual([{ nodeId: created.id, kind: "agent-update", params: { expectedVersion: "9.9.9" } }]);
  });

  it("409s when the node already has an active job or the dispatch fails", async () => {
    const { app, fake } = makeApp({ getJobs: () => stubJobs(async () => { throw new JobBusyError("node already has an active job"); }) });
    const created = await fake.store.create({ name: "spark1", kind: "spark", role: "head", host: "s1" });
    const offline = makeApp({
      getStore: () => stubStore({ ...OLD_NODE, agentVersion: null, id: created.id }),
      getJobs: () => stubJobs(async () => { throw new JobDispatchError("node is not connected"); }),
    }).app;
    expect((await request(app).post(`/api/v1/nodes/${created.id}/agent-update`)).status).toBe(409);
    expect((await request(offline).post(`/api/v1/nodes/${created.id}/agent-update`)).status).toBe(409);
  });

  it("refuses agents older than the kind itself with the one-liner hint", async () => {
    const { app } = makeApp({ getStore: () => stubStore(OLD_NODE) });
    const res = await request(app).post(`/api/v1/nodes/${OLD_NODE.id}/agent-update`);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain(AGENT_UPDATE_MIN_VERSION);
  });

  it("refuses while a benchmark is running on the node", async () => {
    const { app, fake } = makeApp({
      getJobs: () => stubJobs(async () => { throw new JobBusyError("unreachable"); }),
      getBench: (() => ({ active: async () => [{ id: "run-1" }] })) as unknown as () => BenchService | null,
    });
    const created = await fake.store.create({ name: "spark1", kind: "spark", role: "head", host: "s1" });
    const res = await request(app).post(`/api/v1/nodes/${created.id}/agent-update`);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("benchmark");
  });

  it("refuses while a setup is running on the node", async () => {
    const busyNode = { id: "" };
    const { app, fake } = makeApp({
      getJobs: () => stubJobs(async () => { throw new JobBusyError("unreachable"); }),
      getSetups: (() => ({ list: async () => [{ headNodeId: busyNode.id, status: "running" }] })) as unknown as () => SetupsService | null,
    });
    const created = await fake.store.create({ name: "spark1", kind: "spark", role: "head", host: "s1" });
    busyNode.id = created.id;
    const res = await request(app).post(`/api/v1/nodes/${created.id}/agent-update`);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("setup");
  });

  it("allows the update while a setup runs on a scope-capable agent (ADR-0017)", async () => {
    const busyNode = { id: "" };
    const { app, fake } = makeApp({
      // The job dispatch itself still refuses (busy node) — the point is the
      // error provenance: the setups guard was bypassed, the job layer spoke.
      getJobs: () => stubJobs(async () => { throw new JobBusyError("unreachable"); }),
      getSetups: (() => ({ list: async () => [{ headNodeId: busyNode.id, status: "running" }] })) as unknown as () => SetupsService | null,
      getHub: () => ({ online: () => new Set<string>(), sendToNode: () => false, isScopeCapable: () => true }),
    });
    const created = await fake.store.create({ name: "spark1", kind: "spark", role: "head", host: "s1" });
    busyNode.id = created.id;
    const res = await request(app).post(`/api/v1/nodes/${created.id}/agent-update`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("unreachable");
  });
});

/** supertest leaves unknown content types as a Buffer when parsed this way. */
function rawBody(res: import("node:http").IncomingMessage, cb: (err: Error | null, body?: unknown) => void): void {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
}
