import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadQueueEntrySchema } from "@irori/core";
import {
  cancelJob, createJob, downloadAvgSpeedBps, downloadEntryEta, downloadJobSummary,
  downloadStatusChip, enqueueDownload, enqueueDownloadsBatch, fetchHfQuants,
  fetchModelsPage, isValidJobKind, jobStatusChip, placementChip, removeDownload,
  retryDownload, setupServingModel, startAgentUpdate,
} from "../src/models";

/**
 * IRI-084: models.ts wrapper contracts — POST/DELETE/retry flows, error
 * surfaces, chip mappings and the pure helper branches. Fixtures built via
 * schema.parse so they cannot drift.
 */

afterEach(() => vi.unstubAllGlobals());

const UUID = "11111111-1111-4111-8111-111111111111";
const iso = new Date().toISOString();

function row(over: Partial<Record<string, unknown>> = {}) {
  return downloadQueueEntrySchema.parse({
    id: UUID, source: "hf", name: "GLM-5.3-EXL3", status: "pending",
    jobId: null, error: null, createdAt: iso, updatedAt: iso, ...over,
  });
}

function jobBody() {
  return { job: { id: UUID, nodeId: UUID, kind: "sync-local", status: "queued", createdAt: new Date().toISOString(), exitCode: null, startedAt: null, finishedAt: null } };
}

function res(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("async wrappers", () => {
  it("createJob posts and returns the job; errors surface the server message", async () => {
    const post = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toContain("/jobs");
      expect(init?.method).toBe("POST");
      return res(200, jobBody());
    });
    vi.stubGlobal("fetch", post);
    const job = await createJob(UUID, "sync-local", {});
    expect(job.status).toBe("queued");
    vi.stubGlobal("fetch", vi.fn(async () => res(409, { error: "node offline" })));
    await expect(createJob(UUID, "sync-local", {})).rejects.toThrow("node offline");
    vi.stubGlobal("fetch", vi.fn(async () => res(500, null)));
    await expect(createJob(UUID, "sync-local", {})).rejects.toThrow("HTTP 500");
    vi.stubGlobal("fetch", vi.fn(async () => res(200, { job: {} })));
    await expect(createJob(UUID, "sync-local", {})).rejects.toThrow("malformed job response");
  });

  it("cancelJob tolerates 204 and surfaces error bodies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    await expect(cancelJob(UUID)).resolves.toBeUndefined();
    vi.stubGlobal("fetch", vi.fn(async () => res(409, { error: "already finished" })));
    await expect(cancelJob(UUID)).rejects.toThrow("already finished");
  });

  it("enqueueDownload parses the entry and surfaces errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(200, { entry: row({ status: "pending" }) })));
    const e = await enqueueDownload({ source: "hf", name: "m", jobs: 1 });
    expect(e.name).toBe("GLM-5.3-EXL3");
    vi.stubGlobal("fetch", vi.fn(async () => res(400, { error: "bad source" })));
    await expect(enqueueDownload({ source: "x", jobs: 1 })).rejects.toThrow("bad source");
    vi.stubGlobal("fetch", vi.fn(async () => res(200, { entry: {} })));
    await expect(enqueueDownload({ source: "x", jobs: 1 })).rejects.toThrow("malformed download queue response");
  });

  it("enqueueDownloadsBatch parses entries; errors propagate", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(200, { entries: [row(), row({ name: "B" })] })));
    const es = await enqueueDownloadsBatch({ downloads: [], jobs: 2 });
    expect(es).toHaveLength(2);
    vi.stubGlobal("fetch", vi.fn(async () => res(409, { error: "busy" })));
    await expect(enqueueDownloadsBatch({ downloads: [], jobs: 2 })).rejects.toThrow("busy");
  });

  it("fetchHfQuants parses results and surfaces server error text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(200, { repo: "org/m", modelCard: null, quants: [], companions: { mmproj: { candidates: [], default: null }, mtp: { candidates: [], default: null } } })));
    await expect(fetchHfQuants("org/m")).resolves.toMatchObject({ repo: "org/m" });
    vi.stubGlobal("fetch", vi.fn(async () => res(502, { error: "hf unavailable" })));
    await expect(fetchHfQuants("org/m")).rejects.toThrow("hf unavailable");
    vi.stubGlobal("fetch", vi.fn(async () => res(502, {})));
    await expect(fetchHfQuants("org/m")).rejects.toThrow("GET /api/v1/hf-quants -> 502");
  });

  it("removeDownload and retryDownload handle ok/error/terminal paths", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    await expect(removeDownload(UUID)).resolves.toBeUndefined();
    vi.stubGlobal("fetch", vi.fn(async () => res(409, { error: "batch running" })));
    await expect(removeDownload(UUID)).rejects.toThrow("batch running");
    vi.stubGlobal("fetch", vi.fn(async () => res(200, { entry: row({ status: "pending" }) })));
    await expect(retryDownload(UUID)).resolves.toMatchObject({ status: "pending" });
    vi.stubGlobal("fetch", vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.body).toContain("force");
      return res(200, { entry: row({ status: "pending" }) });
    }));
    await expect(retryDownload(UUID, true)).resolves.toBeDefined();
    vi.stubGlobal("fetch", vi.fn(async () => res(500, { error: "nope" })));
    await expect(retryDownload(UUID)).rejects.toThrow("nope");
  });

  it("startAgentUpdate returns the job and surfaces 409 copy", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: RequestInfo | URL, init?: RequestInit) => {
      expect(String(u)).toContain("agent-update");
      expect(init?.method).toBe("POST");
      return res(200, jobBody());
    }));
    await expect(startAgentUpdate(UUID)).resolves.toMatchObject({ kind: "sync-local" });
    vi.stubGlobal("fetch", vi.fn(async () => res(409, { error: "active job" })));
    await expect(startAgentUpdate(UUID)).rejects.toThrow("active job");
  });

  it("fetchModelsPage throws on non-ok and malformed bodies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(500)));
    await expect(fetchModelsPage(1, "")).rejects.toThrow("-> 500");
    vi.stubGlobal("fetch", vi.fn(async () => res(200, {})));
    await expect(fetchModelsPage(1, "")).rejects.toThrow("malformed models response");
  });
});

