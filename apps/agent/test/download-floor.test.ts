import { mkdtempSync, chmodSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JobManager } from "../src/jobs.js";
import { loadConfig } from "../src/config.js";

const temps: string[] = [];
const TIB = 1024 ** 4;

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "irori-floor-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    try {
      chmodSync(dir, 0o755);
    } catch {
      /* already gone */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Fake modelctl: appends its args to a log so tests can prove (non-)invocation. */
function fakeModelctl(dir: string): { path: string; log: string } {
  const log = join(dir, "calls.log");
  const path = join(dir, "modelctl");
  writeFileSync(path, `#!/bin/sh\necho "$*" >> '${log}'\n`, { mode: 0o755 });
  return { path, log };
}

interface Captured {
  lines: string[];
  done: Array<{ status: string; exitCode: number | null }>;
  /** Resolves with the first terminal event — the real signal, no polling. */
  donePromise: Promise<{ status: string; exitCode: number | null }>;
}

function captured(): Captured {
  const { promise, resolve } = Promise.withResolvers<{ status: string; exitCode: number | null }>();
  const c: Captured = { lines: [], done: [], donePromise: promise };
  return c;
}

function manager(path: string, free: number | null, floor: number, c: Captured): JobManager {
  return new JobManager(
    () => ({ serverUrl: "", pin: "0.23.0", nasRoot: null, modelctlPath: path, storeFreeBytes: () => free, minStoreFreeBytes: floor }),
    {
      onOutput: (_id, _seq, line) => c.lines.push(line),
      onDone: (_id, status, exitCode) => {
        c.done.push({ status, exitCode });
        c.donePromise = Promise.resolve({ status, exitCode });
        // Resolve the shared deferred exactly once (only the first terminal event is awaited).
        resolveFirst({ status, exitCode });
      },
    },
  );
}

let resolveFirst: (v: { status: string; exitCode: number | null }) => void = () => {};
function capturedWithDeferred(): Captured {
  const { promise, resolve } = Promise.withResolvers<{ status: string; exitCode: number | null }>();
  resolveFirst = resolve;
  return { lines: [], done: [], donePromise: promise };
}

describe("store free-space floor (IR-213)", () => {
  it("fails a download fast when the store is below the floor, without invoking modelctl", async () => {
    const dir = tempDir();
    const { path, log } = fakeModelctl(dir);
    const c = capturedWithDeferred();
    const mgr = manager(path, 1 * TIB, 1.5 * TIB, c);
    expect(mgr.start("j1", "download", { name: "m" })).toBe(true);
    const done = await c.donePromise;
    expect(done).toEqual({ status: "failed", exitCode: 1 });
    expect(c.lines[0]).toContain("below the 1.5 TiB download floor");
    expect(c.lines[0]).toContain("1.00 TiB free");
    expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe("");
  });

  it("gates download-queue the same way", async () => {
    const dir = tempDir();
    const { path } = fakeModelctl(dir);
    const c = capturedWithDeferred();
    const mgr = manager(path, 0, 1.5 * TIB, c);
    mgr.start("j2", "download-queue", { queue: "x" });
    const done = await c.donePromise;
    expect(done.status).toBe("failed");
    expect(c.lines[0]).toContain("download floor");
  });

  it("proceeds when free space is above the floor, telemetry is unknown, or the floor is disabled", async () => {
    const dir = tempDir();
    const { path, log } = fakeModelctl(dir);
    for (const [free, floor] of [
      [2 * TIB, 1.5 * TIB],
      [null, 1.5 * TIB],
      [1 * TIB, 0],
    ] as Array<[number | null, number]>) {
      const c = capturedWithDeferred();
      const mgr = manager(path, free, floor, c);
      mgr.start(`j-${String(free)}-${String(floor)}`, "download", { name: "m" });
      await c.donePromise;
      expect(c.lines.some((l) => l.includes("download floor"))).toBe(false);
    }
    expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toHaveLength(3);
  });

  it("passes the floor through to modelctl's --min-free-bytes for download and queue (IR-207)", async () => {
    const dir = tempDir();
    const { path, log } = fakeModelctl(dir);
    const c = capturedWithDeferred();
    const mgr = manager(path, 10 * TIB, 1.5 * TIB, c);
    mgr.start("j-floor", "download", { name: "m" });
    await c.donePromise;
    expect(readFileSync(log, "utf8")).toContain(`--min-free-bytes ${1.5 * TIB}`);
    mgr.start("j-q", "download-queue", { downloads: [{ source: "org/m" }], root: dir });
    await new Promise((r) => setTimeout(r, 50));
    expect(readFileSync(log, "utf8").split("--min-free-bytes").length - 1).toBe(2);
  });

  it("omits the flag when the floor is disabled (modelctl default 0)", async () => {
    const dir = tempDir();
    const { path, log } = fakeModelctl(dir);
    const c = capturedWithDeferred();
    const mgr = manager(path, 10 * TIB, 0, c);
    mgr.start("j-nofloor", "download", { name: "m" });
    await c.donePromise;
    expect(readFileSync(log, "utf8")).not.toContain("--min-free-bytes");
  });

  it("defaults the floor to 1.5 TiB and honors IRORI_MIN_STORE_FREE_BYTES", () => {
    expect(loadConfig({ IRORI_NODE_TOKEN: "t", IRORI_SERVER_URL: "ws://h:1" }).minStoreFreeBytes).toBe(1.5 * TIB);
    expect(loadConfig({ IRORI_NODE_TOKEN: "t", IRORI_SERVER_URL: "ws://h:1", IRORI_MIN_STORE_FREE_BYTES: "0" }).minStoreFreeBytes).toBe(0);
    expect(loadConfig({ IRORI_NODE_TOKEN: "t", IRORI_SERVER_URL: "ws://h:1", IRORI_MIN_STORE_FREE_BYTES: "nonsense" }).minStoreFreeBytes).toBe(1.5 * TIB);
  });
});
