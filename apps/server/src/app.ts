import { existsSync } from "node:fs";
import { join } from "node:path";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { nodeCreateSchema, nodeInfoSchema, nodePatchSchema, type NodeInfo } from "@irori/core";
import type { NodeRecord, NodeStore } from "@irori/db";
import { isHistoryRange, type HistoryResponse, type HistoryRange } from "./history.js";
import { type LlmHistoryResponse } from "./llm-history.js";
import type { LlmStore } from "./llm-store.js";
import { nodeLlmAssignments } from "./llm-store.js";
import type { Rings } from "./rings.js";
import type { SseHub } from "./sse.js";
import type { AgentHub } from "./hub.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_NODES_ONLINE: ReadonlySet<string> = new Set();
/** Upper bound on probe assignments accepted per node. */
const MAX_LLM_PORTS = 32;

/** Builds a history response; null while degraded (no DB wired yet). */
export type HistoryBuilder = (nodeId: string, range: HistoryRange) => Promise<HistoryResponse>;

/** Builds an llm history response; null while degraded (no DB wired yet). */
export type LlmHistoryBuilder = (nodeId: string, range: HistoryRange) => Promise<LlmHistoryResponse>;

export interface AppDeps {
  /** Null while degraded (no/migrating DB): store-backed routes answer 503. */
  getStore: () => NodeStore | null;
  /** Null while degraded: history routes answer 503 and llm-ports writes fail. */
  getLlmStore: () => LlmStore | null;
  /** Null while degraded: the history routes answer 503. */
  getHistory: () => HistoryBuilder | null;
  getLlmHistory: () => LlmHistoryBuilder | null;
  dbHealthy: () => Promise<boolean>;
  rings: Rings;
  sse: SseHub;
  getHub: () => Pick<AgentHub, "online"> | null;
  version: string;
  /** apps/web/dist when it exists, else null. */
  staticDir: string | null;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.use(express.json());

  // Degraded mode (ADR-0002): while the store is absent, store-backed routes
  // answer 503 and nothing else in the API is affected.
  const requireStore = (res: Response): NodeStore | null => {
    const store = deps.getStore();
    if (store === null) res.status(503).json({ error: "database unavailable" });
    return store;
  };

  app.get("/healthz", async (_req, res) => {
    res.json({ ok: true, db: await deps.dbHealthy(), version: deps.version });
  });

  app.get("/api/v1/events", (_req, res) => {
    deps.sse.subscribe(res);
  });

  const onlineSet = (): ReadonlySet<string> => deps.getHub()?.online() ?? NO_NODES_ONLINE;

  app.get("/api/v1/nodes", async (_req, res) => {
    const store = requireStore(res);
    if (!store) return;
    const online = onlineSet();
    res.json((await store.list()).map((row) => toNodeDto(row, online.has(row.id))));
  });

  app.post("/api/v1/nodes", async (req, res) => {
    const store = requireStore(res);
    if (!store) return;
    const body = nodeCreateSchema.safeParse(req.body);
    if (!body.success) return sendZodError(res, body.error);
    const created = await store.create(body.data);
    const now = new Date().toISOString();
    const node = nodeInfoSchema.parse({
      id: created.id,
      name: body.data.name,
      kind: body.data.kind,
      role: body.data.role,
      host: body.data.host,
      enabled: body.data.enabled ?? true,
      agentVersion: null,
      online: false,
      lastSeenAt: null,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });
    res.status(201).json({ node, token: created.token });
  });

  app.patch("/api/v1/nodes/:id", async (req, res) => {
    const store = requireStore(res);
    if (!store) return;
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid node id" });
    const body = nodePatchSchema.safeParse(req.body);
    if (!body.success) return sendZodError(res, body.error);
    if ((await store.get(id)) === null) return res.status(404).json({ error: "node not found" });
    await store.patch(id, body.data);
    const row = await store.get(id);
    if (row === null) return res.status(404).json({ error: "node not found" });
    res.json({ node: toNodeDto(row, onlineSet().has(id)) });
  });

  app.delete("/api/v1/nodes/:id", async (req, res) => {
    const store = requireStore(res);
    if (!store) return;
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid node id" });
    if ((await store.get(id)) === null) return res.status(404).json({ error: "node not found" });
    await store.remove(id);
    deps.rings.remove(id);
    res.status(204).end();
  });

  app.post("/api/v1/nodes/:id/token/rotate", async (req, res) => {
    const store = requireStore(res);
    if (!store) return;
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid node id" });
    if ((await store.get(id)) === null) return res.status(404).json({ error: "node not found" });
    const created = await store.rotateToken(id);
    res.json({ token: created.token });
  });

  app.get("/api/v1/nodes/:id/snapshot", async (req, res) => {
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid node id" });
    const snapshot = deps.rings.latest(id);
    if (snapshot === undefined) return res.status(404).json({ error: "no snapshot available" });
    res.json(snapshot);
  });

