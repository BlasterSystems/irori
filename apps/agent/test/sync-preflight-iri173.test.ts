import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listUnlinkedActive } from "../src/catalog-read.js";
import { buildInventory, unlinkedActiveWarning } from "../src/inventory.js";
import { JobManager } from "../src/jobs.js";
import { syncLocalPreflight } from "../src/sync-preflight.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A store as a node sees it: `linked` is a real symlink into models/ (the
 * NAS node, or an NFS mount); `copied` is a directory (what an SMB mount
 * shows for a server-side symlink); `.DS_Store` is the stray file on the NAS.
 */
function store(): string {
  const root = mkdtempSync(join(tmpdir(), "irori-links-"));
  temps.push(root);
  mkdirSync(join(root, "models", "org", "linked", "abc--def"), { recursive: true });
  mkdirSync(join(root, "active", "copied"), { recursive: true });
  symlinkSync("../models/org/linked/abc--def", join(root, "active", "linked"));
  writeFileSync(join(root, "active", ".DS_Store"), "");
  return root;
}

describe("listUnlinkedActive (IRI-173)", () => {
  it("lists directory entries only; symlinks and hidden files are skipped", async () => {
    expect(await listUnlinkedActive(store())).toEqual(["copied"]);
  });

  it("is unknown (null) when active/ cannot be listed", async () => {
    const root = mkdtempSync(join(tmpdir(), "irori-links-"));
    temps.push(root);
    expect(await listUnlinkedActive(root)).toBeNull();
  });
});

describe("inventory store link report (IRI-173)", () => {
  const base = {
    nasRoot: "/mnt/nas",
    modelctlPath: "/fake/modelctl",
    agentUser: "root",
    users: [],
    exec: async () => ({ stdout: "", stderr: "" }),
  };
  const read = async () => ({ entries: [], source: "catalog" as const });

  it("reports the unlinked names and a warning", async () => {
    const report = await buildInventory({ ...base, readStoreImpl: read, unlinkedActiveImpl: async () => ["a", "b"] });
    expect(report.store?.unlinkedActive).toEqual(["a", "b"]);
    expect(report.store?.warning).toContain("2 active entries are not visible as symlinks");
    // True on every modelctl version: it names the requirement, not a verdict.
    expect(report.store?.warning).toContain("needs modelctl 0.25.1 or newer");
    expect(report.store?.warning).toContain("on the store host itself, run a repair check");
    expect(report.store?.warning).not.toContain("will not work");
  });

  it("reports an empty list with no warning when every link is visible", async () => {
    const report = await buildInventory({ ...base, readStoreImpl: read, unlinkedActiveImpl: async () => [] });
    expect(report.store?.unlinkedActive).toEqual([]);
    expect(report.store?.warning).toBeNull();
  });

  it("omits the field when the listing is unknown, and keeps a store-read warning", async () => {
    const report = await buildInventory({
      ...base,
      readStoreImpl: async () => ({ entries: [], source: "scan" as const, warning: "no catalog.json; scanned active/" }),
      unlinkedActiveImpl: async () => null,
    });
    expect(report.store).not.toHaveProperty("unlinkedActive");
    expect(report.store?.warning).toBe("no catalog.json; scanned active/");
  });

  it("keeps the store view when the link listing is slow: only the field is dropped", async () => {
    const report = await buildInventory({
      ...base,
      readStoreImpl: async () => ({ entries: [{ name: "m", repository: "org/m", runtime: "vllm", bytes: 1 }], source: "catalog" as const }),
      unlinkedActiveImpl: () => new Promise(() => {}), // never answers
      linkListingMs: 30,
    });
    expect(report.store?.models.map((m) => m.name)).toEqual(["m"]);
    expect(report.store?.warning).toBeNull();
    expect(report.store).not.toHaveProperty("unlinkedActive");
  });

  it("words the singular warning", () => {
    expect(unlinkedActiveWarning(["a"])).toContain("1 active entry is not visible");
    expect(unlinkedActiveWarning([])).toBeNull();
    expect(unlinkedActiveWarning(null)).toBeNull();
  });
});

