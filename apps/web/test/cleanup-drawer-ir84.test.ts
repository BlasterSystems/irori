// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";

/**
 * IRI-084: CleanupDrawer tier — audit run via the job poller, the typed
 * node-name confirm gating the clean, streamed outcomes table, and the
 * prevention toggles.
 */

const UUID = "11111111-1111-4111-8111-111111111111";

/** The mocked job runner responds per dispatched kind (IR-207 debris flow). */
const modelsState = vi.hoisted(() => ({ kind: "hygiene-audit" as string }));

vi.mock("../src/models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/models")>();
  return {
    ...actual,
    createJob: vi.fn(async (_nodeId: string, kind: string) => {
      modelsState.kind = kind;
      return { id: UUID };
    }),
    fetchJob: vi.fn(async () => {
    let line = '{"outcomes":[{"category":"pip-cache","status":"cleaned","bytesReclaimed":1048576,"itemsRemoved":3,"error":null}]}';
    if (modelsState.kind === "staging-tree-audit") {
      line = JSON.stringify({
        kind: "staging-tree-audit",
        trees: [{ path: "/store/.staging/.cleanup-quarantine/abc", kind: "cleanup-quarantine", name: null, bytes: 1000, mtimeMs: null }],
        totals: { stagingBytes: 0, activeQuarantineBytes: 0, cleanupQuarantineBytes: 1000 },
        freeBytes: null,
        timedOut: false,
      });
    }
    if (modelsState.kind === "prune-cleanup-quarantine") {
      line = JSON.stringify({
        kind: "prune-cleanup-quarantine",
        applied: true,
        freedBytes: 1000,
        results: [{ path: "/store/.staging/.cleanup-quarantine/abc", status: "removed", bytes: 1000 }],
      });
    }
    return {
      job: { id: UUID, status: "succeeded", kind: modelsState.kind, createdAt: new Date().toISOString(), exitCode: 0, startedAt: null, finishedAt: null, nodeId: UUID },
      output: [{ seq: 1, line }],
    };
  }),
};
});
vi.mock("../src/scrim", () => ({ vScrimClose: {} }));
vi.mock("../src/api", () => ({
  fetchCleanup: vi.fn(async () => ({ latestAudit: null, history: [], prevention: { weeklySafePass: false, logRotationApplied: false } })),
  setWeeklySafePass: vi.fn(async () => ({ weeklySafePass: true, logRotationApplied: true })),
}));

import type { CleanupDrawerProps } from "./cleanup-harness";

afterEach(() => {
  try { vi.useRealTimers(); } catch { /* not faked */ }
  vi.clearAllMocks();
  modelsState.kind = "hygiene-audit";
});

async function mountDrawer() {
  const { default: CleanupDrawer } = await import("../src/components/CleanupDrawer.vue");
  const w = mount(CleanupDrawer as never, { props: { nodeId: UUID, nodeName: "dgx1" } as never });
  await new Promise((r) => setTimeout(r, 30));
  return w;
}

const flush = async () => {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
  }
};

describe("CleanupDrawer", () => {
  it("mounts with the never-audited state and runs an audit through the poller", async () => {
    const w = await mountDrawer();
    expect(w.text()).toContain("never audited");
    vi.useFakeTimers();
    const run = w.findAll("button").find((b) => b.text() === "Run audit")!;
    await run.trigger("click");
    await flush();
    await vi.advanceTimersByTimeAsync(2100);
    await flush();
    const { createJob, fetchJob } = (await import("../src/models")) as unknown as { createJob: ReturnType<typeof vi.fn>; fetchJob: ReturnType<typeof vi.fn> };
    expect(createJob).toHaveBeenCalledWith(UUID, "hygiene-audit", {});
    expect(fetchJob).toHaveBeenCalled();
    w.unmount();
  });

  it("gates the clean behind the typed node name and renders outcomes", async () => {
    const w = await mountDrawer();
    vi.useFakeTimers();
    const cleanBtn = () => w.findAll("button").find((b) => b.text().startsWith("Clean"));
    expect(cleanBtn()!.attributes("disabled")).toBeDefined(); // empty confirm name
    await w.find("input[aria-label='Type the node name to confirm the clean']").setValue("dgx1");
    expect(cleanBtn()!.attributes("disabled")).toBeUndefined();
    await cleanBtn()!.trigger("click");
    await flush();
    await vi.advanceTimersByTimeAsync(2100);
    await flush();
    const text = w.text();
    expect(text).toContain("Finished");
    expect(text).toContain("pip-cache");
    expect(text).toContain("1 MB"); // fmtBytes trims trailing zeros
    w.unmount();
  });

  it("toggles the weekly safe pass through the api", async () => {
    const w = await mountDrawer();
    const weekly = w.find("input[type='checkbox']");
    await weekly.setValue(true);
    const { setWeeklySafePass } = (await import("../src/api")) as unknown as { setWeeklySafePass: ReturnType<typeof vi.fn> };
    expect(setWeeklySafePass).toHaveBeenCalledWith(UUID, true);
    w.unmount();
  });

  it("history tab shows the empty state", async () => {
    const w = await mountDrawer();
    await w.findAll("button").find((b) => b.text() === "History")!.trigger("click");
    expect(w.text()).not.toContain("never audited");
    w.unmount();
  });

  it("dry-runs the cleanup debris prune, then arms and applies it (IR-207)", async () => {
    const w = await mountDrawer();
    vi.useFakeTimers();
    // The staging audit renders the debris section (totals > 0).
    await w.findAll("button").find((b) => b.text() === "Audit staging trees")!.trigger("click");
    await flush();
    await vi.advanceTimersByTimeAsync(2100);
    await flush();
    expect(w.text()).toContain("cleanup-quarantine 1 KB");

    // Dry run: dispatches without confirm, never deletes.
    await w.findAll("button").find((b) => b.text() === "List cleanup debris (dry run)")!.trigger("click");
    await flush();
    await vi.advanceTimersByTimeAsync(2100);
    await flush();
    const { createJob } = (await import("../src/models")) as unknown as { createJob: ReturnType<typeof vi.fn> };
    expect(createJob).toHaveBeenCalledWith(UUID, "prune-cleanup-quarantine", {});
    expect(w.text()).toContain("dry run");

    // Arm → typed confirm → apply.
    await w.findAll("button").find((b) => b.text() === "Prune debris…")!.trigger("click");
    const armed = w.findAll("button").find((b) => b.text() === "Prune debris")!;
    expect(armed.attributes("disabled")).toBeDefined(); // confirm empty
    await w.find("input[aria-label='Type prune to confirm removing the cleanup-quarantine debris']").setValue("prune");
    expect(armed.attributes("disabled")).toBeUndefined();
    await armed.trigger("click");
    await flush();
    await vi.advanceTimersByTimeAsync(2100);
    await flush();
    expect(createJob).toHaveBeenCalledWith(UUID, "prune-cleanup-quarantine", { confirm: "prune" });
    expect(w.text()).toContain("applied");
    expect(w.text()).toContain("freed");
    w.unmount();
  });
});