  app.get("/api/v1/nodes/:id/history", async (req, res) => {
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid node id" });
    const range = req.query.range;
    if (typeof range !== "string" || !isHistoryRange(range)) {
      return res.status(400).json({ error: "unknown range" });
    }
    const store = requireStore(res);
    if (!store) return;
    if ((await store.get(id)) === null) return res.status(404).json({ error: "node not found" });
    const build = deps.getHistory();
    if (build === null) return res.status(503).json({ error: "database unavailable" });
    res.json(await build(id, range));
  });

  // Live llm probe view: in-memory ring first, latest persisted pass as
  // fallback (fresh boot, agent still to reconnect). 404 when nothing is known.
  app.get("/api/v1/nodes/:id/llm", async (req, res) => {
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid node id" });
    const store = requireStore(res);
    if (!store) return;
    if ((await store.get(id)) === null) return res.status(404).json({ error: "node not found" });
    const entry = deps.rings.latestLlm(id);
    if (entry !== undefined) {
      return res.json({ ports: entry.ports, updatedAt: new Date(entry.serverTimeMs).toISOString() });
    }
    const llmStore = deps.getLlmStore();
    const fallback = llmStore === null ? null : await llmStore.latestLlmSnapshot(id);
    if (fallback === null) return res.status(404).json({ error: "no llm data available" });
    res.json({ ports: fallback.ports, updatedAt: new Date(fallback.serverTimeMs).toISOString() });
  });

  app.get("/api/v1/nodes/:id/llm/history", async (req, res) => {
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid node id" });
    const range = req.query.range;
    if (typeof range !== "string" || !isHistoryRange(range)) {
      return res.status(400).json({ error: "unknown range" });
    }
    const store = requireStore(res);
    if (!store) return;
    if ((await store.get(id)) === null) return res.status(404).json({ error: "node not found" });
    const build = deps.getLlmHistory();
    if (build === null) return res.status(503).json({ error: "database unavailable" });
    res.json(await build(id, range));
  });

  // Dedicated probe-assignment endpoint: nodePatchSchema (core, out of M3
  // scope) has no llmPorts yet — reported to Main. Body: { ports: number[] }.
  app.put("/api/v1/nodes/:id/llm-ports", async (req, res) => {
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid node id" });
    const store = requireStore(res);
    if (!store) return;
    if ((await store.get(id)) === null) return res.status(404).json({ error: "node not found" });
    const ports = parsePortsBody(req.body);
    if (ports === null) return res.status(400).json({ error: "invalid request" });
    const llmStore = deps.getLlmStore();
    if (llmStore === null) return res.status(503).json({ error: "database unavailable" });
    await llmStore.setNodeLlmPorts(id, ports);
    const row = await store.get(id);
    res.json({ llmPorts: nodeLlmAssignments(row) });
  });

  // Unknown API paths answer JSON, not the SPA.
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  const staticDir = deps.staticDir;
  if (staticDir !== null && existsSync(staticDir)) {
    app.use(express.static(staticDir));
    // SPA fallback for client-side routes; never swallows /api or /agent-ws.
    app.use((req, res, next) => {
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      if (req.path.startsWith("/api/") || req.path === "/agent-ws") return next();
      res.sendFile(join(staticDir, "index.html"), (err) => {
        if (err) next();
      });
    });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    const e = err as { status?: number; type?: string } | null;
    const status = e?.type === "entity.parse.failed" ? 400 : (e?.status ?? 500);
    res.status(status).json({ error: status >= 500 ? "internal server error" : "bad request" });
  });

  return app;
}

function toNodeDto(row: NodeRecord, online: boolean): NodeInfo {
  return nodeInfoSchema.parse({
    id: row.id,
    name: row.name,
    kind: row.kind,
    role: row.role,
    host: row.host,
    enabled: row.enabled,
    agentVersion: row.agentVersion,
    online,
    lastSeenAt: toIso(row.lastSeenAt),
    sortOrder: row.sortOrder,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  });
}

const toIso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

function sendZodError(res: Response, error: { issues: Array<{ path: PropertyKey[]; message: string }> }): void {
  res.status(400).json({
    error: "invalid request",
    issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  });
}

function parseUuidParam(req: Request): string | null {
  const id = req.params.id;
  return typeof id === "string" && UUID_RE.test(id) ? id : null;
}

/**
 * Validates the PUT /llm-ports body ({ ports: number[] }) without zod (not a
 * server dependency): positive 16-bit ints, deduped, capped at MAX_LLM_PORTS.
 */
function parsePortsBody(body: unknown): number[] | null {
  if (typeof body !== "object" || body === null || !("ports" in body)) return null;
  const ports = body.ports;
  if (!Array.isArray(ports) || ports.length > MAX_LLM_PORTS) return null;
  const out: number[] = [];
  for (const port of ports) {
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    if (!out.includes(port)) out.push(port);
  }
  return out.sort((a, b) => a - b);
}
