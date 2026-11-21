import { describe, expect, it } from "vitest";
import {
  CatalogFormatError,
  catalogModelSchema,
  catalogToEntries,
  parseCatalog,
  planPlacement,
  storeCompanionsSchema,
  storeCompanionsStateSchema,
  isCompanionsUnreadable,
  type PlacementNode,
} from "../src/catalog.js";
import { catalogMsgSchema } from "../src/job-messages.js";
import { modelEntrySchema, modelsPageSchema } from "../src/model-api.js";
import { draftKind } from "../src/hf-quants.js";
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

describe("store companions wire (IRI-155)", () => {
  const base = { name: "ink", runtime: "llama.cpp", repository: "o/ink", bytes: 1 };
  const companions = {
    mmproj: { path: "mmproj-F16.gguf", bytes: 10 },
    draft: { path: "dspark-ink-Q8_0.gguf", bytes: 5, specType: null },
  };

  it("keeps old frames and rows parsing: companions is optional, absent stays absent", () => {
    const frame = catalogMsgSchema.parse({ type: "catalog", source: "catalog", entries: [base] });
    expect(frame.entries[0]).toEqual(base);
    expect("companions" in frame.entries[0]!).toBe(false);
    const page = modelsPageSchema.parse({ page: 1, pageSize: 25, total: 1, models: [base] });
    expect(page.models[0]!.companions).toBeUndefined();
  });

  it("carries companions and known-none (null) through the frame and the API row", () => {
    const frame = catalogMsgSchema.parse({ type: "catalog", source: "scan", entries: [{ ...base, companions }, { ...base, name: "v", companions: null }] });
    expect(frame.entries[0]!.companions).toEqual(companions);
    expect(frame.entries[1]!.companions).toBeNull();
    expect(modelEntrySchema.parse({ ...base, companions }).companions).toEqual(companions);
  });

  it("carries the unreadable state, and tells it apart from companions", () => {
    const frame = catalogMsgSchema.parse({ type: "catalog", source: "catalog", entries: [{ ...base, companions: { unreadable: true } }] });
    expect(frame.entries[0]!.companions).toEqual({ unreadable: true });
    expect(isCompanionsUnreadable(frame.entries[0]!.companions)).toBe(true);
    for (const c of [undefined, null, companions]) expect(isCompanionsUnreadable(c)).toBe(false);
    expect(storeCompanionsStateSchema.safeParse({ unreadable: false }).success).toBe(false);
  });

  it("an unknown future companions shape degrades to unknown instead of dropping the frame", () => {
    const frame = catalogMsgSchema.safeParse({
      type: "catalog",
      source: "catalog",
      entries: [{ ...base, companions: { mmproj: "new-format" } }, { ...base, name: "ok", companions }],
    });
    expect(frame.success).toBe(true);
    expect(frame.data!.entries[0]!.companions).toBeUndefined();
    expect(frame.data!.entries[1]!.companions).toEqual(companions);
  });

  it("an unknown companions shape from a newer hub doesn't fail the models page parse", () => {
    const page = modelsPageSchema.safeParse({ page: 1, pageSize: 25, total: 1, models: [{ ...base, companions: { mmproj: "new" } }] });
    expect(page.success).toBe(true);
    expect(page.data!.models[0]!.companions).toBeUndefined();
  });

  it("an older consumer's catalog model schema strips the field instead of failing", () => {
    expect(catalogModelSchema.parse({ ...base, companions })).toEqual(base);
  });

  it("modelctl catalog.json parsing ignores a companions key it does not own", () => {
    const catalog = parseCatalog(JSON.stringify({ schema: 3, models: [{ ...base, companions: "future-format" }] }));
    expect(catalog.models[0]).toEqual(base);
  });

  it("rejects unsafe paths and spec types", () => {
    expect(storeCompanionsSchema.safeParse({ mmproj: { path: "../x", bytes: null }, draft: null }).success).toBe(false);
    expect(storeCompanionsSchema.safeParse({ mmproj: { path: "/abs", bytes: null }, draft: null }).success).toBe(false);
    expect(storeCompanionsSchema.safeParse({ mmproj: null, draft: { path: "d.gguf", bytes: null, specType: "BAD TYPE" } }).success).toBe(false);
    expect(storeCompanionsSchema.safeParse({ mmproj: null, draft: { path: "MTP/mtp-d.gguf", bytes: null, specType: "draft-mtp" } }).success).toBe(true);
  });

  it("draftKind mirrors modelctl draft_kind", () => {
    expect(draftKind("dspark-Inkling-2-Mini-Q8_0.gguf")).toBe("dspark");
    expect(draftKind("dflash2-x.gguf")).toBe("dflash2");
    expect(draftKind("MTP/x-Q8_0.gguf")).toBe("mtp");
    expect(draftKind("mmproj-F16.gguf")).toBeNull();
    expect(draftKind("mtp-x.bin")).toBeNull();
  });
});
