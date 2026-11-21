import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { storeModelSchema } from "@irori/core";
import {
  METADATA_FILE,
  METADATA_MAX_BYTES,
  boundedResult,
  companionsFromMetadata,
  companionsOutcome,
  type MetadataFailure,
  readObjectMetadata,
  readStore,
  withCompanions,
} from "../src/catalog-read.js";

/**
 * IRI-155: installed companions from `active/<name>/.modelctl.json`
 * (modelctl validation.write_metadata, schema 1).
 */

const temps: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "irori-iri155-"));
  temps.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

/** The live dev object for Inkling-2-Mini-GGUF-Q4_K_XL, trimmed to the keys modelctl writes. */
const INKLING_METADATA = {
  schema: 1,
  name: "Inkling-2-Mini-GGUF-Q4_K_XL",
  repo: "unsloth/Inkling-2-Mini-GGUF",
  revision: "main",
  commit: "c8d27935d3f2",
  include: ["*Q4_K_XL*"],
  format: "gguf",
  entrypoint: "Inkling-2-Mini-UD-Q4_K_XL.gguf",
  model_card: null,
  companions: { mmproj: "mmproj-F16.gguf", mtp: "dspark-Inkling-2-Mini-Q8_0.gguf" },
  runtime: { type: "llama.cpp", args: [] },
  files: [
    { path: "Inkling-2-Mini-UD-Q4_K_XL.gguf", size: 2_400_000_000, sha256: null },
    { path: "mmproj-F16.gguf", size: 644_245_094, sha256: null },
    { path: "dspark-Inkling-2-Mini-Q8_0.gguf", size: 429_496_730, sha256: null },
  ],
};

/** A store with one modelctl-style RELATIVE active link (`../models/...`), like layout.py writes. */
function storeWith(name: string, metadata: string | null): string {
  const root = tempDir();
  const objectRel = join("models", "org", name, "commit--x");
  mkdirSync(join(root, objectRel), { recursive: true });
  if (metadata !== null) writeFileSync(join(root, objectRel, METADATA_FILE), metadata);
  mkdirSync(join(root, "active"), { recursive: true });
  symlinkSync(join("..", objectRel), join(root, "active", name));
  return root;
}

const UNREADABLE = { unreadable: true };
const entry = (name: string) => ({ name, runtime: "llama.cpp", repository: `org/${name}`, bytes: 1 });

describe("companionsFromMetadata", () => {
  it("reads an Inkling-like object: projector, DSpark draft, sizes from files[]", () => {
    expect(companionsFromMetadata(INKLING_METADATA)).toEqual({
      mmproj: { path: "mmproj-F16.gguf", bytes: 644_245_094 },
      draft: { path: "dspark-Inkling-2-Mini-Q8_0.gguf", bytes: 429_496_730, specType: null },
    });
  });

  it("carries a recorded draft_spec_type and tolerates a file missing from files[]", () => {
    const c = companionsFromMetadata({ ...INKLING_METADATA, companions: { mtp: "MTP/mtp-x.gguf" }, draft_spec_type: "draft-mtp" });
    expect(c).toEqual({ mmproj: null, draft: { path: "MTP/mtp-x.gguf", bytes: null, specType: "draft-mtp" } });
  });

  it("is null for objects without companions (vLLM, plain GGUF)", () => {
    expect(companionsFromMetadata({ ...INKLING_METADATA, companions: {} })).toBeNull();
    expect(companionsFromMetadata({ ...INKLING_METADATA, companions: undefined })).toBeNull();
  });

  it("is unreadable for anything that is not schema-1 metadata", () => {
    expect(companionsFromMetadata(null)).toEqual(UNREADABLE);
    expect(companionsFromMetadata([])).toEqual(UNREADABLE);
    expect(companionsFromMetadata({ ...INKLING_METADATA, schema: 2 })).toEqual(UNREADABLE);
    expect(companionsFromMetadata({ ...INKLING_METADATA, files: "x" })).toEqual(UNREADABLE);
  });

  it("rejects unsafe companion paths and invalid spec types instead of forwarding them", () => {
    for (const bad of ["/etc/passwd", "../x.gguf", "a/../../x.gguf", "a\\b.gguf", "a//b.gguf", "x\0.gguf", "./x.gguf"]) {
      expect(companionsFromMetadata({ ...INKLING_METADATA, companions: { mmproj: bad } })).toEqual(UNREADABLE);
    }
    expect(companionsFromMetadata({ ...INKLING_METADATA, draft_spec_type: "Draft MTP; rm -rf" })).toEqual(UNREADABLE);
    // a bad size is only a missing size, not a corrupt object
    expect(companionsFromMetadata({ ...INKLING_METADATA, files: [{ path: "mmproj-F16.gguf", size: -1 }] })).toMatchObject({ mmproj: { bytes: null } });
  });

  it("only ever produces values the hub's frame schema accepts", () => {
    for (const raw of [INKLING_METADATA, null, { ...INKLING_METADATA, companions: {} }]) {
      expect(storeModelSchema.safeParse({ ...entry("m"), companions: companionsFromMetadata(raw) }).success).toBe(true);
    }
  });
});

describe("companionsOutcome (owner decision)", () => {
  it("a missing metadata file is known-none; every other failure is unreadable", () => {
    expect(companionsOutcome("missing")).toBeNull();
    const failures: MetadataFailure[] = ["timeout", "unreadable", "too-large", "not-a-file", "escape", "malformed"];
    for (const reason of failures) expect(companionsOutcome(reason)).toEqual(UNREADABLE);
  });
});

