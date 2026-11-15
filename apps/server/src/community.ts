import { desc, eq } from "drizzle-orm";
import { communityItems, communitySources, type Db } from "@irori/db";

/**
 * IRI-083: community intelligence. Pollers with conditional GET (etag),
 * per-source intervals + jitter, a shared UA, and a circuit breaker that
 * opens after N consecutive failures (warn-only chip, dead sources never
 * block). Third-party text is untrusted: sanitized to plain text. X posts
 * are identity-only (embedOnly) — bodies hydrate at view time per the
 * Developer Agreement; the allowlist is owner-config, never scraped.
 */

export const COMMUNITY_UA = "irori/0.3 (community poller)";
const BREAKER_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 30 * 60_000;

export interface CommunitySourceDef {
  source: string;
  url: string;
  kind: "forum-top" | "atom" | "feed";
  intervalMs: number;
}

export const COMMUNITY_SOURCES: CommunitySourceDef[] = [
  // IR-245: the category-scoped latest.json (sorted by bumped_at) replaced
  // the site-wide weekly Top — the top-50 contained zero GB10 topics, and
  // Top ranks by score, not last activity. Source id unchanged (the chip and
  // list derive from it; no DB migration).
  { source: "forum:gb10-top", url: "https://forums.developer.nvidia.com/c/accelerated-computing/dgx-spark-gb10/719/l/latest.json", kind: "forum-top", intervalMs: 3 * 3_600_000 },
  { source: "atom:sparkrun-releases", url: "https://github.com/spark-arena/sparkrun/releases.atom", kind: "atom", intervalMs: 6 * 3_600_000 },
  { source: "atom:sparkdash-releases", url: "https://github.com/MiaAI-Lab/sparkDash/releases.atom", kind: "atom", intervalMs: 6 * 3_600_000 },
  { source: "atom:tensorfold-releases", url: "https://github.com/ashhart/TensorFold/releases.atom", kind: "atom", intervalMs: 6 * 3_600_000 },
  { source: "atom:spark-vllm-releases", url: "https://github.com/eugr/spark-vllm-docker/releases.atom", kind: "atom", intervalMs: 6 * 3_600_000 },
  { source: "atom:recipe-registry-commits", url: "https://github.com/spark-arena/recipe-registry/commits/main.atom", kind: "atom", intervalMs: 3 * 3_600_000 },
  // IR-246: per-repo commit watch for the seeded MiaAI-Lab recipe repos (the
  // whole github.com/MiaAI-Lab.atom feed would flood Releases with ~50
  // HTML-gallery repos). These land in Releases + a chip automatically.
  { source: "atom:miaai-glm53-exl3-2x-tf", url: "https://github.com/MiaAI-Lab/GLM-5.3-Flash-EXL3-2x-DGX-Sparks-TensorFold/commits/main.atom", kind: "atom", intervalMs: 3 * 3_600_000 },
  { source: "atom:miaai-glm53-exl3-2x-vllm", url: "https://github.com/MiaAI-Lab/GLM-5.3-Flash-EXL3-2x-DGX-Sparks/commits/main.atom", kind: "atom", intervalMs: 3 * 3_600_000 },
  { source: "atom:miaai-dsv41-4x-tf", url: "https://github.com/MiaAI-Lab/DeepSeek-v4.1-Flash-1017-4x-DGX-Sparks-TensorFold/commits/main.atom", kind: "atom", intervalMs: 3 * 3_600_000 },
  { source: "atom:miaai-dsv41-3x-sglang", url: "https://github.com/MiaAI-Lab/DeepSeek-v4.1-Flash-DGX-Sparks/commits/main.atom", kind: "atom", intervalMs: 3 * 3_600_000 },
  { source: "atom:miaai-nemotron-bolt", url: "https://github.com/MiaAI-Lab/Nemotron-3.5-Bolt-TensorFold-DGX-Spark/commits/main.atom", kind: "atom", intervalMs: 3 * 3_600_000 },
  { source: "atom:miaai-qwen38-dual", url: "https://github.com/MiaAI-Lab/Qwen3.8-Flash-Next-Dual-DGX-Sparks/commits/main.atom", kind: "atom", intervalMs: 3 * 3_600_000 },
  // The pre-existing single-node TensorFold seed (miaai-qwen3.8-flash-next-single-tensorfold) gets its watcher too (IR-237 review).
  { source: "atom:miaai-qwen38-single", url: "https://github.com/MiaAI-Lab/Qwen3.8-Flash-Next-Single-DGX-Spark-TensorFold/commits/main.atom", kind: "atom", intervalMs: 3 * 3_600_000 },
  { source: "feed:nvidia-blog", url: "https://developer.nvidia.com/blog/tag/dgx-spark/feed/", kind: "feed", intervalMs: 12 * 3_600_000 },
];

