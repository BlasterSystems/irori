import { execFile } from "node:child_process";
import { readdir, readFile, readlink, stat, realpath, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { Dirent } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  HYGIENE_CATEGORY_LABELS,
  type HygieneAudit,
  type HygieneCategory,
  type HygieneCategoryAudit,
  type HygieneCleanOutcome,
  type HygieneCleanParams,
  type HygieneCleanResult,
  type HygieneDetail,
} from "@irori/core";

const execFileAsync = promisify(execFile);

/** One scanned staging entry (modelctl staging-audit --json). */
export interface StagingEntry {
  path: string;
  status: string;
  bytes: number;
  name: string | null;
  detail: string;
}

/** One docker image row (`docker images --format`). */
export interface DockerImageRow {
  repository: string;
  tag: string;
  id: string;
  sizeBytes: number;
  createdSince: string;
}

/** `docker system df --format` row. */
export interface DockerDfRow {
  type: string;
  sizeBytes: number;
  reclaimableBytes: number;
}

/** One local HF-cache directory scan entry. */
export interface HfCacheScan {
  incompleteBytes: number;
  incompleteCount: number;
  unreferencedBytes: number;
  unreferencedCount: number;
}

/**
 * Staging entries that are safe to clean: SPEC §11.6 says "non-resumable
 * only" — resumable downloads and journal-referenced staging belong to an
 * in-flight modelctl update and must survive.
 */
export function selectCleanableStaging(entries: StagingEntry[]): StagingEntry[] {
  return entries.filter((e) => e.status !== "resumable" && e.status !== "journal_referenced");
}

/** Category details are UI rows; cap them so the report stays small. */
const MAX_DETAILS = 12;

function capDetails(rows: HygieneDetail[]): HygieneDetail[] {
  return rows.slice(0, MAX_DETAILS);
}

/** Maps a modelctl staging-audit JSON array to the modelctl-staging category row. */
export function stagingAuditToCategory(entries: StagingEntry[]): HygieneCategoryAudit {
  const cleanable = selectCleanableStaging(entries);
  return {
    category: "modelctl-staging",
    safe: false,
    rationale: "Non-resumable staging data under the NAS store root; resumable and journal-referenced entries are protected.",
    itemCount: cleanable.length,
    reclaimableBytes: cleanable.reduce((sum, e) => sum + (Number.isFinite(e.bytes) ? e.bytes : 0), 0),
    details: capDetails(
      cleanable.map((entry) => ({
        label: entry.status,
        path: entry.path,
        bytes: Number.isFinite(entry.bytes) ? entry.bytes : 0,
        items: 1,
      })),
    ),
  };
}

/**
 * Parses `docker system df --format {{.Type}}\t{{.Size}}\t{{.Reclaimable}}`.
 * Sizes may carry units (B, KB, MB, GB, TB); Reclaimable is a percent.
 */
export function parseDockerDf(text: string): DockerDfRow[] {
  const rows: DockerDfRow[] = [];
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\t/);
    if (parts.length < 3) continue;
    const [type, size, reclaimable] = parts as [string, string, string];
    const sizeBytes = parseDockerSize(size);
    const pctMatch = /([\d.]+)%\s*\(.*\)/.exec(reclaimable) ?? /([\d.]+)%/.exec(reclaimable);
    const pct = pctMatch ? Number.parseFloat(pctMatch[1]!) : 0;
    rows.push({ type, sizeBytes, reclaimableBytes: Math.round((sizeBytes * (Number.isFinite(pct) ? pct : 0)) / 100) });
  }
  return rows;
}

/** "212.4GB" | "1.2MB" | "534.2kB" | "10GB (Virtual 12GB)" → bytes. */
export function parseDockerSize(raw: string): number {
  const m = /([\d.]+)\s*(B|kB|KB|MB|GB|TB)/.exec(raw);
  if (!m) return 0;
  const n = Number.parseFloat(m[1]!);
  switch (m[2]!) {
    case "TB":
      return n * 1e12;
    case "GB":
      return n * 1e9;
    case "MB":
      return n * 1e6;
    case "kB":
    case "KB":
      return n * 1e3;
    default:
      return n;
  }
}

/**
 * Old-image selection: keep the newest `keepPerRepo` rows per repository,
 * drop everything else, never touch protected ids (running containers,
 * platform images) or dangling-less repos. Input must be sorted newest-first
 * (docker images default ordering).
 */
