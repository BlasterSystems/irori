import type * as FsPromises from "node:fs/promises";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * IRI-155 re-review N2: the inventory job never pays for companion reads
 * (they would spend its store deadline on a degraded mount).
 */
const realpathCalls: string[] = [];
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    realpath: (p: string) => {
      realpathCalls.push(p);
      return actual.realpath(p);
    },
  };
});

const { inventoryStoreRead } = await import("../src/inventory.js");
const { readStore } = await import("../src/catalog-read.js");

const root = mkdtempSync(join(tmpdir(), "irori-iri155-inv-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("inventory store read", () => {
  it("reads the catalog without touching any object metadata", async () => {
    mkdirSync(join(root, "models/o/m/c"), { recursive: true });
    writeFileSync(join(root, "models/o/m/c/.modelctl.json"), "{}");
    mkdirSync(join(root, "active"));
    symlinkSync("../models/o/m/c", join(root, "active", "m"));
    writeFileSync(join(root, "catalog.json"), JSON.stringify({ schema: 3, models: [{ name: "m", runtime: "vllm", repository: "o/m", bytes: 1 }] }));

    realpathCalls.length = 0;
    const read = await inventoryStoreRead(root);
    expect(read.entries.map((e) => e.name)).toEqual(["m"]);
    expect(realpathCalls).toEqual([]);

    // control: the catalog path does read companions, so the spy can see them
    await readStore(root);
    expect(realpathCalls.some((p) => p.includes("/active/"))).toBe(true);
  });
});
