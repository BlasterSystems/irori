import { readdir, readFile, readlink, lstat, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseCatalog, CatalogFormatError, type Catalog, type ScannedModel } from "@irori/core";

/**
 * Reads a modelctl store: trusted catalog.json (schema 3) when fresh/valid,
 * otherwise a live scan of active/ with manifest parsing (ADR-0004 — Irori
 * never rewrites the catalog).
 *
 * IR-206: every filesystem op is async and races a hard 2 s timer. The old
 * sync calls (`readdirSync`/`readFileSync`/…) froze the agent MAIN THREAD on
 * a wedged CIFS mount (no frames, no pongs, no jobs); the async versions
 * block nothing, and the bound makes a dead mount skip instead of hang.
 */

export interface StoreRead {
  entries: ScannedModel[];
  source: "catalog" | "scan";
  warning?: string;
}

/** Per-operation bound — a wedged network mount must not hold the read open. */
export const OP_TIMEOUT_MS = 2000;

/** Races an fs op against a timer; null on timeout OR rejection (skip). */
export async function boundedOrNull<T>(op: () => Promise<T>): Promise<T | null> {
  const { promise: timerP, resolve } = Promise.withResolvers<null>();
  const timer = setTimeout(() => resolve(null), OP_TIMEOUT_MS);
  timer.unref?.();
  try {
    return await Promise.race([op(), timerP]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Minimal YAML for modelctl manifests: flat keys + one nested runtime map + include/companions lists. */
export function parseManifestFields(yaml: string): { name?: string; repo?: string; revision?: string; format?: string; runtimeType?: string } {
  const out: { name?: string; repo?: string; revision?: string; format?: string; runtimeType?: string } = {};
  let inRuntime = false;
  for (const raw of yaml.split("\n")) {
    const line = raw.replace(/\t/g, "  ");
    if (/^runtime:/.test(line)) {
      inRuntime = true;
      continue;
    }
    if (/^\S/.test(line)) inRuntime = false;
    const m = /^(\s*)([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    const indent = m[1]!.length;
    const key = m[2]!;
    const value = m[3]!.trim().replace(/^['"]|['"]$/g, "");
    if (!inRuntime && indent === 0) {
      if (key === "name" && value) out.name = value;
      else if (key === "repo" && value) out.repo = value;
      else if (key === "revision" && value) out.revision = value;
      else if (key === "format" && value) out.format = value;
    } else if (inRuntime && indent > 0 && key === "type" && value) {
      out.runtimeType = value;
    }
  }
  return out;
}

const execFileAsync = promisify(execFile);

/**
 * du-style byte size of a directory (block counts, like modelctl's catalog).
 * Async so a slow NAS never stalls the agent's event loop mid-catalog; GNU
 * `du -sb` falls back to a manual walk where it is unavailable (BSD/macOS).
 */
export async function dirBytes(path: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync("du", ["-sb", path], { encoding: "utf8", timeout: 30_000 });
    const n = Number.parseInt(stdout.split("\t")[0] ?? "0", 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return walkBytes(path);
  }
}

async function walkBytes(path: string): Promise<number> {
  const dirents = await readdir(path, { withFileTypes: true }).catch(() => null);
  if (dirents === null) return 0;
  let total = 0;
  for (const entry of dirents) {
    const child = join(path, entry.name);
    try {
      if (entry.isSymbolicLink()) continue; // never follow links out of the store
      if (entry.isDirectory()) total += await walkBytes(child);
      else total += (await stat(child)).size;
    } catch {
      // unreadable entries contribute nothing
    }
  }
  return total;
}

/** Manifest YAML if present and readable within the bound; null otherwise. */
async function readManifestBounded(
  path: string,
): Promise<{ name?: string; repo?: string; revision?: string; format?: string; runtimeType?: string } | null> {
  const yaml = await boundedOrNull(() => readFile(path, "utf8"));
  return yaml === null ? null : parseManifestFields(yaml);
}

/** Live scan of active/ — name → manifest parse → object dir size. */
export async function scanStore(root: string): Promise<ScannedModel[]> {
  const activeDir = join(root, "active");
  const names = (await boundedOrNull(() => readdir(activeDir)))?.sort() ?? [];
  const entries: ScannedModel[] = [];
  for (const name of names) {
    const ref = join(activeDir, name);
    const st = await boundedOrNull(() => lstat(ref));
    if (st === null) continue;
    if (st.isDirectory()) {
      // A validated directory copy — modelctl doctor can repair it; still list it.
      const mf = await readManifestBounded(join(root, "manifests", `${name}.yaml`));
      if (mf !== null) {
        entries.push({ name, runtime: mf.runtimeType ?? "unknown", repository: mf.repo ?? name, bytes: await dirBytes(ref) });
      }
      continue;
    }
    if (!st.isSymbolicLink()) continue; // hidden foreign files: doctor's job, not ours
    const linkTarget = await boundedOrNull(() => readlink(ref));
    if (linkTarget === null) continue;
    const objectDir = resolve(root, linkTarget);
    const objectSt = await boundedOrNull(() => stat(objectDir));
    if (objectSt === null || !objectSt.isDirectory()) continue; // broken link: doctor reports it
    let runtimeType = "unknown";
    let repo = name;
    const mf = await readManifestBounded(join(root, "manifests", `${name}.yaml`));
    if (mf !== null) {
      runtimeType = mf.runtimeType ?? runtimeType;
      repo = mf.repo ?? repo;
    } else {
      // Manifest missing: derive ORG/REPO from the object path models/ORG/REPO/…
      const rel = objectDir.startsWith(root) ? objectDir.slice(root.length + 1).split("/") : [];
      if (rel.length >= 3 && rel[0] === "models") repo = `${rel[1]}/${rel[2]}`;
    }
    entries.push({ name, runtime: runtimeType, repository: repo, bytes: await dirBytes(objectDir) });
  }
  return entries;
}

/**
 * Reads the store with the ADR-0004 fallback ladder:
 * catalog.json parse → live scan. Never writes anything.
 */
export async function readStore(root: string): Promise<StoreRead> {
  const catalogPath = join(root, "catalog.json");
  const catalogText = await boundedOrNull(() => readFile(catalogPath, "utf8"));
  if (catalogText !== null) {
    try {
      const catalog: Catalog = parseCatalog(catalogText);
      if (catalog.schema === 3) {
        return { entries: catalog.models.map((m) => ({ ...m })), source: "catalog" };
      }
      return { entries: await scanStore(root), source: "scan", warning: `catalog schema ${catalog.schema} unsupported; scanned active/` };
    } catch (e) {
      if (e instanceof CatalogFormatError) {
        return { entries: await scanStore(root), source: "scan", warning: `catalog unreadable (${e.message}); scanned active/` };
      }
      throw e;
    }
  }
  return { entries: await scanStore(root), source: "scan", warning: "no catalog.json; scanned active/" };
}
