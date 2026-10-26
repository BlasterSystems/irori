import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probeRemovable, runNasDeleteApply } from "../src/delete-preflight.js";
import type { ModelctlCtx } from "../src/modelctl.js";

const temps: string[] = [];
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "irori-del-"));
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

/** Fake modelctl: prints the plan JSON on --json, appends to a log on --apply. */
function fakeModelctl(dir: string, object: string): { path: string; log: string } {
  const log = join(dir, "apply.log");
  const path = join(dir, "modelctl");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      `case "$*" in`,
      `  *--json*) printf '%s\\n' '{"applied":false,"removed_objects":[{"path":"${object}"}],"removed_staging":[]}' ;;`,
      `  *--apply*) echo applied >> '${log}'; echo "deleted ${object}" ;;`,
      `  *) echo "unexpected: $*" >&2; exit 2 ;;`,
      `esac`,
    ].join("\n"),
    { mode: 0o755 },
  );
  chmodSync(path, 0o755);
  return { path, log };
}

function ctxFor(store: string, binary: string): ModelctlCtx {
  return { nasRoot: store, pin: "0.22.0", modelctlPath: binary };
}

describe("probeRemovable", () => {
  it("passes a writable tree and leaves no probe files behind", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(join(dir, "nested", "w.bin"), "x");
    expect(await probeRemovable(dir)).toBeNull();
    expect(existsSync(join(dir, "nested", ".irori-probe"))).toBe(false);
  });

  it.skipIf(isRoot)("reports the denied directory with its errno", async () => {
    const dir = tempDir();
    const locked = join(dir, "locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "w.bin"), "x");
    chmodSync(locked, 0o555);
    const failure = await probeRemovable(dir);
    expect(failure?.path).toBe(locked);
    expect(failure?.code).toBe("EACCES");
    chmodSync(locked, 0o755);
  });
});

describe("runNasDeleteApply", () => {
  it("probes, then applies when the tree is writable", async () => {
    const dir = tempDir();
    const store = join(dir, "store");
    const object = join(store, "models/org/repo/abc--def");
    mkdirSync(object, { recursive: true });
    writeFileSync(join(object, "w.bin"), "x");
    const { path, log } = fakeModelctl(dir, object);
    const lines: string[] = [];

    const result = await runNasDeleteApply({ name: "glm" }, ctxFor(store, path), (line) => lines.push(line), new AbortController().signal);

    expect(result.ok).toBe(true);
    expect(readFileSync(log, "utf8")).toBe("applied\n");
    expect(lines.some((line) => line.startsWith("preflight: writable"))).toBe(true);
  });

  it.skipIf(isRoot)("fails before the apply when the object tree is denied", async () => {
    const dir = tempDir();
    const store = join(dir, "store");
    const object = join(store, "models/org/repo/abc--def");
    mkdirSync(object, { recursive: true });
    writeFileSync(join(object, "w.bin"), "x");
    chmodSync(object, 0o555);
    const { path, log } = fakeModelctl(dir, object);
    const lines: string[] = [];

    const result = await runNasDeleteApply({ name: "glm" }, ctxFor(store, path), (line) => lines.push(line), new AbortController().signal);

    expect(result.ok).toBe(false);
    expect(existsSync(log)).toBe(false);
    expect(lines.some((line) => line.includes("the model was left ACTIVE"))).toBe(true);
    chmodSync(object, 0o755);
  });

  it("fails when the dry-run plan cannot be read", async () => {
    const dir = tempDir();
    const store = join(dir, "store");
    mkdirSync(store, { recursive: true });
    const binary = join(dir, "modelctl");
    writeFileSync(binary, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    const lines: string[] = [];

    const result = await runNasDeleteApply({ name: "glm" }, ctxFor(store, binary), (line) => lines.push(line), new AbortController().signal);

    expect(result.ok).toBe(false);
    expect(lines.some((line) => line.startsWith("error: delete plan failed"))).toBe(true);
  });
});
