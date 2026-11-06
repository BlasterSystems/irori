import { describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { redactAuditValue, type AuditEntry } from "@irori/core";
import { createApp, type AppDeps } from "../src/app.js";
import { auditInventory, audit, auditReadOnly } from "../src/audit-routes.js";
import type { AuditInput, AuditService } from "../src/audit.js";
import type { LogStore } from "../src/logs-store.js";
import { createRings } from "../src/rings.js";
import { createSseHub } from "../src/sse.js";
import { makeFakeStore } from "./helpers.js";

/**
 * IRI-077 (epic IR-157 WS4): the audit contract at the route layer.
 *
 * The load-bearing test is the route-table coverage one: it walks the REAL
 * Express router and fails when a mutating registration carries no audit
 * action and no explicit read-only declaration. A future `app.post(...)` added
 * without auditing breaks this suite instead of silently escaping the record.
 * DB-backed behaviour (filters, pagination, purge, restart survival) lives in
 * audit-db.test.ts.
 */

interface Recorded {
  input: AuditInput;
  outcome: string;
  error: string | null;
  /** Post-mutation state, delivered as record()'s second argument. */
  after?: unknown;
}

function makeApp(opts: { auditService?: AuditService | null; hfToken?: { get: () => Promise<string | null>; set: (t: string | null) => Promise<void> } } = {}) {
  const recorded: Recorded[] = [];
  const fake = makeFakeStore();
  // `??` would treat an explicit null ("degraded") as absent, so presence is
  // tested by key, not value.
  const service: AuditService | null =
    opts.auditService !== undefined
      ? opts.auditService
      : {
          record: (input, result) => {
            recorded.push({ input, outcome: result?.outcome ?? "ok", error: result?.error ?? null, after: result?.after });
          },
          write: async () => {},
          list: async () => ({ entries: [] as AuditEntry[], nextCursor: null, total: 0 }),
          prune: async () => 0,
        };
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
    getUsage: () => null,
    getUsageClients: () => null,
    getUsageChats: () => null,
    getDownloads: () => null,
    dbHealthy: async () => true,
    rings: createRings(),
    sse: createSseHub({ heartbeatMs: 0 }),
    getHub: () => null,
    hfQuants: { listQuants: async () => ({}) } as never,
    version: "test",
    tag: null,
    staticDir: null,
    getAudit: () => service,
    getHfToken: opts.hfToken === undefined ? undefined : () => opts.hfToken!,
  };
  return { app: createApp(deps), recorded, fake };
}

