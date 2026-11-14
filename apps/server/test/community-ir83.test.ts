import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { clusterTopics, parseAtom, parseForumTop, pollSource, sanitizeText } from "../src/community.js";
import { createDbHandle, communityItems, communitySources, type Db } from "@irori/db";

/**
 * IRI-083 (IR-174): poller contracts against saved fixtures — deterministic
 * in CI (live probes are run separately by the owner, never in tests).
 * Covers: fixture parsing, sanitize, 304 conditional-GET, dedupe on
 * (source, external_id), circuit breaker, topic clustering.
 */

const FORUM_FIXTURE = JSON.stringify({
  topic_list: {
    topics: [
      { id: 101, title: "GB10 rebooting after most recent update", slug: "gb10-reboot", posts_count: 37, like_count: 12, created_at: "2026-10-30T10:00:00Z", category_id: 719 },
      { id: 102, title: "TP2 vs TP3 tok/s on 35B", slug: "tp2-vs-tp3", posts_count: 9, like_count: 4, created_at: "2026-11-01T10:00:00Z", category_id: 719 },
      { id: 103, title: "Unrelated CUDA category thread", slug: "other", posts_count: 1, like_count: 0, created_at: "2026-11-01T11:00:00Z", category_id: 100 },
    ],
  },
});

const ATOM_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry><id>tag:github.com,2008:Repository/1/v0.4.2</id><link href="https://github.com/spark-arena/sparkrun/releases/tag/v0.4.2"/><title>sparkrun 0.4.2</title><updated>2026-10-26T12:00:00Z</updated><content>&lt;p&gt;fixes&lt;/p&gt;</content></entry>
  <entry><id>tag:github.com,2008:Repository/1/v0.4.1</id><link href="https://github.com/spark-arena/sparkrun/releases/tag/v0.4.1"/><title>sparkrun 0.4.1</title><updated>2026-10-19T12:00:00Z</updated></entry>
