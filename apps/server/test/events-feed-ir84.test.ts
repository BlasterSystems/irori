import { describe, expect, it } from "vitest";
import { createEventFeed, EVENT_FEED_CAP, FEED_EXCLUDED, type EventFeed } from "../src/events-feed.js";
import type { SseEvent } from "@irori/core";

/**
 * IRI-084: unit tier for the event-feed ring — the exclusion filter (heart
 * beats and throttled streams never evict real events), the cap, and the
 * best-effort journal sink.
 */

const innerFeed = (): { hub: { subscribe: EventFeed["subscribe"]; unsubscribe: EventFeed["unsubscribe"]; stop: () => void; send: (e: SseEvent) => void }; sent: SseEvent[] } => {
  const sent: SseEvent[] = [];
  return {
    sent,
    hub: {
      subscribe: () => {},
      unsubscribe: () => {},
      stop: () => {},
      send: (e) => {
        sent.push(e);
      },
    },
  };
};

const ev = (type: string): SseEvent => ({ type, serverTimeMs: 1 }) as SseEvent;

describe("event feed ring", () => {
  it("keeps real events, drops excluded streams", () => {
    const inner = innerFeed();
    const feed = createEventFeed(inner.hub, 10);
    feed.send(ev("node-up"));
    feed.send(ev("heartbeat"));
    feed.send(ev("snapshot"));
    feed.send(ev("job-progress"));
    feed.send(ev("setup-log"));
    feed.send(ev("log-update"));
    expect(feed.recent().map((e) => e.type)).toEqual(["node-up"]);
    expect(inner.sent).toHaveLength(6); // excluded frames still deliver live
  });

  it("caps the ring at `cap` events", () => {
    const feed = createEventFeed(innerFeed().hub, 3);
    for (let i = 0; i < 10; i++) feed.send(ev(`e${i}`) );
    expect(feed.recent()).toHaveLength(3);
    expect(feed.recent().map((e) => e.type)).toEqual(["e7", "e8", "e9"]);
  });

  it("journal sink sees exactly what the ring keeps and never throws into send", () => {
    const seen: string[] = [];
    const feed = createEventFeed(
      innerFeed().hub,
      10,
      (e) => {
        seen.push(e.type);
        if (e.type === "boom") throw new Error("journal down");
      },
    );
    feed.send(ev("a"));
    feed.send(ev("heartbeat"));
    feed.send(ev("boom")); // sink throws — must not break delivery
    expect(seen).toEqual(["a", "boom"]);
  });

  it("exposes the documented cap and exclusion set", () => {
    expect(EVENT_FEED_CAP).toBe(500);
    expect(FEED_EXCLUDED["job-progress"]).toBe(true);
  });
});
