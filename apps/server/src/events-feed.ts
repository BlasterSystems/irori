import type { SseEvent } from "@irori/core";
import type { SseHub } from "./sse.js";

/**
 * Recording decorator over the SSE hub (IRI-013): every non-heartbeat frame
 * is kept in a bounded drop-oldest ring so a freshly loaded page can render
 * feed history via GET /api/v1/events/recent — the SSE stream itself has no
 * history. In-memory only; a server restart starts an empty feed.
 */
export interface EventFeed extends SseHub {
  /** Last `limit` recorded frames in send order (default 200, capped at `cap`). */
  recent(limit?: number): SseEvent[];
}

export const EVENT_FEED_CAP = 500;

/** Frames that never enter the feed: heartbeats, the 2 s-cadence
 *  snapshot/llm streams and the throttled job-output frames (IRI-028) — they
 *  would evict real events from the cap; the web client streams those lines
 *  itself (IR-102) and seeds job context from GET /api/v1/jobs. */
const FEED_EXCLUDED = new Set(["heartbeat", "snapshot", "llm", "job-progress"]);

export function createEventFeed(inner: SseHub, cap: number = EVENT_FEED_CAP): EventFeed {
  const ring: SseEvent[] = [];
  return {
    subscribe: (res) => inner.subscribe(res),
    unsubscribe: (res) => inner.unsubscribe(res),
    stop: () => inner.stop(),
    send(event) {
      if (!FEED_EXCLUDED.has(event.type)) {
        ring.push(event);
        if (ring.length > cap) ring.splice(0, ring.length - cap);
      }
      inner.send(event);
    },
    recent(limit = 200) {
      return ring.slice(Math.max(0, ring.length - Math.min(Math.max(limit, 1), cap)));
    },
  };
}
