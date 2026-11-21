import { DRAFT_SPEC_TYPE_RE, type HfFile, type HfRunHints } from "@irori/core";

/**
 * IRI-153 (ADR-0020): best-effort run hints for the download modal. Reads
 * `llama-server`/`llama-cli` invocations from the repo README and, when the
 * README has none, from at most a few README links on an exact-host allowlist
 * (Inkling-2-Mini's command lives only on unsloth.ai/docs). A hint is kept
 * only when it names a file in the repo's own listing — hints preselect, they
 * never add files — and nothing here can fail the quant listing.
 */

/** Exact hostnames doc links may point at (override: IRORI_HF_DOC_HOSTS, comma-separated; empty disables). */
export const DEFAULT_DOC_HOSTS: readonly string[] = ["huggingface.co", "unsloth.ai", "docs.unsloth.ai"];

const MAX_DOC_LINKS = 3;
const MAX_REDIRECTS = 2;
const FETCH_TIMEOUT_MS = 5_000;
/** The Inkling docs page is 1.43 MiB with its first snippet ~490 KiB in. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const TEXT_TYPES = ["text/html", "text/markdown", "text/plain", "text/x-markdown"];
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 100;
/** One budget for a whole hints computation (README + every doc hop), on top of the per-hop timeout. */
const TOTAL_BUDGET_MS = 10_000;
/** Marks the end of a code block (closing pre/code tag or markdown fence); invocations never span it. */
const BLOCK_END = "\u0001";

const INVOCATION_RE = /llama-(?:server|cli|mtmd-cli)\b/g;
const INVOCATION_WINDOW = 4_000;
/** A flag's value: one shell word, stopping at quotes, continuations and markup. */
const VALUE = String.raw`([^\s\\\x60"'<>(),;]+)`;
const flagRe = (flag: string): RegExp => new RegExp(String.raw`(?:^|\s)${flag}(?:\s+|=)${VALUE}`);
/** Compiled once (a 2 MiB page can hold ~160k invocations). Non-global: exec has no lastIndex state. */
const FLAGS = {
  model: flagRe("(?:--model|-m)"),
  mmproj: flagRe("--mmproj"),
  draft: flagRe("(?:--model-draft|-md)"),
  specType: flagRe("--spec-type"),
} as const;

export interface RunInvocation {
  model?: string;
  mmproj?: string;
  draft?: string;
  specType?: string;
}

const firstMatch = (segment: string, re: RegExp): string | undefined => re.exec(segment)?.[1];

/**
 * Normalises README markdown or a docs HTML page into searchable text.
 * Every pattern here is linear on adversarial input (README text is
 * repo-author controlled): tag patterns use `[^<>]*`, so a run of `<`
 * without `>` can't backtrack quadratically (IR-267 review F1).
 */
