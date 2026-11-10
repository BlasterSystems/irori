import { mkdirSync, mkdtempSync, chmodSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runNasDeleteBatch } from "../src/delete-preflight.js";
import { RUNNER_KINDS } from "../src/jobs.js";
import type { ModelctlCtx } from "../src/modelctl.js";

const temps: string[] = [];
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "irori-batch-"));
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

/**
 * Fake modelctl: the plan (`--json`) prints a one-object removal plan for
 * every name except `failPlan` (which exits 1 with modelctl's manifest-not-
 * found wording); the apply appends the name to a log.
 */
function fakeModelctl(dir: string, store: string, opts: { failPlan?: string } = {}): { path: string; log: string } {
  const log = join(dir, "apply.log");
  const path = join(dir, "modelctl");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      `name=$2; case "$2" in --*) name=$3 ;; esac`,
      `case "$*" in`,
      `  *--json*)`,
      `    if [ "$name" = "${opts.failPlan ?? "__none__"}" ]; then echo "modelctl: manifest for '$name' not found" >&2; exit 1; fi`,
      `    printf '%s\\n' '{"applied":false,"removed_objects":[{"path":"${store}/objects/'"$name"'"}],"removed_staging":[]}' ;;`,
      `  *--apply*)`,
      `    echo "$name" >> '${log}'; echo "deleted $name" ;;`,
      `  *) echo "unexpected: $*" >&2; exit 2 ;;`,
      `esac`,
    ].join("\n"),
    { mode: 0o755 },
  );
  return { path, log };
}

function ctxFor(store: string, binary: string): ModelctlCtx {
  return { nasRoot: store, pin: "0.22.0", modelctlPath: binary };
}

/** Pre-creates the writable object dir each passing model's plan names. */
function objectDir(store: string, name: string, mode = 0o755): string {
  const dir = join(store, "objects", name);
  mkdirSync(dir, { recursive: true, mode });
  return dir;
}

function modelLines(lines: string[]): Array<{ model: string; status: string; error?: string }> {
  return lines
    .map((line) => {
      try {
        return JSON.parse(line) as { model?: string; status?: string };
      } catch {
        return null;
      }
    })
    .filter((v): v is { model: string; status: string; error?: string } => v !== null && typeof v.model === "string" && typeof v.status === "string");
}

