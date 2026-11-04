// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";

/**
 * IRI-084: CleanupDrawer tier — audit run via the job poller, the typed
 * node-name confirm gating the clean, streamed outcomes table, and the
 * prevention toggles.
 */

const UUID = "11111111-1111-4111-8111-111111111111";

vi.mock("../src/scrim", () => ({ vScrimClose: {} }));
vi.mock("../src/models", () => ({
  createJob: vi.fn(async () => ({ id: UUID })),
  fetchJob: vi.fn(async () => ({
    job: { id: UUID, status: "succeeded", kind: "hygiene-audit", createdAt: new Date().toISOString(), exitCode: 0, startedAt: null, finishedAt: null, nodeId: UUID },
    output: [{ seq: 1, line: '{"outcomes":[{"category":"pip-cache","status":"cleaned","bytesReclaimed":1048576,"itemsRemoved":3,"error":null}]}' }],
  })),
}));
vi.mock("../src/api", () => ({
  fetchCleanup: vi.fn(async () => ({ latestAudit: null, history: [], prevention: { weeklySafePass: false, logRotationApplied: false } })),
  setWeeklySafePass: vi.fn(async () => ({ weeklySafePass: true, logRotationApplied: true })),
}));

import { CleanupDrawerProps } from "./cleanup-harness";

afterEach(() => {
  try { vi.useRealTimers(); } catch { /* not faked */ }
  vi.clearAllMocks();
});

async function mountDrawer() {
  const { default: CleanupDrawer } = await import("../src/components/CleanupDrawer.vue");
  const w = mount(CleanupDrawer as never, { props: { nodeId: UUID, nodeName: "dgx1" } as never as CleanupDrawerProps });
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
});
