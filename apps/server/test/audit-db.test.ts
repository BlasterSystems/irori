import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog, createDbHandle, eventJournal, nodes, type Db, type DbHandle } from "@irori/db";
import { auditQuerySchema, type SseEvent } from "@irori/core";
import { createAuditService } from "../src/audit.js";
import { createEventJournalService } from "../src/event-journal.js";
import { makeSnapshot } from "./helpers.js";

/**
 * IRI-077 (epic IR-157 WS4): audit + event-journal storage behaviour against
 * a REAL Postgres (same convention as m7.test.ts — IRORI_TEST_DATABASE_URL at
 * a disposable database; CI starts a Postgres service container).
 *
 * Covers what the route-layer tests cannot: filter and cursor semantics over a
 * seeded set, retention purge, redaction at the storage boundary, and restart
 * survival — a fresh service instance over the same database still sees what
 * the previous one wrote.
 */
const url = process.env.IRORI_TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d("audit + event journal (db integration)", () => {
  let handle: DbHandle;
  let db: Db;
  let nodeId: string;

  beforeAll(async () => {
    handle = createDbHandle(url!);
    await handle.migrate();
    db = handle.db;
    nodeId = randomUUID();
    await db.insert(nodes).values({
      id: nodeId,
      name: `audit-test-${nodeId.slice(0, 8)}`,
      kind: "spark",
      role: "standalone",
      host: "localhost",
      agentTokenHash: "x",
      agentTokenEnc: "x",
    });
    await db.delete(auditLog);
    await db.delete(eventJournal);
  });

  afterAll(async () => {
    await db.delete(nodes).where(eq(nodes.id, nodeId));
    await handle.close();
  });

  const audit = () => createAuditService(db);

  it("records rows and answers every documented filter", async () => {
    const service = audit();
    await service.write({ actor: "hub", action: "node.delete", targetType: "node", targetId: "n-1", summary: "node deleted (n-1)" });
    await service.write({ actor: "client", actorDetail: "omp", action: "setup.start", targetType: "setup", targetId: "s-1", summary: "setup started" });
    await service.write({ actor: "anonymous", action: "setup.stop", targetType: "setup", targetId: "s-1", summary: "setup stopped" }, { outcome: "error", error: "HTTP 409" });

    const all = await service.list(auditQuerySchema.parse({ range: "1y", limit: 50 }));
    expect(all.total).toBeGreaterThanOrEqual(3);
    expect(all.entries.length).toBeGreaterThanOrEqual(3);

    const byActor = await service.list(auditQuerySchema.parse({ range: "1y", actor: "client" }));
    expect(byActor.entries.length).toBe(1);
    expect(byActor.entries[0]!.actorDetail).toBe("omp");

    const byDomain = await service.list(auditQuerySchema.parse({ range: "1y", domain: "setup" }));
    expect(byDomain.entries.every((e) => e.action.startsWith("setup."))).toBe(true);
    expect(byDomain.entries).toHaveLength(2);

    const byAction = await service.list(auditQuerySchema.parse({ range: "1y", action: "setup.start" }));
    expect(byAction.entries.map((e) => e.action)).toEqual(["setup.start"]);

    const byTarget = await service.list(auditQuerySchema.parse({ range: "1y", targetId: "s-1" }));
    expect(byTarget.entries.every((e) => e.targetId === "s-1")).toBe(true);

    const byQuery = await service.list(auditQuerySchema.parse({ range: "1y", q: "deleted" }));
    expect(byQuery.entries.map((e) => e.action)).toEqual(["node.delete"]);

    const failed = byDomain.entries.find((e) => e.outcome === "error");
    expect(failed?.error).toBe("HTTP 409");
    expect(failed?.outcome).toBe("error");
  });

  it("paginates with a descending cursor without gaps or repeats", async () => {
    const service = audit();
    for (let i = 0; i < 7; i += 1) {
      await service.write({ actor: "hub", action: "bench.start", targetType: "bench-run", targetId: `page-${i}`, summary: `page seed ${i}` });
    }
    const first = await service.list(auditQuerySchema.parse({ range: "1y", domain: "bench", limit: 3 }));
    expect(first.entries).toHaveLength(3);
    expect(first.nextCursor).not.toBeNull();
    const second = await service.list(auditQuerySchema.parse({ range: "1y", domain: "bench", limit: 3, cursor: first.nextCursor! }));
    expect(second.entries).toHaveLength(3);
    const ids = [...first.entries, ...second.entries].map((e) => String(e.id));
    expect(new Set(ids).size).toBe(6);
    // Strictly descending ids = stable newest-first pagination.
    const nums = ids.map(Number);
    expect(nums).toEqual([...nums].sort((a, b) => b - a));
  });

  it("never stores secret values in before/after", async () => {
    const service = audit();
    const secret = "hf_SUPERSECRETvalue";
    await service.write({
      actor: "hub",
      action: "settings.hf-token.put",
      targetType: "settings",
      targetId: "hf-token",
      summary: "hf-token set",
      before: { hfToken: null },
      after: { hfToken: secret, nested: { token: secret, apiKey: secret, modelPath: "/models/keep-me" } },
    });
    const [row] = await db.select().from(auditLog).where(eq(auditLog.action, "settings.hf-token.put")).orderBy(auditLog.id).limit(1);
    const stored = JSON.stringify({ before: row!.before, after: row!.after });
    expect(stored).not.toContain(secret);
    expect(stored).toContain("***");
    // Non-secret content survives redaction — the record stays useful.
    expect(stored).toContain("/models/keep-me");
  });

  it("survives a simulated restart: a fresh service reads what the old one wrote", async () => {
    await audit().write({ actor: "hub", action: "job.cancel", targetType: "job", targetId: "survivor-1", summary: "cancel before restart" });
    // "Restart" = drop every in-memory object; only Postgres remains. The SSE
    // ring (500 frames, memory) loses exactly this; the audit log must not.
    const reopened = createAuditService(db);
    const page = await reopened.list(auditQuerySchema.parse({ range: "1y", targetId: "survivor-1" }));
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]!.summary).toBe("cancel before restart");
  });

  it("purges rows past retention and keeps newer ones", async () => {
    const service = audit();
    await service.write({ actor: "hub", action: "node.patch", targetType: "node", targetId: "old-row", summary: "ancient" });
    await db.update(auditLog).set({ ts: new Date(Date.now() - 400 * 86_400_000) }).where(eq(auditLog.targetId, "old-row"));
    await service.write({ actor: "hub", action: "node.patch", targetType: "node", targetId: "fresh-row", summary: "recent" });

    const deleted = await service.prune(365);
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect((await service.list(auditQuerySchema.parse({ range: "1y", targetId: "old-row" }))).entries).toHaveLength(0);
    expect((await service.list(auditQuerySchema.parse({ range: "1y", targetId: "fresh-row" }))).entries).toHaveLength(1);
  });

  it("journals live frames, excludes cache streams, and reads back after restart", async () => {
    const journal = createEventJournalService(db);
    const job: SseEvent = {
      type: "job",
      serverTimeMs: Date.now(),
      nodeId,
      jobId: randomUUID(),
      kind: "models-inventory",
      status: "succeeded",
      params: {},
      exitCode: 0,
      durationMs: 10,
    };
    const thermal: SseEvent = { type: "thermal", serverTimeMs: Date.now(), nodeId, gpuIndex: 0, active: ["gpu0"] };
    await journal.journal(job);
    await journal.journal(thermal);
    // High-rate caches have durable homes elsewhere; never journaled here.
    await journal.journal({ type: "heartbeat", serverTimeMs: Date.now() });
    await journal.journal({ type: "snapshot", serverTimeMs: Date.now(), nodeId, snapshot: makeSnapshot() });
    await journal.journal({ type: "setup-log", serverTimeMs: Date.now(), setupId: randomUUID(), nodeId, name: "s", line: "x" });

    const rows = await db.select({ id: eventJournal.id, type: eventJournal.type }).from(eventJournal);
    expect(rows.map((r) => r.type).sort()).toEqual(["job", "thermal"]);

    // Restart: a fresh service over the same database still lists them.
    const reopened = createEventJournalService(db);
    const page = await reopened.list({ range: "1h", type: "thermal", nodeId, limit: 10 });
    expect(page.events).toHaveLength(1);
    expect((page.events[0]!.payload as { active: string[] }).active).toEqual(["gpu0"]);
  });

  it("prunes journaled events past retention", async () => {
    const journal = createEventJournalService(db);
    await journal.journal({
      type: "bench",
      serverTimeMs: Date.now(),
      runId: randomUUID(),
      bench: "decode",
      nodeId,
      status: "completed",
      progress: null,
    });
    await db.update(eventJournal).set({ ts: new Date(Date.now() - 200 * 86_400_000) }).where(eq(eventJournal.type, "bench"));
    expect(await journal.prune(90)).toBeGreaterThanOrEqual(1);
    expect((await journal.list({ range: "30d", type: "bench", limit: 10 })).events).toHaveLength(0);
  });

  it("an audit write failure is reported, never thrown into the request path", async () => {
    // The service's own contract: the row may be lost, the operator's action
    // must not fail, and the failure must be visible in the log callback.
    const broken = {
      insert: () => ({
        values: () => Promise.reject(new Error("database gone")),
      }),
    } as unknown as Parameters<typeof createAuditService>[0];
    const logged = Promise.withResolvers<string>();
    const service = createAuditService(broken, (msg) => logged.resolve(msg));
    expect(() => service.record({ actor: "hub", action: "node.delete", targetType: "node", targetId: "x", summary: "s" })).not.toThrow();
    expect(await logged.promise).toContain("audit write failed");
    // The awaitable variant surfaces the failure to its caller instead.
    await expect(service.write({ actor: "hub", action: "node.delete", targetType: "node", targetId: "y", summary: "s" })).rejects.toThrow("database gone");
  });
});
