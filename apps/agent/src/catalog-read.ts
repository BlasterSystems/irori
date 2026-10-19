import { readdirSync, readFileSync, readlinkSync, lstatSync, statSync, existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseCatalog, CatalogFormatError, type Catalog, type ScannedModel } from "@irori/core";

/**
 * Reads a modelctl store: trusted catalog.json (schema 3) when fresh/valid,
 * otherwise a live scan of active/ with manifest parsing (ADR-0004 — Irori
 * never rewrites the catalog).
 */

export interface StoreRead {
  entries: ScannedModel[];
  source: "catalog" | "scan";
  warning?: string;
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
async function dirBytes(path: string): Promise<number> {
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

/** Live scan of active/ — name → manifest parse → object dir size. */
export async function scanStore(root: string): Promise<ScannedModel[]> {
  const activeDir = join(root, "active");
  const entries: ScannedModel[] = [];
  for (const name of readdirSync(activeDir).sort()) {
    const ref = join(activeDir, name);
    let st;
    try {
      st = lstatSync(ref);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      // A validated directory copy — modelctl doctor can repair it; still list it.
      const manifestPath = join(root, "manifests", `${name}.yaml`);
      if (existsSync(manifestPath)) {
        const mf = parseManifestFields(readFileSync(manifestPath, "utf8"));
        entries.push({ name, runtime: mf.runtimeType ?? "unknown", repository: mf.repo ?? name, bytes: await dirBytes(ref) });
      }
      continue;
    }
    if (!st.isSymbolicLink()) continue; // hidden foreign files: doctor's job, not ours
    let target: string;
    try {
      target = resolve(root, readlinkSync(ref));
    } catch {
      continue;
    }
    let objectDir = target;
    try {
      if (!statSync(objectDir).isDirectory()) continue;
    } catch {
      continue; // broken link: doctor reports it
    }
    const manifestPath = join(root, "manifests", `${name}.yaml`);
    let runtimeType = "unknown";
    let repo = name;
    if (existsSync(manifestPath)) {
      const mf = parseManifestFields(readFileSync(manifestPath, "utf8"));
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
  if (existsSync(catalogPath)) {
    try {
      const catalog: Catalog = parseCatalog(readFileSync(catalogPath, "utf8"));
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