export function selectOldImages(rows: DockerImageRow[], keepPerRepo: number, protectedIds: ReadonlySet<string>): DockerImageRow[] {
  const perRepo = new Map<string, number>();
  const old: DockerImageRow[] = [];
  for (const row of rows) {
    if (protectedIds.has(row.id)) continue;
    const count = perRepo.get(row.repository) ?? 0;
    perRepo.set(row.repository, count + 1);
    if (count >= keepPerRepo) old.push(row);
  }
  return old;
}

/** Parses `docker images --format {{.Repository}}\t{{.Tag}}\t{{.ID}}\t{{.Size}}\t{{.CreatedSince}}`. */
export function parseDockerImages(text: string): DockerImageRow[] {
  const rows: DockerImageRow[] = [];
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\t/);
    if (parts.length < 5) continue;
    rows.push({
      repository: parts[0]!,
      tag: parts[1]!,
      id: parts[2]!,
      sizeBytes: parseDockerSize(parts[3]!),
      createdSince: parts[4]!,
    });
  }
  return rows;
}

/**
 * HF-cache orphan scan: `blobs/*.incomplete` plus snapshot dirs never
 * referenced by any `refs/*` pointer. `protectedPrefixes` (modelctl
 * registrations) excludes whole cache subtrees from the orphan count.
 */
export async function scanHfCache(
  cacheDir: string,
  protectedPrefixes: ReadonlySet<string>,
): Promise<HfCacheScan> {
  const scan: HfCacheScan = { incompleteBytes: 0, incompleteCount: 0, unreferencedBytes: 0, unreferencedCount: 0 };
  const modelsDir = join(cacheDir, "hub");
  const hubRoot = existsSync(modelsDir) ? modelsDir : cacheDir;
  const isProtected = (p: string) => [...protectedPrefixes].some((prefix) => p === prefix || p.startsWith(prefix + "/"));

  // Blobs: *.incomplete are partial downloads; nothing references them.
  const blobsDir = join(hubRoot, "blobs");
  const blobEntries = await safeReaddir(blobsDir);
  for (const entry of blobEntries) {
    if (!entry.name.endsWith(".incomplete")) continue;
    const st = await safeStat(join(blobsDir, entry.name));
    if (st === null) continue;
    scan.incompleteCount += 1;
    scan.incompleteBytes += st.size;
  }

  // Snapshots: referenced sets live under models--*/refs/<ref> → commit hash.
  const modelDirs = await safeReaddir(hubRoot);
  for (const model of modelDirs) {
    if (!model.isDirectory() || !model.name.startsWith("models--")) continue;
    const modelDir = join(hubRoot, model.name);
    if (isProtected(modelDir)) continue;
    const referenced = new Set<string>();
    const refsDir = join(modelDir, "refs");
    for (const ref of await safeReaddir(refsDir)) {
      const content = await readFile(join(refsDir, ref.name), "utf8").catch(() => null);
      const hash = content?.trim().split(/\s+/)[0];
      if (hash && /^[0-9a-f]{40}$/.test(hash)) referenced.add(hash);
    }
    const snapshotsDir = join(modelDir, "snapshots");
    for (const snap of await safeReaddir(snapshotsDir)) {
      if (!snap.isDirectory()) continue;
      if (referenced.has(snap.name)) continue;
      const bytes = await walkBytes(join(snapshotsDir, snap.name));
      if (bytes > 0) {
        scan.unreferencedCount += 1;
        scan.unreferencedBytes += bytes;
      }
    }
  }
  return scan;
}

// ─── protected set ──────────────────────────────────────────────────────────

/** Paths the cleaners must never touch (SPEC §11.6 protected set). */
export interface ProtectedSet {
  /** Resolved prefixes (realpath'd where possible). */
  prefixes: Set<string>;
  /** Docker image ids backing running containers + platform images. */
  imageIds: Set<string>;
  notes: string[];
}

