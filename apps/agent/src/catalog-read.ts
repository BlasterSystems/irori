import { constants as fsConstants } from "node:fs";
import { open, readdir, readFile, readlink, lstat, realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  parseCatalog,
  storeCompanionsSchema,
  COMPANIONS_UNREADABLE,
  CatalogFormatError,
  type Catalog,
  type ScannedModel,
  type StoreCompanionsState,
} from "@irori/core";

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

/**
 * IRI-173: names under active/ that this node sees as directories instead of
 * symlinks. modelctl `sync-local` refuses those, and an SMB mount shows every
 * server-side symlink this way. Null = active/ could not be listed (unknown).
 * One bounded lstat per entry; hidden entries (`.DS_Store`) are skipped.
 */
export async function listUnlinkedActive(root: string): Promise<string[] | null> {
  const activeDir = join(root, "active");
  // One call yields the entry kinds; a per-entry lstat is needed only when
  // the filesystem does not report a kind.
  const entries = await boundedOrNull(() => readdir(activeDir, { withFileTypes: true }));
  if (entries === null) return null;
  const unlinked: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isSymbolicLink() || entry.isFile()) continue;
    if (entry.isDirectory()) {
      unlinked.push(entry.name);
      continue;
    }
    const st = await boundedOrNull(() => lstat(join(activeDir, entry.name)));
    // A wedged mount mid-listing: report unknown rather than a partial list.
    if (st === null) return null;
    if (st.isDirectory()) unlinked.push(entry.name);
  }
  return unlinked.sort();
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
 * IRI-155: installed companions (ADR-0020) come from the published object's
 * metadata, `active/<name>/.modelctl.json`, never the manifest, which can be
 * ahead of the installed object after a failed update.
 */
export const METADATA_FILE = ".modelctl.json";
/** modelctl writes a few KiB; anything bigger is not object metadata. */
export const METADATA_MAX_BYTES = 1024 * 1024;
/** Parallel metadata reads per catalog: bounded so a slow CIFS mount stays bounded. */
export const COMPANION_CONCURRENCY = 8;
/**
 * Overall budget for one catalog's companion reads (review F1). A degraded
 * mount costs up to 2 x OP_TIMEOUT_MS per entry, so without it N models
 * would hold the catalog frame for about N/8 x 4 s. Entries not read in time
 * report unreadable, which is the truth: they could not be read.
 */
export const COMPANIONS_DEADLINE_MS = 10_000;

/** Why an object's metadata could not be used. */
export type MetadataFailure = "missing" | "timeout" | "unreadable" | "too-large" | "not-a-file" | "escape" | "malformed";

export type Bounded<T> = { ok: true; value: T } | { ok: false; timeout: true } | { ok: false; timeout: false; error: unknown };

/** Like boundedOrNull, but keeps a timeout apart from an error (and the error itself). */
export async function boundedResult<T>(op: () => Promise<T>): Promise<Bounded<T>> {
  const { promise: timerP, resolve } = Promise.withResolvers<Bounded<T>>();
  const timer = setTimeout(() => resolve({ ok: false, timeout: true }), OP_TIMEOUT_MS);
  timer.unref?.();
  try {
    return await Promise.race([op().then((value): Bounded<T> => ({ ok: true, value })), timerP]);
  } catch (error) {
    return { ok: false, timeout: false, error };
  } finally {
    clearTimeout(timer);
  }
}

const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code;

/** A store entry name is one path segment (it is joined under active/). */
function isPlainName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !/[/\\\0]/.test(name);
}

class MetadataError extends Error {
  constructor(readonly reason: MetadataFailure) {
    super(reason);
  }
}

/**
 * Reads `<object>/.modelctl.json` with store confinement: the object dir must
 * resolve (realpath) inside the store root, and the file is opened without
 * following a final symlink (O_NOFOLLOW) or blocking on a FIFO (O_NONBLOCK),
 * must be a regular file, and is read with a hard byte cap.
 */
