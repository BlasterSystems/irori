import { randomUUID } from "node:crypto";
import { inArray, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbHandle, downloadQueue as downloadQueueTable, jobOutput, jobs, nodes, type Db, type DbHandle } from "@irori/db";
import {
  createDownloadQueueService,
  DownloadBusyError,
  DownloadInvalidTransitionError,
  DownloadValidationError,
  type DownloadQueueService,
  type DownloadQueueEntry,
} from "../src/download-queue-service.js";
import { createJobsService, type JobSettledEvent, type JobsService } from "../src/jobs-service.js";

/**
 * IRI-014 integration: enqueue → batch dispatch to the NAS-preferred store
 * node → batch outcome reconcile → retry/remove → boot recover. Requires a
 * REAL Postgres (ADR-0002) — same convention as job-events.test.ts:
 * IRORI_TEST_DATABASE_URL at a DISPOSABLE database. The suite drives settle
 * effects explicitly (queue.onJobSettled) after each jobsService.onDone —
 * production wires the same call into the jobs settle fan-out (index.ts).
 */
const url = process.env.IRORI_TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

const NAS_ID = randomUUID();
const HEAD_ID = randomUUID();
const WORKER_ID = randomUUID();

d("download queue (db integration)", () => {
  let handle: DbHandle;
  let db: Db;
  let jobsService: JobsService;
  let queue: DownloadQueueService;
  let online: Set<string>;
  /** Agent frames the server "sent" (job dispatch + catalog-request). */
  let sent: Array<{ nodeId: string; msg: Record<string, unknown> }>;

  beforeAll(async () => {
    handle = createDbHandle(url!);
    await handle.migrate();
    db = handle.db;
    const token = { agentTokenHash: "x", agentTokenEnc: "x" };
    await db.insert(nodes).values([
      { id: NAS_ID, name: `nas-${NAS_ID.slice(0, 8)}`, kind: "nas", role: "standalone", host: "nas", nasRoot: "/mnt/llms", ...token },
      { id: HEAD_ID, name: `head-${HEAD_ID.slice(0, 8)}`, kind: "spark", role: "head", host: "dgx1", nasRoot: "/mnt/nas", ...token },
      { id: WORKER_ID, name: `worker-${WORKER_ID.slice(0, 8)}`, kind: "spark", role: "worker", host: "dgx2", nasRoot: null, ...token },
    ]);
    online = new Set([NAS_ID, HEAD_ID, WORKER_ID]);
    sent = [];
    const recordSend = (nodeId: string, msg: unknown): boolean => {
      sent.push({ nodeId, msg: msg as Record<string, unknown> });
      return true;
    };
    jobsService = createJobsService(db, recordSend);
    queue = createDownloadQueueService({ db, jobs: jobsService, sendToAgent: recordSend, online: () => online });
  });

  afterAll(async () => {
    // Scoped cleanup: the disposable DB is shared by parallel test files.
    await db.delete(downloadQueueTable).where(
      inArray(downloadQueueTable.source, [
        "org/alpha", "org/beta", "org/gamma", "org/delta", "org/epsilon",
        "org/zeta", "org/eta", "org/theta", "org/iota", "org/juliet", "org/kappa", "org/lambda",
      ]),
    );
    await db.delete(nodes).where(inArray(nodes.id, [NAS_ID, HEAD_ID, WORKER_ID])); // cascades jobs + job_output
    await handle.close();
  });

  const settle = async (batchRef: { jobId: string | null }, status: "succeeded" | "failed" | "canceled", exitCode = 0): Promise<void> => {
    const jobId = batchRef.jobId;
    if (jobId === null) throw new Error("settle() needs a dispatched row");
    await jobsService.onDone(NAS_ID, jobId, status, exitCode);
    const event: JobSettledEvent = { nodeId: NAS_ID, jobId, kind: "download-queue", status, exitCode, durationMs: null };
    await queue.onJobSettled(event);
  };

  const rowFor = async (id: string): Promise<typeof downloadQueueTable.$inferSelect | undefined> => {
    const [row] = await db.select().from(downloadQueueTable).where(eq(downloadQueueTable.id, id)).limit(1);
    return row;
  };

  it("dispatches the first entry as a batch on the NAS-kind node and drains the next on settle", async () => {
    const a = await queue.enqueue({ source: "org/alpha", jobs: 4 });
    expect(a.status).toBe("running");
    expect(a.name).toBe("alpha"); // store-name fallback from the repo tail
    let job = await jobsService.get(a.jobId!);
    expect(job?.nodeId).toBe(NAS_ID); // NAS wins over the spark with the mount
    expect(job?.kind).toBe("download-queue");
    expect(job?.params).toMatchObject({ downloads: [{ source: "org/alpha", name: "alpha" }], jobs: 4 });

    // The node is busy with the batch → the next add QUEUES instead of 409.
    const b = await queue.enqueue({ source: "org/beta", jobs: 8 });
    expect(b.status).toBe("pending");

    // Settling the batch reconciles alpha and drains beta with its own
    // concurrency preference (its entry's jobs value, not alpha's).
    await settle(a, "succeeded");
    expect((await rowFor(a.id))?.status).toBe("succeeded");
    const rowB = await rowFor(b.id);
    expect(rowB?.status).toBe("running");
    expect(rowB?.jobId).not.toBe(a.jobId);
    job = await jobsService.get(rowB!.jobId!);
    expect(job?.params).toMatchObject({ downloads: [{ source: "org/beta", name: "beta" }], jobs: 8 });
    await settle(rowB!, "succeeded");
    expect((await rowFor(b.id))?.status).toBe("succeeded");
  });

  it("keeps entries pending while the store node has an active job, then drains", async () => {
    const busy = await jobsService.create(NAS_ID, "sync-local", { name: "alpha" });
    const entry = await queue.enqueue({ source: "org/gamma", jobs: 4 });
    expect(entry.status).toBe("pending");
    expect(entry.jobId).toBeNull();
    await jobsService.cancel(busy.id);
    await queue.dispatchIfIdle();
    const dispatched = await rowFor(entry.id);
    expect(dispatched?.status).toBe("running");
    await settle(dispatched!, "succeeded");
  });

  it("keeps entries pending when no store node is online, then drains once it is", async () => {
    online = new Set();
    const entry = await queue.enqueue({ source: "org/delta", jobs: 4 });
    expect(entry.status).toBe("pending");
    online = new Set([NAS_ID, HEAD_ID, WORKER_ID]);
    await queue.dispatchIfIdle();
    const after = await rowFor(entry.id);
    expect(after?.status).toBe("running");
    expect(after?.jobId).not.toBeNull();
    await settle(after!, "succeeded");
  });

  it("reconciles a failed batch from the modelctl complete/failed output lines", async () => {
    // Three adds while the node is busy → they form ONE batch when it frees.
    const busy = await jobsService.create(NAS_ID, "sync-local", { name: "alpha" });
    const a = await queue.enqueue({ source: "org/epsilon", jobs: 4 });
    const b = await queue.enqueue({ source: "org/zeta", jobs: 4 });
    const c = await queue.enqueue({ source: "org/eta", jobs: 4 });
    for (const e of [a, b, c]) expect(e.status).toBe("pending");
    await jobsService.cancel(busy.id);
    await queue.dispatchIfIdle();
    const rowA0 = await rowFor(a.id);
    expect(rowA0?.status).toBe("running");
    const jobId = rowA0!.jobId!;
    expect((await rowFor(b.id))?.jobId).toBe(jobId);
    expect((await rowFor(c.id))?.jobId).toBe(jobId);
    // Batch ends with per-entry terminal lines (modelctl prints them LAST,
    // so they survive the 400-line output ring).
    await db.insert(jobOutput).values([
      { jobId, seq: 1, line: "[1/3] complete: epsilon -> /mnt/llms/models/org/epsilon" },
      { jobId, seq: 2, line: "[2/3] failed: zeta: DownloadError: connection reset" },
    ]);
    await settle(rowA0!, "failed", 1);
    expect((await rowFor(a.id))?.status).toBe("succeeded");
    const rowB = await rowFor(b.id);
    expect(rowB?.status).toBe("failed");
    expect(rowB?.error).toContain("connection reset");
    const rowC = await rowFor(c.id);
    expect(rowC?.status).toBe("failed");
    expect(rowC?.error).toBe("did not complete in the batch");
    // Partial failure still refreshes the catalog (published entries); the
    // jobs service only sends catalog-request on full success.
    expect(sent.some((s) => s.msg.type === "catalog-request")).toBe(true);
  });

  it("marks rows canceled when the batch job is canceled", async () => {
    const a = await queue.enqueue({ source: "org/theta", jobs: 4 });
    expect(a.status).toBe("running");
    const ok = await jobsService.cancel(a.jobId!);
    expect(ok).toBe(true);
    await queue.onJobSettled({ nodeId: NAS_ID, jobId: a.jobId!, kind: "download-queue", status: "canceled", exitCode: null, durationMs: null });
    const row = await rowFor(a.id);
    expect(row?.status).toBe("canceled");
    expect(row?.error).toBe("batch canceled");
  });

  it("retries failed entries and refuses invalid transitions", async () => {
    const [failed] = await db.select().from(downloadQueueTable).where(eq(downloadQueueTable.status, "failed")).limit(1);
    expect(failed).toBeDefined();
    const entry = await queue.retry(failed!.id);
    expect(entry.status).toBe("running"); // node idle again → drained
    await expect(queue.retry(entry.id)).rejects.toBeInstanceOf(DownloadInvalidTransitionError);
    await settle(entry, "succeeded");
  });

  it("removes pending rows but refuses the running batch entry", async () => {
    const a = await queue.enqueue({ source: "org/juliet", jobs: 4 }); // idle → dispatched
    expect(a.status).toBe("running");
    await expect(queue.remove(a.id)).rejects.toBeInstanceOf(DownloadBusyError);
    // Node busy with the running batch → the add stays pending → removable.
    const pending = await queue.enqueue({ source: "org/iota", jobs: 2 });
    expect(pending.status).toBe("pending");
    await queue.remove(pending.id);
    expect(await rowFor(pending.id)).toBeUndefined();
    await settle(a, "succeeded");
  });

  it("rejects invalid enqueue payloads", async () => {
    await expect(queue.enqueue({ source: "" })).rejects.toBeInstanceOf(DownloadValidationError);
    await expect(queue.enqueue({ source: "org/x", jobs: 99 })).rejects.toBeInstanceOf(DownloadValidationError);
  });

  it("recovers: settles rows whose batch ended while the server was down, then drains", async () => {
    // Simulate a crash mid-batch: job already terminal in the DB, row still running.
    const a = await queue.enqueue({ source: "org/kappa", jobs: 4 });
    expect(a.status).toBe("running");
    const jobId = a.jobId!;
    await db.insert(jobOutput).values({ jobId, seq: 1, line: "[1/1] complete: kappa -> /mnt/llms/models/org/kappa" });
    await db.update(jobs).set({ status: "failed", exitCode: 1, finishedAt: new Date() }).where(eq(jobs.id, jobId));
    await queue.recover();
    expect((await rowFor(a.id))?.status).toBe("succeeded");
    // And a pending row drains once the store node is idle again.
    const [pending] = await db
      .insert(downloadQueueTable)
      .values({ source: "org/lambda", name: "lambda", jobs: 4 })
      .returning();
    await queue.recover();
    const after = await rowFor(pending!.id);
    expect(after?.status).toBe("running");
  });
});
