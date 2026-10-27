import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { InventoryLeftover, InventoryLocalCache, InventoryModel, NodeInventory } from "@irori/core";
import { dirBytes, readStore } from "./catalog-read.js";

/**
 * Per-node model inventory (IRI-028).
 *
 * Three sources, none interchangeable (research brief §1):
 *  - the modelctl store under `nasRoot` (catalog.json / active scan),
 *  - failed `modelctl delete` journals (`state/NAME.delete.json`, state FAILED)
 *    whose object is orphaned and recoverable with `gc-objects`,
 *  - local HF-cache registrations, which modelctl keys off the **invoking
 *    user's** home (`~/.local/state/modelctl/hf-cache/<hash>`), so a root
 *    agent must list each cache owner separately (`runuser`).
 *
 * The final output line of the `models-inventory` job is the JSON report.
 */

const execFileAsync = promisify(execFile);
const LIST_TIMEOUT_MS = 30_000;
const PATH_TIMEOUT_MS = 20_000;
/** Cap the per-model `du` walk so a cache with hundreds of registrations
 *  cannot stall the job; rows beyond the cap keep bytes null. */
const MAX_SIZED_MODELS = 40;

export interface PasswdUser {
  user: string;
  home: string;
}

export interface InventoryCtx {
  nasRoot: string | null;
  /** The agent's modelctl binary (root's uv tool install). */
  modelctlPath: string;
  /** The agent's own user; its cache is listed directly, no runuser. */
  agentUser: string;
  /** Test seams. */
  passwdPath?: string;
  users?: PasswdUser[];
  exec?: (file: string, args: string[], opts: { timeout: number }) => Promise<{ stdout: string; stderr: string }>;
  now?: () => number;
}

/** Parses /etc/passwd into the users whose HF cache can hold models. */
export function discoverUsers(passwd: string, agentUser: string): PasswdUser[] {
  const out: PasswdUser[] = [];
  const seen = new Set<string>();
  const add = (user: string, home: string): void => {
    if (seen.has(user) || home.length === 0) return;
    if (home !== "/root" && !home.startsWith("/home/")) return;
    seen.add(user);
    out.push({ user, home });
  };
  for (const line of passwd.split("\n")) {
    const parts = line.split(":");
    if (parts.length < 6) continue;
    const [user, , uid, , , home] = parts as [string, string, string, string, string, string];
    if (!/^\d+$/.test(uid)) continue;
    add(user, home);
  }
  // The agent user may not be in a minimal passwd fixture; its own cache is
  // always listed (root in production).
  if (!seen.has(agentUser)) out.push({ user: agentUser, home: homedir() });
  return out;
}

/** First executable modelctl for a user (uv installs to ~/.local/bin). */
export function localBinary(home: string): string | null {
  const candidates = [join(home, ".local", "bin", "modelctl"), "/usr/local/bin/modelctl", "/usr/bin/modelctl"];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/** Resolves a cache owner for a `delete-local` job; null when unknown. */
export function resolveLocalUser(
  user: string,
  opts: { agentUser: string; modelctlPath: string; passwdPath?: string },
): { home: string; binary: string } | null {
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,31}$/.test(user)) return null;
  const entry = discoverUsers(readPasswd(opts.passwdPath ?? "/etc/passwd"), opts.agentUser).find((u) => u.user === user);
  if (entry === undefined) return null;
  const binary = user === opts.agentUser ? opts.modelctlPath : localBinary(entry.home);
  if (binary === null) return null;
  return { home: entry.home, binary };
}

/** argv for running modelctl as a cache owner (pure; tests pin it). */
export function userArgv(
  user: string,
  agentUser: string,
  home: string,
  binary: string,
  args: string[],
): string[] {
  if (user === agentUser) return [binary, ...args];
  return [
    "runuser",
    "-u",
    user,
    "--",
    "env",
    "-u",
    "XDG_STATE_HOME",
    "-u",
    "HF_HOME",
    "-u",
    "HF_HUB_CACHE",
    `HOME=${home}`,
    `PATH=${dirname(binary)}:/usr/local/bin:/usr/bin:/bin`,
    binary,
    ...args,
  ];
}

/** `modelctl list --local --json` → rows (no sizes in that payload). */
export function parseLocalList(stdout: string): InventoryModel[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error("modelctl list --local --json is not an array");
  const models: InventoryModel[] = [];
  for (const raw of parsed) {
    if (typeof raw !== "object" || raw === null) continue;
    const row = raw as { name?: unknown; runtime?: unknown; repository?: unknown };
    if (typeof row.name !== "string" || row.name.length === 0) continue;
    models.push({
      name: row.name,
      repository: typeof row.repository === "string" ? row.repository : "",
      runtime: typeof row.runtime === "string" ? row.runtime : "",
      bytes: null,
    });
  }
  return models;
}

