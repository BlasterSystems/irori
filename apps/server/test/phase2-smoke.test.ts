import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request as httpRequest, type Server } from "node:http";
import { sql } from "drizzle-orm";
import request from "supertest";
import type { Express } from "express";
import { createDbHandle, createNodeStore, type DbHandle } from "@irori/db";
import { CaptureProxy } from "@irori/proxy";
import { usageRequestSchema } from "@irori/core";
import { createUsageStore } from "../src/usage-store.js";
import { createUsageClients } from "../src/usage-clients.js";
import { createUsageChats } from "../src/usage-chats.js";
import { createApp } from "../src/app.js";
import { createRings } from "../src/rings.js";
import { createSseHub } from "../src/sse.js";
import { UsageBuffer } from "../../agent/src/usage-buffer.js";

/**
 * Phase-2 live smoke (IR-52..55, ADR-0010): REAL components, disposable
 * Postgres —
 *   docker run --rm -d -p 54331:5432 -e POSTGRES_PASSWORD=test postgres:16-alpine
 *   IRORI_TEST_DATABASE_URL=postgres://postgres:test@localhost:54331/postgres \
 *     pnpm --filter @irori/server test test/phase2-smoke.test.ts
 *
 * Path under test: mock OpenAI engine → CaptureProxy (retention ON, headers,
 * bearer key, streamed tool calls) → agent UsageBuffer (SQLite parts store)
 * → server insertBatch (exactly-once ingest) → chats/tools/agents API.
 * Mirrors the IRI-009 live e2e minus the WS hop (buffer→insertBatch IS the
 * sync payload; the WS frame chain has its own suite).
 */
const url = process.env.IRORI_TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

let handle: DbHandle | null = null;
let engine: Server;
let enginePort = 0;
let proxy: CaptureProxy;
let proxyPort = 0;
let bufferDir = "";
let nodeId = "";

function post(body: string, headers: Record<string, string> = {}): Promise<{ status: number; raw: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; raw: string }>();
  const req = httpRequest(
    {
      host: "127.0.0.1",
      port: proxyPort,
      method: "POST",
      path: "/v1/chat/completions",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers },
    },
    (res) => {
      let raw = "";
      res.on("data", (c: Buffer) => (raw += c.toString("utf8")));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, raw }));
    },
  );
  req.on("error", reject);
  req.end(body);
  return promise;
}

beforeAll(async () => {
  if (url === undefined) return;
  handle = createDbHandle(url);
  await handle.migrate();
  await handle.db.execute(sql`delete from nodes where name like 'phase2-smoke%'`);
  const store = createNodeStore(handle.db, "a".repeat(64));
  const created = await store.create({ name: `phase2-smoke-${randomUUID().slice(0, 8)}`, kind: "spark", role: "head", host: "smoke.local" });
  nodeId = created.id;

  engine = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => {
      const body = JSON.parse(raw) as { fixture?: string; messages?: Array<{ role: string }> };
      res.writeHead(200, { "content-type": "application/json" });
      if (body.fixture === "tool-calls") {
        const chunks = [
          'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_smoke_a","function":{"name":"get_weather","arguments":"{\\"city\\":"}}]}}]}\n\n',
          'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":" \\"SF\\"}"}}]}}]}\n\n',
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":60,"completion_tokens":9,"total_tokens":69}}\n\n',
          "data: [DONE]\n\n",
        ];
        for (const chunk of chunks) res.write(chunk);
        res.end();
        return;
      }
      if ((body.messages?.length ?? 0) >= 3) {
        // Third turn: a role:tool result rides in — echo a text answer.
        res.end(
          JSON.stringify({
            choices: [{ index: 0, message: { role: "assistant", content: "Sunny, 21°C." }, finish_reason: "stop" }],
            usage: { prompt_tokens: 210, completion_tokens: 6, total_tokens: 216 },
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          choices: [{ index: 0, message: { role: "assistant", content: "It is a red dot." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 120, completion_tokens: 7, total_tokens: 127 },
        }),
      );
    });
  });
  engine.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => engine.once("listening", resolve));
  enginePort = engine.address()!.port;

  bufferDir = mkdtempSync(join(tmpdir(), "irori-phase2-smoke-"));
  const buffer = new UsageBuffer(bufferDir);
  proxy = new CaptureProxy({
    listenPort: 0,
    targetHost: "127.0.0.1",
    targetPort: enginePort,
    setupId: null,
    retention: { bodyCapBytes: 1024 * 1024, partCapBytes: 256 * 1024 },
    onEvent: (event) => buffer.add(event),
    log: () => {},
  });
  await proxy.start();
  proxyPort = proxy.address!.port;
  // Expose the buffer for the ingest step below.
  (globalThis as Record<string, unknown>).__smokeBuffer = buffer;
});

afterAll(async () => {
  if (url === undefined) return;
  ((globalThis as Record<string, unknown>).__smokeBuffer as UsageBuffer | undefined)?.close();
  await proxy.stop();
  engine.close();
  rmSync(bufferDir, { recursive: true, force: true });
  await handle!.db.execute(sql`delete from nodes where id = ${nodeId}`);
  await handle.close();
});

