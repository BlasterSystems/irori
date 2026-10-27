import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dirBytes } from "../src/catalog-read.js";

const temps: string[] = [];
afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true });
});

describe("dirBytes (IR-106)", () => {
  it("sizes an HF-cache model dir by its blobs, ignoring snapshot symlinks", async () => {
    const modelDir = mkdtempSync(join(tmpdir(), "irori-dirbytes-"));
    temps.push(modelDir);
    // HF-cache layout: blobs/ holds real files, snapshots/<commit>/ is a farm
    // of symlinks into blobs/ — the walk must count the blobs exactly once.
    const blob = join(modelDir, "blobs", "sha256-abc");
    mkdirSync(join(modelDir, "blobs"), { recursive: true });
    writeFileSync(blob, Buffer.alloc(100_000, 1));
    const snap = join(modelDir, "snapshots", "abc1234");
    mkdirSync(snap, { recursive: true });
    symlinkSync("../../blobs/sha256-abc", join(snap, "model.safetensors"));
    symlinkSync("../../blobs/sha256-abc", join(snap, "config.json"));
    expect(await dirBytes(modelDir)).toBeGreaterThanOrEqual(100_000);
    // The snapshot alone contributes nothing meaningful (its entries are
    // symlinks the walk never follows — a few dozen bytes at most).
    expect(await dirBytes(snap)).toBeLessThan(100_000);
  });

  it("survives a missing path and dangling symlinks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "irori-dirbytes-"));
    temps.push(dir);
    symlinkSync(join(dir, "missing-target"), join(dir, "dangling"));
    expect(await dirBytes(join(dir, "nope"))).toBe(0);
    expect(await dirBytes(dir)).toBeLessThan(1_000);
  });
});