describe("audit route coverage (IRI-077)", () => {
  it("every mutating route declares an audit action or an explicit read-only exemption", () => {
    const { app } = makeApp();
    const routes = auditInventory(app);
    expect(routes.length).toBeGreaterThan(20);
    const unmanaged = routes.filter((r) => r.action === null && !r.readOnly);
    expect(unmanaged.map((r) => `${r.method} ${r.path}`)).toEqual([]);
  });

  it("actions are domain.verb and target types are populated", () => {
    const { app } = makeApp();
    for (const route of auditInventory(app)) {
      if (route.readOnly) continue;
      expect(route.action, `${route.method} ${route.path}`).toMatch(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/);
      expect(route.targetType, `${route.method} ${route.path}`).toBeTruthy();
    }
  });

  it("audits the whole mutating surface, naming each expected verb", () => {
    const { app } = makeApp();
    const actions = new Set(auditInventory(app).map((r) => r.action));
    for (const action of [
      "node.create",
      "node.patch",
      "node.delete",
      "node.token.rotate",
      "node.agent-update",
      "node.hygiene.put",
      "node.llm-ports.put",
      "node.models-refresh",
      "node.job-dispatch",
      "job.cancel",
      "settings.hf-token.put",
      "settings.cadence-ms.put",
      "settings.energy-cost.put",
      "settings.token-cost.put",
      "settings.modelctl-pin.put",
      "usage-client.create",
      "usage-client.delete",
      "download.enqueue",
      "download.delete",
      "download.retry",
      "model.catalog-refresh",
      "setup.create",
      "setup.patch",
      "setup.delete",
      "setup.start",
      "setup.stop",
      "setup.transfer",
      "transfer.cancel",
      "bench.start",
      "bench.cancel",
    ]) {
      expect(actions.has(action), `missing audit action ${action}`).toBe(true);
    }
  });

  it("catches a mutating route registered without auditing (the guard works)", () => {
    const { app } = makeApp();
    // The coverage test's own failure mode: an unmanaged route must show up as
    // unmanaged, otherwise every future route silently escapes the record.
    app.post("/api/v1/decoy-unmanaged", (_req, res) => res.status(204).end());
    const unmanaged = auditInventory(app).filter((r) => r.action === null && !r.readOnly);
    expect(unmanaged.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /api/v1/decoy-unmanaged"]);
  });
});

describe("audit row content (IRI-077)", () => {
  it("records one row per mutation with actor, action and target", async () => {
    const { app, recorded } = makeApp();
    const created = await request(app).post("/api/v1/nodes").send({ name: "spark1", kind: "spark", role: "head", host: "h" });
    expect(created.status).toBe(201);
    const id = created.body.node.id as string;

    const rows = recorded.filter((r) => r.input.action === "node.create");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.input.targetType).toBe("node");
    // The id only exists after the insert; the handler publishes it.
    expect(rows[0]!.input.targetId).toBe(id);
    expect(rows[0]!.outcome).toBe("ok");
    expect(rows[0]!.input.actor).toBe("anonymous");

    await request(app).delete(`/api/v1/nodes/${id}`).send();
    const del = recorded.find((r) => r.input.action === "node.delete");
    expect(del!.input.targetId).toBe(id);
  });

  it("never records the HF token value, only that it was set", async () => {
    const secret = "hf_S3cr3tTok3nValue";
    const sets: Array<string | null> = [];
    const { app, recorded } = makeApp({
      hfToken: { get: async () => secret, set: async (t) => void sets.push(t) },
    });
    const res = await request(app).put("/api/v1/settings/hf-token").set("x-irori-client", "omp-main").send({ hfToken: secret });
    expect(res.status).toBe(200);
    expect(sets).toEqual([secret]);

    const row = recorded.find((r) => r.input.action === "settings.hf-token.put");
    expect(row).toBeDefined();
    expect(row!.input.summary).toContain("set");
    expect(JSON.stringify(row!.input)).not.toContain(secret);

    // Redaction is a property of what gets stored, not of the caller's care.
    const redacted = redactAuditValue({ hfToken: secret, nested: { token: secret, modelPath: "/models/x" } });
    expect(JSON.stringify(redacted)).not.toContain(secret);
    expect(JSON.stringify(redacted)).toContain("/models/x");
  });

  it("records a cleared token as cleared", async () => {
    const { app, recorded } = makeApp({ hfToken: { get: async () => null, set: async () => {} } });
    await request(app).put("/api/v1/settings/hf-token").send({ hfToken: null });
    const row = recorded.find((r) => r.input.action === "settings.hf-token.put");
    expect(row!.input.summary).toContain("cleared");
  });

  it("attributes the actor from the client identity header", async () => {
    const { app, recorded } = makeApp();
    await request(app).post("/api/v1/usage/clients").set("x-irori-client", "ci-bot").send({ name: "ci" });
    const row = recorded.find((r) => r.input.action === "usage-client.create");
    expect(row!.input.actor).toBe("client");
    expect(row!.input.actorDetail).toBe("ci-bot");
  });

  it("records a rejected attempt as an error row with the guard message (IR-193)", async () => {
    const { app, recorded } = makeApp();
    const res = await request(app).delete("/api/v1/nodes/00000000-0000-4000-8000-000000000000").send();
    expect(res.status).toBe(404);
    const row = recorded.find((r) => r.input.action === "node.delete");
    expect(row!.outcome).toBe("error");
    // The response body's message, not just the status: the durable record
    // must say WHY the mutation was refused.
    expect(row!.error).toBe("node not found");
  });

  it("stores before/after entity state for a patched node", async () => {
    const { app, recorded, fake } = makeApp();
    const created = await fake.store.create({ name: "spark1", kind: "spark", role: "head", host: "h" });
    const res = await request(app).patch(`/api/v1/nodes/${created.id}`).send({ host: "new.local" });
    expect(res.status).toBe(200);
    const row = recorded.find((r) => r.input.action === "node.patch");
    expect(row).toBeDefined();
    expect((row!.input.before as { host: string }).host).toBe("h");
    expect((row!.after as { host: string }).host).toBe("new.local");
  });

  it("degrades silently when the audit service is absent", async () => {
    const { app } = makeApp({ auditService: null });
    const res = await request(app).post("/api/v1/nodes").send({ name: "spark1", kind: "spark", role: "head", host: "h" });
    expect(res.status).toBe(201);
  });
});