describe("readObjectMetadata (store confinement and bounds)", () => {
  it("reads through a relative active/ link", async () => {
    const root = storeWith("ink", JSON.stringify(INKLING_METADATA));
    const read = await readObjectMetadata(realpathSync(root), root, "ink");
    expect(read).toEqual({ ok: true, raw: INKLING_METADATA });
  });

  it("reports a legacy object without metadata as missing", async () => {
    const root = storeWith("legacy", null);
    expect(await readObjectMetadata(realpathSync(root), root, "legacy")).toEqual({ ok: false, reason: "missing" });
  });

  it("reports malformed JSON", async () => {
    const root = storeWith("bad", "{ not json");
    expect(await readObjectMetadata(realpathSync(root), root, "bad")).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses an active link that resolves outside the store", async () => {
    const root = tempDir();
    const outside = tempDir();
    writeFileSync(join(outside, METADATA_FILE), JSON.stringify(INKLING_METADATA));
    mkdirSync(join(root, "active"));
    symlinkSync(outside, join(root, "active", "escape"));
    expect(await readObjectMetadata(realpathSync(root), root, "escape")).toEqual({ ok: false, reason: "escape" });
  });

  it("refuses a metadata file that is itself a symlink (no follow)", async () => {
    const outside = tempDir();
    writeFileSync(join(outside, "secret.json"), JSON.stringify(INKLING_METADATA));
    const root = storeWith("linked", null);
    symlinkSync(join(outside, "secret.json"), join(root, "models", "org", "linked", "commit--x", METADATA_FILE));
    expect(await readObjectMetadata(realpathSync(root), root, "linked")).toEqual({ ok: false, reason: "not-a-file" });
  });

  it("refuses names that are not one path segment", async () => {
    const root = tempDir();
    for (const name of ["..", ".", "", "a/b", "..\\x"]) {
      expect(await readObjectMetadata(realpathSync(root), root, name)).toEqual({ ok: false, reason: "escape" });
    }
  });

  it("enforces the size cap", async () => {
    const root = storeWith("huge", " ".repeat(METADATA_MAX_BYTES + 1));
    expect(await readObjectMetadata(realpathSync(root), root, "huge")).toEqual({ ok: false, reason: "too-large" });
    // exactly at the cap is still read (and then fails to parse as JSON)
    const atCap = storeWith("cap", " ".repeat(METADATA_MAX_BYTES));
    expect(await readObjectMetadata(realpathSync(atCap), atCap, "cap")).toEqual({ ok: false, reason: "malformed" });
  });

  it("bounds a hanging op as a timeout, distinct from an error", async () => {
    vi.useFakeTimers();
    try {
      const hanging = boundedResult(() => new Promise<string>(() => {}));
      const assertion = expect(hanging).resolves.toEqual({ ok: false, timeout: true });
      await vi.advanceTimersByTimeAsync(2001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
    const failed = await boundedResult(async () => {
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    });
    expect(failed).toMatchObject({ ok: false, timeout: false });
  });
});

describe("readStore enrichment", () => {
  it("adds companions on both the catalog and the scan paths, without dropping entries", async () => {
    const root = storeWith("ink", JSON.stringify(INKLING_METADATA));
    mkdirSync(join(root, "manifests"));
    writeFileSync(join(root, "manifests/ink.yaml"), "name: ink\nrepo: org/ink\nruntime:\n  type: llama.cpp\n");
    // withCompanions directly, as readStore applies it after a live scan.
    const scanned = await withCompanions(root, [entry("ink")]);
    expect(scanned[0]!.companions).toMatchObject({ mmproj: { path: "mmproj-F16.gguf" } });

    // catalog path: catalog.json lists ink and a model without an active link.
    writeFileSync(join(root, "catalog.json"), JSON.stringify({ schema: 3, models: [entry("ink"), entry("gone")] }));
    const read = await readStore(root);
    expect(read.source).toBe("catalog");
    expect(read.entries.map((e) => e.name)).toEqual(["ink", "gone"]);
    expect(read.entries[0]!.companions).toMatchObject({ draft: { path: "dspark-Inkling-2-Mini-Q8_0.gguf" } });
    // no active link at all: realpath ENOENT reads as missing → known-none
    expect(read.entries[1]!.companions).toBeNull();
  });

  it("skips companion reads entirely when asked (the inventory path)", async () => {
    const root = storeWith("ink", JSON.stringify(INKLING_METADATA));
    writeFileSync(join(root, "catalog.json"), JSON.stringify({ schema: 3, models: [entry("ink")] }));
    const read = await readStore(root, { companions: false });
    expect(read.entries).toEqual([entry("ink")]);
    expect("companions" in read.entries[0]!).toBe(false);
  });

  it("marks every entry unreadable when the store root itself is unreachable", async () => {
    expect(await withCompanions(join(tempDir(), "no-such-root"), [entry("x")])).toEqual([{ ...entry("x"), companions: UNREADABLE }]);
  });

  it("marks a corrupt object unreadable and a legacy object none, in one frame", async () => {
    const root = storeWith("bad", "{ not json");
    const legacyRel = join("models", "org", "legacy", "c");
    mkdirSync(join(root, legacyRel), { recursive: true });
    symlinkSync(join("..", legacyRel), join(root, "active", "legacy"));
    const out = await withCompanions(root, [entry("bad"), entry("legacy")]);
    expect(out.map((e) => e.companions)).toEqual([UNREADABLE, null]);
  });
});
