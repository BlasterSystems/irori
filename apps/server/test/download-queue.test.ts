import { randomUUID } from "node:crypto";
import { inArray, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbHandle, downloadQueue as downloadQueueTable, jobOutput, jobs, nodes, type Db, type DbHandle } from "@irori/db";
import {
  createDownloadQueueService,
  DownloadBusyError,
  DownloadInvalidTransitionError,
  DownloadValidationError,
  parseProgressLine,
  type DownloadQueueService,
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

describe("parseProgressLine (pure)", () => {
  it("extracts the modelctl progress contract fields", () => {
    expect(parseProgressLine('progress: {"entry":2,"name":"sierra","bytes_done":1024.4,"bytes_total":2048,"speed_bps":5242880}')).toEqual({
      entry: 2,
      name: "sierra",
      bytesDone: 1024.4,
      bytesTotal: 2048,
      speedBps: 5242880,
    });
  });

  it("tolerates missing optional fields and junk lines", () => {
    expect(parseProgressLine('progress: {"bytes_done":0}')).toEqual({ entry: null, name: null, bytesDone: 0, bytesTotal: null, speedBps: null });
    expect(parseProgressLine("[1/1] complete: kappa -> /mnt/llms/models/org/kappa")).toBeNull();
    expect(parseProgressLine("progress: {not json")).toBeNull();
    expect(parseProgressLine('progress: {"bytes_done":"nope"}')).toBeNull();
  });
});

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
        "org/zeta", "org/eta", "org/theta", "org/iota", "org/juliet", "org/kappa", "org/lambda", "org/mike",
        "org/november", "org/oscar", "org/papa", "org/quebec", "org/romeo",
        "org/rho", "org/sierra", "org/tango", "org/uniform",
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
    // IR-131: cancel no longer frees the slot — the agent's terminal report does.
    await jobsService.onDone(NAS_ID, busy.id, "canceled", null);
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
    // IR-131: cancel no longer frees the slot — the agent's terminal report does.
    await jobsService.onDone(NAS_ID, busy.id, "canceled", null);
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
    expect(ok).toEqual({ ok: true });
    // IR-131 verify-before-write: the batch is untouched until the agent
    // reports the kill — a premature canceled write would free the slot.
    const unsettled = await db.select().from(jobs).where(eq(jobs.id, a.jobId!));
    expect(unsettled[0]!.status).toBe("running");
    expect(unsettled[0]!.cancelRequestedAt).not.toBeNull();
    await jobsService.onDone(NAS_ID, a.jobId!, "canceled", null);
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

  it("rejects a whole batch when any entry is invalid (atomic)", async () => {
    const before = await queue.list();
    await expect(
      queue.enqueueBatch({ downloads: [{ source: "org/valid" }, { source: "" }], jobs: 4 }),
    ).rejects.toBeInstanceOf(DownloadValidationError);
    expect(await queue.list()).toEqual(before); // nothing landed
  });

  it("enqueues a batch atomically and dispatches it as ONE modelctl batch", async () => {
    const entries = await queue.enqueueBatch({
      downloads: [{ source: "org/november" }, { source: "org/oscar", name: "oscar-custom" }],
      jobs: 6,
    });
    expect(entries).toHaveLength(2);
    expect(entries[0]!.name).toBe("november"); // derived from the repo tail
    expect(entries[1]!.name).toBe("oscar-custom");
    expect(entries[0]!.status).toBe("running");
    expect(entries[1]!.jobId).toBe(entries[0]!.jobId); // one shared batch
    const job = await jobsService.get(entries[0]!.jobId!);
    expect(job?.nodeId).toBe(NAS_ID);
    // Batch rows share createdAt — the dispatch order is (createdAt, id), not
    // insertion order, so compare the entry set order-insensitively.
    const atomicDownloads = (job?.params as { downloads: Array<{ source: string; name: string }> }).downloads;
    expect([...atomicDownloads].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { source: "org/november", name: "november" },
      { source: "org/oscar", name: "oscar-custom" },
    ]);
    expect(job?.params).toMatchObject({ jobs: 6 });
    await settle(entries[0]!, "succeeded");
    expect((await rowFor(entries[1]!.id))?.status).toBe("succeeded");
  });

  it("persists and dispatches per-entry quantization/mtp with derived names (IRI-016)", async () => {
    const entries = await queue.enqueueBatch({
      downloads: [
        { source: "org/quebec", quantization: "UD-Q4_K_XL" },
        { source: "org/romeo", quantization: "bf16", mtp: "MTP/mtp-x.gguf" },
      ],
      jobs: 2,
    });
    // Same-repo quants can't collide: derived names carry the tag suffix.
    expect(entries.map((e) => e.name)).toEqual(["quebec-UD-Q4_K_XL", "romeo-bf16"]);
    expect(entries.map((e) => e.quantization)).toEqual(["UD-Q4_K_XL", "bf16"]);
    expect(entries[0]!.mtp).toBeNull();
    expect(entries[1]!.mtp).toBe("MTP/mtp-x.gguf");
    const job = await jobsService.get(entries[0]!.jobId!);
    const i016Downloads = (job?.params as { downloads: Array<{ source: string; name: string; quantization?: string; mtp?: string }> }).downloads;
    expect([...i016Downloads].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { source: "org/quebec", name: "quebec-UD-Q4_K_XL", quantization: "UD-Q4_K_XL" },
      { source: "org/romeo", name: "romeo-bf16", quantization: "bf16", mtp: "MTP/mtp-x.gguf" },
    ]);
    expect(job?.params).toMatchObject({ jobs: 2 });
    await settle(entries[0]!, "failed");
    const retried = await queue.retry(entries[0]!.id);
    expect(retried.quantization).toBe("UD-Q4_K_XL"); // retry keeps the stored fields
    // The retry re-dispatched the entry: settle it so later tests see an idle node.
    expect(retried.status).toBe("running");
    await settle(retried, "succeeded");
  });

  it("reconciles a failed batch from the modelctl queue --json results document", async () => {
    // Busy the node first so both entries land in ONE batch (idle dispatches
    // the first add immediately).
    const busy = await jobsService.create(NAS_ID, "sync-local", { name: "alpha" });
    const a = await queue.enqueue({ source: "org/papa", jobs: 4 });
    const b = await queue.enqueue({ source: "org/quebec", jobs: 4 });
    for (const e of [a, b]) expect(e.status).toBe("pending");
    await jobsService.cancel(busy.id);
    // IR-131: cancel no longer frees the slot — the agent's terminal report does.
    await jobsService.onDone(NAS_ID, busy.id, "canceled", null);
    await queue.dispatchIfIdle();
    const rowA0 = await rowFor(a.id);
    expect(rowA0?.status).toBe("running");
    const jobId = rowA0!.jobId!;
    expect((await rowFor(b.id))?.jobId).toBe(jobId);
    // Output carries ONLY the queue --json document (last stdout line) —
    // no [i/n] terminal lines; the JSON tail is authoritative.
    await db.insert(jobOutput).values({
      jobId,
      seq: 1,
      line:
        '{"schema":1,"results":[' +
        '{"index":1,"name":"papa","source":"org/papa","status":"complete","active_path":"/mnt/llms/models/org/papa/x--y","error_type":null,"error":null},' +
        '{"index":2,"name":"quebec","source":"org/quebec","status":"failed","active_path":null,"error_type":"DownloadError","error":"connection reset mid-stream"}]}',
    });
    await settle(rowA0!, "failed", 1);
    expect((await rowFor(a.id))?.status).toBe("succeeded");
    const rowB = await rowFor(b.id);
    expect(rowB?.status).toBe("failed");
    expect(rowB?.error).toBe("DownloadError: connection reset mid-stream");
  });

  it("settles orphaned running rows when the batch job reference is lost (node delete cascade)", async () => {
    const a = await queue.enqueue({ source: "org/mike", jobs: 4 });
    expect(a.status).toBe("running");
    // Simulate the FK cascade: the node row is deleted, download_queue.job_id
    // drops to NULL while the entry still reads "running".
    await db
      .update(downloadQueueTable)
      .set({ status: "running", jobId: null })
      .where(eq(downloadQueueTable.id, a.id));
    // The reaper tick (dispatchIfIdle) must settle it without a restart.
    await queue.dispatchIfIdle();
    const row = await rowFor(a.id);
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe("batch job reference lost");
    // Free the store node for the next test: the batch job itself is still
    // active even though this row's reference was lost.
    await settle(a, "failed", 1);
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

  it("persists and dispatches per-entry force, and Retry with force re-arms it (IRI-017)", async () => {
    // The recover test leaves its drained row dispatching — settle that batch
    // so the store node is idle for this one.
    const [leftover] = await db.select().from(downloadQueueTable).where(eq(downloadQueueTable.source, "org/lambda")).limit(1);
    if (leftover !== undefined && leftover.jobId !== null) await settle(leftover, "succeeded");
    const entries = await queue.enqueueBatch({
      downloads: [{ source: "org/rho", force: true }, { source: "org/tango" }],
      jobs: 2,
    });
    expect(entries[0]!.force).toBe(true);
    expect(entries[1]!.force).toBe(false);
    const job = await jobsService.get(entries[0]!.jobId!);
    const forceDownloads = (job?.params as { downloads: Array<{ source: string; name: string; force?: boolean }> }).downloads;
    expect([...forceDownloads].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { source: "org/rho", name: "rho", force: true },
      { source: "org/tango", name: "tango" },
    ]);
    await settle(entries[0]!, "failed");
    // A plain retry keeps the stored per-entry force.
    const plain = await queue.retry(entries[0]!.id);
    expect(plain.force).toBe(true);
    expect(plain.status).toBe("running");
    await settle(plain, "failed");
    // Retry with force arms an entry that never had it.
    const forced = await queue.retry(entries[1]!.id, { force: true });
    expect(forced.force).toBe(true);
    expect(forced.status).toBe("running");
    const jobAfter = await jobsService.get(forced.jobId!);
    expect(jobAfter?.params).toMatchObject({ downloads: [{ source: "org/tango", name: "tango", force: true }] });
    await settle(forced, "succeeded");
  });

  it("maps modelctl progress lines onto the running batch rows (IRI-017)", async () => {
    const busy = await jobsService.create(NAS_ID, "sync-local", { name: "alpha" });
    const a = await queue.enqueue({ source: "org/sierra", jobs: 4 });
    const b = await queue.enqueue({ source: "org/uniform", jobs: 4 });
    for (const e of [a, b]) expect(e.status).toBe("pending");
    await jobsService.cancel(busy.id);
    // IR-131: cancel no longer frees the slot — the agent's terminal report does.
    await jobsService.onDone(NAS_ID, busy.id, "canceled", null);
    await queue.dispatchIfIdle();
    const rowA0 = await rowFor(a.id);
    expect(rowA0?.status).toBe("running");
    const jobId = rowA0!.jobId!;
    expect((await rowFor(b.id))?.jobId).toBe(jobId);

    // Name match wins over the entry index — entry 1 points at sierra, so
    // ONLY the name branch can select uniform.
    await queue.onJobOutput(jobId, 'progress: {"entry":1,"name":"uniform","bytes_done":1024,"bytes_total":2048,"speed_bps":5000000}');
    const rowB = await rowFor(b.id);
    expect(rowB?.bytesDone).toBe(1024);
    expect(rowB?.bytesTotal).toBe(2048);
    expect(rowB?.speedBps).toBe(5000000);
    expect((await rowFor(a.id))?.bytesDone).toBeNull();

    // Entry-index fallback (dispatch order = pending rows by createdAt).
    await queue.onJobOutput(jobId, 'progress: {"entry":1,"bytes_done":1,"bytes_total":2}');
    const rowA1 = await rowFor(a.id);
    expect(rowA1?.bytesDone).toBe(1);
    expect(rowA1?.bytesTotal).toBe(2);

    // Unknown jobs and non-progress lines are no-ops.
    await expect(queue.onJobOutput(randomUUID(), 'progress: {"bytes_done":1}')).resolves.toBeUndefined();
    await expect(queue.onJobOutput(jobId, "[1/2] complete: sierra")).resolves.toBeUndefined();

    // Terminal settle drops the stale speed but keeps the last byte counts.
    await settle(rowA0!, "succeeded");
    const rowB2 = await rowFor(b.id);
    expect(rowB2?.status).toBe("succeeded");
    expect(rowB2?.speedBps).toBeNull();
    expect(rowB2?.bytesDone).toBe(1024);
  });
});
