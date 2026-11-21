import {
  hfModelInfoSchema,
  type HfDraftKind,
  type HfFile,
  type HfQuantGroup,
  type HfQuantsResult,
  HfQuantsError,
} from "@irori/core";
import type { CardHintsService } from "./hf-card-hints.js";

export { HfQuantsError };

/**
 * IRI-016: HF repo GGUF quantization listing for the download modal's
 * "Expand quants" flow. Read-only: fetches the repo file list from the
 * public HF API and groups model GGUFs exactly like modelctl's `_gguf_groups`
 * (shard regex, mmproj/MTP exclusions, (dir, base, count) keys), plus the
 * companion candidates modelctl's `_select_mmproj`/`_select_mtp` would
 * consider. The grouping port is pinned by fixture tests built from the real
 * unsloth/flint-GGUF and unsloth/gemma-4-31B-it-GGUF file lists, and (IRI-152)
 * Inkling-2-Mini (dspark), unsloth + bartowski gemma-4-26B (multi-draft,
 * imatrix). Draft rules mirror modelctl `drafts.py`.
 */

const SHARD_RE = /^(.+)-(\d{5})-of-(\d{5})\.gguf$/i;

const isGguf = (p: string): boolean => p.toLowerCase().endsWith(".gguf");
const baseName = (p: string): string => p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1);
const parentDir = (p: string): string => {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
};

// IRI-152 (modelctl drafts.py): longest prefix first so `dflash2-` never reads as `dflash`.
const DRAFT_PREFIXES: ReadonlyArray<readonly [string, HfDraftKind]> = [
  ["dflash2-", "dflash2"],
  ["dflash-", "dflash"],
  ["dspark-", "dspark"],
  ["mtp-", "mtp"],
];
const DRAFT_DIRS: ReadonlySet<string> = new Set<HfDraftKind>(["mtp", "dspark", "dflash", "dflash2"]);
const Q8_0_RE = /(?:^|[-_.])q8_0(?:[-_.]|$)/;

/** Mirrors modelctl `draft_kind`: basename prefix, else the nearest draft-named parent dir. */
export function draftKind(path: string): HfDraftKind | null {
  if (!isGguf(path)) return null;
  const base = baseName(path).toLowerCase();
  for (const [prefix, kind] of DRAFT_PREFIXES) if (base.startsWith(prefix)) return kind;
  const parts = parentDir(path).split("/").reverse();
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (DRAFT_DIRS.has(lower)) return lower as HfDraftKind;
  }
  return null;
}

export function isDraftArtifact(path: string): boolean {
  return draftKind(path) !== null;
}

/** Importance-matrix calibration data some repos ship as `*.gguf` (modelctl `is_imatrix_artifact`). */
export function isImatrixArtifact(path: string): boolean {
  return baseName(path).toLowerCase().includes("imatrix");
}

export function isMmprojArtifact(path: string): boolean {
  return isGguf(path) && baseName(path).toLowerCase().startsWith("mmproj");
}

/** Never a quantization group: projectors, drafts, imatrix calibration files. */
function isQuantExcluded(path: string): boolean {
  return isMmprojArtifact(path) || isDraftArtifact(path) || isImatrixArtifact(path);
}

interface RawGroup {
  dir: string;
  base: string;
  count: number | null;
  files: HfFile[];
}

function sumBytes(files: HfFile[]): number | null {
  return files.some((f) => f.bytes === null) ? null : files.reduce((acc, f) => acc + (f.bytes ?? 0), 0);
}

