import type { Response } from "express";
import type { SseEvent } from "@irori/core";

/**
 * Server-sent events hub (GET /api/v1/events). Every frame is
 * `data: <json>\n\n`; a heartbeat keeps intermediaries from idling out the
 * stream. The interval is injectable for tests (0 disables it).
 */
export interface SseHub {
  /** Negotiates SSE headers and registers the response. Auto-unsubscribes on close. */
  subscribe(res: Response): void;
  unsubscribe(res: Response): void;
  send(event: SseEvent): void;
  stop(): void;
}

export interface SseHubOptions {
  heartbeatMs?: number;
}

const DEFAULT_HEARTBEAT_MS = 15_000;

export function createSseHub(options: SseHubOptions = {}): SseHub {
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const clients = new Set<Response>();

  const write = (res: Response, event: SseEvent): void => {
    if (res.writableEnded) return;
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      // Socket died between select and write; the close handler reaps it.
    }
  };

  const hub: SseHub = {
    subscribe(res) {
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();
      clients.add(res);
      res.on("close", () => clients.delete(res));
    },
    unsubscribe(res) {
      clients.delete(res);
    },
    send(event) {
      for (const res of clients) write(res, event);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };

  let timer: ReturnType<typeof setInterval> | null = null;
  if (heartbeatMs > 0) {
    timer = setInterval(() => hub.send({ type: "heartbeat", serverTimeMs: Date.now() }), heartbeatMs);
    timer.unref();
  }

  return hub;
}
