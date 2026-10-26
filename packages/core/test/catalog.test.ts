import { describe, expect, it } from "vitest";
import { CatalogFormatError, catalogToEntries, parseCatalog, planPlacement, type PlacementNode } from "../src/catalog.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "apps", "agent", "test", "fixtures", "store", "catalog.json");

describe("parseCatalog", () => {
  it("parses the golden catalog captured from the real NAS store", () => {
    const catalog = parseCatalog(readFileSync(GOLDEN, "utf8"));
    expect(catalog.schema).toBe(3);
    expect(catalog.models.length).toBeGreaterThanOrEqual(100);
    const glm = catalog.models.find((m) => m.name === "glm-5.3-flash-exl3-q4");
    expect(glm).toBeTruthy();
    expect(glm?.runtime).toBe("vllm");
  });

  it("rejects non-catalog payloads", () => {
    expect(() => parseCatalog("not json")).toThrow(CatalogFormatError);
    expect(() => parseCatalog('{"models": "nope"}')).toThrow(CatalogFormatError);
  });

  it("maps entries with source=catalog", () => {
    const entries = catalogToEntries(parseCatalog('{"schema":3,"models":[{"name":"a","runtime":"vllm","repository":"o/a","bytes":1}]}'));
    expect(entries).toEqual([{ name: "a", runtime: "vllm", repository: "o/a", bytes: 1, source: "catalog" }]);
  });
});

describe("planPlacement", () => {
  const nas: PlacementNode = { id: "nas", name: "nas", kind: "nas", role: "standalone", hasNasRoot: true, pushCapable: true, diskFreeBytes: 1000 };
  const head: PlacementNode = { id: "head", name: "head", kind: "spark", role: "head", hasNasRoot: false, pushCapable: true, diskFreeBytes: 5000 };
  const offline: PlacementNode = { id: "worker", name: "worker", kind: "spark", role: "worker", hasNasRoot: false, pushCapable: false, diskFreeBytes: 5000 };

  it("nas always present", () => {
    expect(planPlacement({ availableOn: [{ nodeId: "nas", bytes: 100 }], target: nas, reserveBytes: 0 })).toEqual({ action: "present" });
  });

  it("local copy present", () => {
    expect(planPlacement({ availableOn: [{ nodeId: "head", bytes: 100 }], target: head, reserveBytes: 0 })).toEqual({ action: "present" });
  });

  it("sync from nas with capacity check", () => {
    expect(planPlacement({ availableOn: [{ nodeId: "nas", bytes: 300 }], target: { ...head, hasNasRoot: true, diskFreeBytes: 300 }, reserveBytes: 0 }))
      .toEqual({ action: "sync", bytes: 300 });
    expect(planPlacement({ availableOn: [{ nodeId: "nas", bytes: 300 }], target: { ...head, hasNasRoot: true, diskFreeBytes: 320 }, reserveBytes: 50 }))
      .toEqual({ action: "unavailable", reason: expect.stringContaining("needs 300") });
  });

  it("prefers the CX7 push from an online holder over the NAS sync hop (IR-100)", () => {
    expect(
      planPlacement({
        availableOn: [{ nodeId: "nas", bytes: 300 }, { nodeId: "head", bytes: 300, online: true }],
        target: { ...head, id: "spark2", name: "spark2", hasNasRoot: true },
        reserveBytes: 0,
      }),
    ).toEqual({ action: "push", bytes: 300, viaNodeIds: ["head"] });
  });

  it("falls back to the NAS sync when every holder is offline", () => {
    expect(
      planPlacement({
        availableOn: [{ nodeId: "nas", bytes: 300 }, { nodeId: "head", bytes: 300, online: false }],
        target: { ...head, id: "spark2", name: "spark2", hasNasRoot: true },
        reserveBytes: 0,
      }),
    ).toEqual({ action: "sync", bytes: 300 });
  });

  it("orders online holders before offline ones (the push dispatches on viaNodeIds[0])", () => {
    const spark3 = { ...head, id: "spark3", name: "spark3", hasNasRoot: true };
    expect(
      planPlacement({
        availableOn: [
          { nodeId: "nas", bytes: 300 },
          { nodeId: "head", bytes: 300, online: false },
          { nodeId: "worker", bytes: 300, online: true },
        ],
        target: spark3,
        reserveBytes: 0,
      }),
    ).toEqual({ action: "push", bytes: 300, viaNodeIds: ["worker", "head"] });
  });

  it("push from another node when nas lacks it", () => {
    expect(planPlacement({ availableOn: [{ nodeId: "head", bytes: 200 }], target: { ...offline, pushCapable: true }, reserveBytes: 0 }))
      .toEqual({ action: "push", bytes: 200, viaNodeIds: ["head"] });
  });

  it("nas-mounted node pushes when the model is not on the NAS but a node holds it", () => {
    const workerWithNas = { ...head, id: "worker2", name: "worker2", hasNasRoot: true };
    expect(planPlacement({ availableOn: [{ nodeId: "head", bytes: 200 }], target: workerWithNas, reserveBytes: 0 }))
      .toEqual({ action: "push", bytes: 200, viaNodeIds: ["head"] });
  });

  it("unavailable when nas-only model has no local holder to push from", () => {
    expect(planPlacement({ availableOn: [{ nodeId: "nas", bytes: 100 }], target: { ...head, hasNasRoot: false }, reserveBytes: 0 }))
      .toEqual({ action: "unavailable", reason: expect.stringContaining("no node holds it locally") });
  });

  it("unavailable when target offline or model nowhere", () => {
    expect(planPlacement({ availableOn: [{ nodeId: "nas", bytes: 100 }], target: { ...offline, hasNasRoot: true }, reserveBytes: 0 }))
      .toEqual({ action: "unavailable", reason: expect.stringContaining("not modelctl-capable") });
    expect(planPlacement({ availableOn: [], target: head, reserveBytes: 0 }))
      .toEqual({ action: "unavailable", reason: expect.stringContaining("not present") });
  });
});