/**
 * Snapshot root behind a `modelctl path --local` result:
 * `<cache>/models--ORG--REPO/snapshots/<commit>[/entrypoint…]`. Null when the
 * path does not look like an HF snapshot (sizes are then left unknown).
 */
export function snapshotRootFromEntrypoint(entry: string): string | null {
  const parts = entry.split("/");
  const index = parts.lastIndexOf("snapshots");
  if (index < 0 || index + 1 >= parts.length) return null;
  const commit = parts[index + 1]!;
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) return null;
  return parts.slice(0, index + 2).join("/");
}

export function parseModelctlVersion(stdout: string): string | null {
  const match = /(\d+\.\d+\.\d+)/.exec(stdout);
  return match === null ? null : match[1]!;
}

/** One parsed failed-delete journal (pre-path resolution). */
export interface FailedDelete {
  name: string;
  object: string;
  repo: string | null;
  error: string | null;
  failedAt: string | null;
}

/** Parses a `state/NAME.delete.json`; null unless the last state is FAILED. */
export function parseDeleteJournal(name: string, raw: string): FailedDelete | null {
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof document !== "object" || document === null) return null;
  const doc = document as { operation?: unknown; history?: unknown };
  if (doc.operation !== "delete" || !Array.isArray(doc.history)) return null;
  const history = doc.history.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null);
  const failed = [...history].reverse().find((entry) => entry.state === "FAILED");
  if (failed === undefined) return null;
  const withObject = [...history].reverse().find((entry) => typeof entry.object === "string");
  const planned = history.find((entry) => entry.state === "PLANNED");
  const object = typeof failed.object === "string" ? failed.object : typeof withObject?.object === "string" ? withObject.object : null;
  if (object === null) return null;
  return {
    name,
    object,
    repo: typeof planned?.repo === "string" ? planned.repo : null,
    error: typeof failed.error === "string" ? failed.error : null,
    failedAt: typeof failed.at === "string" ? failed.at : null,
  };
}

/** `ORG/REPO/COMMIT--SELECTION` for gc-objects, from a journal object path. */
export function objectTarget(root: string, object: string, repo: string | null): string | null {
  const prefix = join(root, "models") + "/";
  if (object.startsWith(prefix)) {
    const relative = object.slice(prefix.length);
    return relative.split("/").length === 3 ? relative : null;
  }
  const base = object.split("/").filter((part) => part.length > 0).pop() ?? "";
  if (repo !== null && repo.includes("/") && base.length > 0) return `${repo}/${base}`;
  return null;
}

function readPasswd(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

async function exec(ctx: InventoryCtx, file: string, args: string[], timeout: number): Promise<string> {
  if (ctx.exec !== undefined) return (await ctx.exec(file, args, { timeout })).stdout;
  const { stdout } = await execFileAsync(file, args, { encoding: "utf8", timeout });
  return stdout;
}

async function runAs(ctx: InventoryCtx, user: string, home: string, binary: string, args: string[], timeout: number): Promise<string> {
  const argv = userArgv(user, ctx.agentUser, home, binary, args);
  return exec(ctx, argv[0]!, argv.slice(1), timeout);
}

async function readFailedDeletes(root: string): Promise<InventoryLeftover[]> {
  const stateDir = join(root, "state");
  const entries = await readdir(stateDir).catch(() => null);
  if (entries === null) return [];
  const leftovers: InventoryLeftover[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.endsWith(".delete.json")) continue;
    const name = entry.slice(0, -".delete.json".length);
    const raw = await readFileText(join(stateDir, entry));
    if (raw === null) continue;
    const failed = parseDeleteJournal(name, raw);
    if (failed === null || seen.has(failed.object)) continue;
    seen.add(failed.object);
    const target = objectTarget(root, failed.object, failed.repo);
    const candidate = existsSync(failed.object) ? failed.object : target === null ? null : join(root, "models", target);
    const bytes = candidate === null ? null : await dirBytes(candidate).catch(() => null);
    leftovers.push({
      name: failed.name,
      object: failed.object,
      target,
      error: failed.error,
      failedAt: failed.failedAt,
      bytes,
    });
  }
  return leftovers;
}

