import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import request from "supertest";
import type { GpuSnapshot, SseEvent } from "@irori/core";
import { createApp, type AppDeps } from "../src/app.js";
import { EVENT_FEED_CAP, createEventFeed } from "../src/events-feed.js";
import { createSseHub } from "../src/sse.js";
import { createRings } from "../src/rings.js";
import { thermalTransitions } from "../src/hub.js";
import { makeFakeStore } from "./helpers.js";

function gpu(index: number, throttleReasons: string[]): GpuSnapshot {
  return {
    index,
    name: "NVIDIA GB10",
    uuid: null,
    usagePct: 10,
    tempC: 50,
    memUsedBytes: 1,
    memTotalBytes: 2,
    powerW: 40,
    powerLimitW: null,
    smClockMHz: null,
    smClockMaxMHz: null,
    throttleReasons,
    processes: [],
  };
}

function onlineEvent(serverTimeMs: number): SseEvent {
  return { type: "node-online", serverTimeMs, nodeId: randomUUID(), agentVersion: "0.3.0" };
}

describe("event feed", () => {
  it("records feed frames in order and skips snapshot/llm/heartbeat", () => {
    const feed = createEventFeed(createSseHub({ heartbeatMs: 0 }), 10);
    feed.send(onlineEvent(1));
    feed.send({ type: "snapshot", serverTimeMs: 2, nodeId: randomUUID(), snapshot: {} as never });
    feed.send({ type: "heartbeat", serverTimeMs: 3 });
    feed.send({ type: "thermal", serverTimeMs: 4, nodeId: randomUUID(), gpuIndex: 0, active: [] });
    const events = feed.recent();
    expect(events.map((e) => e.type)).toEqual(["node-online", "thermal"]);
  });

  it("bounds the ring at cap (drop oldest)", () => {
    const feed = createEventFeed(createSseHub({ heartbeatMs: 0 }), 3);
    for (let i = 0; i < 5; i++) feed.send(onlineEvent(i));
    expect(feed.recent().length).toBe(3);
    expect(feed.recent()[0]!.serverTimeMs).toBe(2);
  });

  it("slices recent(limit) from the tail and caps at the ring cap", () => {
    const feed = createEventFeed(createSseHub({ heartbeatMs: 0 }), 10);
    for (let i = 0; i < 6; i++) feed.send(onlineEvent(i));
    expect(feed.recent(2).length).toBe(2);
    expect(feed.recent(2)[0]!.serverTimeMs).toBe(4);
    expect(feed.recent(1000).length).toBe(EVENT_FEED_CAP > 6 ? 6 : EVENT_FEED_CAP);
  });

  it("answers /api/v1/events/recent from the recording hub", async () => {
    const feed = createEventFeed(createSseHub({ heartbeatMs: 0 }));
    feed.send(onlineEvent(1));
    const fake = makeFakeStore();
    const deps: AppDeps = {
      getStore: () => fake.store,
      getLlmStore: () => null,
      getHistory: () => null,
      getLlmHistory: () => null,
      dbHealthy: async () => true,
      rings: createRings(),
      sse: feed,
      getHub: () => null,
      version: "test",
      tag: null,
      staticDir: null,
    };
    const res = await request(createApp(deps)).get("/api/v1/events/recent");
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].type).toBe("node-online");
  });

  it("answers an empty feed when the hub has no recording capability", async () => {
    const fake = makeFakeStore();
    const deps: AppDeps = {
      getStore: () => fake.store,
      getLlmStore: () => null,
      getHistory: () => null,
      getLlmHistory: () => null,
      dbHealthy: async () => true,
      rings: createRings(),
      sse: createSseHub({ heartbeatMs: 0 }),
      getHub: () => null,
      version: "test",
      tag: null,
      staticDir: null,
    };
    const res = await request(createApp(deps)).get("/api/v1/events/recent");
    expect(res.status).toBe(200);
    expect(res.body.events).toEqual([]);
  });
});

describe("thermalTransitions", () => {
  it("ignores the first sighting of a card", () => {
    expect(thermalTransitions([], [gpu(0, ["HW Slowdown"])]).length).toBe(0);
  });

  it("emits when the reason set appears or clears, order-insensitively", () => {
    const one = thermalTransitions([gpu(0, [])], [gpu(0, ["HW Slowdown"])]);
    expect(one).toEqual([{ gpuIndex: 0, active: ["HW Slowdown"] }]);

    const clear = thermalTransitions([gpu(0, ["HW Slowdown"])], [gpu(0, [])]);
    expect(clear).toEqual([{ gpuIndex: 0, active: [] }]);

    // Same set in a different order is NOT a transition.
    expect(thermalTransitions([gpu(0, ["SW Power Cap", "HW Slowdown"])], [gpu(0, ["HW Slowdown", "SW Power Cap"])]).length).toBe(0);
  });

  it("ignores unchanged sets and tracks cards independently", () => {
    const out = thermalTransitions(
      [gpu(0, ["HW Slowdown"]), gpu(1, [])],
      [gpu(0, ["HW Slowdown"]), gpu(1, ["SW Power Cap"])],
    );
    expect(out).toEqual([{ gpuIndex: 1, active: ["SW Power Cap"] }]);
  });
});