/** Strip tags/entities — third-party text is untrusted input. */
export function sanitizeText(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

export interface CommunityItemInput {
  source: string;
  externalId: string;
  canonicalUrl: string;
  title: string;
  summary?: string | null;
  author?: string | null;
  publishedAt?: Date | null;
  score?: number | null;
  embedOnly?: boolean;
}

/** Discourse latest.json/top.json → items (filtered by the caller to the GB10 subtree).
 *  IR-245: the scoped endpoint lists subcategory topics tagged with their OWN
 *  category_id — 719 is the parent of 721 (GB10) and 723 (Projects). */
export function parseForumTop(json: string, source: string, categoryFilter?: number | number[]): CommunityItemInput[] {
  const allowed = categoryFilter === undefined ? undefined : new Set(Array.isArray(categoryFilter) ? categoryFilter : [categoryFilter]);
  let parsed: { topic_list?: { topics?: Array<{ id?: number; title?: string; slug?: string; posts_count?: number; like_count?: number; created_at?: string; bumped_at?: string; category_id?: number; posters?: Array<{ user_id?: number }> }> } };
  try {
    parsed = JSON.parse(json) as typeof parsed;
  } catch {
    return [];
  }
  const topics = parsed.topic_list?.topics ?? [];
  return topics
    .filter((t) => allowed === undefined || (t.category_id !== undefined && allowed.has(t.category_id)))
    .map((t) => {
      // IR-245: last ACTIVITY, not creation — a topic created weeks ago but
      // bumped 3 hours ago must pass the client's period filter.
      const activity = t.bumped_at ?? t.created_at;
      return {
        source,
        externalId: String(t.id ?? ""),
        canonicalUrl: `https://forums.developer.nvidia.com/t/${t.slug ?? t.id}/${t.id ?? ""}`,
        title: sanitizeText(t.title ?? ""),
        summary: null,
        author: null,
        publishedAt: activity === undefined ? null : new Date(activity),
        score: t.like_count ?? null,
        embedOnly: false,
      };
    })
    .filter((t) => t.externalId !== "" && t.title !== "");
}

/** Minimal Atom/RSS entry extraction (regex; XML parsers are a dep we skip). */
export function parseAtom(xml: string, source: string): CommunityItemInput[] {
  const entries: CommunityItemInput[] = [];
  const entryRe = /<(?:entry|item)>([\s\S]*?)<\/(?:entry|item)>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml)) !== null) {
    const body = m[1]!;
    const pick = (tag: string): string | null => {
      const mm = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(body);
      return mm === null ? null : mm[1]!.trim();
    };
    const id = pick("id") ?? pick("guid");
    const title = sanitizeText(pick("title") ?? "");
    let link = pick("link");
    if (link === null) {
      const lm = /<link[^>]*href="([^"]+)"/i.exec(body);
      link = lm === null ? null : lm[1]!;
    }
    if (id === null || title === "" || link === null) continue;
    // IR-237 review hardening: third-party feed links become :href in the
    // community view — only https URLs are accepted (all curated sources
    // are https; a compromised upstream cannot pivot to javascript:).
    if (!/^https:\/\//i.test(link)) continue;
    const updated = pick("updated") ?? pick("pubDate") ?? pick("published");
    entries.push({
      source,
      externalId: sanitizeText(id).slice(0, 300),
      canonicalUrl: sanitizeText(link),
      title,
      summary: sanitizeText((pick("summary") ?? pick("content") ?? pick("description")) ?? "") || null,
      author: sanitizeText(pick("author") ?? "") || null,
      publishedAt: updated === null || Number.isNaN(new Date(updated).getTime()) ? null : new Date(updated),
      score: null,
      embedOnly: false,
    });
  }
  return entries;
}

