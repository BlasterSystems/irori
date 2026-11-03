import { z } from "zod";

/**
 * Community intelligence (IRI-083, epic IR-157 WS7). Hub-side polling only:
 * never the browser, never a fleet node (ADR-0003/0007 — the agent connects
 * out, it does not scrape the internet). Items are immutable rows keyed
 * (source, externalId); topics are derived by keyword rollup because the
 * upstream tags are too sparse to key on.
 *
 * Third-party text is untrusted input: titles/summaries are sanitized to text
 * before storage and rendered as text, never HTML.
 *
 * X posture (verified in docs/research/IRI-083-community-topics-research-brief.md):
 * timelines and search are not reachable without a paid API, so the only
 * compliant surface is hydration by post id at view time. Store the id, the
 * handle and the canonical URL — never a body cache, never engagement
 * aggregation as a service metric.
 */

export const COMMUNITY_SOURCES = [
  "forum-gb10",
  "forum-projects",
  "forum-announcements",
  "nvidia-docs",
  "nvidia-blog",
  "github-releases",
  "github-commits",
  "huggingface",
  "x-post",
] as const;
export const communitySourceSchema = z.enum(COMMUNITY_SOURCES);
export type CommunitySource = z.infer<typeof communitySourceSchema>;

export const communityItemSchema = z.object({
  id: z.string().uuid(),
  source: communitySourceSchema,
  externalId: z.string().max(191),
  canonicalUrl: z.string().max(2048),
  title: z.string().max(512),
  summary: z.string().max(2048).nullable(),
  author: z.string().max(160).nullable(),
  publishedAt: z.string().nullable(),
  fetchedAt: z.string(),
  /** Upstream ranking signal when it has one (forum replies/likes). */
  score: z.number().int().nonnegative().nullable(),
  tags: z.array(z.string().max(64)).default([]),
  hidden: z.boolean().default(false),
  pinned: z.boolean().default(false),
  seen: z.boolean().default(false),
  /** For x-post rows: hydrated at view time, never persisted. */
  embedOnly: z.boolean().default(false),
});
export type CommunityItem = z.infer<typeof communityItemSchema>;

/** Derived topic: a keyword cluster over item titles. */
export const communityTopicSchema = z.object({
  key: z.string().max(96),
  label: z.string().max(160),
  items: z.number().int().nonnegative(),
  score: z.number().nonnegative(),
  lastPublishedAt: z.string().nullable(),
  /** Representative items, newest/highest scored first (bounded). */
  sampleItemIds: z.array(z.string().uuid()).max(5),
});
export type CommunityTopic = z.infer<typeof communityTopicSchema>;

export const communityQuerySchema = z.object({
  view: z.enum(["top", "latest", "releases", "announcements"]).default("top"),
  source: communitySourceSchema.optional(),
  period: z.enum(["weekly", "monthly", "quarterly", "yearly"]).default("monthly"),
  q: z.string().max(128).optional(),
  limit: z.coerce.number().int().positive().max(100).default(25),
  cursor: z.coerce.number().int().nonnegative().optional(),
});
export type CommunityQuery = z.infer<typeof communityQuerySchema>;

export const communityResponseSchema = z.object({
  view: communityQuerySchema.shape.view,
  items: z.array(communityItemSchema),
  topics: z.array(communityTopicSchema),
  /** Per-source health; a broken source shows a chip and never blanks the page. */
  sources: z
    .array(
      z.object({
        source: communitySourceSchema,
        ok: z.boolean(),
        lastFetchedAt: z.string().nullable(),
        /** Consecutive failures; the circuit breaker opens past the threshold. */
        failures: z.number().int().nonnegative(),
        note: z.string().max(256).nullable(),
      }),
    )
    .default([]),
  nextCursor: z.number().int().nullable(),
});
export type CommunityResponse = z.infer<typeof communityResponseSchema>;

export const communityPatchSchema = z.object({
  hidden: z.boolean().optional(),
  pinned: z.boolean().optional(),
  seen: z.boolean().optional(),
});
export type CommunityPatch = z.infer<typeof communityPatchSchema>;

/** X post hydration is on-demand only; nothing about it is cached. */
export const xPostHydrateSchema = z.object({
  postId: z.string().regex(/^\d{5,25}$/),
});
export const xPostHydratedSchema = z.object({
  postId: z.string(),
  authorHandle: z.string().nullable(),
  authorName: z.string().nullable(),
  text: z.string().max(4096).nullable(),
  createdAt: z.string().nullable(),
  url: z.string(),
  /** False when hydration failed; the UI falls back to a plain link. */
  hydrated: z.boolean(),
});
export type XPostHydrated = z.infer<typeof xPostHydratedSchema>;

/** Owner-editable allowlist; ids and handles only, never scraped. */
export const communityCurationSchema = z.object({
  xPosts: z.array(z.object({ postId: z.string().regex(/^\d{5,25}$/), handle: z.string().max(40), note: z.string().max(256).default("") })).default([]),
  repos: z.array(z.object({ repo: z.string().max(160), reason: z.string().max(256).default("") })).default([]),
});
export type CommunityCuration = z.infer<typeof communityCurationSchema>;
