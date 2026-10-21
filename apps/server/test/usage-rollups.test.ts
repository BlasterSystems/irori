import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { sql } from "drizzle-orm";
import request from "supertest";
import type { Express } from "express";
import { createDbHandle, createNodeStore, settings, type DbHandle } from "@irori/db";
import { usageRequestSchema, type UsageRequest } from "@irori/core";
import { createUsageRollupEngine, USAGE_ROLLUP_WATERMARK_KEY } from "../src/usage-rollups.js";
import { createUsageStore } from "../src/usage-store.js";
import { createUsageClients } from "../src/usage-clients.js";
import { createUsageChats } from "../src/usage-chats.js";
import { runUsageRetention } from "../src/retention.js";
import { createApp } from "../src/app.js";
import { createRings } from "../src/rings.js";
import { createSseHub } from "../src/sse.js";

/**
 * Requires a REAL Postgres (ADR-0002) — same contract as rollups.test.ts:
 *   docker run --rm -d -p 54329:5432 -e POSTGRES_PASSWORD=test postgres:16-alpine
 *   IRORI_TEST_DATABASE_URL=postgres://postgres:test@localhost:54329/postgres pnpm --filter @irori/server test
 *
 * Covers the ADR-0008 exactly-once path: dedup by UUID across redelivery,
 * watermark-guarded rollups (ingest-time keyed), the four usage endpoints
 * against real buckets, and the 90 d / 1 y retention pass.
 */
const url = process.env.IRORI_TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

let handle: DbHandle | null = null;
let store: ReturnType<typeof createNodeStore> | null = null;
let nodeId = "";

function usageRequest(overrides: Partial<UsageRequest> = {}): UsageRequest {
  return usageRequestSchema.parse({
    id: randomUUID(),
    ts: Date.now() - 60_000,
    setupId: null,
    port: 8081,
    model: "GLM-5.3-Flash-EXL3",
    endpoint: "/v1/chat/completions",
    stream: true,
    status: 200,
    finishReason: "stop",
    error: null,
    errorSig: null,
    durationMs: 1000,
    ttftMs: 120,
    decodeTps: 40,
    promptTokens: 100,
    completionTokens: 50,
    cachedTokens: 10,
    reasoningTokens: 5,
    totalTokens: 150,
    engineMeta: null,
    reqBytes: 1000,
    resBytes: 2000,
    sourceAddr: "127.0.0.1",
    ...overrides,
  });
}

beforeAll(async () => {
  if (url === undefined) return;
  handle = createDbHandle(url);
  await handle.migrate();
  store = createNodeStore(handle.db, "a".repeat(64));
  const { id } = await store.create({ name: `usage-${randomUUID().slice(0, 8)}`, kind: "spark", role: "head", host: "usage-test.local" });
  nodeId = id;
});

afterAll(async () => {
  if (handle === null || nodeId === "") return;
  await store!.remove(nodeId);
  await handle.close();
});

function makeApp(): Express {
  const store = createUsageStore(handle!.db);
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
    getUsage: () => store,
    dbHealthy: async () => true,
    rings: createRings(),
    sse: createSseHub({ heartbeatMs: 0 }),
    getHub: () => null,
    version: "test",
    tag: null,
    staticDir: null,
  });
}

