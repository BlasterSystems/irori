import { describe, expect, it } from "vitest";
import {
  parseDockerDf,
  parseDockerImages,
  parseDockerSize,
  selectCleanableStaging,
  selectOldImages,
  stagingAuditToCategory,
  type DockerImageRow,
  type StagingEntry,
} from "../src/hygiene.js";

describe("parseDockerSize", () => {
  it("parses docker's unit suffixes", () => {
    expect(parseDockerSize("212.4GB")).toBe(212_400_000_000);
    expect(parseDockerSize("1.2MB")).toBe(1_200_000);
    expect(parseDockerSize("534.2kB")).toBe(534_200);
    expect(parseDockerSize("10TB")).toBe(10_000_000_000_000);
    expect(parseDockerSize("37B")).toBe(37);
  });

  it("reads the first size out of decorated output", () => {
    expect(parseDockerSize("10GB (Virtual 12GB)")).toBe(10_000_000_000);
    expect(parseDockerSize("garbage")).toBe(0);
  });
});

describe("parseDockerDf", () => {
  it("maps reclaimable percentages to bytes", () => {
    const rows = parseDockerDf("Images\t10GB\t50% (5GB)\nBuild Cache\t2GB\t100% (2GB)\n");
    expect(rows).toEqual([
      { type: "Images", sizeBytes: 10_000_000_000, reclaimableBytes: 5_000_000_000 },
      { type: "Build Cache", sizeBytes: 2_000_000_000, reclaimableBytes: 2_000_000_000 },
    ]);
  });

  it("ignores malformed lines", () => {
    expect(parseDockerDf("nonsense\n")).toEqual([]);
  });
});

describe("selectOldImages", () => {
  const rows: DockerImageRow[] = [
    { repository: "irori", tag: "latest", id: "id-1", sizeBytes: 1, createdSince: "1h" },
    { repository: "irori", tag: "v2", id: "id-2", sizeBytes: 1, createdSince: "2d" },
    { repository: "irori", tag: "v1", id: "id-3", sizeBytes: 1, createdSince: "9d" },
    { repository: "engine", tag: "big", id: "id-4", sizeBytes: 5, createdSince: "3d" },
    { repository: "engine", tag: "old", id: "id-5", sizeBytes: 7, createdSince: "30d" },
    { repository: "engine", tag: "older", id: "id-6", sizeBytes: 9, createdSince: "60d" },
  ];

  it("keeps the newest two per repo and flags the rest", () => {
    const old = selectOldImages(rows, 2, new Set());
    expect(old.map((r) => r.id)).toEqual(["id-3", "id-6"]);
  });

  it("never selects protected ids even when old", () => {
    const old = selectOldImages(rows, 2, new Set(["id-6"]));
    expect(old.map((r) => r.id)).toEqual(["id-3"]);
  });
});

describe("parseDockerImages", () => {
  it("parses the format rows", () => {
    const rows = parseDockerImages("irori\tlatest\tabc123\t212.4MB\t2 hours ago\n");
    expect(rows).toEqual([{ repository: "irori", tag: "latest", id: "abc123", sizeBytes: 212_400_000, createdSince: "2 hours ago" }]);
  });
});

describe("selectCleanableStaging + stagingAuditToCategory", () => {
  const entries: StagingEntry[] = [
    { path: "/mnt/nas/.staging/a", status: "orphaned", bytes: 200, name: null, detail: "no journal" },
    { path: "/mnt/nas/.staging/b", status: "resumable", bytes: 50, name: "m", detail: "resumable" },
    { path: "/mnt/nas/.staging/c", status: "journal_referenced", bytes: 30, name: "j", detail: "downloading" },
    { path: "/mnt/nas/.staging/d", status: "failed", bytes: 20, name: null, detail: "failed" },
  ];

  it("protects resumable and journal-referenced entries (SPEC: non-resumable only)", () => {
    const cleanable = selectCleanableStaging(entries);
    expect(cleanable.map((e) => e.path)).toEqual(["/mnt/nas/.staging/a", "/mnt/nas/.staging/d"]);
  });

  it("maps to a care category row with the cleanable sum", () => {
    const row = stagingAuditToCategory(entries);
    expect(row.category).toBe("modelctl-staging");
    expect(row.safe).toBe(false);
    expect(row.itemCount).toBe(2);
    expect(row.reclaimableBytes).toBe(220);
  });
});
