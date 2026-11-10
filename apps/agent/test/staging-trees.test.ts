import { mkdirSync, mkdtempSync, chmodSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { QUARANTINE_NAME_RE, runQuarantinePrune, runStagingTreeAudit, type StagingTreeReport, type QuarantinePruneSummary } from "../src/staging-trees.js";
import type { ModelctlCtx } from "../src/modelctl.js";

const temps: string[] = [];
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "irori-staging-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    try {
      chmodSync(dir, 0o755);
    } catch {
      /* already gone */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Builds a store shape the audit must classify: regular staging, an
 *  active-quarantine tree, a cleanup-quarantine tree, and a hidden dir. */
function seedStore(root: string, opts: { cleanupTree?: boolean } = {}): void {
  const staging = join(root, ".staging");
  // Regular staging: owner/repo/object with one file.
  mkdirSync(join(staging, "ownera", "repoa", "obja"), { recursive: true });
  writeFileSync(join(staging, "ownera", "repoa", "obja", "w.bin"), "x".repeat(10));
  // Hidden quarantine: .active-quarantine/<NAME>/<stamp>/file
  mkdirSync(join(staging, ".active-quarantine", "glm-main", "20261109T120000Z-abc"), { recursive: true });
  writeFileSync(join(staging, ".active-quarantine", "glm-main", "20261109T120000Z-abc", "w.bin"), "x".repeat(100));
  if (opts.cleanupTree !== false) {
    mkdirSync(join(staging, ".cleanup-quarantine", "deadbeef"), { recursive: true });
    writeFileSync(join(staging, ".cleanup-quarantine", "deadbeef", "w.bin"), "x".repeat(1000));
  }
  mkdirSync(join(staging, ".some-other-hidden"), { recursive: true });
}

function auditLines(lines: string[]): StagingTreeReport {
  const parsed = lines.map((l) => {
    try {
      return JSON.parse(l) as unknown;
    } catch {
      return null;
    }
  });
  const report = parsed.find((p): p is StagingTreeReport => p !== null && typeof p === "object" && (p as StagingTreeReport).kind === "staging-tree-audit");
  expect(report).toBeDefined();
  return report!;
}

function fakeModelctl(dir: string, opts: { dryPaths?: string[]; failDryFor?: string; failApplyFor?: string } = {}): string {
  const path = join(dir, "modelctl");
  const dry = JSON.stringify(opts.dryPaths ?? []);
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      `name=$2; case "$2" in --*) name=$3 ;; esac`,
      `case "$*" in`,
      `  *--json*)`,
      `    if [ "$name" = "${opts.failDryFor ?? "__none__"}" ]; then echo "modelctl: validation failed" >&2; exit 1; fi`,
      `    printf '%s\\n' '${dry}' ;;`,
      `  *--apply*)`,
      `    if [ "$name" = "${opts.failApplyFor ?? "__none__"}" ]; then echo "apply boom" >&2; exit 3; fi`,
      `    echo "pruned $name" ;;`,
      `  *) echo "unexpected: $*" >&2; exit 2 ;;`,
      `esac`,
    ].join("\n"),
    { mode: 0o755 },
  );
  return path;
}

function ctxFor(root: string, binary?: string): ModelctlCtx {
  return { nasRoot: root, pin: "0.22.0", ...(binary ? { modelctlPath: binary } : {}) };
}

