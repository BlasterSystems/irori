import { describe, expect, it } from "vitest";
import type { Response } from "express";
import { createSseHub } from "../src/sse.js";
import { sleep } from "./helpers.js";

function fakeSseRes() {
  const frames: string[] = [];
  const headers: Array<[string, string]> = [];
  let closeHandler: (() => void) | null = null;
  const obj: {
    writableEnded: boolean;
    write(chunk: string): boolean;
    on(ev: string, cb: () => void): unknown;
    status(code: number): unknown;
    setHeader(name: string, value: string): unknown;
    flushHeaders(): void;
  } = {
    writableEnded: false,
    write(chunk) {
      frames.push(chunk);
      return true;
    },
    on(ev, cb) {
      if (ev === "close") closeHandler = cb;
      return obj;
    },
    status(code) {
      headers.push(["status", String(code)]);
      return obj;
    },
    setHeader(name, value) {
      headers.push([name, value]);
      return obj;
    },
    flushHeaders() {},
  };
  return { res: obj as unknown as Response, frames, headers, fireClose: () => closeHandler?.() };
}

describe("sse hub", () => {
  it("negotiates SSE headers on subscribe", () => {
    const hub = createSseHub({ heartbeatMs: 0 });
    const { res, headers } = fakeSseRes();
    hub.subscribe(res);
    expect(headers).toContainEqual(["Content-Type", "text/event-stream"]);
    expect(headers).toContainEqual(["Cache-Control", "no-cache"]);
  });

  it("writes data frames to subscribed responses", () => {
    const hub = createSseHub({ heartbeatMs: 0 });
    const a = fakeSseRes();
    const b = fakeSseRes();
    hub.subscribe(a.res);
    hub.subscribe(b.res);
    const event = { type: "heartbeat", serverTimeMs: 1 } as const;
    hub.send(event);
    expect(a.frames).toEqual(["data: {\"type\":\"heartbeat\",\"serverTimeMs\":1}\n\n"]);
    expect(b.frames).toEqual([a.frames[0]]);
  });

  it("stops writing after unsubscribe", () => {
    const hub = createSseHub({ heartbeatMs: 0 });
    const { res, frames } = fakeSseRes();
    hub.subscribe(res);
    hub.unsubscribe(res);
    hub.send({ type: "heartbeat", serverTimeMs: 2 });
    expect(frames).toEqual([]);
  });

  it("auto-unsubscribes when the response closes", () => {
    const hub = createSseHub({ heartbeatMs: 0 });
    const { res, frames, fireClose } = fakeSseRes();
    hub.subscribe(res);
    fireClose();
    hub.send({ type: "heartbeat", serverTimeMs: 3 });
    expect(frames).toEqual([]);
  });

  it("injects heartbeat frames on the configured interval", async () => {
    const hub = createSseHub({ heartbeatMs: 15 });
    const { res, frames } = fakeSseRes();
    hub.subscribe(res);
    await sleep(60);
    hub.stop();
    const afterStop = frames.length;
    const types = frames.map((frame) => {
      const event: unknown = JSON.parse(frame.replace(/^data: /, "").trim());
      return typeof event === "object" && event !== null && "type" in event ? event.type : null;
    });
    expect(types.length).toBeGreaterThan(0);
    expect(types.every((t) => t === "heartbeat")).toBe(true);
    await sleep(40);
    expect(frames.length).toBe(afterStop);
  });
});