</feed>`;

describe("sanitizeText", () => {
  it("strips tags, entities and collapses whitespace", () => {
    expect(sanitizeText("<p>Hello &amp; <b>world</b></p>\n  more")).toBe("Hello & world more");
  });
});

describe("parseForumTop", () => {
  it("extracts GB10 topics (category 719) with scores and canonical URLs", () => {
    const items = parseForumTop(FORUM_FIXTURE, "forum:gb10-top", 719);
    expect(items).toHaveLength(2);
    expect(items[0]!.externalId).toBe("101");
    expect(items[0]!.canonicalUrl).toBe("https://forums.developer.nvidia.com/t/gb10-reboot/101");
    expect(items[0]!.score).toBe(12);
    expect(items.every((i) => i.title.length > 0)).toBe(true);
  });

  it("uses bumped_at (last activity) with created_at fallback (IR-245)", () => {
    const json = JSON.stringify({
      topic_list: {
        topics: [
          { id: 201, title: "Old thread, active today", slug: "old-active", created_at: "2026-11-04T10:00:00Z", bumped_at: "2026-11-14T09:00:00Z", category_id: 719 },
          { id: 202, title: "No bump field", slug: "no-bump", created_at: "2026-11-10T10:00:00Z", category_id: 719 },
        ],
      },
    });
    const items = parseForumTop(json, "forum:gb10-top", 719);
    expect(items[0]!.publishedAt).toEqual(new Date("2026-11-14T09:00:00Z"));
    expect(items[1]!.publishedAt).toEqual(new Date("2026-11-10T10:00:00Z"));
  });

  it("keeps subcategory topics (721 GB10 / 723 Projects) and drops foreign ones (IR-245)", () => {
    const json = JSON.stringify({
      topic_list: {
        topics: [
          { id: 301, title: "Main GB10 subcategory", slug: "main", created_at: "2026-11-13T10:00:00Z", category_id: 721 },
          { id: 302, title: "Projects subcategory", slug: "proj", created_at: "2026-11-13T10:00:00Z", category_id: 723 },
          { id: 303, title: "Unrelated CUDA thread", slug: "other", created_at: "2026-11-13T10:00:00Z", category_id: 100 },
        ],
      },
    });
    const items = parseForumTop(json, "forum:gb10-top", [719, 721, 723]);
    expect(items.map((i) => i.externalId)).toEqual(["301", "302"]);
  });

  it("returns empty for malformed JSON", () => {
    expect(parseForumTop("not json", "s")).toEqual([]);
  });
});

describe("parseAtom", () => {
  it("extracts entries with sanitized titles and links", () => {
    const items = parseAtom(ATOM_FIXTURE, "atom:sparkrun-releases");
    expect(items).toHaveLength(2);
    expect(items[0]!.title).toBe("sparkrun 0.4.2");
    expect(items[0]!.canonicalUrl).toContain("/releases/tag/v0.4.2");
    expect(items[0]!.summary).toBe("fixes"); // tags stripped
    expect(items[0]!.publishedAt).not.toBeNull();
  });
});

describe("clusterTopics", () => {
  it("clusters by keyword and sorts by count", () => {
    const counts = clusterTopics([{ title: "TP2 tok/s" }, { title: "vllm FP8 quant" }, { title: "update broke OTA" }, { title: "unrelated" }]);
    expect(counts[0]!.count).toBeGreaterThanOrEqual(1);
    expect(counts.map((c) => c.topic)).toContain("quants");
    expect(counts.map((c) => c.topic)).toContain("updates/OTA");
  });
});

describe("pollSource (db integration)", () => {
  const url = process.env.IRORI_TEST_DATABASE_URL;
  const d = url ? describe : describe.skip;
  let db: Db;

  beforeAll(async () => {
    if (url === undefined) return;
    const handle = createDbHandle(url);
    await handle.migrate();
    db = handle.db;
  });

  d("conditional GET + dedupe + breaker", () => {
    it("inserts on 200, skips on 304, dedupes on (source, external_id)", async () => {
      let calls = 0;
      const def = { source: "test:atom-" + randomUUID(), url: "https://example.invalid/atom", kind: "atom" as const, intervalMs: 1000 };
      const fetchImpl = (async () => {
        calls += 1;
        return calls === 1 ? new Response(ATOM_FIXTURE, { status: 200, headers: { etag: '"abc"' } }) : new Response(null, { status: 304, headers: { etag: '"abc"' } });
      }) as unknown as typeof fetch;
      const first = await pollSource(db, def, fetchImpl);
      expect(first).toMatchObject({ ok: true, count: 2 });
      const second = await pollSource(db, def, fetchImpl);
      expect(second).toMatchObject({ ok: true, count: 0, notModified: true });
      // Re-poll 200 with the same body: dedupe keeps one row per external id.
      const third = await pollSource(db, { ...def, url: "https://example.invalid/atom" }, (async () => new Response(ATOM_FIXTURE, { status: 200, headers: { etag: '"abc"' } })) as unknown as typeof fetch);
      expect(third.count).toBe(2);
      const rows = await db.select().from(communityItems);
      const mine = rows.filter((r) => r.source === def.source);
      expect(mine).toHaveLength(2);
    });

    it("opens the circuit breaker after repeated failures and stops polling", async () => {
      const def = { source: "test:fail-" + randomUUID(), url: "https://example.invalid/x", kind: "atom" as const, intervalMs: 1000 };
      const fetchImpl = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
      for (let i = 0; i < 5; i++) await pollSource(db, def, fetchImpl);
      const [state] = await db.select().from(communitySources).where(eq(communitySources.source, def.source));
      expect(state!.failures).toBe(5);
      expect(state!.breakerOpenUntil!.getTime()).toBeGreaterThan(Date.now());
      // Once open, the fetcher is not even called.
      let calls = 0;
      const spy = (async () => {
        calls += 1;
        return new Response("", { status: 200 });
      }) as unknown as typeof fetch;
      await pollSource(db, def, spy);
      expect(calls).toBe(0);
    });
  });
});
