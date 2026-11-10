import { execFile } from "node:child_process";
import { open, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildCommand, runStreaming, type ModelctlCtx } from "./modelctl.js";

/**
 * `nas-delete-apply` with a writability preflight (IRI-028).
 *
 * modelctl deactivates the model first, then removes its object tree. When the
 * store principal cannot write into that tree (observed on the NAS: CIFS ACLs
 * on pre-agent model dirs), the delete fails halfway and leaves an orphan that
 * `gc-objects` cannot remove either (research brief §3). The dry-run plan names
 * every object/staging directory the apply will remove, so this runner probes
 * each one with a create+unlink before running `--apply`: a denied tree fails
 * the job while the model is still active.
 */

const execFileAsync = promisify(execFile);
const PLAN_TIMEOUT_MS = 120_000;
const MAX_PROBE_DIRS = 2_000;
/** Store model names: must survive argv embedding and object-tree paths. */
const MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface PlanEntry {
  path?: unknown;
}

interface DeletePlan {
  applied?: unknown;
  removed_objects?: PlanEntry[];
  removed_staging?: PlanEntry[];
}

export interface ProbeFailure {
  path: string;
  code: string;
  message: string;
}

/**
 * Proves every directory in `root` accepts a create+unlink. Returns the first
 * failure, or null when the whole tree is writable (or the walk exceeds the
 * cap — the apply's own error is then the backstop).
 */
export async function probeRemovable(root: string, maxDirs = MAX_PROBE_DIRS): Promise<ProbeFailure | null> {
  const stack = [root];
  let visited = 0;
  while (stack.length > 0) {
    const dir = stack.pop()!;
    visited += 1;
    if (visited > maxDirs) return null;
    const probe = join(dir, `.irori-probe-${process.pid}-${visited}`);
    try {
      const handle = await open(probe, "wx", 0o600);
      await handle.close();
    } catch (err) {
      return failure(dir, err);
    }
    try {
      await unlink(probe);
    } catch (err) {
      return failure(dir, err);
    }
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
    if (entries === null) continue;
    for (const entry of entries) {
      if (entry.isDirectory()) stack.push(join(dir, entry.name));
    }
  }
  return null;
}

function failure(path: string, err: unknown): ProbeFailure {
  const code = typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : "EACCES";
  return { path, code, message: err instanceof Error ? err.message : String(err) };
}

function planPaths(entries: PlanEntry[] | undefined): string[] {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) => entry.path).filter((path): path is string => typeof path === "string" && path.length > 0);
}

/** Runs the dry-run plan, probes every removal target, then applies.
 *  `error` carries a short machine-readable reason for the failure (IR-208
 *  batch lines); absent on success. */
export async function runNasDeleteApply(
  params: Record<string, unknown>,
  ctx: ModelctlCtx,
  emit: (line: string) => void,
  signal: AbortSignal,
): Promise<{ ok: boolean; error?: string }> {
  const name = typeof params.name === "string" ? params.name : "";
  if (!MODEL_NAME_RE.test(name)) {
    emit("error: nas-delete-apply needs a valid model name");
    return { ok: false, error: "invalid model name" };
  }
  const binary = ctx.modelctlPath ?? "modelctl";
  const env: Record<string, string> = {};
  if (ctx.hfToken !== undefined && ctx.hfToken.length > 0) env.HF_TOKEN = ctx.hfToken;

  // modelctl's dry run is read-only and prints the exact removal plan as JSON.
  let plan: DeletePlan;
  try {
    const dry = buildCommand("nas-delete", params, ctx).argv;
    // dry[0] is the modelctl binary; execFile takes it separately.
    const jsonArgv = [dry[1]!, "--json", ...dry.slice(2)];
    const { stdout } = await execFileAsync(binary, jsonArgv, {
      encoding: "utf8",
      timeout: PLAN_TIMEOUT_MS,
      env: { ...process.env, ...env },
    });
    plan = JSON.parse(stdout) as DeletePlan;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit(`error: delete plan failed: ${message}`);
    return { ok: false, error: `plan failed: ${message}` };
  }

  const objects = planPaths(plan.removed_objects);
  const staging = planPaths(plan.removed_staging);
  emit(`preflight: ${objects.length} object(s), ${staging.length} staging dir(s) to remove`);
  for (const target of [...objects, ...staging]) {
    const denied = await probeRemovable(target);
    if (denied !== null) {
      emit(`error: cannot delete ${name}: the store denies writes in ${denied.path} (${denied.code}: ${denied.message})`);
      emit("error: the model was left ACTIVE — fix ownership/ACLs for the store principal and retry");
      return { ok: false, error: `preflight denied: ${denied.path} (${denied.code})` };
    }
    emit(`preflight: writable ${target}`);
  }

  const run = runStreaming(buildCommand("nas-delete-apply", params, ctx).argv, { env, onLine: emit });
  const onAbort = (): void => run.cancel();
  signal.addEventListener("abort", onAbort, { once: true });
  const outcome = await run.done;
  signal.removeEventListener("abort", onAbort);
  if (outcome.canceled) {
    emit("error: canceled");
    return { ok: false, error: "canceled" };
  }
  if (outcome.exitCode !== 0) return { ok: false, error: `apply failed (exit ${outcome.exitCode ?? "signal"})` };
  return { ok: true };
}

export interface BatchDeleteResult {
  model: string;
  status: "deleted" | "failed" | "skipped";
  error?: string;
}

/**
 * `nas-delete-batch` (IR-208): deletes several models from the store in one
 * job. Each name runs the exact `nas-delete-apply` sequence (plan → preflight
 * → apply) so the audit trail and safety properties match the single-delete
 * path; one structured line is emitted per model and a final summary closes
 * the job. A failed model never stops the batch — `skipped` marks names the
 * batch declined to attempt (invalid, duplicate) or never reached (cancel).
 * The job is green only when every name ended `deleted` — anything skipped
 * or failed turns it red so the operator cleans the list before rerunning.
 */
export async function runNasDeleteBatch(
  params: Record<string, unknown>,
  ctx: ModelctlCtx,
  emit: (line: string) => void,
  signal: AbortSignal,
): Promise<{ ok: boolean; error?: string }> {
  const names = params.names;
  if (!Array.isArray(names) || names.length === 0 || names.some((n) => typeof n !== "string")) {
    emit("error: nas-delete-batch needs a non-empty names array of strings");
    return { ok: false, error: "invalid params" };
  }
  const results: BatchDeleteResult[] = [];
  const attempted = new Set<string>();
  for (const name of names) {
    let result: BatchDeleteResult;
    if (!MODEL_NAME_RE.test(name)) {
      result = { model: name, status: "skipped", error: "invalid model name" };
    } else if (attempted.has(name)) {
      result = { model: name, status: "skipped", error: "duplicate in batch" };
    } else if (signal.aborted) {
      result = { model: name, status: "skipped", error: "canceled before delete" };
    } else {
      attempted.add(name);
      emit(`batch: deleting ${name}`);
      const outcome = await runNasDeleteApply({ name }, ctx, emit, signal);
      result = outcome.ok ? { model: name, status: "deleted" } : { model: name, status: "failed", error: outcome.error ?? "delete failed" };
    }
    results.push(result);
    emit(JSON.stringify(result));
  }
  const deleted = results.filter((r) => r.status === "deleted").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  emit(JSON.stringify({ kind: "nas-delete-batch", total: names.length, deleted, failed, skipped, results }));
  return { ok: failed === 0 && skipped === 0 };
}