export function toSearchableText(raw: string): string {
  return (
    raw
      // Next.js/GitBook pages also embed the code as JSON-escaped strings.
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, '"')
      .replace(/<\/(?:pre|code)\s*>/gi, `\n${BLOCK_END}\n`)
      .replace(/^[ \t]*(?:```|~~~)[^\n]*$/gm, BLOCK_END)
      .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h\d)\b[^<>]*>/gi, "\n")
      .replace(/<[^<>]*>/g, "")
      .replace(/&(?:quot|#34);/g, '"')
      .replace(/&(?:#39|#x27|apos);/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
  );
}

/** Pure: every llama.cpp invocation's companion flags, in document order. */
export function parseRunHints(raw: string): RunInvocation[] {
  const text = toSearchableText(raw);
  const starts = [...text.matchAll(INVOCATION_RE)].map((m) => m.index);
  // Block ends found once and walked with one pointer: linear overall.
  const blockEnds: number[] = [];
  for (let i = text.indexOf(BLOCK_END); i !== -1; i = text.indexOf(BLOCK_END, i + 1)) blockEnds.push(i);
  let b = 0;
  return starts.map((start, i) => {
    while (b < blockEnds.length && blockEnds[b]! < start) b += 1;
    const blockEnd = blockEnds[b] ?? text.length;
    const end = Math.min(starts[i + 1] ?? text.length, start + INVOCATION_WINDOW, blockEnd);
    const segment = text.slice(start, end);
    const inv: RunInvocation = {};
    const model = firstMatch(segment, FLAGS.model);
    const mmproj = firstMatch(segment, FLAGS.mmproj);
    const draft = firstMatch(segment, FLAGS.draft);
    const specType = firstMatch(segment, FLAGS.specType);
    if (model !== undefined) inv.model = model;
    if (mmproj !== undefined) inv.mmproj = mmproj;
    if (draft !== undefined) inv.draft = draft;
    if (specType !== undefined) inv.specType = specType;
    return inv;
  });
}

const baseName = (p: string): string => p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1);

/**
 * Maps a snippet path (`Inkling-2-Mini-GGUF/dspark-…-Q8_0.gguf`, a local
 * download dir prefix, …) to exactly one repo file: the longest repo-path
 * suffix match, else a unique case-insensitive basename. Anything else → null.
 * A path naming ANOTHER GGUF repo directory (`gemma-4-31B-it-GGUF/…` while
 * listing the 26B repo — multi-model docs pages) is rejected, not basename-matched.
 */
export function resolveHint(value: string | undefined, files: readonly HfFile[], repo?: string): string | null {
  if (value === undefined) return null;
  const v = value.replace(/^\.\//, "").replace(/\\/g, "/").toLowerCase();
  if (!v.endsWith(".gguf")) return null;
  if (repo !== undefined) {
    const tail = (repo.split("/").pop() ?? repo).toLowerCase();
    const foreign = v
      .split("/")
      .slice(0, -1)
      .some((seg) => seg.endsWith("-gguf") && seg !== tail);
    if (foreign) return null;
  }
  const paths = files.map((f) => f.path);
  const suffix = paths.filter((p) => v === p.toLowerCase() || v.endsWith(`/${p.toLowerCase()}`));
  if (suffix.length > 0) {
    const longest = Math.max(...suffix.map((p) => p.length));
    const best = suffix.filter((p) => p.length === longest);
    return best.length === 1 ? best[0]! : null;
  }
  const base = baseName(v);
  const byBase = paths.filter((p) => baseName(p).toLowerCase() === base);
  return byBase.length === 1 ? byBase[0]! : null;
}

type Hints = Omit<HfRunHints, "error" | "url" | "source">;

/** First invocation whose draft or mmproj resolves; the spec type rides only with a resolved draft. */
export function pickHints(invocations: readonly RunInvocation[], files: readonly HfFile[], repo?: string): Hints | null {
  for (const inv of invocations) {
    const draft = resolveHint(inv.draft, files, repo);
    const mmproj = resolveHint(inv.mmproj, files, repo);
    if (draft === null && mmproj === null) continue;
    const specType =
      draft !== null && inv.specType !== undefined && DRAFT_SPEC_TYPE_RE.test(inv.specType) ? inv.specType : null;
    return { draft, mmproj, specType };
  }
  return null;
}

/** Parses the allowlist env; an explicitly empty value disables doc-host fetches. */
export function docHostsFromEnv(value: string | undefined): readonly string[] {
  if (value === undefined) return DEFAULT_DOC_HOSTS;
  return value
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
}

const IP_LITERAL_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:.]+\])$/i;

/** https, default port, no userinfo, no IP literal, exact allowlisted host. */
export function isAllowedDocUrl(raw: string, hosts: readonly string[]): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "") return null;
  const host = url.hostname.toLowerCase();
  if (IP_LITERAL_RE.test(host) || !hosts.includes(host)) return null;
  return url;
}

/** Bounded so a pathological run can't make one huge match (IR-267 review F1). */
const LINK_RE = /https:\/\/[^\s)\]"'<>]{1,2048}/g;
const TRAILING_PUNCT = new Set([".", ",", ";", ":"]);

/** Strips trailing sentence punctuation with a loop (a `[.,;:]+$` regex is quadratic on long runs). */
function trimTrailingPunct(value: string): string {
  let end = value.length;
  while (end > 0 && TRAILING_PUNCT.has(value[end - 1]!)) end -= 1;
  return value.slice(0, end);
}
const ASSET_RE = /\.(?:png|jpe?g|gif|svg|webp|ico|mp4)(?:$|\?)|\/~gitbook\/image/i;

/**
 * Candidate doc links from a README, allow-listed and deduped, ranked so the
 * page about THIS model (its slug in the path) comes first.
 */
export function docLinks(readme: string, repo: string, hosts: readonly string[]): URL[] {
  const slug = (repo.split("/").pop() ?? repo).replace(/-gguf$/i, "").toLowerCase();
  const seen = new Set<string>();
  const out: { url: URL; score: number; order: number }[] = [];
  for (const m of readme.matchAll(LINK_RE)) {
    const raw = trimTrailingPunct(m[0]);
    if (ASSET_RE.test(raw)) continue;
    const url = isAllowedDocUrl(raw, hosts);
    if (url === null) continue;
    url.hash = "";
    const key = url.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    // Same-repo HF pages (tree/blob) carry no run commands of their own.
    const path = url.pathname.toLowerCase();
    const own = `/${repo.toLowerCase()}`;
    if (url.hostname === "huggingface.co" && (path === own || path.startsWith(`${own}/`))) continue;
    out.push({ url, score: url.pathname.toLowerCase().includes(slug) ? 1 : 0, order: out.length });
  }
  return out
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, MAX_DOC_LINKS)
    .map((c) => c.url);
}

/** Streams at most `limit` bytes of a response body as UTF-8 text. */
async function readCapped(res: Response, limit: number): Promise<string> {
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = value.subarray(0, Math.min(value.byteLength, limit - total));
      chunks.push(take);
      total += take.byteLength;
    }
  } finally {
    // Not awaited: cancelling must never stall the listing.
    void reader.cancel().catch(() => undefined);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks));
}

/**
 * GET with manual redirects: every hop must satisfy `allow`. Credentials are
 * attached only by `headersFor` (never to a doc host). Non-text bodies refuse.
 */
async function guardedGet(
  fetchImpl: typeof fetch,
  start: URL,
  allow: (u: URL) => boolean,
  headersFor: (u: URL) => Record<string, string>,
  deadline: AbortSignal,
): Promise<{ text: string; url: URL }> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!allow(url)) throw new Error(`blocked host ${url.hostname}`);
    if (deadline.aborted) throw new Error("hints time budget exhausted");
    const res = await fetchImpl(url.toString(), {
      headers: { accept: "text/html, text/markdown, text/plain", ...headersFor(url) },
      redirect: "manual",
      // Per hop AND the shared budget; the signal also aborts the body read.
      signal: AbortSignal.any([deadline, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      void res.body?.cancel().catch(() => undefined);
      if (location === null) throw new Error(`redirect without location from ${url.hostname}`);
      url = new URL(location, url);
      continue;
    }
    if (!res.ok) {
      void res.body?.cancel().catch(() => undefined);
      throw new Error(`${url.hostname} answered ${res.status}`);
    }
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!TEXT_TYPES.includes(type)) {
      void res.body?.cancel().catch(() => undefined);
      throw new Error(`${url.hostname} served ${type || "no content type"}`);
    }
    return { text: await readCapped(res, MAX_BODY_BYTES), url };
  }
  throw new Error(`too many redirects from ${start.hostname}`);
}

export interface CardHintsOptions {
  fetchImpl?: typeof fetch;
  /** HF origin (tests point it at a fake). README fetches stay on this origin. */
  hfBase?: string;
  docHosts?: readonly string[];
  now?: () => number;
  /** Total time budget per computation (default 10s; tests shorten it). */
  budgetMs?: number;
}

export interface CardHintsService {
  hints(repo: string, revision: string, files: readonly HfFile[], token?: string | null): Promise<HfRunHints>;
}

const EMPTY: HfRunHints = { draft: null, mmproj: null, specType: null, source: null, url: null, error: null };

export function createCardHintsService(opts: CardHintsOptions = {}): CardHintsService {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const hfOrigin = new URL(opts.hfBase ?? "https://huggingface.co").origin;
  const docHosts = opts.docHosts ?? docHostsFromEnv(process.env.IRORI_HF_DOC_HOSTS);
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { at: number; value: HfRunHints }>();

  async function compute(repo: string, revision: string, files: readonly HfFile[], token?: string | null): Promise<HfRunHints> {
    if (!files.some((f) => f.path === "README.md")) return EMPTY;
    const deadline = AbortSignal.timeout(opts.budgetMs ?? TOTAL_BUDGET_MS);
    const repoUrl = `${hfOrigin}/${repo}`;
    const readmeUrl = new URL(`${repoUrl}/resolve/${encodeURIComponent(revision)}/README.md`);
    const auth: Record<string, string> =
      token !== undefined && token !== null && token.length > 0 && !/[\u0000\r\n]/.test(token) ? { authorization: `Bearer ${token}` } : {};
    let readme: string;
    try {
      // The README stays on the configured HF origin; the token never follows a redirect elsewhere.
      readme = (
        await guardedGet(
          fetchImpl,
          readmeUrl,
          (u) => u.origin === hfOrigin,
          (u) => (u.origin === hfOrigin ? auth : {}),
          deadline,
        )
      ).text;
    } catch (err) {
      return { ...EMPTY, error: `README unavailable: ${err instanceof Error ? err.message : String(err)}` };
    }
    const fromReadme = pickHints(parseRunHints(readme), files, repo);
    if (fromReadme?.draft != null) return { ...fromReadme, source: "readme", url: repoUrl, error: null };

    // README first, field by field (review F2): docs only fill what the README
    // left empty, and the search goes on until a page resolves a DRAFT.
    let docMmproj: { mmproj: string; url: string } | null = null;
    const errors: string[] = [];
    for (const link of docLinks(readme, repo, docHosts)) {
      try {
        const page = await guardedGet(fetchImpl, link, (u) => isAllowedDocUrl(u.toString(), docHosts) !== null, () => ({}), deadline);
        const found = pickHints(parseRunHints(page.text), files, repo);
        if (found === null) continue;
        if (found.draft !== null) {
          return {
            draft: found.draft,
            specType: found.specType,
            mmproj: fromReadme?.mmproj ?? found.mmproj,
            source: "docs",
            url: page.url.toString(),
            error: null,
          };
        }
        if (docMmproj === null && found.mmproj !== null) docMmproj = { mmproj: found.mmproj, url: page.url.toString() };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(deadline.aborted ? `${link.hostname}: hints time budget exhausted` : `${link.hostname}: ${message}`);
      }
    }
    // A partial result still carries doc failures, so it isn't cached (review R1).
    const docError = errors.length > 0 ? `docs unavailable: ${errors.join("; ")}` : null;
    if (fromReadme !== null) return { ...fromReadme, source: "readme", url: repoUrl, error: docError };
    if (docMmproj !== null) return { ...EMPTY, mmproj: docMmproj.mmproj, source: "docs", url: docMmproj.url, error: docError };
    return { ...EMPTY, error: docError };
  }

  return {
    async hints(repo, revision, files, token) {
      const key = `${repo}@${revision}`;
      const hit = cache.get(key);
      if (hit !== undefined && now() - hit.at < CACHE_TTL_MS) return hit.value;
      let value: HfRunHints;
      try {
        value = await compute(repo, revision, files, token);
      } catch (err) {
        value = { ...EMPTY, error: err instanceof Error ? err.message : String(err) };
      }
      // Failures are not cached (review F4): a fixed token or a recovered host applies on the next listing.
      if (value.error === null) {
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
        cache.set(key, { at: now(), value });
      }
      return value;
    },
  };
}