describe("syncLocalPreflight (IRI-173)", () => {
  const opts = { node: "dgx-4" };

  it("passes for a symlink entry, and for a repository id once the store is there", async () => {
    const root = store();
    expect(await syncLocalPreflight(root, "linked", opts)).toBeNull();
    expect(await syncLocalPreflight(root, "org/linked", opts)).toBeNull();
  });

  it("explains a directory entry (SMB-hidden link)", async () => {
    const problem = await syncLocalPreflight(store(), "copied", opts);
    expect(problem).toContain("dgx-4: 'copied' is not visible as a symlink");
    expect(problem).toContain("NFS");
  });

  it("does not blame SMB for a plain file, and leaves '.' and '..' to modelctl", async () => {
    const root = store();
    writeFileSync(join(root, "active", "afile"), "");
    const problem = await syncLocalPreflight(root, "afile", opts);
    expect(problem).toContain("is not a symlink");
    expect(problem).not.toContain("SMB");
    expect(await syncLocalPreflight(root, "..", opts)).toBeNull();
    expect(await syncLocalPreflight(root, ".", opts)).toBeNull();
  });

  it("lets modelctl decide when the store cannot be read for another reason", async () => {
    const denied = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    expect(await syncLocalPreflight("/mnt/nas", "linked", { ...opts, lstatFn: () => Promise.reject(denied) })).toBeNull();
  });

  it("accepts a directory entry once modelctl resolves it from the journal (IRI-175)", async () => {
    expect(await syncLocalPreflight(store(), "copied", { ...opts, linkOptional: true })).toBeNull();
    // Still not a pass for a missing entry or an unmounted share.
    expect(await syncLocalPreflight(store(), "absent", { ...opts, linkOptional: true })).toContain("is not active in the store");
  });

  it("explains a missing entry", async () => {
    expect(await syncLocalPreflight(store(), "absent", opts)).toContain("'absent' is not active in the store");
  });

  it("explains a root that is not the store (unmounted share)", async () => {
    const root = mkdtempSync(join(tmpdir(), "irori-links-"));
    temps.push(root);
    const problem = await syncLocalPreflight(root, "linked", opts);
    expect(problem).toContain("is not the model store");
    expect(problem).toContain("Is the NAS share mounted?");
  });

  it("gives up on a wedged mount instead of hanging", async () => {
    const started = Date.now();
    const problem = await syncLocalPreflight("/mnt/nas", "linked", { ...opts, timeoutMs: 40, lstatFn: () => new Promise(() => {}) });
    expect(problem).toContain("did not answer");
    expect(problem).toContain("dead network mount");
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("sync-local job pre-check (IRI-173)", () => {
  function fakeModelctl(): { path: string; log: string } {
    const dir = mkdtempSync(join(tmpdir(), "irori-links-"));
    temps.push(dir);
    const log = join(dir, "calls.log");
    const path = join(dir, "modelctl");
    writeFileSync(path, `#!/bin/sh\necho "$*" >> '${log}'\n`, { mode: 0o755 });
    return { path, log };
  }

  function run(root: string, target: string, modelctlPath: string, syncPreflight?: (root: string, target: string) => Promise<string | null>, extraParams: Record<string, unknown> = {}) {
    const lines: string[] = [];
    const { promise, resolve } = Promise.withResolvers<{ status: string; exitCode: number | null }>();
    const mgr = new JobManager(
      () => ({ serverUrl: "", pin: "0.25.1", nasRoot: root, modelctlPath, ...(syncPreflight === undefined ? {} : { syncPreflight }) }),
      { onOutput: (_id, _seq, line) => lines.push(line), onDone: (_id, status, exitCode) => resolve({ status, exitCode }) },
    );
    expect(mgr.start("j1", "sync-local", { name: target, ...extraParams })).toBe(true);
    return { lines, done: promise, mgr };
  }

  it("fails without spawning modelctl when the node sees the link as a directory", async () => {
    const { path, log } = fakeModelctl();
    const { lines, done, mgr } = run(store(), "copied", path);
    // The job owns the node's one active slot while the check runs.
    expect(mgr.activeJobId).toBe("j1");
    expect(await done).toEqual({ status: "failed", exitCode: 1 });
    expect(lines[0]).toContain("error: ");
    expect(lines[0]).toContain("'copied' is not visible as a symlink");
    expect(existsSync(log)).toBe(false);
    expect(mgr.activeJobId).toBeNull();
  });

  it("fails without spawning modelctl when the share is not mounted or the entry is missing", async () => {
    const { path, log } = fakeModelctl();
    const empty = mkdtempSync(join(tmpdir(), "irori-links-"));
    temps.push(empty);
    const unmounted = run(empty, "linked", path);
    expect(await unmounted.done).toEqual({ status: "failed", exitCode: 1 });
    expect(unmounted.lines[0]).toContain("Is the NAS share mounted?");
    const missing = run(store(), "absent", path);
    expect(await missing.done).toEqual({ status: "failed", exitCode: 1 });
    expect(missing.lines[0]).toContain("is not active in the store");
    expect(existsSync(log)).toBe(false);
  });

  it("holds the slot during the check, and a cancel settles canceled without spawning", async () => {
    const { path, log } = fakeModelctl();
    const gate = Promise.withResolvers<string | null>();
    const { done, mgr } = run(store(), "linked", path, () => gate.promise);
    expect(mgr.start("j2", "sync-local", { name: "linked" })).toBe(false);
    expect(mgr.cancel("j1")).toBe(true);
    gate.resolve(null);
    expect(await done).toEqual({ status: "canceled", exitCode: null });
    expect(existsSync(log)).toBe(false);
    expect(mgr.activeJobId).toBeNull();
  });

  it("fails cleanly when the check itself throws", async () => {
    const { path, log } = fakeModelctl();
    const { done, lines, mgr } = run(store(), "linked", path, () => {
      throw new Error("boom");
    });
    expect(await done).toEqual({ status: "failed", exitCode: 1 });
    expect(lines[0]).toContain("store pre-check failed: boom");
    expect(existsSync(log)).toBe(false);
    expect(mgr.activeJobId).toBeNull();
  });

  it("spawns modelctl for a hidden link only when the hub says this node's modelctl can sync it (IRI-175)", async () => {
    const { path, log } = fakeModelctl();
    // The agent's own pin (0.25.1 here) is a target, not what is installed:
    // without the hub's word the plain sentence stays.
    const unsure = run(store(), "copied", path);
    expect((await unsure.done).status).toBe("failed");
    expect(existsSync(log)).toBe(false);
    const { done } = run(store(), "copied", path, undefined, { linkOptional: true });
    expect((await done).status).toBe("succeeded");
    expect(readFileSync(log, "utf8")).toContain("sync-local copied");
  });

  it("spawns modelctl when the link is visible", async () => {
    const { path, log } = fakeModelctl();
    const root = store();
    const { done } = run(root, "linked", path);
    expect((await done).status).toBe("succeeded");
    expect(readFileSync(log, "utf8")).toContain(`sync-local linked --source-root ${root}`);
  });
});
