import { lstat } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import type { Stats } from "node:fs";
import { OP_TIMEOUT_MS } from "./catalog-read.js";

/**
 * IRI-173: checks the store link before `modelctl sync-local` starts.
 *
 * modelctl resolves `<root>/active/<name>` and requires a symlink there. On
 * an SMB mount every server-side symlink shows up as a directory, and the
 * only message the user got was modelctl's "has no active NAS reference".
 * This turns the known causes into plain sentences and fails before any
 * staging directory is created. Read-only; every stat is bounded so a wedged
 * mount cannot hold the job open (IR-206).
 */

type Probe = { kind: "ok"; stats: Stats } | { kind: "missing" } | { kind: "timeout" } | { kind: "error"; message: string };

export type LstatFn = (path: string) => Promise<Stats>;

async function probe(path: string, lstatFn: LstatFn, timeoutMs: number): Promise<Probe> {
  const { promise: timerP, resolve } = Promise.withResolvers<Probe>();
  const timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
  timer.unref?.();
  try {
    return await Promise.race([
      lstatFn(path).then(
        (stats): Probe => ({ kind: "ok", stats }),
        (err: NodeJS.ErrnoException): Probe =>
          err.code === "ENOENT" || err.code === "ENOTDIR" ? { kind: "missing" } : { kind: "error", message: err.message },
      ),
      timerP,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface SyncPreflightOpts {
  /** IRI-175: the node's modelctl resolves the object from the update
   *  journal (>= 0.25.1), so a directory entry is no longer a failure. */
  linkOptional?: boolean;
  /** Test seams. */
  lstatFn?: LstatFn;
  timeoutMs?: number;
  node?: string;
}

/**
 * Returns null when the sync may start, otherwise the sentence to show.
 * `target` is the sync-local argument; a repository id (`org/repo`) cannot be
 * mapped to an active name here, so only the store itself is checked then.
 */
export async function syncLocalPreflight(root: string, target: string, opts: SyncPreflightOpts = {}): Promise<string | null> {
  const lstatFn = opts.lstatFn ?? lstat;
  const timeoutMs = opts.timeoutMs ?? OP_TIMEOUT_MS;
  const node = opts.node ?? hostname();
  const dead = `${node}: ${root} did not answer within ${Math.round(timeoutMs / 1000)}s (possibly a dead network mount)`;

  const active = await probe(join(root, "active"), lstatFn, timeoutMs);
  if (active.kind === "timeout") return dead;
  if (active.kind === "missing") return `${node}: ${root} is not the model store (no active/ directory). Is the NAS share mounted?`;
  // Any other error (EACCES for a root agent on a root-squashed export, …)
  // is not proof: modelctl runs as the cache user and may still succeed.
  if (active.kind === "error") return null;

  // A repository id cannot be mapped to an entry here; "." and ".." are not
  // names. modelctl validates all three itself.
  if (target.includes("/") || target === "." || target === "..") return null;
  const entry = await probe(join(root, "active", target), lstatFn, timeoutMs);
  if (entry.kind === "timeout") return dead;
  if (entry.kind === "missing") return `${node}: '${target}' is not active in the store at ${root}. Refresh the catalog and try again.`;
  if (entry.kind === "error" || entry.stats.isSymbolicLink()) return null;
  if (entry.stats.isDirectory() && opts.linkOptional === true) return null;
  if (!entry.stats.isDirectory()) return `${node}: '${target}' in the store at ${root} is not a symlink. Run a repair check on the store node.`;
  return `${node}: '${target}' is not visible as a symlink on this node's mount of ${root}, so modelctl cannot sync it. SMB shows the store's links as directories: mount the store over NFS, or enable symlink support on the share.`;
}
