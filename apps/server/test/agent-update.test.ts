import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbHandle, jobs, nodes, type Db } from "@irori/db";
import { AGENT_UPDATE_GRACE_MS, createJobsService } from "../src/jobs-service.js";

/**
 * IRI-012 integration: agent-update settle/reap semantics against a real
 * schema. Requires a REAL Postgres (ADR-0002) — same convention as m7.test.ts:
 * IRORI_TEST_DATABASE_URL at a DISPOSABLE database; CI starts the container.
 */
const url = process.env.IRORI_TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d("agent-update jobs (db integration)", () => {
  let handle: ReturnType<typeof createDbHandle>;
  let db: Db;
  let nodeId: string;
  let service: ReturnType<typeof createJobsService>;

  beforeAll(async () => {
    handle = createDbHandle(url!);
    await handle.migrate();
    db = handle.db;
    nodeId = randomUUID();
    await db.insert(nodes).values({
      id: nodeId,
      name: `upd-test-${nodeId.slice(0, 8)}`,
      kind: "spark",
      role: "standalone",
      host: "localhost",
      agentTokenHash: "x",
      agentTokenEnc: "x",
    });
    service = createJobsService(db, () => true);
  });

  afterAll(async () => {
    await db.delete(jobs).where(eq(jobs.nodeId, nodeId));
    await db.delete(nodes).where(eq(nodes.id, nodeId));
    await handle.close();
  });

  it("leaves a young agent-update job alone when the node is offline", async () => {
    const row = await service.create(nodeId, "agent-update", { expectedVersion: "0.3.0" });
    const reaped = await service.reapOffline(new Set());
    expect(reaped).not.toContain(row.id);
    expect((await service.get(row.id))!.status).toBe("running");
    // Free the single-active slot for the next test.
    await db.delete(jobs).where(eq(jobs.id, row.id));
  });

  it("fails an aged-out agent-update with a rollback hint", async () => {
    const row = await service.create(nodeId, "agent-update", { expectedVersion: "0.3.0" });
    await db
      .update(jobs)
      .set({ createdAt: new Date(Date.now() - AGENT_UPDATE_GRACE_MS - 1000) })
      .where(eq(jobs.id, row.id));
    const reaped = await service.reapOffline(new Set());
    expect(reaped).toContain(row.id);
    const detail = await service.get(row.id);
    expect(detail!.status).toBe("failed");
    expect(detail!.output.at(-1)!.line).toContain("timed out");
  });

  it("settles on hello: match succeeds, mismatch stays pending, idle is none", async () => {
    const good = await service.create(nodeId, "agent-update", { expectedVersion: "0.3.0" });
    await expect(service.settleAgentUpdate(nodeId, "0.3.0")).resolves.toBe("succeeded");
    const done = await service.get(good.id);
    expect(done!.status).toBe("succeeded");
    expect(done!.output.at(-1)!.line).toContain("update confirmed");

    const bad = await service.create(nodeId, "agent-update", { expectedVersion: "0.3.0" });
    await expect(service.settleAgentUpdate(nodeId, "0.2.0")).resolves.toBe("pending");
    expect((await service.get(bad.id))!.status).toBe("running");
    await db.delete(jobs).where(eq(jobs.id, bad.id));

    // A newer-than-expected report proves the update took (the fleet may run
    // a bundle newer than the hub's package version) — the slot must free.
    const ahead = await service.create(nodeId, "agent-update", { expectedVersion: "0.3.0" });
    await expect(service.settleAgentUpdate(nodeId, "0.4.0")).resolves.toBe("succeeded");
    expect((await service.get(ahead.id))!.status).toBe("succeeded");

    await expect(service.settleAgentUpdate(nodeId, "0.3.0")).resolves.toBe("none");

    // IR-68: a job created without expectedVersion (the generic jobs
    // endpoint's old shape) must settle FAILED on hello instead of pending
    // forever and blocking the node's single-active slot.
    const malformed = await service.create(nodeId, "agent-update", {});
    await expect(service.settleAgentUpdate(nodeId, "0.3.0")).resolves.toBe("succeeded");
    const malformedDone = await service.get(malformed.id);
    expect(malformedDone!.status).toBe("failed");
    expect(malformedDone!.output.at(-1)!.line).toContain("expectedVersion");
  });

  it("ignores the restart-killed job-done frame but settles a real failure", async () => {
    // The agent's own restart kills the systemd-run child, so the dying agent
    // reports failed with a NULL exit code while the update actually landed
    // (observed on DGX-2/DGX-3 during the 0.5.1 rollout). The version check
    // owns that row; a non-zero exit is a real failure and settles at once.
    const killed = await service.create(nodeId, "agent-update", { expectedVersion: "0.5.1" });
    await service.onDone(nodeId, killed.id, "failed", null);
    expect((await service.get(killed.id))!.status).toBe("running");
    await expect(service.settleAgentUpdate(nodeId, "0.5.1")).resolves.toBe("succeeded");
    expect((await service.get(killed.id))!.status).toBe("succeeded");

    const real = await service.create(nodeId, "agent-update", { expectedVersion: "0.5.1" });
    await service.onDone(nodeId, real.id, "failed", 1);
    expect((await service.get(real.id))!.status).toBe("failed");
  });
});
