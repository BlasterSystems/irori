import { execFile } from "node:child_process";
import { readdir, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ModelctlCtx } from "./modelctl.js";

/**
 * IR-211: hidden staging debris audit + armed quarantine prune.
 *
 * modelctl's `staging-audit` walks only non-hidden staging trees
 * (`_object_directories` skips dot-dirs), so `.active-quarantine` /
 * `.cleanup-quarantine` trees are invisible to the hygiene panel. This module
 * audits the whole `.staging` tree (read-only) and prunes `.active-quarantine`
 * trees through `modelctl cleanup-quarantine NAME --apply` — the command that
 * validates the repaired reference and every copy's metadata before deleting.
 * `.cleanup-quarantine` has no modelctl command yet: reported, not pruned.
 */

const execFileAsync = promisify(execFile);
/** Whole-audit deadline; deep/slow trees past it report `bytes: null`. */
const AUDIT_DEADLINE_MS = 240_000;
/** modelctl cleanup-quarantine per-name timeout (validation walks objects). */
const PRUNE_TIMEOUT_MS = 900_000;
const STATFS_TIMEOUT_MS = 15_000;
const MAX_TREES = 2_000;
/** Store model names must survive argv embedding (same rule as deletes). */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type StagingTreeKind = "staging" | "active-quarantine" | "cleanup-quarantine" | "hidden";

export interface StagingTreeRow {
  path: string;
  kind: StagingTreeKind;
  /** Quarantined model name (active-quarantine rows only). */
  name: string | null;
  /** null when the walk deadline hit before this tree was measured. */
  bytes: number | null;
  mtimeMs: number | null;
}

export interface StagingTreeReport {
  kind: "staging-tree-audit";
  trees: StagingTreeRow[];
  totals: { stagingBytes: number; activeQuarantineBytes: number; cleanupQuarantineBytes: number };
  /** statfs free bytes on the store at audit time; null when statfs failed. */
  freeBytes: number | null;
  timedOut: boolean;
}

export interface QuarantinePruneResult {
  name: string;
  status: "pruned" | "empty" | "dry-run" | "failed" | "skipped";
  /** Quarantine trees the dry run named (dry-run + pruned). */
  paths: string[];
  error?: string;
}

export interface QuarantinePruneSummary {
  kind: "quarantine-prune";
  armed: boolean;
  freedBytes: number | null;
  results: QuarantinePruneResult[];
}

/** statfs with a hard bound — a wedged network mount must not hang the job. */
async function boundedStatfs(path: string): Promise<number | null> {
  try {
    const { promise, resolve } = Promise.withResolvers<null>();
    const timer = setTimeout(() => resolve(null), STATFS_TIMEOUT_MS);
    timer.unref?.();
    const s = await Promise.race([statfs(path), promise]);
    return s === null ? null : Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/** Recursively sums file sizes under `dir`, bounded by the shared deadline.
 *  Returns null when the deadline hit first (tree too deep/slow to measure). */
async function treeBytes(dir: string, deadline: number, counter: { trees: number }): Promise<number | null> {
  let total = 0;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    if (Date.now() > deadline || counter.trees > MAX_TREES) return null;
    const current = stack.pop()!;
    counter.trees += 1;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue; // unreadable subtree contributes its known part only
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile()) {
        try {
          const s = await stat(full);
          total += s.size;
        } catch {
          /* raced delete — skip the file */
        }
      }
      if (Date.now() > deadline) return null;
    }
  }
  return total;
}