export async function buildProtectedSet(opts: { nasRoot: string | null; modelctlPath?: string; dockerAvailable: boolean }): Promise<ProtectedSet> {
  const ps: ProtectedSet = { prefixes: new Set(), imageIds: new Set(), notes: [] };
  // 1. modelctl registrations: resolve each local HF-cache entry to a path.
  if (opts.modelctlPath && existsSync(opts.modelctlPath)) {
    const listed = await execFileAsync(opts.modelctlPath, ["list", "--local", "--json"], { encoding: "utf8", timeout: 30_000 }).catch(() => null);
    if (listed) {
      try {
        const entries = JSON.parse(listed.stdout) as Array<{ name: string }>;
        for (const entry of entries) {
          const pathOut = await execFileAsync(opts.modelctlPath, ["path", "--local", entry.name], { encoding: "utf8", timeout: 30_000 }).catch(() => null);
          const p = pathOut?.stdout.trim();
          if (p) ps.prefixes.add(await safeRealpath(p));
        }
        ps.notes.push(`protected ${entries.length} modelctl local registration(s)`);
      } catch {
        ps.notes.push("modelctl list --local unreadable — registrations not protected this run");
      }
    }
  } else {
    ps.notes.push("modelctl binary not available — registrations not protected this run");
  }
  // 2. Running container images (docker available only).
  if (opts.dockerAvailable) {
    const ps_ = await execFileAsync("docker", ["ps", "--format", "{{.ID}}\t{{.Image}}"], { encoding: "utf8", timeout: 30_000 }).catch(() => null);
    if (ps_) {
      for (const line of ps_.stdout.split("\n")) {
        const [cid, image] = line.trim().split(/\t/);
        if (!cid || !image) continue;
        ps.imageIds.add(image);
        const inspect = await execFileAsync("docker", ["image", "inspect", image, "--format", "{{.Id}}"], { encoding: "utf8", timeout: 30_000 }).catch(() => null);
        const id = inspect?.stdout.trim();
        if (id) ps.imageIds.add(id);
      }
      // Platform images are never old-image candidates.
      for (const name of ["irori:latest", "irori-agent:latest", "irori-dev:latest"]) ps.imageIds.add(name);
    }
  } else {
    ps.notes.push("docker CLI not available — running-container images not enumerated");
  }
  // 3. The NAS store itself is modelctl-owned state — never touched.
  if (opts.nasRoot) ps.prefixes.add(await safeRealpath(opts.nasRoot));
  // 4. Files currently open by any process (engine weights, journals) — a
  //    bounded /proc/*/fd walk; unreadable pids are skipped.
  const pids = await safeReaddir("/proc");
  for (const pid of pids) {
    if (!/^\d+$/.test(pid.name)) continue;
    const fdDir = join("/proc", pid.name, "fd");
    const fds = await safeReaddir(fdDir);
    for (const fd of fds) {
      const target = await readlink(join(fdDir, fd.name)).catch(() => null);
      if (target === null || !target.startsWith("/")) continue;
      ps.prefixes.add(await safeRealpath(target));
    }
  }
  return ps;
}

// ─── audit ──────────────────────────────────────────────────────────────────

export interface HygieneCtx {
  nasRoot: string | null;
  modelctlPath?: string;
  now?: () => number;
}

const COMPILER_CACHE_DIRS = [".cache/vllm", ".cache/torch", ".cache/triton", ".nv/ComputeCache"];

