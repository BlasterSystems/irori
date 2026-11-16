// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { jobInfoSchema, type JobInfo } from "@irori/core";

/**
 * IR-262: the dock footer carries a Clear history button when settled rows
 * exist — one click DELETEs /api/v1/jobs and re-seeds, leaving only
 * queued/running rows; no button without settled rows.
 */

vi.mock("../src/live", async () => ({ live: (await import("./live-mock")).liveMock }));

afterEach(() => vi.unstubAllGlobals());

const NODE = "33333333-3333-4333-8333-333333333333";
const RUNNING = "44444444-4444-4444-8444-444444444444";
const DONE_A = "55555555-5555-4555-8555-555555555555";
const DONE_B = "66666666-6666-4666-8666-666666666666";

function job(id: string, status: "running" | "succeeded" | "failed") {
  return jobInfoSchema.parse({
    id,
    nodeId: NODE,
    kind: "sync-local",
    status,
    params: { name: "GLM" },
    progress: null,
    cancelRequestedAt: null,
    exitCode: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: status === "running" ? null : new Date().toISOString(),
  });
}

function stubFetch() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "DELETE") return new Response(JSON.stringify({ deleted: 2 }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ jobs: [] }), { status: 200, headers: { "content-type": "application/json" } });
  });
}

async function mountDock(seed: JobInfo[]) {
  const { liveMock } = await import("./live-mock");
  // The dock re-seeds on mount, so the seed must come from refreshJobs —
  // after the DELETE it returns only the queued/running rows.
  let cleared = false;
  const running = seed.find((j) => j.status === "running");
  liveMock.refreshJobs = async () => {
    liveMock.jobs.clear();
    for (const j of cleared ? seed.filter((j) => j.status === "running") : seed) liveMock.jobs.set(j.id, j);
  };
  const fetches = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "DELETE") {
      cleared = true;
      return new Response(JSON.stringify({ deleted: seed.length - (running === undefined ? 0 : 1) }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ jobs: [] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetches);
  const { default: TransfersDock } = await import("../src/components/TransfersDock.vue");
  const w = mount(TransfersDock as never);
  await new Promise((r) => setTimeout(r, 60));
  return { w, fetches };
}

describe("Transfers dock clear history (IR-262)", () => {
  it("clears the settled history and keeps active rows", async () => {
    const { w, fetches } = await mountDock([job(RUNNING, "running"), job(DONE_A, "succeeded"), job(DONE_B, "failed")]);
    const button = w.find('button[aria-label="Clear transfer history"]');
    expect(button.exists()).toBe(true);
    expect(w.text()).toContain("Earlier");

    await button.trigger("click");
    await vi.waitFor(() => expect(w.text()).not.toContain("Earlier"));
    const del = fetches.mock.calls.find((c) => String(c[0]).includes("/api/v1/jobs") && c[1]?.method === "DELETE");
    expect(del).toBeDefined();
    // The active row survives the re-seed.
    expect(w.text()).toContain("Active · 1");
    w.unmount();
  });

  it("renders no clear button without settled rows", async () => {
    const { w } = await mountDock([job(RUNNING, "running")]);
    expect(w.find('button[aria-label="Clear transfer history"]').exists()).toBe(false);
    w.unmount();
  });
});