d("usage store (postgres)", () => {
  it("deduplicates redelivered batches by UUID (exactly-once)", async () => {
    const store = createUsageStore(handle!.db);
    const batch = [usageRequest(), usageRequest({ model: null })];
    const first = await store.insertBatch(nodeId, batch);
    const second = await store.insertBatch(nodeId, batch); // replay — no-op
    expect(first).toBe(2);
    expect(second).toBe(0);
    const page = await store.requests({ range: "24h", page: 1, limit: 100 });
    expect(page.rows.filter((r) => batch.some((b) => b.id === r.id))).toHaveLength(2);
  });

  it("rolls up hourly/daily buckets on ingest time and advances the watermark", async () => {
    const store = createUsageStore(handle!.db);
    const events = [usageRequest(), usageRequest({ error: "boom", errorSig: "boom", status: 500 })];
    await store.insertBatch(nodeId, events);

    // The engine computes only COMPLETE buckets — move these rows into a
    // past hour so the run below deterministically covers them. Absolute
    // UTC instant (session TZ must not shift it).
    const pastHour = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 - 2 * 3_600_000);
    await handle!.db.execute(sql`update llm_requests set received_at = ${pastHour.toISOString()}::timestamptz where node_id = ${nodeId}`);

    const engine = createUsageRollupEngine(handle!.db);
    // Watermark tests must not see a watermark left by an earlier run
    // (shared disposable DB) — same contract as rollups.test.ts.
    await handle!.db.execute(sql`delete from settings where key = ${USAGE_ROLLUP_WATERMARK_KEY}`);
    await engine.runOnce();

    const overview = await store.overview({ range: "24h", nodeId });
    const mine = overview.tokenMix.find((m) => m.model === "GLM-5.3-Flash-EXL3");
    expect(mine).toBeDefined();
    expect(mine!.requests).toBeGreaterThanOrEqual(2);
    expect(mine!.errors).toBeGreaterThanOrEqual(1);
    expect(mine!.totalTokens).toBeGreaterThanOrEqual(300); // 150 per event

    const wm = await handle!.db.select().from(settings).where(sql`${settings.key} = ${USAGE_ROLLUP_WATERMARK_KEY}`);
    expect(wm).toHaveLength(1);
    void store;
  });

  it("serves the four endpoints from real buckets", async () => {
    const app = makeApp();
    const base = `/api/v1/usage`;
    const overview = await request(app).get(`${base}/overview?range=24h&nodeId=${nodeId}`);
    expect(overview.status).toBe(200);
    expect(overview.body.granularity).toBe("hour");
    expect(overview.body.kpis.requests).toBeGreaterThanOrEqual(2);

    const requests = await request(app).get(`${base}/requests?range=24h&nodeId=${nodeId}&limit=10`);
    expect(requests.status).toBe(200);
    expect(requests.body.total).toBeGreaterThanOrEqual(2);
    const row = requests.body.rows[0];
    expect(row.nodeId).toBe(nodeId);
    expect(typeof row.receivedAtMs).toBe("number");

    const detail = await request(app).get(`${base}/requests/${row.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.id).toBe(row.id);

    const errors = await request(app).get(`${base}/errors?range=24h&nodeId=${nodeId}`);
    expect(errors.status).toBe(200);
    expect(errors.body.groups.some((g: { sig: string }) => g.sig === "boom")).toBe(true);

    const models = await request(app).get(`${base}/models?range=24h&nodeId=${nodeId}`);
    expect(models.status).toBe(200);
    expect(models.body.models.length).toBeGreaterThan(0);
  });

  it("prunes raw rows and buckets (90 d / 1 y)", async () => {
    const store = createUsageStore(handle!.db);
    await store.insertBatch(nodeId, [usageRequest()]);
    const result = await runUsageRetention(store, 90, 365);
    expect(result.raw).toBe(0); // nothing older than 90 d yet
    expect(result.hour).toBe(0);
  });

  it("stores deduped parts with refcounts; redelivery never double-counts (IR-52)", async () => {
    const store = createUsageStore(handle!.db);
    const mk = (content: string): UsageRequest["parts"][number] => {
      const canonical = Buffer.from(content, "utf8");
      return {
        hash: createHash("sha256").update(canonical).digest("hex"),
        kind: "message",
        role: "user",
        index: 0,
        bytes: canonical.length,
        gz: gzipSync(canonical).toString("base64"),
        truncated: false,
      };
    };
    // Content-addressed hashing means repeated runs would otherwise accrue
    // refcounts on identical bytes — make fixture content unique per run.
    const run = randomUUID().slice(0, 8);
    const shared = mk(`shared prefix bytes ${run}`);
    const batch = [
      usageRequest({ parts: [shared, mk(`turn one ${run}`)], ts: Date.now() - 60_000 }),
      usageRequest({ parts: [shared, mk(`turn two ${run}`)], ts: Date.now() - 50_000 }),
    ];
    const inserted = await store.insertBatch(nodeId, batch);
    expect(inserted).toBe(2);

    const parts = await handle!.db.execute(
      sql`select hash, refcount, bytes, truncated from llm_parts where hash in (${shared.hash}, ${batch[0]!.parts[1]!.hash}, ${batch[1]!.parts[1]!.hash})`,
    );
    const byHash = new Map((parts as unknown as Array<{ hash: string; refcount: number; bytes: number; truncated: boolean }>).map((r) => [r.hash, r]));
    expect(byHash.get(shared.hash)?.refcount).toBe(2); // shared by both rows
    expect(byHash.get(batch[0]!.parts[1]!.hash)?.refcount).toBe(1);
    expect(byHash.get(batch[1]!.parts[1]!.hash)?.refcount).toBe(1);
    const joinIds = sql.join(batch.map((b) => sql`${b.id}`), sql`, `);
    const joins = await handle!.db.execute(sql`select count(*)::int as n from llm_request_parts where request_id in (${joinIds})`);
    expect(Number((joins as unknown as Array<{ n: number }>)[0]?.n)).toBe(4);

    // Replay: no new rows, refcounts unchanged.
    expect(await store.insertBatch(nodeId, batch)).toBe(0);
    const after = await handle!.db.execute(sql`select refcount from llm_parts where hash = ${shared.hash}`);
    expect(Number((after as unknown as Array<{ refcount: number }>)[0]?.refcount)).toBe(2);
  });

  it("prunes parts with their owning rows (refcount release, IR-52)", async () => {
    const store = createUsageStore(handle!.db);
    const mk = (content: string): UsageRequest["parts"][number] => {
      const canonical = Buffer.from(content, "utf8");
      return {
        hash: createHash("sha256").update(canonical).digest("hex"),
        kind: "message",
        role: "user",
        index: 0,
        bytes: canonical.length,
        gz: gzipSync(canonical).toString("base64"),
        truncated: false,
      };
    };
    const run = randomUUID().slice(0, 8);
    const doomedShared = mk(`doomed shared body ${run}`);
    const survivor = mk(`survivor body ${run}`);
    const old = [usageRequest({ parts: [doomedShared, mk("old extra")] }), usageRequest({ parts: [doomedShared] })];
    await store.insertBatch(nodeId, old);
    await store.insertBatch(nodeId, [usageRequest({ parts: [survivor] })]);
    // Age only the doomed batch's rows (91 d — older than the 90 d cutoff).
    const past = new Date(Date.now() - 91 * 86_400_000);
    const doomedIds = sql.join(old.map((r) => sql`${r.id}`), sql`, `);
    await handle!.db.execute(sql`update llm_requests set received_at = ${past.toISOString()}::timestamptz where id in (${doomedIds})`);

    const pruned = await store.pruneRaw(new Date(Date.now() - 90 * 86_400_000));
    expect(pruned).toBe(2);
    const gone = await handle!.db.execute(sql`select count(*)::int as n from llm_parts where hash = ${doomedShared.hash}`);
    expect(Number((gone as unknown as Array<{ n: number }>)[0]?.n)).toBe(0); // refcount 2 → 0 → deleted
    const kept = await handle!.db.execute(sql`select refcount from llm_parts where hash = ${survivor.hash}`);
    expect(Number((kept as unknown as Array<{ refcount: number }>)[0]?.refcount)).toBe(1); // untouched
  });

  it("resolves issued keys over self-declared headers (IR-55)", async () => {
    const clients = createUsageClients(handle!.db);
    const identity = await clients.create({ name: "omp", project: "irori", agentType: "main" });
    const keyHash = createHash("sha256").update(identity.key, "utf8").digest("hex");
    const store = createUsageStore(handle!.db);

    // Key-mapped identity fills every dimension; headers only fill gaps.
    await store.insertBatch(nodeId, [
      usageRequest({ clientKeyHash: keyHash, ts: Date.now() - 40_000 }),
      usageRequest({ clientKeyHash: keyHash, clientProject: "header-project", clientAgentType: "subagent", totalTokens: 90, ts: Date.now() - 30_000 }),
      // Unknown key + header-declared identity still attributes (client-asserted).
      usageRequest({ clientKeyHash: "c".repeat(64), clientProject: "header-only", clientName: "codex", ts: Date.now() - 20_000 }),
      // Unidentified: source-IP fallback only.
      usageRequest({ ts: Date.now() - 10_000, sourceAddr: "192.168.1.50" }),
    ]);
    const rows = await store.requests({ range: "1h", page: 1, limit: 10 });
    // Event 1 (150 tokens): key-mapped only → full identity from the registry.
    const keyOnly = rows.rows.filter((r) => r.clientKeyHash === keyHash && r.totalTokens === 150);
    expect(keyOnly).toHaveLength(1);
    expect(keyOnly[0]).toMatchObject({ clientName: "omp", clientProject: "irori", clientAgentType: "main" });
    // Event 2 (90 tokens): the issued key wins over the header-declared
    // project/agentType — both resolve to the registry identity.
    const mixed = rows.rows.filter((r) => r.clientKeyHash === keyHash && r.totalTokens === 90);
    expect(mixed).toHaveLength(1);
    expect(mixed[0]).toMatchObject({ clientProject: "irori", clientAgentType: "main" });
    const headerOnly = rows.rows.filter((r) => r.clientKeyHash === "c".repeat(64));
    expect(headerOnly[0]).toMatchObject({ clientProject: "header-only", clientName: "codex" });
    const bare = rows.rows.filter((r) => r.sourceAddr === "192.168.1.50");
    expect(bare).toHaveLength(1);
    expect(bare[0]!.clientKeyHash).toBeNull();
    expect(bare[0]!.clientProject).toBeNull();
  });

  it("resolves a key issued after its misses were cached (TTL invalidation, IR-55)", async () => {
    const clients = createUsageClients(handle!.db);
    const store = createUsageStore(handle!.db);
    const run = randomUUID().slice(0, 8);
    const key = `irn_${run}`;
    const keyHash = createHash("sha256").update(key, "utf8").digest("hex");
    const addr = `10.6.${run.length % 200}.4`;
    // 1) Unknown key: the resolver caches the miss.
    await store.insertBatch(nodeId, [usageRequest({ clientKeyHash: keyHash, sourceAddr: addr })]);
    let rows = await store.requests({ range: "1h", page: 1, limit: 5 });
    expect(rows.rows.find((r) => r.clientKeyHash === keyHash)?.clientName).toBeNull();
    // 2) Identity created afterwards invalidates the cache → next batch resolves.
    await handle!.db.execute(sql`delete from client_identities where name = 'late-key'`); // shared-DB reruns
    await clients.create({ name: "late-key", project: "irori", agentType: "subagent" });
    // (create() generated its own key; point the registry at the client's key.)
    await handle!.db.execute(sql`update client_identities set key_hash = ${keyHash} where name = 'late-key'`);
    await store.insertBatch(nodeId, [usageRequest({ clientKeyHash: keyHash, sourceAddr: addr, totalTokens: 77 })]);
    rows = await store.requests({ range: "1h", page: 1, limit: 5 });
    const late = rows.rows.find((r) => r.totalTokens === 77);
    expect(late).toMatchObject({ clientName: "late-key", clientProject: "irori", clientAgentType: "subagent" });
  });

  it("groups the agents view across identified and fallback clients (IR-55)", async () => {
    const clients = createUsageClients(handle!.db);
    const identity = await clients.create({ name: "omp", project: "irori", agentType: "main" });
    const keyHash = createHash("sha256").update(identity.key, "utf8").digest("hex");
    const store = createUsageStore(handle!.db);
    await store.insertBatch(nodeId, [
      usageRequest({ clientKeyHash: keyHash, totalTokens: 100 }),
      usageRequest({ clientKeyHash: keyHash, totalTokens: 50, error: "boom", errorSig: "boom", status: 500 }),
      usageRequest({ sourceAddr: "10.0.0.9", totalTokens: 10 }),
    ]);
    const agents = await store.agents({ range: "1h", nodeId });
    const identified = agents.groups.find((g) => g.keyHash === keyHash);
    expect(identified).toMatchObject({ name: "omp", project: "irori", agentType: "main", requests: 2, errors: 1, totalTokens: 150 });
    const fallback = agents.groups.find((g) => g.keyHash === null && (g.sourceAddrs ?? []).includes("10.0.0.9"));
    expect(fallback).toMatchObject({ requests: 1, totalTokens: 10 });
    await clients.remove(identity.id);
  });

  it("chains a multi-turn session and reconstructs it with images and tools (IR-53)", async () => {
    const store = createUsageStore(handle!.db);
    const chats = createUsageChats(handle!.db);
    const run = randomUUID().slice(0, 8);
    const mk = (content: string): UsageRequest["parts"][number] => {
      const canonical = Buffer.from(content, "utf8");
      return {
        hash: createHash("sha256").update(canonical).digest("hex"),
        kind: "message",
        role: "user",
        index: 0,
        bytes: canonical.length,
        gz: gzipSync(canonical).toString("base64"),
        truncated: false,
      };
    };
    const system = `{"role":"system","content":"You are terse. ${run}"}`;
    const user1 = `{"role":"user","content":[{"type":"text","text":"look at this"},{"type":"image_url","image_url":{"url":"data:image/png;base64,iVBORw0KGgo="}}]}`;
    const assistant = `{"role":"assistant","content":"It is a red dot."}`;
    const user2 = `{"role":"user","content":"and now the time?"}`;
    const toolMsg = `{"role":"tool","tool_call_id":"call_x_${run}","content":"{\\"iso\\":\\"2026-10-21T18:00:00Z\\"}"}`;
    const IMAGE_PART = mk(user1);
    const SYSTEM_PART = mk(system);
    const t1 = usageRequest({ ts: Date.now() - 40_000, sourceAddr: `10.${run.split("").reduce((a, c) => a + c.charCodeAt(0), 0) % 200}.1.1`, parts: [SYSTEM_PART, IMAGE_PART] });
    const t2 = usageRequest({ ts: Date.now() - 30_000, sourceAddr: t1.sourceAddr!, parts: [SYSTEM_PART, IMAGE_PART, mk(assistant)] });
    const t3 = usageRequest({
      ts: Date.now() - 20_000,
      sourceAddr: t1.sourceAddr!,
      toolResults: [{ callId: `call_x_${run}`, resultChars: 30, error: false }],
      parts: [SYSTEM_PART, IMAGE_PART, mk(assistant), mk(user2), mk(toolMsg)],
    });
    await store.insertBatch(nodeId, [t1, t2, t3]);

    const list = await chats.list({ range: "1h", nodeId });
    const session = list.sessions.find((s) => s.id === t1.id);
    expect(session).toBeDefined();
    expect(session!.requests).toBe(3);
    expect(session!.messages).toBe(5); // last snapshot message count
    expect(session!.totalTokens).toBe(150 * 3);
    expect(session!.compacted).toBe(false);

    const detail = await chats.detail(t1.id);
    expect(detail).not.toBeNull();
    expect(detail!.requests).toBe(3);
    // Reconstruction renders the LAST request's snapshot + final response.
    expect(detail!.turns.map((t) => t.role)).toEqual(["system", "user", "assistant", "user", "tool"]);
    expect(detail!.turns[1]!.imageUrls).toEqual(["data:image/png;base64,iVBORw0KGgo="]);
    expect(detail!.turns[1]!.text).toBe("look at this");
    expect(detail!.turns[4]!.toolResult).toMatchObject({ callId: `call_x_${run}` });
  });

  it("marks compaction instead of splitting the session (IR-53)", async () => {
    const store = createUsageStore(handle!.db);
    const chats = createUsageChats(handle!.db);
    const run = randomUUID().slice(0, 8);
    const mk = (role: string, content: string): UsageRequest["parts"][number] => {
      const canonical = Buffer.from(JSON.stringify({ role, content }), "utf8");
      return {
        hash: createHash("sha256").update(canonical).digest("hex"),
        kind: "message",
        role,
        index: 0,
        bytes: canonical.length,
        gz: gzipSync(canonical).toString("base64"),
        truncated: false,
      };
    };
    const long = "x".repeat(4000);
    const addr = `10.${run.split("").reduce((a, c) => a + c.charCodeAt(0), 0) % 200}.2.2`;
    const t1 = usageRequest({ promptTokens: 4000, ts: Date.now() - 30_000, sourceAddr: addr, parts: [mk("user", long)] });
    // Compacted turn: same client, chain broken, input drops by >50%.
    const t2 = usageRequest({ promptTokens: 900, ts: Date.now() - 20_000, sourceAddr: addr, parts: [mk("user", `summarized ${run}`)] });
    await store.insertBatch(nodeId, [t1, t2]);
    const list = await chats.list({ range: "1h", nodeId });
    const session = list.sessions.find((s) => s.id === t1.id);
    expect(session).toBeDefined();
    expect(session!.requests).toBe(2); // same session
    expect(session!.compacted).toBe(true);
  });

  it("reports captured-without-bodies guidance (IR-53)", async () => {
    const store = createUsageStore(handle!.db);
    const chats = createUsageChats(handle!.db);
    await store.insertBatch(nodeId, [usageRequest({ sourceAddr: "10.9.9.9" })]); // no parts (retention off)
    const list = await chats.list({ range: "1h", nodeId });
    expect(list.capturedWithoutBodies).toBeGreaterThan(0);
    expect(list.sessions.find((s) => s.sourceAddrs.includes("10.9.9.9"))).toBeUndefined();
  });

  it("attributes parallel tool calls with exact token sums (IR-54)", async () => {
    const store = createUsageStore(handle!.db);
    const run = randomUUID().slice(0, 8);
    // Turn 1: parallel tool calls in the streamed response.
    const turn1 = usageRequest({
      completionTokens: 100,
      promptTokens: 120,
      ts: Date.now() - 30_000,
      respTools: [
        { id: `call_a_${run}`, name: "get_weather", argsChars: 10 },
        { id: `call_b_${run}`, name: "get_time", argsChars: 6 },
      ],
    });
    // Turn 2: the follow-up request carries role:"tool" results.
    const turn2 = usageRequest({
      promptTokens: 210,
      completionTokens: 5,
      ts: Date.now() - 20_000,
      toolResults: [
        { callId: `call_a_${run}`, resultChars: 40, error: false },
        { callId: `call_b_${run}`, resultChars: 22, error: true },
        { callId: `call_z_${run}`, resultChars: 18, error: false }, // never seen → unknown
      ],
    });
    await store.insertBatch(nodeId, [turn1, turn2]);

    const toolRows = await handle!.db.execute(sql`
      select t.request_id::text as rid, t.tool, t.model, t.calls, t.errors, t.args_chars, t.result_chars,
             t.prompt_tokens, t.completion_tokens
      from llm_request_tools t where t.request_id in (${sql.join([sql`${turn1.id}`, sql`${turn2.id}`], sql`, `)})
      order by t.request_id, t.tool
    `);
    const list = toolRows as unknown as Array<{ rid: string; tool: string; calls: number; errors: number; args_chars: number; result_chars: number; prompt_tokens: number; completion_tokens: number }>;
    // Turn 1 (response side): 100 completion tokens split 10:6 → 63 + 37.
    const t1 = list.filter((r) => r.rid === turn1.id);
    expect(t1.find((r) => r.tool === "get_weather")).toMatchObject({ calls: 1, args_chars: 10, completion_tokens: 63 });
    expect(t1.find((r) => r.tool === "get_time")).toMatchObject({ calls: 1, args_chars: 6, completion_tokens: 37 });
    expect(t1.reduce((s, r) => s + r.completion_tokens, 0)).toBe(100); // sums to the request total
    // Turn 2 (request side): names resolved through the ring; unknown fallback.
    // 210 prompt tokens split by result chars 40:22:18 → 105 / 58 / 47.
    const t2 = list.filter((r) => r.rid === turn2.id);
    expect(t2.find((r) => r.tool === "get_weather")).toMatchObject({ result_chars: 40, errors: 0, prompt_tokens: 105 });
    expect(t2.find((r) => r.tool === "get_time")).toMatchObject({ result_chars: 22, errors: 1, prompt_tokens: 58 });
    expect(t2.find((r) => r.tool === "unknown")).toMatchObject({ result_chars: 18, errors: 0, prompt_tokens: 47 });
    expect(t2.reduce((s, r) => s + r.prompt_tokens, 0)).toBe(210);

    // Read model aggregates per (tool, model) and serves a series.
    const view = await store.tools({ range: "1h", nodeId });
    const weather = view.tools.find((t) => t.tool === "get_weather");
    expect(weather).toMatchObject({ calls: 1, argsChars: 10, resultChars: 40, promptTokens: 105, completionTokens: 63 });
    expect(view.tools.find((t) => t.tool === "unknown")).toBeDefined();
    expect(view.series.find((s) => s.tool === "get_weather")?.points.length).toBeGreaterThan(0);
  });
});