/** Read-only audit of `<nasRoot>/.staging` including hidden trees. */
export async function runStagingTreeAudit(
  _params: Record<string, unknown>,
  ctx: ModelctlCtx,
  emit: (line: string) => void,
  signal: AbortSignal,
): Promise<{ ok: boolean; error?: string }> {
  const root = ctx.nasRoot;
  if (!root || root.length === 0) {
    emit("error: staging-tree-audit needs a NAS store root");
    return { ok: false, error: "no nasRoot" };
  }
  const staging = join(root, ".staging");
  const freeBytes = await boundedStatfs(staging);
  const deadline = Date.now() + AUDIT_DEADLINE_MS;
  const counter = { trees: 0 };
  const trees: StagingTreeRow[] = [];
  let timedOut = false;

  let top;
  try {
    top = await readdir(staging, { withFileTypes: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit(`error: cannot read ${staging}: ${message}`);
    return { ok: false, error: `readdir failed: ${message}` };
  }

  const row = async (path: string, kind: StagingTreeKind, name: string | null): Promise<void> => {
    if (trees.length >= MAX_TREES) return;
    let mtimeMs: number | null = null;
    try {
      mtimeMs = (await stat(path)).mtimeMs;
    } catch {
      /* raced delete — row still reported with null mtime */
    }
    const bytes = Date.now() > deadline ? null : await treeBytes(path, deadline, counter);
    if (bytes === null) timedOut = true;
    trees.push({ path, kind, name, bytes, mtimeMs });
  };

  for (const entry of top) {
    if (signal.aborted) break;
    const full = join(staging, entry.name);
    if (entry.name === ".active-quarantine" && entry.isDirectory()) {
      let names;
      try {
        names = await readdir(full, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const perName of names) {
        if (signal.aborted || Date.now() > deadline) break;
        if (!perName.isDirectory()) continue;
        let stamps;
        try {
          stamps = await readdir(join(full, perName.name), { withFileTypes: true });
        } catch {
          continue;
        }
        for (const stamp of stamps) {
          if (stamp.isDirectory()) await row(join(full, perName.name, stamp.name), "active-quarantine", perName.name);
        }
      }
    } else if (entry.name === ".cleanup-quarantine" && entry.isDirectory()) {
      let ids;
      try {
        ids = await readdir(full, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const id of ids) {
        if (id.isDirectory()) await row(join(full, id.name), "cleanup-quarantine", null);
      }
    } else if (entry.name.startsWith(".") && entry.isDirectory()) {
      await row(full, "hidden", null);
    } else if (entry.isDirectory()) {
      await row(full, "staging", null);
    }
  }

  const totals = {
    stagingBytes: trees.filter((t) => t.kind === "staging").reduce((s, t) => s + (t.bytes ?? 0), 0),
    activeQuarantineBytes: trees.filter((t) => t.kind === "active-quarantine").reduce((s, t) => s + (t.bytes ?? 0), 0),
    cleanupQuarantineBytes: trees.filter((t) => t.kind === "cleanup-quarantine").reduce((s, t) => s + (t.bytes ?? 0), 0),
  };
  emit(JSON.stringify({ kind: "staging-tree-audit", trees, totals, freeBytes, timedOut } satisfies StagingTreeReport));
  return { ok: true };
}

/** Armed (confirm:"prune") vs dry-run quarantine prune, per model NAME via
 *  modelctl cleanup-quarantine — the command that validates before deleting. */
export async function runQuarantinePrune(
  params: Record<string, unknown>,
  ctx: ModelctlCtx,
  emit: (line: string) => void,
  signal: AbortSignal,
): Promise<{ ok: boolean; error?: string }> {
  const root = ctx.nasRoot;
  if (!root || root.length === 0) {
    emit("error: quarantine-prune needs a NAS store root");
    return { ok: false, error: "no nasRoot" };
  }
  const rawNames = params.names;
  if (!Array.isArray(rawNames) || rawNames.length === 0 || rawNames.some((n) => typeof n !== "string")) {
    emit("error: quarantine-prune needs a non-empty names array of strings");
    return { ok: false, error: "invalid params" };
  }
  const names = rawNames;
  const armed = params.confirm === "prune";
  const binary = ctx.modelctlPath ?? "modelctl";
  const env: Record<string, string> = {};
  if (ctx.hfToken !== undefined && ctx.hfToken.length > 0) env.HF_TOKEN = ctx.hfToken;

  const before = armed ? await boundedStatfs(join(root, ".staging")) : null;
  const results: QuarantinePruneResult[] = [];
  for (const name of names) {
    let result: QuarantinePruneResult;
    if (!NAME_RE.test(name)) {
      result = { name, status: "skipped", paths: [], error: "invalid model name" };
    } else if (signal.aborted) {
      result = { name, status: "skipped", paths: [], error: "canceled before prune" };
    } else {
      try {
        // Dry validation first: names every quarantine tree, verifies the
        // repaired reference + metadata. Apply only reuses that verdict.
        const dryArgv = ["cleanup-quarantine", name, "--json", "--root", root];
        const dry = await execFileAsync(binary, dryArgv, { encoding: "utf8", timeout: PRUNE_TIMEOUT_MS, env: { ...process.env, ...env } });
        const parsed: unknown = JSON.parse(dry.stdout);
        // Fail closed: anything but a JSON string array reads as "nothing to
        // remove", so a malformed dry output can never arm a deletion.
        const paths = Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
        if (!armed) {
          emit(`${name}: ${paths.length} quarantine tree(s) would be removed (dry run)`);
          result = { name, status: "dry-run", paths };
        } else if (paths.length === 0) {
          emit(`${name}: no quarantine trees`);
          result = { name, status: "empty", paths: [] };
        } else {
          await execFileAsync(binary, ["cleanup-quarantine", name, "--apply", "--root", root], {
            encoding: "utf8",
            timeout: PRUNE_TIMEOUT_MS,
            env: { ...process.env, ...env },
          });
          emit(`${name}: pruned ${paths.length} quarantine tree(s)`);
          result = { name, status: "pruned", paths };
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit(`error: ${name} prune failed: ${message}`);
        result = { name, status: "failed", paths: [], error: message };
      }
    }
    results.push(result);
    emit(JSON.stringify(result));
  }
  const after = armed ? await boundedStatfs(join(root, ".staging")) : null;
  const freedBytes = before !== null && after !== null ? Math.max(0, before - after) : null;
  const summary: QuarantinePruneSummary = { kind: "quarantine-prune", armed, freedBytes, results };
  emit(JSON.stringify(summary));
  return { ok: results.every((r) => r.status !== "failed") };
}

/** Guard re-exported for tests: quarantine names follow the store-name rule. */
export const QUARANTINE_NAME_RE = NAME_RE;