/** Read-only audit of all eight categories (SPEC §11.6). */
export async function auditHygiene(ctx: HygieneCtx): Promise<HygieneAudit> {
  const now = (ctx.now ?? Date.now)();
  const dockerAvailable = await hasDocker();
  const dockerDf = dockerAvailable ? await dockerSystemDf() : [];
  const protectedSet = await buildProtectedSet({ nasRoot: ctx.nasRoot, modelctlPath: ctx.modelctlPath, dockerAvailable });

  const home = homedir();
  const categories: HygieneCategoryAudit[] = [];

  // 1. docker build cache
  const buildCache = dockerDf.find((r) => r.type === "Build Cache");
  categories.push({
    category: "docker-build-cache",
    safe: true,
    rationale: dockerAvailable
      ? "docker builder prune — rebuildable layers only."
      : "docker CLI not available on this agent.",
    itemCount: buildCache ? 1 : 0,
    reclaimableBytes: buildCache?.reclaimableBytes ?? 0,
    details:
      buildCache === undefined
        ? []
        : [{ label: "docker builder cache", path: null, bytes: buildCache.reclaimableBytes, items: 1 }],
  });

  // 2. docker old images (keep last 2 per repo, exclude in-use)
  let oldImages: DockerImageRow[] = [];
  if (dockerAvailable) {
    const images = await execFileAsync(
      "docker",
      ["images", "--format", "{{.Repository}}\t{{.Tag}}\t{{.ID}}\t{{.Size}}\t{{.CreatedSince}}"],
      { encoding: "utf8", timeout: 30_000 },
    ).catch(() => null);
    if (images) {
      oldImages = selectOldImages(parseDockerImages(images.stdout), 2, protectedSet.imageIds);
    }
  }
  categories.push({
    category: "docker-images",
    safe: false,
    rationale: "Keeps the last 2 images per repository; running containers and platform images are protected.",
    itemCount: oldImages.length,
    reclaimableBytes: oldImages.reduce((sum, r) => sum + r.sizeBytes, 0),
    details: capDetails(
      oldImages.map((image) => ({
        label: `${image.repository}:${image.tag}`,
        path: null,
        bytes: image.sizeBytes,
        items: 1,
      })),
    ),
  });

  // 3. stopped containers
  const containers = dockerDf.find((r) => r.type === "Containers");
  let stoppedCount = 0;
  if (dockerAvailable) {
    const stopped = await execFileAsync("docker", ["ps", "-aq", "--filter", "status=exited", "--filter", "status=created"], { encoding: "utf8", timeout: 30_000 }).catch(() => null);
    stoppedCount = stopped ? stopped.stdout.split("\n").filter((l) => l.trim().length > 0).length : 0;
  }
  categories.push({
    category: "docker-containers",
    safe: true,
    rationale: dockerAvailable ? "Removes exited/created containers only — never running ones." : "docker CLI not available on this agent.",
    itemCount: stoppedCount,
    reclaimableBytes: containers?.reclaimableBytes ?? 0,
    details:
      stoppedCount === 0
        ? []
        : [{ label: "exited/created containers", path: null, bytes: containers?.reclaimableBytes ?? 0, items: stoppedCount }],
  });

  // 4. HF cache orphans
  const hfDir = process.env.HF_HOME ?? join(home, ".cache", "huggingface");
  let hfScan = { incompleteBytes: 0, incompleteCount: 0, unreferencedBytes: 0, unreferencedCount: 0 };
  if (existsSync(hfDir)) {
    hfScan = await scanHfCache(hfDir, protectedSet.prefixes);
  }
  categories.push({
    category: "hf-cache",
    safe: false,
    rationale: "Removes *.incomplete blobs and snapshots no ref points at; modelctl registrations are protected.",
    itemCount: hfScan.incompleteCount + hfScan.unreferencedCount,
    reclaimableBytes: hfScan.incompleteBytes + hfScan.unreferencedBytes,
    details: [
      ...(hfScan.incompleteCount > 0
        ? [{ label: "*.incomplete blobs", path: hfDir, bytes: hfScan.incompleteBytes, items: hfScan.incompleteCount }]
        : []),
      ...(hfScan.unreferencedCount > 0
        ? [{ label: "unreferenced snapshots", path: hfDir, bytes: hfScan.unreferencedBytes, items: hfScan.unreferencedCount }]
        : []),
    ],
  });

  // 5. modelctl staging (non-resumable only)
  let staging: HygieneCategoryAudit = {
    category: "modelctl-staging",
    safe: false,
    rationale: ctx.nasRoot ? "Non-resumable staging data under the NAS store root." : "No NAS store root on this node.",
    itemCount: 0,
    reclaimableBytes: 0,
    details: [],
  };
  if (ctx.nasRoot && ctx.modelctlPath && existsSync(ctx.modelctlPath)) {
    const audit = await execFileAsync(ctx.modelctlPath, ["staging-audit", "--json", "--root", ctx.nasRoot], { encoding: "utf8", timeout: 120_000 }).catch(() => null);
    if (audit) {
      try {
        staging = stagingAuditToCategory(JSON.parse(audit.stdout) as StagingEntry[]);
        staging.rationale = "Non-resumable staging data under the NAS store root; resumable and journal-referenced entries are protected.";
      } catch {
        staging.itemCount = 0;
        staging.reclaimableBytes = 0;
      }
    }
  }
  categories.push(staging);

  // 6. compiler/pkg caches
  let compilerBytes = 0;
  const compilerDetails: HygieneDetail[] = [];
  for (const dir of COMPILER_CACHE_DIRS) {
    const p = join(home, dir);
    if (!existsSync(p)) continue;
    const bytes = await walkBytes(p);
    compilerBytes += bytes;
    compilerDetails.push({ label: dir, path: p, bytes, items: 1 });
  }
  categories.push({
    category: "compiler-caches",
    safe: true,
    rationale: "vllm/torch/triton compile caches and the CUDA ComputeCache — rebuilt on demand.",
    itemCount: compilerDetails.length,
    reclaimableBytes: compilerBytes,
    details: capDetails(compilerDetails),
  });

  // 7. apt/pkg caches
  const aptDir = "/var/cache/apt";
  const aptBytes = existsSync(aptDir) ? await walkBytes(aptDir) : 0;
  categories.push({
    category: "apt-caches",
    safe: true,
    rationale: existsSync(aptDir) ? "apt-get clean + autoremove — package archives and orphaned deps only." : "No apt cache on this platform.",
    itemCount: existsSync(aptDir) ? 1 : 0,
    reclaimableBytes: aptBytes,
    details: existsSync(aptDir) ? [{ label: "package archives", path: aptDir, bytes: aptBytes, items: 1 }] : [],
  });

  // 8. system junk: journal, /tmp > 7d, cores, old snap revisions
  let junkBytes = 0;
  const junkDetails: HygieneDetail[] = [];
  const journal = await execFileAsync("journalctl", ["--disk-usage"], { encoding: "utf8", timeout: 30_000 }).catch(() => null);
  if (journal) {
    const m = /archive and latest ([\d.]+)\s*([GMTKB])/.exec(journal.stdout) ?? /([\d.]+)\s*([GMTKB])/.exec(journal.stdout);
    const journalBytes = m ? parseDockerSize(`${m[1]}${m[2]!.toUpperCase() === "K" ? "kB" : m[2]}`) : 0;
    junkBytes += journalBytes;
    junkDetails.push({ label: "journal", path: null, bytes: journalBytes, items: 1 });
  }
  const tmpEntries = await safeReaddir("/tmp");
  const nowMs = now;
  let tmpBytes = 0;
  let tmpCount = 0;
  for (const entry of tmpEntries) {
    const st = await safeStat(join("/tmp", entry.name));
    if (st === null) continue;
    if (nowMs - st.mtimeMs < 24 * 3_600_000) continue; // <24 h protected
    if (nowMs - st.mtimeMs > 7 * 86_400_000) {
      tmpCount += 1;
      tmpBytes += st.isDir ? await walkBytes(join("/tmp", entry.name)) : st.size;
    }
  }
  if (tmpCount > 0) {
    junkBytes += tmpBytes;
    junkDetails.push({ label: "/tmp older than 7 d", path: "/tmp", bytes: tmpBytes, items: tmpCount });
  }
  for (const coreDir of ["/var/crash", "/var/lib/apport/coredump"]) {
    if (!existsSync(coreDir)) continue;
    const bytes = await walkBytes(coreDir);
    junkBytes += bytes;
    junkDetails.push({ label: coreDir, path: coreDir, bytes, items: 1 });
  }
  categories.push({
    category: "system-junk",
    safe: true,
    rationale: "Journal vacuum, /tmp older than 7 d, core dumps. Files modified <24 h are protected.",
    itemCount: junkDetails.reduce((sum, detail) => sum + detail.items, 0),
    reclaimableBytes: junkBytes,
    details: capDetails(junkDetails),
  });

  // Disk usage (statvfs via df — portable enough for Linux agents).
  const df = await execFileAsync("df", ["-kB", "/"], { encoding: "utf8", timeout: 15_000 }).catch(() => null);
  let totalBytes: number | null = null;
  let freeBytes: number | null = null;
  if (df) {
    const m = /\s(\d+)\s+(\d+)\s+(\d+)\s+\d+%/.exec(df.stdout);
    if (m) {
      totalBytes = Number(m[1]) * 1024;
      freeBytes = Number(m[3]) * 1024;
    }
  }

  return { generatedAtMs: now, totalBytes, freeBytes, categories };
}