describe("nas-delete-batch", () => {
  it("is a runner kind alongside nas-delete-apply", () => {
    expect(RUNNER_KINDS.has("nas-delete-batch")).toBe(true);
    expect(RUNNER_KINDS.has("nas-delete-apply")).toBe(true);
  });

  it("deletes every name and closes with a summary line", async () => {
    const dir = tempDir();
    const store = join(dir, "store");
    const { path, log } = fakeModelctl(dir, store);
    for (const name of ["alpha", "beta", "gamma"]) objectDir(store, name);

    const lines: string[] = [];
    const result = await runNasDeleteBatch({ names: ["alpha", "beta", "gamma"] }, ctxFor(store, path), (l) => lines.push(l), new AbortController().signal);

    expect(result).toEqual({ ok: true });
    expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toEqual(["alpha", "beta", "gamma"]);
    expect(modelLines(lines)).toEqual([
      { model: "alpha", status: "deleted" },
      { model: "beta", status: "deleted" },
      { model: "gamma", status: "deleted" },
    ]);
    expect(JSON.parse(lines.at(-1)!)).toEqual({
      kind: "nas-delete-batch",
      total: 3,
      deleted: 3,
      failed: 0,
      skipped: 0,
      results: [
        { model: "alpha", status: "deleted" },
        { model: "beta", status: "deleted" },
        { model: "gamma", status: "deleted" },
      ],
    });
  });

  it("continues after a failed model and marks the job failed", async () => {
    const dir = tempDir();
    const store = join(dir, "store");
    const { path, log } = fakeModelctl(dir, store, { failPlan: "beta" });
    for (const name of ["alpha", "beta", "gamma"]) objectDir(store, name);

    const lines: string[] = [];
    const result = await runNasDeleteBatch({ names: ["alpha", "beta", "gamma"] }, ctxFor(store, path), (l) => lines.push(l), new AbortController().signal);

    expect(result.ok).toBe(false);
    // gamma was still attempted after beta's plan failure.
    expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toEqual(["alpha", "gamma"]);
    expect(modelLines(lines)).toContainEqual({ model: "beta", status: "failed", error: expect.stringContaining("manifest for 'beta' not found") });
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ deleted: 2, failed: 1, skipped: 0 });
  });

  it.skipIf(isRoot)("continues after a preflight denial", async () => {
    const dir = tempDir();
    const store = join(dir, "store");
    const { path, log } = fakeModelctl(dir, store);
    objectDir(store, "alpha");
    objectDir(store, "beta", 0o555); // probe denied — the model stays active
    objectDir(store, "gamma");

    const lines: string[] = [];
    const result = await runNasDeleteBatch({ names: ["alpha", "beta", "gamma"] }, ctxFor(store, path), (l) => lines.push(l), new AbortController().signal);

    expect(result.ok).toBe(false);
    expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toEqual(["alpha", "gamma"]);
    expect(modelLines(lines)).toContainEqual({ model: "beta", status: "failed", error: expect.stringContaining("preflight denied") });
    chmodSync(join(store, "objects", "beta"), 0o755);
  });

  it("skips invalid names and duplicates without invoking modelctl", async () => {
    const dir = tempDir();
    const store = join(dir, "store");
    const { path, log } = fakeModelctl(dir, store);
    objectDir(store, "alpha");

    const lines: string[] = [];
    const result = await runNasDeleteBatch({ names: ["alpha", "alpha", "../escape", "bad name"] }, ctxFor(store, path), (l) => lines.push(l), new AbortController().signal);

    // Skipped names keep the job red: the list must be clean before rerunning.
    expect(result.ok).toBe(false);
    expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toEqual(["alpha"]);
    expect(modelLines(lines)).toEqual([
      { model: "alpha", status: "deleted" },
      { model: "alpha", status: "skipped", error: "duplicate in batch" },
      { model: "../escape", status: "skipped", error: "invalid model name" },
      { model: "bad name", status: "skipped", error: "invalid model name" },
    ]);
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ total: 4, deleted: 1, failed: 0, skipped: 3 });
  });

  it("rejects malformed params before any exec", async () => {
    const dir = tempDir();
    const { path, log } = fakeModelctl(dir, join(dir, "store"));
    const ctx = ctxFor(join(dir, "store"), path);
    const lines: string[] = [];

    for (const params of [{}, { names: [] }, { names: ["ok", 5] }]) {
      const result = await runNasDeleteBatch(params as Record<string, unknown>, ctx, (l) => lines.push(l), new AbortController().signal);
      expect(result.ok).toBe(false);
      expect(result.error).toBe("invalid params");
    }
    expect(lines.every((l) => l === "error: nas-delete-batch needs a non-empty names array of strings")).toBe(true);
    expect(existsSync(log)).toBe(false);
  });

  it("marks never-reached names skipped when the signal is already aborted", async () => {
    const dir = tempDir();
    const store = join(dir, "store");
    const { path, log } = fakeModelctl(dir, store);
    objectDir(store, "alpha");

    const controller = new AbortController();
    controller.abort();
    const lines: string[] = [];
    const result = await runNasDeleteBatch({ names: ["alpha", "beta"] }, ctxFor(store, path), (l) => lines.push(l), controller.signal);

    expect(result.ok).toBe(false);
    expect(existsSync(log)).toBe(false);
    expect(modelLines(lines)).toEqual([
      { model: "alpha", status: "skipped", error: "canceled before delete" },
      { model: "beta", status: "skipped", error: "canceled before delete" },
    ]);
  });
});