function companionInfo(
  candidates: HfFile[],
  preferF16: ((stem: string) => boolean) | null,
): HfQuantsResult["companions"]["mmproj"] {
  const list = candidates
    .map((f) => (preferF16 === null ? { path: f.path, bytes: f.bytes, kind: draftKind(f.path) } : { path: f.path, bytes: f.bytes }))
    .sort((a, b) => a.path.localeCompare(b.path));
  let fallback: string | null = null;
  if (preferF16 !== null) {
    const f16 = list.filter((c) => preferF16(baseName(c.path).replace(/\.gguf$/i, "")));
    if (f16.length === 1) fallback = f16[0]!.path;
  } else {
    // modelctl `_select_mtp`: the single ROOT-LEVEL draft is the default;
    // among several root drafts, the single Q8_0 one (IRI-152).
    const root = list.filter((c) => parentDir(c.path) === "");
    if (root.length === 1) fallback = root[0]!.path;
    else if (root.length > 1) {
      const q8 = root.filter((c) => Q8_0_RE.test(baseName(c.path).replace(/\.gguf$/i, "").toLowerCase()));
      if (q8.length === 1) fallback = q8[0]!.path;
    }
  }
  // modelctl `_select_artifact`: a lone candidate is always auto-selected,
  // even nested or non-f16 (IR-266 review F3).
  if (fallback === null && list.length === 1) fallback = list[0]!.path;
  return { candidates: list, default: fallback };
}

/**
 * Groups model GGUFs the way modelctl does and derives, per group, a
 * case-insensitively unique substring needle for --quantization (modelctl
 * matches `needle in basename.lower()`). Incomplete shard sets throw, mirroring
 * modelctl's ManifestError.
 */
export function groupRepoFiles(repo: string, files: HfFile[]): HfQuantsResult {
  const ggufs = files.filter((f) => isGguf(f.path));
  const groups: RawGroup[] = [];
  const byKey = new Map<string, RawGroup>();
  for (const file of ggufs) {
    if (isQuantExcluded(file.path)) continue;
    const dir = parentDir(file.path);
    const base = baseName(file.path);
    const shard = SHARD_RE.exec(base);
    if (shard) {
      const key = `${dir}/${shard[1]!.toLowerCase()}/${shard[3]}`;
      let group = byKey.get(key);
      if (!group) {
        group = { dir, base: shard[1]!, count: Number(shard[3]), files: [] };
        byKey.set(key, group);
        groups.push(group);
      }
      group.files.push(file);
    } else {
      groups.push({ dir, base, count: null, files: [file] });
    }
  }
  for (const group of byKey.values()) {
    const missing: string[] = [];
    const seen = new Set(group.files.map((f) => SHARD_RE.exec(baseName(f.path))![2]));
    for (let i = 1; i <= group.count!; i += 1) {
      if (!seen.has(String(i).padStart(5, "0"))) missing.push(String(i).padStart(5, "0"));
    }
    if (missing.length > 0) {
      throw new HfQuantsError(
        `incomplete GGUF shard group in ${repo}: missing ${missing.join(", ")}`,
        502,
      );
    }
    group.files.sort((a, b) => a.path.localeCompare(b.path));
  }

  // Needle: the last dash-separated token of the shard-stripped stem, widened
  // with earlier tokens while it also matches another group's basenames.
  const stems = groups.map((group) => {
    const base = baseName(group.files[0]!.path);
    const stem = (SHARD_RE.exec(base)?.[1] ?? base).replace(/\.gguf$/i, "");
    return { group, tokens: stem.split("-") };
  });
  const otherBasenames = (except: RawGroup): string[] =>
    ggufs
      .filter((f) => !isQuantExcluded(f.path))
      .filter((f) => !except.files.some((g) => g.path === f.path))
      .map((f) => baseName(f.path).toLowerCase());

  const quants: HfQuantGroup[] = stems.map(({ group, tokens }) => {
    const others = otherBasenames(group);
    // Shards share the stem, so every own basename contains any stem suffix.
    const own = group.files.map((f) => baseName(f.path).toLowerCase());
    let needle = "";
    for (let i = tokens.length - 1; i >= 0; i -= 1) {
      needle = `${tokens[i]}${needle.length > 0 ? `-${needle}` : ""}`;
      const matchesOwn = own.every((name) => name.includes(needle.toLowerCase()));
      const clash = others.some((name) => name.includes(needle.toLowerCase()));
      if (matchesOwn && !clash) break;
    }
    return {
      tag: needle,
      files: group.files.map((f) => f.path),
      sharded: group.count !== null,
      shards: group.count,
      bytes: sumBytes(group.files),
      // The full stem is the widest modelctl-valid needle; if even that is
      // ambiguous (same basename in two dirs) or matches nothing of its own,
      // modelctl would refuse or mis-select — flag the row instead.
      ambiguous: needle.length === 0 || !own.every((name) => name.includes(needle.toLowerCase())) || others.some((name) => name.includes(needle.toLowerCase())),
    };
  });

  return {
    repo,
    modelCard: files.some((f) => f.path === "README.md") ? "README.md" : null,
    quants,
    companions: {
      mmproj: companionInfo(
        files.filter((f) => isMmprojArtifact(f.path)),
        (stem) => /(?:^|[-_.])f16(?:[-_.]|$)/.test(stem.toLowerCase()),
      ),
      mtp: companionInfo(files.filter((f) => isDraftArtifact(f.path)), null),
    },
  };
}