// ─── clean ──────────────────────────────────────────────────────────────────

/** Armed per-category clean. A failing category flips to failed and the rest
 *  continue. `signal` cancels between categories (and awaits inside long
 *  child processes via their own timeouts). */
export async function cleanHygiene(
  params: HygieneCleanParams,
  ctx: HygieneCtx,
  emit: (line: string) => void,
  signal?: AbortSignal,
): Promise<HygieneCleanResult> {
  const startedAtMs = (ctx.now ?? Date.now)();
  const dockerAvailable = await hasDocker();
  const protectedSet = await buildProtectedSet({ nasRoot: ctx.nasRoot, modelctlPath: ctx.modelctlPath, dockerAvailable });
  const outcomes: HygieneCleanOutcome[] = [];

  for (const category of params.categories) {
    if (signal?.aborted) {
      outcomes.push({ category, status: "held", bytesReclaimed: 0, itemsRemoved: 0, error: "canceled before start" });
      continue;
    }
    try {
      outcomes.push(await cleanCategory(category, { dockerAvailable, protectedSet, ctx, emit, dryRun: params.dryRun }));
    } catch (err) {
      outcomes.push({
        category,
        status: "failed",
        bytesReclaimed: 0,
        itemsRemoved: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { startedAtMs, finishedAtMs: (ctx.now ?? Date.now)(), dryRun: params.dryRun, outcomes };
}

async function cleanCategory(
  category: HygieneCategory,
  env: {
    dockerAvailable: boolean;
    protectedSet: ProtectedSet;
    ctx: HygieneCtx;
    emit: (line: string) => void;
    dryRun: boolean;
  },
): Promise<HygieneCleanOutcome> {
  const { emit, dryRun } = env;
  const run = async (argv: string[], timeoutMs = 600_000): Promise<string> => {
    emit(`$ ${argv.join(" ")}`);
    if (dryRun) return "";
    const out = await execFileAsync(argv[0]!, argv.slice(1), { encoding: "utf8", timeout: timeoutMs });
    return out.stdout;
  };

  switch (category) {
    case "docker-build-cache": {
      if (!env.dockerAvailable) return skip(category, "docker CLI not available");
      await run(["docker", "builder", "prune", "-f"]);
      const df = await dockerSystemDf();
      return { category, status: "cleaned", bytesReclaimed: df.find((r) => r.type === "Build Cache")?.reclaimableBytes ?? 0, itemsRemoved: 1, error: null };
    }
    case "docker-containers": {
      if (!env.dockerAvailable) return skip(category, "docker CLI not available");
      await run(["docker", "container", "prune", "-f"]);
      const stopped = await execFileAsync("docker", ["ps", "-aq", "--filter", "status=exited", "--filter", "status=created"], { encoding: "utf8", timeout: 30_000 }).catch(() => null);
      return { category, status: "cleaned", bytesReclaimed: 0, itemsRemoved: stopped ? stopped.stdout.split("\n").filter((l) => l.trim()).length : 0, error: null };
    }
    case "docker-images": {
      if (!env.dockerAvailable) return skip(category, "docker CLI not available");
      const images = await execFileAsync("docker", ["images", "--format", "{{.Repository}}\t{{.Tag}}\t{{.ID}}\t{{.Size}}\t{{.CreatedSince}}"], { encoding: "utf8", timeout: 30_000 });
      const old = selectOldImages(parseDockerImages(images.stdout), 2, env.protectedSet.imageIds);
      let removed = 0;
      let bytes = 0;
      for (const image of old) {
        emit(`$ docker rmi ${image.id} (${image.repository}:${image.tag})`);
        if (dryRun) {
          removed += 1;
          bytes += image.sizeBytes;
          continue;
        }
        const res = await execFileAsync("docker", ["rmi", image.id], { encoding: "utf8", timeout: 120_000 }).catch(() => null);
        if (res) {
          removed += 1;
          bytes += image.sizeBytes;
        } else {
          emit(`docker rmi ${image.id} failed — leaving in place`);
        }
      }
      return { category, status: "cleaned", bytesReclaimed: bytes, itemsRemoved: removed, error: null };
    }
    case "hf-cache": {
      const hfDir = process.env.HF_HOME ?? join(homedir(), ".cache", "huggingface");
      if (!existsSync(hfDir)) return skip(category, "no HF cache on this node");
      const scan = await scanHfCache(hfDir, env.protectedSet.prefixes);
      if (!dryRun) {
        // Remove *.incomplete blobs and unreferenced snapshot dirs (protected
        // prefixes were excluded from the scan itself).
        const rm = async (p: string) => {
          emit(`$ rm -rf ${p}`);
          await execFileAsync("rm", ["-rf", p], { timeout: 120_000 });
        };
        const blobsDir = join(existsSync(join(hfDir, "hub")) ? join(hfDir, "hub") : hfDir, "blobs");
        for (const entry of await safeReaddir(blobsDir)) {
          if (entry.name.endsWith(".incomplete")) await rm(join(blobsDir, entry.name));
        }
        const hubRoot = existsSync(join(hfDir, "hub")) ? join(hfDir, "hub") : hfDir;
        for (const model of await safeReaddir(hubRoot)) {
          if (!model.isDirectory() || !model.name.startsWith("models--")) continue;
          const modelDir = join(hubRoot, model.name);
          if ([...env.protectedSet.prefixes].some((p) => modelDir === p || modelDir.startsWith(p + "/"))) continue;
          const refsDir = join(modelDir, "refs");
          const referenced = new Set<string>();
          for (const ref of await safeReaddir(refsDir)) {
            const content = await readFile(join(refsDir, ref.name), "utf8").catch(() => null);
            const hash = content?.trim().split(/\s+/)[0];
            if (hash && /^[0-9a-f]{40}$/.test(hash)) referenced.add(hash);
          }
          const snapshotsDir = join(modelDir, "snapshots");
          for (const snap of await safeReaddir(snapshotsDir)) {
            if (snap.isDirectory() && !referenced.has(snap.name)) await rm(join(snapshotsDir, snap.name));
          }
        }
      }
      return {
        category,
        status: "cleaned",
        bytesReclaimed: scan.incompleteBytes + scan.unreferencedBytes,
        itemsRemoved: scan.incompleteCount + scan.unreferencedCount,
        error: null,
      };
    }
    case "modelctl-staging": {
      const root = env.ctx.nasRoot;
      const modelctl = env.ctx.modelctlPath;
      if (!root || !modelctl || !existsSync(modelctl)) return skip(category, "no NAS store root / modelctl on this node");
      const audit = await execFileAsync(modelctl, ["staging-audit", "--json", "--root", root], { encoding: "utf8", timeout: 120_000 });
      const entries = selectCleanableStaging(JSON.parse(audit.stdout) as StagingEntry[]);
      if (entries.length === 0) return { category, status: "cleaned", bytesReclaimed: 0, itemsRemoved: 0, error: null };
      const bytes = entries.reduce((sum, e) => sum + (Number.isFinite(e.bytes) ? e.bytes : 0), 0);
      if (dryRun) return { category, status: "skipped", bytesReclaimed: bytes, itemsRemoved: entries.length, error: null };
      // Deletion goes through modelctl (its journal decides resumability) —
      // never raw rm against the NAS store.
      const argv = [modelctl, "cleanup-staging", ...entries.map((e) => e.path), "--apply", "--root", root];
      emit(`$ ${argv.join(" ")}`);
      await execFileAsync(modelctl, ["cleanup-staging", ...entries.map((e) => e.path), "--apply", "--root", root], { timeout: 1_800_000 });
      return { category, status: "cleaned", bytesReclaimed: bytes, itemsRemoved: entries.length, error: null };
    }
    case "compiler-caches": {
      let bytes = 0;
      let count = 0;
      for (const dir of COMPILER_CACHE_DIRS) {
        const p = join(homedir(), dir);
        if (!existsSync(p)) continue;
        if (isProtected(p, env.protectedSet.prefixes)) continue; // open by an engine
        bytes += await walkBytes(p);
        count += 1;
        if (!dryRun) {
          emit(`$ rm -rf ${p}/*`);
          await execFileAsync("find", [p, "-mindepth", "1", "-maxdepth", "1", "-exec", "rm", "-rf", "{}", "+"], { timeout: 300_000 });
        }
      }
      if (count === 0) return skip(category, "no compiler caches on this node");
      return { category, status: "cleaned", bytesReclaimed: bytes, itemsRemoved: count, error: null };
    }
    case "apt-caches": {
      if (!existsSync("/var/cache/apt")) return skip(category, "no apt cache on this platform");
      const bytes = await walkBytes("/var/cache/apt");
      if (!dryRun) {
        await run(["apt-get", "clean"]);
        await run(["apt-get", "autoremove", "--assume-yes"], 900_000);
      }
      return { category, status: "cleaned", bytesReclaimed: bytes, itemsRemoved: 1, error: null };
    }
    case "system-junk": {
      let bytes = 0;
      let count = 0;
      if (!dryRun) await run(["journalctl", "--vacuum-time=14d"], 300_000).catch(() => "");
      const journal = await execFileAsync("journalctl", ["--disk-usage"], { encoding: "utf8", timeout: 30_000 }).catch(() => null);
      if (journal) {
        const m = /([\d.]+)\s*([GMTKB])/.exec(journal.stdout);
        if (m) bytes += parseDockerSize(`${m[1]}${m[2]!.toUpperCase() === "K" ? "kB" : m[2]}`);
        count += 1;
      }
      // /tmp > 7d (24 h rule enforced inside), cores.
      const tmpEntries = await safeReaddir("/tmp");
      const now = Date.now();
      for (const entry of tmpEntries) {
        const p = join("/tmp", entry.name);
        const st = await safeStat(p);
        if (st === null) continue;
        if (now - st.mtimeMs < 24 * 3_600_000) continue;
        if (now - st.mtimeMs < 7 * 86_400_000) continue;
        if (isProtected(p, env.protectedSet.prefixes)) continue; // open by a process
        bytes += st.isDir ? await walkBytes(p) : st.size;
        count += 1;
        if (!dryRun) await execFileAsync("rm", ["-rf", p], { timeout: 120_000 });
      }
      for (const coreDir of ["/var/crash", "/var/lib/apport/coredump"]) {
        if (!existsSync(coreDir)) continue;
        bytes += await walkBytes(coreDir);
        count += 1;
        if (!dryRun) await execFileAsync("find", [coreDir, "-mindepth", "1", "-maxdepth", "1", "-exec", "rm", "-rf", "{}", "+"], { timeout: 120_000 });
      }
      return { category, status: "cleaned", bytesReclaimed: bytes, itemsRemoved: count, error: null };
    }
  }
}

function skip(category: HygieneCategory, reason: string): HygieneCleanOutcome {
  return { category, status: "skipped", bytesReclaimed: 0, itemsRemoved: 0, error: reason };
}

/** True when `path` is the protected set itself or lives under a protected prefix. */
export function isProtected(path: string, prefixes: ReadonlySet<string>): boolean {
  for (const prefix of prefixes) {
    if (path === prefix || path.startsWith(prefix + "/")) return true;
  }
  return false;
}

// ─── prevention ─────────────────────────────────────────────────────────────

/**
 * Opt-in prevention (SPEC §11.6): merge docker log rotation into
 * /etc/docker/daemon.json. Docker is NOT restarted — the agent may live in a
 * container on the same daemon; the operator applies with a restart, and the
 * job output says so.
 */
export async function applyDockerLogRotation(
  emit: (line: string) => void,
): Promise<{ changed: boolean; path: string; error: string | null }> {
  const path = "/etc/docker/daemon.json";
  let doc: Record<string, unknown> = {};
  const existing = await readFile(path, "utf8").catch(() => null);
  if (existing !== null) {
    try {
      const parsed: unknown = JSON.parse(existing);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) doc = parsed as Record<string, unknown>;
    } catch {
      return { changed: false, path, error: "existing daemon.json is not valid JSON — refusing to overwrite" };
    }
  }
  const before = JSON.stringify(doc);
  doc["log-driver"] = "json-file";
  doc["log-opts"] = { "max-size": "10m", "max-file": "3" };
  if (JSON.stringify(doc) === before) {
    emit(`$ ${path} already configures log rotation — nothing to do`);
    return { changed: false, path, error: null };
  }
  if (existing !== null) {
    emit(`$ backing up ${path} → ${path}.irori-backup`);
    await writeFile(path + ".irori-backup", existing, "utf8");
  }
  emit(`$ writing ${path} (log-driver json-file, max-size 10m, max-file 3)`);
  await writeFile(path, JSON.stringify(doc, null, 2) + "\n", "utf8");
  emit("restart docker to apply (systemctl restart docker) — not done automatically: the agent may run on this daemon");
  return { changed: true, path, error: null };
}

// ─── small helpers ──────────────────────────────────────────────────────────

async function hasDocker(): Promise<boolean> {
  const out = await execFileAsync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8", timeout: 15_000 }).catch(() => null);
  return out !== null;
}

async function dockerSystemDf(): Promise<DockerDfRow[]> {
  const out = await execFileAsync("docker", ["system", "df", "--format", "{{.Type}}\t{{.Size}}\t{{.Reclaimable}}"], { encoding: "utf8", timeout: 60_000 }).catch(() => null);
  return out ? parseDockerDf(out.stdout) : [];
}

type DirEntry = Dirent;

async function safeReaddir(dir: string): Promise<DirEntry[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function safeStat(p: string): Promise<{ size: number; mtimeMs: number; isDir: boolean } | null> {
  try {
    const st = await stat(p);
    return { size: st.size, mtimeMs: st.mtimeMs, isDir: st.isDirectory() };
  } catch {
    return null;
  }
}

async function safeRealpath(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return resolve(p);
  }
}

async function walkBytes(path: string): Promise<number> {
  const dirents = await readdir(path, { withFileTypes: true }).catch(() => null);
  if (dirents === null) return 0;
  let total = 0;
  for (const entry of dirents) {
    const child = join(path, entry.name);
    try {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) total += await walkBytes(child);
      else total += (await stat(child)).size;
    } catch {
      // unreadable entries contribute nothing
    }
  }
  return total;
}

/** Label for UI output lines. */
export function hygieneCategoryLabel(category: HygieneCategory): string {
  return HYGIENE_CATEGORY_LABELS[category];
}