describe("audit answer surface (IRI-077)", () => {
  it("GET /api/v1/audit answers 503 while degraded", async () => {
    const { app } = makeApp({ auditService: null });
    expect((await request(app).get("/api/v1/audit")).status).toBe(503);
  });

  it("GET /api/v1/audit validates the query", async () => {
    const { app } = makeApp();
    expect((await request(app).get("/api/v1/audit").query({ range: "nope" })).status).toBe(400);
  });

  it("GET /api/v1/audit returns the service page", async () => {
    const page = { entries: [], nextCursor: null, total: 0 };
    const { app } = makeApp({ auditService: { record: () => {}, write: async () => {}, list: async () => page, prune: async () => 0 } });
    const res = await request(app).get("/api/v1/audit").query({ range: "30d", actor: "hub" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(page);
  });

  it("GET /api/v1/events/journal answers 503 while degraded", async () => {
    const { app } = makeApp();
    expect((await request(app).get("/api/v1/events/journal")).status).toBe(503);
  });
});

describe("logs answer surface (IRI-078)", () => {
  const noopStore = (): LogStore => ({
    ingestBatch: async () => ({ inserted: 0, latestId: null }),
    list: async () => ({ rows: [], nextCursor: null, latestId: null, truncated: false }),
    summary: async () => ({ counts: { trace: 0, debug: 0, info: 0, warn: 0, error: 0 }, total: 0, truncated: false }),
    pruneRaw: async () => 0,
    pruneAll: async () => 0,
  });

  function makeLogApp(logs: LogStore | null | undefined): Express {
    const fake = makeFakeStore();
    return createApp({
      getStore: () => fake.store,
      getLlmStore: () => null,
      getHistory: () => null,
      getLlmHistory: () => null,
      getJobs: () => null,
      getSetups: () => null,
      getBench: () => null,
      getAnalytics: () => null,
      getCleanup: () => null,
      getUsage: () => null,
      getUsageClients: () => null,
      getUsageChats: () => null,
      getDownloads: () => null,
      dbHealthy: async () => true,
      rings: createRings(),
      sse: createSseHub({ heartbeatMs: 0 }),
      getHub: () => null,
      hfQuants: { listQuants: async () => ({}) } as never,
      version: "test",
      tag: null,
      staticDir: null,
      getAudit: () => null,
      // `undefined` (absent) vs null (degraded) — both answer 503.
      ...(logs === undefined ? {} : { getLogs: () => logs }),
    } as AppDeps);
  }

  it("GET /api/v1/logs answers 503 while degraded (absent or null)", async () => {
    expect((await request(makeLogApp(undefined)).get("/api/v1/logs")).status).toBe(503);
    expect((await request(makeLogApp(null)).get("/api/v1/logs")).status).toBe(503);
  });

  it("GET /api/v1/logs validates the query", async () => {
    expect((await request(makeLogApp(noopStore())).get("/api/v1/logs").query({ range: "nope" })).status).toBe(400);
    expect((await request(makeLogApp(noopStore())).get("/api/v1/logs").query({ limit: "9999" })).status).toBe(400);
  });

  it("GET /api/v1/logs returns the store page and passes the tail cursor", async () => {
    const page = { rows: [], nextCursor: null, latestId: "42", truncated: false };
    const seen: unknown[] = [];
    const store = noopStore();
    store.list = async (q) => {
      seen.push(q);
      return page;
    };
    const res = await request(makeLogApp(store)).get("/api/v1/logs").query({ range: "1h", level: "warn", after: "41" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(page);
    expect(seen[0]).toMatchObject({ range: "1h", level: "warn", after: "41" });
  });

  it("GET /api/v1/logs/summary returns per-level counts", async () => {
    const store = noopStore();
    store.summary = async () => ({ counts: { trace: 0, debug: 0, info: 3, warn: 1, error: 0 }, total: 4, truncated: true });
    const res = await request(makeLogApp(store)).get("/api/v1/logs/summary").query({ range: "24h" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ counts: { trace: 0, debug: 0, info: 3, warn: 1, error: 0 }, total: 4, truncated: true });
  });
});

describe("audit marker declarations", () => {
  it("rejects a malformed action at wiring time", () => {
    expect(() => audit({ action: "NodeDelete", targetType: "node" }, () => null)).toThrow(/domain\.verb/);
  });

  it("read-only declarations are route middleware", () => {
    expect(typeof auditReadOnly("probe")).toBe("function");
  });
});