async function readFileText(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 256 * 1024) return null;
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * `models--<owner>--<name>` → `<owner>/<name>`; the first `--` after the
 * prefix splits owner from repo, so owners with dashes (hf-internal-testing)
 * derive correctly. Null for non-cache entries (.locks, junk).
 */
function repoIdFromCacheDir(entry: string): string | null {
  if (!entry.startsWith("models--")) return null;
  const rest = entry.slice("models--".length);
  const idx = rest.indexOf("--");
  if (idx <= 0 || idx + 2 >= rest.length) return null;
  return `${rest.slice(0, idx)}/${rest.slice(idx + 2)}`;
}

/** One local cache per user that has a modelctl binary and an HF cache. */
export async function discoverLocalCaches(ctx: InventoryCtx): Promise<InventoryLocalCache[]> {
  const users = ctx.users ?? discoverUsers(readPasswd(ctx.passwdPath ?? "/etc/passwd"), ctx.agentUser);
  const caches: InventoryLocalCache[] = [];
  for (const { user, home } of users) {
    if (!existsSync(join(home, ".cache", "huggingface"))) continue;
    const cacheDir = join(home, ".cache", "huggingface", "hub");
    const binary = user === ctx.agentUser ? ctx.modelctlPath : localBinary(home);
    if (binary === null) {
      caches.push({ user, home, cacheDir, modelctlVersion: null, error: "modelctl is not installed for this user", models: [], orphans: [] });
      continue;
    }
    try {
      const version = parseModelctlVersion(await runAs(ctx, user, home, binary, ["--version"], LIST_TIMEOUT_MS));
      const listed = parseLocalList(await runAs(ctx, user, home, binary, ["list", "--local", "--json"], LIST_TIMEOUT_MS));
      // IR-104: `models--*` dirs present but not registered — the Register
      // action maps them to a transfer-free `modelctl register-local`.
      const registered = new Set(listed.map((m) => m.repository.toLowerCase()));
      const orphans: string[] = [];
      for (const entry of await readdir(cacheDir).catch(() => [])) {
        const repo = repoIdFromCacheDir(entry);
        if (repo === null || registered.has(repo.toLowerCase())) continue;
        const info = await stat(join(cacheDir, entry)).catch(() => null);
        if (info?.isDirectory()) orphans.push(repo);
      }
      orphans.sort();
      const models: InventoryModel[] = [];
      for (const [index, model] of listed.entries()) {
        if (index >= MAX_SIZED_MODELS) {
          models.push(model);
          continue;
        }
        let bytes: number | null = null;
        try {
          const entry = (await runAs(ctx, user, home, binary, ["path", "--local", model.name], PATH_TIMEOUT_MS)).trim();
          const snapshot = snapshotRootFromEntrypoint(entry);
          // IR-106: measure the MODEL dir (blobs are real files there), not
          // the snapshot — HF snapshots are symlink farms, and the walk
          // never follows links, so a snapshot measures as a few hundred
          // bytes of symlink entries.
          if (snapshot !== null) bytes = await dirBytes(join(snapshot, "..", ".."));
        } catch {
          bytes = null;
        }
        models.push({ ...model, bytes });
      }
      caches.push({ user, home, cacheDir, modelctlVersion: version, error: null, models, orphans });
    } catch (err) {
      caches.push({
        user,
        home,
        cacheDir,
        modelctlVersion: null,
        error: err instanceof Error ? err.message : String(err),
        models: [],
        orphans: [],
      });
    }
  }
  return caches;
}

/** Builds the full report for a `models-inventory` job. */
export async function buildInventory(ctx: InventoryCtx): Promise<NodeInventory> {
  const generatedAtMs = (ctx.now ?? Date.now)();
  let store: NodeInventory["store"] = null;
  if (ctx.nasRoot !== null) {
    try {
      const read = await readStore(ctx.nasRoot);
      store = {
        root: ctx.nasRoot,
        source: read.source,
        warning: read.warning ?? null,
        models: read.entries.map((entry) => ({
          name: entry.name,
          repository: entry.repository,
          runtime: entry.runtime,
          bytes: entry.bytes > 0 ? entry.bytes : null,
        })),
        leftovers: await readFailedDeletes(ctx.nasRoot),
      };
    } catch (err) {
      store = {
        root: ctx.nasRoot,
        source: "scan",
        warning: `store inventory failed: ${err instanceof Error ? err.message : String(err)}`,
        models: [],
        leftovers: [],
      };
    }
  }
  return { generatedAtMs, store, local: await discoverLocalCaches(ctx) };
}