describe("pure helper branches", () => {
  it("chips map every status/action", () => {
    expect(downloadStatusChip("succeeded")).toMatchObject({ label: "downloaded", cls: "chip--ok" });
    expect(downloadStatusChip("failed")).toMatchObject({ cls: "chip--warn" });
    expect(downloadStatusChip("canceled")).toMatchObject({ label: "canceled", cls: "chip" });
    expect(downloadStatusChip("removed")).toMatchObject({ label: "removed" });
    expect(downloadStatusChip("running")).toMatchObject({ cls: "chip--accent" });
    expect(placementChip("present")).toMatchObject({ label: "present", cls: "chip--ok" });
    expect(placementChip("sync")).toMatchObject({ label: "needs sync" });
    expect(placementChip("push")).toMatchObject({ label: "needs push" });
    expect(placementChip("unavailable")).toMatchObject({ label: "unavailable", cls: "chip--warn" });
    expect(jobStatusChip("succeeded")).toMatchObject({ cls: "chip--ok" });
    expect(jobStatusChip("failed")).toMatchObject({ cls: "chip--warn" });
    expect(jobStatusChip("canceled")).toMatchObject({ cls: "chip" });
    expect(jobStatusChip("running")).toMatchObject({ cls: "chip--accent" });
    expect(isValidJobKind("sync-local")).toBe(true);
    expect(isValidJobKind("nope")).toBe(false);
  });

  it("eta and avg-speed branches", () => {
    expect(downloadEntryEta(row({ status: "running", speedBps: 100, bytesDone: 500, bytesTotal: 1500 }))).toBe(10);
    expect(downloadEntryEta(row({ status: "pending" }))).toBeNull();
    expect(downloadEntryEta(row({ status: "running", speedBps: 0 }))).toBeNull();
    expect(downloadEntryEta(row({ status: "running", speedBps: 10, bytesDone: 2000, bytesTotal: 1500 }))).toBe(0);
    const t0 = "2026-11-04T10:00:00Z";
    const t1 = "2026-11-04T10:01:00Z";
    expect(downloadAvgSpeedBps(row({ bytesTotal: 600, createdAt: t0, updatedAt: t1 }))).toBe(10);
    expect(downloadAvgSpeedBps(row({ bytesTotal: null }))).toBeNull();
    expect(downloadAvgSpeedBps(row({ bytesTotal: 600, createdAt: t1, updatedAt: t1 }))).toBeNull();
  });

  it("summary renders failed/canceled lines and setupServingModel matches", () => {
    const s = downloadJobSummary([row({ status: "failed", error: "ECONN\nRESET" }), row({ name: "B", status: "canceled" }), row({ name: "C", status: "pending" })]);
    expect(s).toContain("✗ GLM-5.3-EXL3  failed — ECONN RESET");
    expect(s).toContain("✗ B");
    expect(s).toContain("canceled");
    expect(s).toContain("· C");
    expect(s).toContain("waiting");
    expect(setupServingModel([{ name: "svc", model: "m" }], "m")).toBe("svc");
    expect(setupServingModel([{ name: "svc", model: "m" }], "other")).toBeNull();
  });
});