describe("runStagingTreeAudit", () => {
  it("classifies hidden quarantine trees the staging audit cannot see", async () => {
    const root = tempDir();
    seedStore(root);
    const lines: string[] = [];
    const result = await runStagingTreeAudit({}, ctxFor(root), (l) => lines.push(l), new AbortController().signal);

    expect(result.ok).toBe(true);
    const report = auditLines(lines);
    expect(report.timedOut).toBe(false);
    const kinds = Object.fromEntries(report.trees.map((t) => [t.kind, t]));
    // Regular staging owner dir + the hidden other dir.
    expect(report.trees.filter((t) => t.kind === "staging")).toHaveLength(1);
    expect(report.trees.find((t) => t.kind === "hidden")).toBeDefined();
    // active-quarantine: one row per NAME/stamp with the model name attached.
    const aq = report.trees.filter((t) => t.kind === "active-quarantine");
    expect(aq).toHaveLength(1);
    expect(aq[0]).toMatchObject({ name: "glm-main", bytes: 100 });
    expect(report.trees.find((t) => t.kind === "cleanup-quarantine")).toMatchObject({ bytes: 1000 });
    expect(report.totals.activeQuarantineBytes).toBe(100);
    expect(report.totals.cleanupQuarantineBytes).toBe(1000);
    expect(typeof report.freeBytes).toBe("number");
    void kinds;
  });

  it("fails with a clear error when there is no store root", async () => {
    const lines: string[] = [];
    const result = await runStagingTreeAudit({}, { nasRoot: null, pin: "0.22.0" }, (l) => lines.push(l), new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("no nasRoot");
    expect(lines[0]).toContain("needs a NAS store root");
  });
});

describe("runQuarantinePrune", () => {
  it("is a dry run without confirm and prunes per name with it", async () => {
    const dir = tempDir();
    const store = join(dir, "store");
    mkdirSync(join(store, ".staging"), { recursive: true }); // real path: statfs delta is measurable
    const binary = fakeModelctl(dir, { dryPaths: ["/store/.staging/.active-quarantine/glm-main/20261109T120000Z-abc"] });
    const lines: string[] = [];

    const dry = await runQuarantinePrune({ names: ["glm-main"] }, ctxFor(store, binary), (l) => lines.push(l), new AbortController().signal);
    const drySummary = JSON.parse(lines.at(-1)!) as QuarantinePruneSummary;
    expect(dry).toEqual({ ok: true });
    expect(drySummary.armed).toBe(false);
    expect(drySummary.freedBytes).toBeNull(); // dry runs never measure statfs
    expect(drySummary.results[0]).toMatchObject({ name: "glm-main", status: "dry-run", paths: ["/store/.staging/.active-quarantine/glm-main/20261109T120000Z-abc"] });

    lines.length = 0;
    const armed = await runQuarantinePrune({ names: ["glm-main"], confirm: "prune" }, ctxFor(store, binary), (l) => lines.push(l), new AbortController().signal);
    const armedSummary = JSON.parse(lines.at(-1)!) as QuarantinePruneSummary;
    expect(armed.ok).toBe(true);
    expect(armedSummary.armed).toBe(true);
    expect(armedSummary.results[0]).toMatchObject({ name: "glm-main", status: "pruned" });
    expect(typeof armedSummary.freedBytes).toBe("number");
  });

  it("continues after a failed name and marks the job failed", async () => {
    const dir = tempDir();
    const binary = fakeModelctl(dir, { dryPaths: [], failDryFor: "bad" });
    const lines: string[] = [];
    const result = await runQuarantinePrune({ names: ["bad", "good"], confirm: "prune" }, ctxFor("/store", binary), (l) => lines.push(l), new AbortController().signal);

    expect(result.ok).toBe(false);
    const summary = JSON.parse(lines.at(-1)!) as QuarantinePruneSummary;
    expect(summary.results[0]).toMatchObject({ name: "bad", status: "failed" });
    expect(summary.results[1]).toMatchObject({ name: "good", status: "empty" });
  });

  it("skips invalid names and post-abort names without invoking modelctl", async () => {
    const dir = tempDir();
    const binary = fakeModelctl(dir);
    const lines: string[] = [];
    const controller = new AbortController();
    controller.abort();
    const result = await runQuarantinePrune({ names: ["../escape", "glm-main"] }, ctxFor("/store", binary), (l) => lines.push(l), controller.signal);

    expect(result.ok).toBe(true); // nothing failed — skipped names are not failures
    const summary = JSON.parse(lines.at(-1)!) as QuarantinePruneSummary;
    expect(summary.results.map((r) => [r.name, r.status])).toEqual([
      ["../escape", "skipped"],
      ["glm-main", "skipped"],
    ]);
    expect(summary.freedBytes).toBeNull(); // never armed
  });

  it("follows the store-name rule for quarantine names", () => {
    expect(QUARANTINE_NAME_RE.test("glm-main")).toBe(true);
    expect(QUARANTINE_NAME_RE.test("../escape")).toBe(false);
  });

  it("rejects malformed params before any exec", async () => {
    const dir = tempDir();
    const lines: string[] = [];
    for (const params of [{}, { names: [] }, { names: ["ok", 5] }]) {
      const result = await runQuarantinePrune(params as Record<string, unknown>, ctxFor("/store", join(dir, "missing")), (l) => lines.push(l), new AbortController().signal);
      expect(result.ok).toBe(false);
      expect(result.error).toBe("invalid params");
    }
    expect(lines.every((l) => l === "error: quarantine-prune needs a non-empty names array of strings")).toBe(true);
    expect(existsSync(join(dir, "apply.log"))).toBe(false);
  });
});