export async function readObjectMetadata(rootReal: string, root: string, name: string): Promise<{ ok: true; raw: unknown } | { ok: false; reason: MetadataFailure }> {
  if (!isPlainName(name)) return { ok: false, reason: "escape" };
  const resolved = await boundedResult(() => realpath(join(root, "active", name)));
  if (!resolved.ok) {
    if (resolved.timeout) return { ok: false, reason: "timeout" };
    return { ok: false, reason: errCode(resolved.error) === "ENOENT" ? "missing" : "unreadable" };
  }
  const objectDir = resolved.value;
  if (!objectDir.startsWith(rootReal + sep)) return { ok: false, reason: "escape" };

  const text = await boundedResult(async () => {
    let fh;
    try {
      fh = await open(join(objectDir, METADATA_FILE), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    } catch (e) {
      const code = errCode(e);
      throw new MetadataError(code === "ENOENT" ? "missing" : code === "ELOOP" ? "not-a-file" : "unreadable");
    }
    try {
      const st = await fh.stat();
      if (!st.isFile()) throw new MetadataError("not-a-file");
      if (st.size > METADATA_MAX_BYTES) throw new MetadataError("too-large");
      // Cap-sized, not fstat-sized: CIFS can report a stale size, and a buffer
      // sized to it would truncate the file (re-review N1). allocUnsafe skips the
      // zero fill (review F2); only the bytes actually read are ever decoded.
      const buf = Buffer.allocUnsafe(METADATA_MAX_BYTES + 1);
      let total = 0;
      for (;;) {
        const { bytesRead } = await fh.read(buf, total, buf.length - total, total);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > METADATA_MAX_BYTES) throw new MetadataError("too-large"); // grew after fstat
      }
      return buf.subarray(0, total).toString("utf8");
    } finally {
      await fh.close().catch(() => {});
    }
  });
  if (!text.ok) {
    if (text.timeout) return { ok: false, reason: "timeout" };
    return { ok: false, reason: text.error instanceof MetadataError ? text.error.reason : "unreadable" };
  }
  try {
    return { ok: true, raw: JSON.parse(text.value) as unknown };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

/**
 * Object metadata (modelctl `validation.write_metadata`, schema 1) → the
 * companions it records: null = none recorded; unreadable = not schema-1
 * metadata, or a value that fails the shared wire schema (the hub drops a
 * WHOLE catalog frame that fails its parse, so nothing unvalidated is sent).
 */
export function companionsFromMetadata(raw: unknown): StoreCompanionsState {
  if (typeof raw !== "object" || raw === null) return COMPANIONS_UNREADABLE;
  const meta = raw as Record<string, unknown>;
  if (meta.schema !== 1 || !Array.isArray(meta.files)) return COMPANIONS_UNREADABLE;
  const companions = typeof meta.companions === "object" && meta.companions !== null ? (meta.companions as Record<string, unknown>) : {};
  const sizeOf = (path: string): number | null => {
    for (const f of meta.files as unknown[]) {
      if (typeof f !== "object" || f === null) continue;
      const file = f as Record<string, unknown>;
      if (file.path === path) return Number.isSafeInteger(file.size) && (file.size as number) >= 0 ? (file.size as number) : null;
    }
    return null;
  };
  const mmprojPath = typeof companions.mmproj === "string" ? companions.mmproj : null;
  const draftPath = typeof companions.mtp === "string" ? companions.mtp : null;
  if (mmprojPath === null && draftPath === null) return null;
  const parsed = storeCompanionsSchema.safeParse({
    mmproj: mmprojPath === null ? null : { path: mmprojPath, bytes: sizeOf(mmprojPath) },
    draft:
      draftPath === null
        ? null
        : { path: draftPath, bytes: sizeOf(draftPath), specType: typeof meta.draft_spec_type === "string" ? meta.draft_spec_type : null },
  });
  return parsed.success ? parsed.data : COMPANIONS_UNREADABLE;
}

/**
 * What a metadata failure reports on the wire (owner decision, IRI-155).
 * A missing file is an object modelctl recorded no metadata for (older
 * downloads): known, none. Every other failure is "cannot read": the page
 * shows an info marker instead of companions, replacing any earlier value.
 */
export function companionsOutcome(reason: MetadataFailure): StoreCompanionsState {
  return reason === "missing" ? null : COMPANIONS_UNREADABLE;
}

/** Companions of one store entry; see companionsOutcome for failures. */
export async function readCompanions(rootReal: string, root: string, name: string): Promise<StoreCompanionsState> {
  const read = await readObjectMetadata(rootReal, root, name);
  if (!read.ok) return companionsOutcome(read.reason);
  return companionsFromMetadata(read.raw);
}

/** Order-preserving map with at most `limit` calls in flight. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Adds `companions` to every entry within COMPANIONS_DEADLINE_MS; never fails, never drops an entry. */
export async function withCompanions(root: string, entries: ScannedModel[], deadlineMs = COMPANIONS_DEADLINE_MS): Promise<ScannedModel[]> {
  const rootReal = await boundedResult(() => realpath(root));
  if (!rootReal.ok) return entries.map((entry) => ({ ...entry, companions: COMPANIONS_UNREADABLE }));
  const { promise: expiredP, resolve: expire } = Promise.withResolvers<StoreCompanionsState>();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    expire(COMPANIONS_UNREADABLE);
  }, deadlineMs);
  timer.unref?.();
  try {
    return await mapLimit(entries, COMPANION_CONCURRENCY, async (entry) => ({
      ...entry,
      companions: expired
        ? COMPANIONS_UNREADABLE // past the budget: don't start more I/O
        : await Promise.race([
            readCompanions(rootReal.value, root, entry.name).catch((): StoreCompanionsState => COMPANIONS_UNREADABLE),
            expiredP,
          ]),
    }));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads the store with the ADR-0004 fallback ladder:
 * catalog.json parse → live scan. Never writes anything.
 */
export async function readStore(root: string, opts: { companions?: boolean } = {}): Promise<StoreRead> {
  const read = await readStoreEntries(root);
  // Inventory has no use for companions and its own store deadline (review F1).
  if (opts.companions === false) return read;
  return { ...read, entries: await withCompanions(root, read.entries) };
}

async function readStoreEntries(root: string): Promise<StoreRead> {
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
