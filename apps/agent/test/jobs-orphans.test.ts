import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { JobManager, reconcileOrphanedJobs, ACTIVE_JOBS_FILE } from "../src/jobs.js";

// Deterministic modelctl: no real spawn, a fixed group-leader pid, and a
// run the test settles explicitly (no microtask races around `active`).
vi.mock("../src/modelctl.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modelctl.js")>();
  return {
    ...actual,
    runStreaming: vi.fn(() => {
      const { promise, resolve } = Promise.withResolvers<{ exitCode: number; canceled: boolean }>();
      resolveRun = resolve as (o: { exitCode: number; canceled: boolean }) => void;
      return { done: promise, pid: 4242, cancel: () => {} };
    }),
  };
});
let resolveRun: (o: { exitCode: number; canceled: boolean }) => void = () => {};

const ID = "11111111-1111-4111-8111-111111111111";

describe("active-job persistence (IR-131)", () => {
  let stateDir: string;
  let dones: Array<{ jobId: string; status: string; exitCode: number | null }>;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "irori-jobs-"));
    dones = [];
  });
  // eslint-disable-next-line -- vitest cleans tmpdirs via the OS; explicit rm keeps locals honest
  function cleanup(): void {
    rmSync(stateDir, { recursive: true, force: true });
  }

  function manager(): JobManager {
    return new JobManager(
      () => ({ nasRoot: "/mnt/nas", pin: "0.23.0", serverUrl: "ws://hub/agent-ws", stateDir }),
      {
        onOutput: () => {},
        onDone: (jobId, status, exitCode) => dones.push({ jobId, status, exitCode }),
      },
    );
  }

  it("persists the process-group handle at start and clears it on completion", async () => {
    const mgr = manager();
    mgr.start(ID, "sync-local", { name: "glm" });
    const file = join(stateDir, ACTIVE_JOBS_FILE);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([{ jobId: ID, pgid: -4242, kind: "sync-local", startedAt: expect.any(Number) }]);
    resolveRun({ exitCode: 0, canceled: false });
    await vi.waitFor(() => expect(existsSync(file)).toBe(false));
    cleanup();
  });

  it("reports whether the kill signal was actually issued", async () => {
    const mgr = manager();
    expect(mgr.cancel(ID)).toBe(false); // nothing active
    mgr.start(ID, "push", { name: "glm", hosts: ["dgx2"] });
    expect(mgr.cancel(ID)).toBe(true);
    resolveRun({ exitCode: 0, canceled: true });
    await vi.waitFor(() => expect(mgr.cancel(ID)).toBe(false)); // cleared after done
    cleanup();
  });
});

describe("reconcileOrphanedJobs (IR-131)", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "irori-jobs-"));
  });
  function cleanup(): void {
    rmSync(stateDir, { recursive: true, force: true });
  }

  it("kills the persisted group and settles the row failed", async () => {
    writeFileSync(join(stateDir, ACTIVE_JOBS_FILE), JSON.stringify([{ jobId: ID, pgid: -4321, kind: "push", startedAt: 1 }]));
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const dones: Array<{ jobId: string; status: string; exitCode: number | null }> = [];
    await reconcileOrphanedJobs(stateDir, {
      onOutput: () => {},
      onDone: (jobId, status, exitCode) => dones.push({ jobId, status, exitCode }),
    });
    expect(kill).toHaveBeenCalledWith(-4321, "SIGKILL");
    expect(dones).toEqual([{ jobId: ID, status: "failed", exitCode: null }]);
    expect(existsSync(join(stateDir, ACTIVE_JOBS_FILE))).toBe(false);
    kill.mockRestore();
    cleanup();
  });

  it("is a no-op without a registry file", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    await reconcileOrphanedJobs(stateDir, { onOutput: () => {}, onDone: () => {} });
    expect(kill).not.toHaveBeenCalled();
    kill.mockRestore();
    cleanup();
  });
});
