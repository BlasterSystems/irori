import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbHandle, jobs, nodes, type Db, type DbHandle } from "@irori/db";
import { createJobsService, type JobSettledEvent, type JobsService } from "../src/jobs-service.js";

/**
 * IRI-013 integration: every terminal job transition emits exactly one
 * JobSettledEvent. Requires a REAL Postgres (ADR-0002) — same convention as
 * m7.test.ts: IRORI_TEST_DATABASE_URL at a DISPOSABLE database.
 */
const url = process.env.IRORI_TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d("job settle events (db integration)", () => {
  let handle: DbHandle;
  let db: Db;
  let nodeId: string;
  let service: JobsService;
  let settled: JobSettledEvent[];

  beforeAll(async () => {
    handle = createDbHandle(url!);
    await handle.migrate();
    db = handle.db;
    nodeId = randomUUID();
    await db.insert(nodes).values({
      id: nodeId,
      name: `jobevt-${nodeId.slice(0, 8)}`,
      kind: "spark",
      role: "standalone",
      host: "localhost",
      agentTokenHash: "x",
      agentTokenEnc: "x",
    });
    settled = [];
    service = createJobsService(db, () => true, (e) => settled.push(e));
  });

  afterAll(async () => {
    await db.delete(jobs).where(eq(jobs.nodeId, nodeId));
    await db.delete(nodes).where(eq(nodes.id, nodeId));
    await handle.close();
  });

  it("emits exactly one event on done, none on a repeated done", async () => {
    const row = await service.create(nodeId, "sync-local", {});
    await service.onDone(nodeId, row.id, "succeeded", 0);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ nodeId, jobId: row.id, kind: "sync-local", status: "succeeded", exitCode: 0 });
    expect(settled[0]!.durationMs).not.toBeNull();
    await service.onDone(nodeId, row.id, "failed", 1);
    expect(settled).toHaveLength(1);
  });

  it("emits canceled on cancel", async () => {
    const row = await service.create(nodeId, "sync-local", {});
    await service.cancel(row.id);
    expect(settled).toHaveLength(2);
    expect(settled[1]).toMatchObject({ jobId: row.id, kind: "sync-local", status: "canceled" });
  });

  it("emits failed when the reaper collects an offline node's job", async () => {
    const row = await service.create(nodeId, "sync-local", {});
    const reaped = await service.reapOffline(new Set());
    expect(reaped).toContain(row.id);
    expect(settled).toHaveLength(3);
    expect(settled[2]).toMatchObject({ jobId: row.id, kind: "sync-local", status: "failed" });
  });
});