d("phase-2 live smoke (proxy → buffer → ingest → API)", () => {
  it("captures a tool-call turn and a vision turn through the proxy", async () => {
    const buffer = (globalThis as Record<string, unknown>).__smokeBuffer as UsageBuffer;
    const headers = {
      authorization: "Bearer irn_smoke_client_key",
      "x-irori-project": "irori",
      "x-irori-agent-type": "main",
      "x-irori-client": "omp",
    };
    // Turn 1: image question (vision payload + base64 data URL).
    const r1 = await post(
      JSON.stringify({
        model: "GLM-5.3-Flash-EXL3",
        stream: false,
        messages: [
          { role: "system", content: "You are terse." },
          { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }] },
        ],
      }),
      headers,
    );
    expect(r1.status).toBe(200);
    // Real-clock spacing between wire requests: capture stamps Date.now()
    // internally (sockets + real clock), so fake timers cannot order these —
    // the 5 ms gaps make intra-batch chaining deterministic, not a race wait.
    await new Promise((r) => setTimeout(r, 5));
    // Turn 2 (full history resend + the new question): model asks for a tool.
    const r2 = await post(
      JSON.stringify({
        model: "GLM-5.3-Flash-EXL3",
        stream: true,
        fixture: "tool-calls",
        messages: [
          { role: "system", content: "You are terse." },
          { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }] },
          { role: "assistant", content: "It is a red dot." },
          { role: "user", content: "weather?" },
        ],
      }),
      headers,
    );
    expect(r2.status).toBe(200);
    await new Promise((r) => setTimeout(r, 5));
    // Turn 3: the tool result rides back in.
    const r3 = await post(
      JSON.stringify({
        model: "GLM-5.3-Flash-EXL3",
        stream: false,
        messages: [
          { role: "system", content: "You are terse." },
          { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }] },
          { role: "assistant", content: "It is a red dot." },
          { role: "user", content: "weather?" },
          { role: "assistant", content: null, tool_calls: [{ id: "call_smoke_a", type: "function", function: { name: "get_weather", arguments: "{\"city\": \"SF\"}" } }] },
          { role: "tool", tool_call_id: "call_smoke_a", content: "{\"forecast\":\"sunny\",\"temp_c\":21}" },
        ],
      }),
      headers,
    );
    expect(r3.status).toBe(200);

    // Ingest exactly what the agent would sync: re-attach gz from the buffer.
    const batch = buffer.takeBatch(10).map((row) => usageRequestSchema.parse(JSON.parse(row.payload)));
    expect(batch.length).toBe(3);
    const store = createUsageStore(handle!.db);
    expect(await store.insertBatch(nodeId, batch)).toBe(3);
    // Replay (lost ack) is a no-op end to end.
    const batch2 = buffer.takeBatch(10).map((row) => usageRequestSchema.parse(JSON.parse(row.payload)));
    expect(batch2.length).toBe(3);
    expect(await store.insertBatch(nodeId, batch2)).toBe(0);
  });

  it("serves chats, tools and agents from the captured traffic", async () => {
    const app = makeApp();
    const chatsList = await request(app).get(`/api/v1/usage/chats?range=1h&nodeId=${nodeId}`);
    expect(chatsList.status).toBe(200);
    const session = chatsList.body.sessions.find((s: { clientName: string | null }) => s.clientName === "omp");
    expect(session).toBeDefined();
    expect(session.requests).toBe(3);

    const detail = await request(app).get(`/api/v1/usage/chats/${session.id}`);
    expect(detail.status).toBe(200);
    const roles: string[] = detail.body.turns.map((t: { role: string | null }) => t.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
    expect(roles).toContain("tool");
    // Byte-exact image + tool arguments + tool result all present.
    expect(detail.body.turns.some((t: { imageUrls: string[] }) => t.imageUrls.includes("data:image/png;base64,iVBORw0KGgo="))).toBe(true);
    expect(detail.body.turns.some((t: { toolCalls: Array<{ name: string }> }) => t.toolCalls.some((c) => c.name === "get_weather"))).toBe(true);
    expect(detail.body.turns.some((t: { toolResult: { callId: string } | null }) => t.toolResult?.callId === "call_smoke_a")).toBe(true);

    const tools = await request(app).get("/api/v1/usage/tools?range=1h");
    expect(tools.status).toBe(200);
    const weather = tools.body.tools.find((t: { tool: string }) => t.tool === "get_weather");
    expect(weather).toMatchObject({ calls: 1, errors: 0 });
    // Completion share: the only attributed tool carries the whole 9 tokens.
    expect(weather.completionTokens).toBe(9);

    const agents = await request(app).get(`/api/v1/usage/agents?range=1h&nodeId=${nodeId}`);
    expect(agents.status).toBe(200);
    const group = agents.body.groups.find((g: { clientName: string | null; name: string | null }) => g.name === "omp");
    expect(group).toMatchObject({ name: "omp", project: "irori", agentType: "main" });
  });

  it("registers the issued client key and attributes by fingerprint", async () => {
    const clients = createUsageClients(handle!.db);
    const identity = await clients.create({ name: "smoke-key", project: "irori", agentType: "main" });
    expect(identity.key.startsWith("irn_")).toBe(true);
    const listed = await clients.list();
    expect(listed.some((c) => c.id === identity.id && c.keyHash !== null)).toBe(true);
    expect(await clients.remove(identity.id)).toBe(true);
  });
});

function makeApp(): Express {
  return createApp({
    getStore: () => null,
    getLlmStore: () => null,
    getHistory: () => null,
    getLlmHistory: () => null,
    getJobs: () => null,
    getSetups: () => null,
    getBench: () => null,
    getAnalytics: () => null,
    getCleanup: () => null,
    getUsage: () => createUsageStore(handle!.db),
    getUsageClients: () => createUsageClients(handle!.db),
    getUsageChats: () => createUsageChats(handle!.db),
    getDownloads: () => null,
    dbHealthy: async () => true,
    rings: createRings(),
    sse: createSseHub({ heartbeatMs: 0 }),
    getHub: () => null,
    version: "smoke",
    tag: null,
    staticDir: null,
  });
}
