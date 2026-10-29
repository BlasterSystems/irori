import { describe, expect, it } from "vitest";
import { stripStoreCategory } from "../src/cleanup-service.js";
import type { CleanupEntry } from "../src/cleanup-service.js";

/**
 * IRI-046 pure scoping: the modelctl-staging audit category is store-volume
 * data, so it is stripped from audit entries of non-store nodes while clean
 * rows and store-node rows pass through untouched. The pickStoreNode wiring
 * around it is covered by the m7 db integration suite.
 */
const auditEntry = (categories: unknown, kind = "audit"): CleanupEntry => ({
  id: "00000000-0000-0000-0000-000000000001",
  kind,
  status: "succeeded",
  categories: [],
  report: { generatedAtMs: 1, totalBytes: 1000, freeBytes: 100, categories },
  error: null,
  jobId: null,
  createdAt: "2026-10-29T00:00:00.000Z",
  finishedAt: "2026-10-29T00:00:01.000Z",
});

const stagingRow = { category: "modelctl-staging", safe: false, rationale: "store staging", itemCount: 1, reclaimableBytes: 253_397_553_152 };
const buildCacheRow = { category: "docker-build-cache", safe: true, rationale: "rebuildable", itemCount: 1, reclaimableBytes: 5 };

describe("stripStoreCategory (IRI-046)", () => {
  it("keeps store-node rows untouched (identity return)", () => {
    const entry = auditEntry([buildCacheRow, stagingRow]);
    expect(stripStoreCategory(entry, true)).toBe(entry);
  });

  it("drops only the staging category from non-store audit rows", () => {
    const stripped = stripStoreCategory(auditEntry([buildCacheRow, stagingRow]), false);
    expect(stripped.report).toEqual({
      generatedAtMs: 1,
      totalBytes: 1000,
      freeBytes: 100,
      categories: [buildCacheRow],
    });
  });

  it("passes through audit rows without the staging category", () => {
    const entry = auditEntry([buildCacheRow]);
    expect(stripStoreCategory(entry, false)).toBe(entry);
  });

  it("never touches clean rows — their requested categories are factual history", () => {
    const entry: CleanupEntry = { ...auditEntry([stagingRow]), kind: "clean", categories: ["modelctl-staging"] };
    expect(stripStoreCategory(entry, false)).toBe(entry);
  });

  it("tolerates absent or malformed reports", () => {
    const noReport: CleanupEntry = { ...auditEntry(null), report: null };
    expect(stripStoreCategory(noReport, false)).toBe(noReport);
    const scalarReport: CleanupEntry = { ...auditEntry(null), report: "junk" };
    expect(stripStoreCategory(scalarReport, false)).toBe(scalarReport);
    const noCategories: CleanupEntry = { ...auditEntry(null), report: { generatedAtMs: 1 } };
    expect(stripStoreCategory(noCategories, false)).toBe(noCategories);
    const categoriesNotArray: CleanupEntry = { ...auditEntry(null), report: { generatedAtMs: 1, categories: "junk" } };
    expect(stripStoreCategory(categoriesNotArray, false)).toBe(categoriesNotArray);
  });
});