const TOPIC_KEYWORDS: Array<{ topic: string; re: RegExp }> = [
  { topic: "updates/OTA", re: /\b(update|ota|upgrade|kernel|reboot|firmware)\b/i },
  { topic: "thermal/power", re: /\b(thermal|temp|fan|watt|power|throttl)/i },
  { topic: "multi-node/TP", re: /\b(tp[23]|tensor parallel|multi.?node|cluster)\b/i },
  { topic: "quants", re: /\b(fp8|fp4|nvfp4|awq|gguf|int4|bpw)\b/i },
  { topic: "vllm", re: /\bvllm\b/i },
  { topic: "sglang", re: /\bsglang\b/i },
  { topic: "tensorfold", re: /\btensorfold\b/i },
  { topic: "exl3", re: /\bexl[23]\b/i },
];

/** Keyword clustering over titles — community tags are too sparse to key on. */
export function clusterTopics(items: Array<{ title: string }>): Array<{ topic: string; count: number }> {
  const counts = TOPIC_KEYWORDS.map((k) => ({ topic: k.topic, count: items.filter((i) => k.re.test(i.title)).length }));
  return counts.filter((c) => c.count > 0).sort((a, b) => b.count - a.count);
}

export async function pollSource(db: Db, def: CommunitySourceDef, fetchImpl: typeof fetch): Promise<{ ok: boolean; count: number; notModified?: boolean }> {
  const [state] = await db.select().from(communitySources).where(eq(communitySources.source, def.source)).limit(1);
  if (state?.breakerOpenUntil !== undefined && state?.breakerOpenUntil !== null && state.breakerOpenUntil.getTime() > Date.now()) {
    return { ok: false, count: 0 };
  }
  try {
    const res = await fetchImpl(def.url, {
      headers: { "user-agent": COMMUNITY_UA, accept: def.kind === "forum-top" ? "application/json" : "application/atom+xml, application/rss+xml, application/xml;q=0.9, */*;q=0.5", ...(state?.etag !== undefined && state.etag !== null ? { "if-none-match": state.etag } : {}) },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 304) {
      await db.update(communitySources).set({ ok: true, lastFetchedAt: new Date(), failures: 0 }).where(eq(communitySources.source, def.source));
      return { ok: true, count: 0, notModified: true };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const etag = res.headers.get("etag");
    const body = await res.text();
    let items: CommunityItemInput[];
    if (def.kind === "forum-top") items = parseForumTop(body, def.source, [719, 721, 723]);
    else items = parseAtom(body, def.source);
    let count = 0;
    for (const it of items) {
      await db
        .insert(communityItems)
        .values({ source: it.source, externalId: it.externalId, canonicalUrl: it.canonicalUrl, title: it.title, summary: it.summary ?? null, author: it.author ?? null, publishedAt: it.publishedAt ?? null, score: it.score ?? null, embedOnly: it.embedOnly ?? false, etag })
        .onConflictDoUpdate({
          target: [communityItems.source, communityItems.externalId],
          set: { title: it.title, summary: it.summary ?? null, publishedAt: it.publishedAt ?? null, score: it.score ?? null, fetchedAt: new Date() },
          // hidden/pinned/seen are owner curation — never reset by a poll.
        });
      count += 1;
    }
    await db
      .insert(communitySources)
      .values({ source: def.source, ok: true, lastFetchedAt: new Date(), failures: 0, etag })
      .onConflictDoUpdate({ target: communitySources.source, set: { ok: true, lastFetchedAt: new Date(), failures: 0, etag } });
    return { ok: true, count };
  } catch (err) {
    const failures = (state?.failures ?? 0) + 1;
    const open = failures >= BREAKER_THRESHOLD;
    await db
      .insert(communitySources)
      .values({ source: def.source, ok: !open, lastFetchedAt: new Date(), failures, breakerOpenUntil: open ? new Date(Date.now() + BREAKER_COOLDOWN_MS) : null, note: err instanceof Error ? err.message.slice(0, 300) : String(err) })
      .onConflictDoUpdate({ target: communitySources.source, set: { ok: !open, failures, ...(open ? { breakerOpenUntil: new Date(Date.now() + BREAKER_COOLDOWN_MS) } : {}), note: err instanceof Error ? err.message.slice(0, 300) : String(err) } });
    return { ok: false, count: 0 };
  }
}

export async function pollAll(db: Db, fetchImpl: typeof fetch): Promise<void> {
  for (const def of COMMUNITY_SOURCES) {
    await pollSource(db, def, fetchImpl).catch(() => {});
    // Jitter: never hammer sources on a fixed beat.
    await new Promise((r) => setTimeout(r, 1_500 + Math.random() * 4_500));
  }
}

export interface CommunityView {
  sources: Array<{ source: string; ok: boolean; failures: number; lastFetchedAt: string | null; breakerOpen: boolean }>;
  topics: Array<{ topic: string; count: number }>;
  items: Array<{ id: string; source: string; title: string; summary: string | null; canonicalUrl: string; author: string | null; publishedAt: string | null; score: number | null; pinned: boolean; seen: boolean; embedOnly: boolean }>;
  releases: Array<{ id: string; source: string; title: string; canonicalUrl: string; publishedAt: string | null }>;
}

export function createCommunityService(db: Db) {
  return {
    async view(): Promise<CommunityView> {
      const rows = await db.select().from(communityItems).where(eq(communityItems.hidden, false)).orderBy(desc(communityItems.pinned), desc(communityItems.publishedAt)).limit(300);
      const srcRows = await db.select().from(communitySources);
      const items = rows
        .filter((r) => !r.source.startsWith("atom:"))
        .map((r) => ({ id: r.id, source: r.source, title: r.title, summary: r.summary, canonicalUrl: r.canonicalUrl, author: r.author, publishedAt: r.publishedAt === null ? null : r.publishedAt.toISOString(), score: r.score, pinned: r.pinned, seen: r.seen, embedOnly: r.embedOnly }));
      const releases = rows.filter((r) => r.source.startsWith("atom:")).map((r) => ({ id: r.id, source: r.source, title: r.title, canonicalUrl: r.canonicalUrl, publishedAt: r.publishedAt === null ? null : r.publishedAt.toISOString() }));
      return {
        sources: srcRows.map((s) => ({ source: s.source, ok: s.ok, failures: s.failures, lastFetchedAt: s.lastFetchedAt === null ? null : s.lastFetchedAt.toISOString(), breakerOpen: s.breakerOpenUntil !== null && s.breakerOpenUntil.getTime() > Date.now() })),
        topics: clusterTopics(rows),
        items,
        releases,
      };
    },
    async curate(id: string, patch: { hidden?: boolean; pinned?: boolean; seen?: boolean }): Promise<void> {
      await db.update(communityItems).set(patch).where(eq(communityItems.id, id));
    },
    async poll(): Promise<void> {
      await pollAll(db, fetch);
    },
  };
}

export type CommunityService = ReturnType<typeof createCommunityService>;
