import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { boundedOrNull, readStore, scanStore } from "../src/catalog-read.js";

const temps: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "irori-ir206-cat-"));
  temps.push(dir);
  return dir;
}

describe("store reads on a dead mount (IR-206)", () => {
  it("bounds a hanging op to null", async () => {
    vi.useFakeTimers();
    try {
      const hanging = boundedOrNull(() => new Promise<string>(() => {}));
      const assertion = expect(hanging).resolves.toBeNull();
      await vi.advanceTimersByTimeAsync(2001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps a rejecting op to null and passes values through", async () => {
    await expect(boundedOrNull(async () => {
      throw new Error("EACCES");
    })).resolves.toBeNull();
    await expect(boundedOrNull(async () => "v")).resolves.toBe("v");
  });

  it("scans a store the same as before (symlinks, manifests, derived repos)", async () => {
    const root = tempDir();
    // object dir + active symlink + manifest
    mkdirSync(join(root, "models/org/glm/commit--x"), { recursive: true });
    writeFileSync(join(root, "models/org/glm/commit--x/w.bin"), "x");
    mkdirSync(join(root, "active"), { recursive: true });
    symlinkSync(join(root, "models/org/glm/commit--x"), join(root, "active", "glm"));
    mkdirSync(join(root, "manifests"), { recursive: true });
    writeFileSync(join(root, "manifests/glm.yaml"), "name: glm\nrepo: org/glm\nruntime:\n  type: vllm\n");
    // broken link and a foreign file are skipped
    symlinkSync(join(root, "models/missing"), join(root, "active", "broken"));
    writeFileSync(join(root, "active", ".DS_Store"), "junk");

    const entries = await scanStore(root);
    expect(entries).toEqual([
      { name: "glm", runtime: "vllm", repository: "org/glm", bytes: expect.any(Number) },
    ]);
    expect(entries[0]!.bytes).toBeGreaterThan(0);

    const read = await readStore(root);
    expect(read.source).toBe("scan");
    expect(read.warning).toBe("no catalog.json; scanned active/");
  });

  it("skips every entry when the root is unreadable instead of throwing", async () => {
    const root = tempDir(); // no active/ at all
    expect(await scanStore(root)).toEqual([]);
    const read = await readStore(root);
    expect(read.entries).toEqual([]);
    expect(read.source).toBe("scan");
  });
});