export interface HfQuantsService {
  /** `token` (IRI-019): global HF token — sent as Bearer only when configured. */
  listQuants(repo: string, token?: string | null): Promise<HfQuantsResult>;
}

const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,94}\/[A-Za-z0-9][A-Za-z0-9._-]{0,94}$/;

export function createHfQuantsService(
  /** IRI-153: `hints` adds README/doc run hints to GGUF listings; omitted = no hints (tests, degraded). */
  opts: { fetchImpl?: typeof fetch; hfBase?: string; hints?: CardHintsService } = {},
): HfQuantsService {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const hfBase = opts.hfBase ?? "https://huggingface.co";
  return {
    async listQuants(repo, token) {
      if (!REPO_RE.test(repo) || repo.includes("..")) {
        throw new HfQuantsError("invalid repository id (expected owner/model)", 400);
      }
      // IRI-019: gated/private repos authenticate via the global token when
      // one is configured; tokenless requests are byte-identical to before.
      const headers: Record<string, string> = { accept: "application/json" };
      if (token !== undefined && token !== null && token.length > 0) {
        // Header values reject NUL/CR/LF — undici's TypeError would embed the
        // token into the 502 body. Reject without echoing the value.
        if (/[\u0000\r\n]/.test(token)) throw new HfQuantsError("configured HF token contains invalid header characters", 500);
        headers.authorization = `Bearer ${token}`;
      }
      let res: Response;
      try {
        res = await fetchImpl(`${hfBase}/api/models/${repo}?blobs=true`, {
          headers,
          signal: AbortSignal.timeout(10_000),
        });
      } catch (err) {
        throw new HfQuantsError(
          `huggingface.co unreachable: ${err instanceof Error ? err.message : String(err)}`,
          502,
        );
      }
      if (res.status === 404 || res.status === 401 || res.status === 403) {
        throw new HfQuantsError("repository not found or not public", 404);
      }
      if (!res.ok) {
        throw new HfQuantsError(`huggingface.co answered ${res.status}`, 502);
      }
      const parsed = hfModelInfoSchema.safeParse(await res.json());
      if (!parsed.success) {
        throw new HfQuantsError("huggingface.co response had no usable file list", 502);
      }
      const files: HfFile[] = parsed.data.siblings.map((s) => ({
        path: s.rfilename,
        bytes: typeof s.size === "number" && s.size > 0 ? s.size : null,
      }));
      if (files.length === 0) {
        throw new HfQuantsError(`repository ${repo} exposed no files`, 502);
      }
      const result = groupRepoFiles(repo, files);
      if (opts.hints === undefined || result.quants.length === 0) return result;
      // Best effort by contract: the hints service never throws.
      return { ...result, hints: await opts.hints.hints(repo, parsed.data.sha ?? "main", files, token) };
    },
  };
}
