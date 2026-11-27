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
 *  itself (IR-102) and seeds job context from GET /api/v1/jobs.
 *  `setup-log` (IR-124) joins them for the same reason: live-only throttled
 *  engine output, backfill via GET /api/v1/setups/:id/log.
 *  `log-update` (IRI-078) is a durable-ingest tail pulse, not an operational
 *  event: journaling/ringing it would let a flooding engine evict real feed
 *  events; the durable record lives in the logs table. */
export const FEED_EXCLUDED: Readonly<Record<string, true>> = {
  heartbeat: true,
  snapshot: true,
  llm: true,
  "job-progress": true,
  "setup-log": true,
  "log-update": true,
  // IRI-164 (ADR-0021): up to 4 frames/s per Spark while a live lease runs —
  // high-rate telemetry that must never reach the ring or the journal.
  "net-rates": true,
};

export function createEventFeed(
  inner: SseHub,
  cap: number = EVENT_FEED_CAP,
  /** IRI-077: durable sink for the frames the ring keeps. Called after the
   *  exclusion filter, so the journal sees exactly what the ring does; the
   *  sink is best-effort and must never throw into the send path. */
  onRecord?: (event: SseEvent) => void,
): EventFeed {
  const ring: SseEvent[] = [];
  return {
    subscribe: (res) => inner.subscribe(res),
    unsubscribe: (res) => inner.unsubscribe(res),
    stop: () => inner.stop(),
    send(event) {
      if (!Object.hasOwn(FEED_EXCLUDED, event.type)) {
        ring.push(event);
        if (ring.length > cap) ring.splice(0, ring.length - cap);
        try {
          onRecord?.(event);
        } catch {
          /* journal failures never block live delivery */
        }
      }
      inner.send(event);
    },
    recent(limit = 200) {
      return ring.slice(Math.max(0, ring.length - Math.min(Math.max(limit, 1), cap)));
    },
  };
}
