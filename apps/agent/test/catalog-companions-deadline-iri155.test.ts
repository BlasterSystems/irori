import type * as FsPromises from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

/**
 * IRI-155 review F1: on a degraded mount (realpath under active/ hangs) the
 * companion reads must not hold the catalog frame for N/8 x 2-4 s.
 */
const realpathCalls: string[] = [];
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    realpath: (p: string) => {
      realpathCalls.push(p);
      return p.includes("/active/") ? new Promise<string>(() => {}) : Promise.resolve(p);
    },
  };
});

const { withCompanions, COMPANION_CONCURRENCY } = await import("../src/catalog-read.js");

describe("withCompanions overall deadline", () => {
  it("marks unread entries unreadable at the deadline and starts no new reads after it", async () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({ name: `m${i}`, runtime: "llama.cpp", repository: `o/m${i}`, bytes: 1 }));
    const started = Date.now();
    const out = await withCompanions("/store", entries, 50);
    expect(Date.now() - started).toBeLessThan(1500); // far below OP_TIMEOUT_MS: the deadline, not per-op bounds
    expect(out.map((e) => e.name)).toEqual(entries.map((e) => e.name));
    expect(out.every((e) => JSON.stringify(e.companions) === '{"unreadable":true}')).toBe(true);
    // only the first in-flight batch ever touched the mount
    expect(realpathCalls.filter((p) => p.includes("/active/")).length).toBe(COMPANION_CONCURRENCY);
  });
});
