import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { NET_LIVE_LEASE_MS, NET_LIVE_MAX_LEASE_MS, type SseEvent } from "@irori/core";
import type { AppDeps } from "../src/app.js";
import { createApp } from "../src/app.js";
import { createEventFeed, FEED_EXCLUDED } from "../src/events-feed.js";
import { AGENT_DURATION_MS, createNetLive, REBROADCAST_MS } from "../src/network-live.js";
import { createRings } from "../src/rings.js";
import { createSseHub } from "../src/sse.js";
import { makeFakeStore } from "./helpers.js";

/** IRI-164 (ADR-0021): leased live rates — lease manager, routes, SSE-only. */

const NODE = "11111111-1111-4111-8111-111111111111";

function setup(opts: { enabled?: () => boolean } = {}) {
  let t = 1_000_000;
  const sent: Array<{ nodeId: string; msg: unknown }> = [];
  const events: SseEvent[] = [];
  const live = createNetLive({
    enabled: opts.enabled ?? (() => true),
    fabricNodes: () => [NODE],
    sendToNode: (nodeId, msg) => (sent.push({ nodeId, msg }), true),
    sse: { send: (e) => events.push(e) },
    now: () => t,
  });
  return { live, sent, events, advance: (ms: number) => (t += ms) };
}

const rates = { type: "net-rates" as const, intervalMs: 250, ifaces: [{ iface: "p0", rxBps: 1, txBps: 2, rdmaRxBps: 3, rdmaTxBps: 4 }] };

describe("lease manager", () => {
  it("shares one stream at the fastest interval and stops when the last lease goes", () => {
    const { live, sent } = setup();
    const a = live.acquire(1000);
    expect(a.ok && a.lease.effectiveIntervalMs).toBe(1000);
    expect(sent.at(-1)!.msg).toEqual({ type: "net-live", intervalMs: 1000, durationMs: AGENT_DURATION_MS });
    const b = live.acquire(250);
    expect(b.ok && b.lease.effectiveIntervalMs).toBe(250);
    expect(sent.at(-1)!.msg).toMatchObject({ intervalMs: 250 });
    live.release(b.ok ? b.lease.leaseId : "");
    expect(sent.at(-1)!.msg).toMatchObject({ intervalMs: 1000 });
    live.release(a.ok ? a.lease.leaseId : "");
    expect(sent.at(-1)!.msg).toEqual({ type: "net-live", intervalMs: 0, durationMs: 0 });
    expect(live.effectiveIntervalMs()).toBeNull();
  });

  it("expires an unrenewed lease after the TTL and re-tells agents while active", () => {
    const { live, sent, advance } = setup();
    live.acquire(500);
    const n = sent.length;
    advance(REBROADCAST_MS);
    live.tick();
    expect(sent.length).toBe(n + 1); // periodic re-broadcast keeps agents' duration fresh
    advance(NET_LIVE_LEASE_MS);
    live.tick();
    expect(live.effectiveIntervalMs()).toBeNull();
    expect(sent.at(-1)!.msg).toMatchObject({ intervalMs: 0 });
  });

  it("caps a renewed lease at 10 minutes", () => {
    const { live, advance } = setup();
    const first = live.acquire(1000);
    const id = first.ok ? first.lease.leaseId : "";
    for (let i = 0; i < 19; i++) {
      advance(30_000);
      expect(live.acquire(1000, id).ok).toBe(true);
    }
    advance(NET_LIVE_MAX_LEASE_MS - 19 * 30_000);
    expect(live.acquire(1000, id)).toEqual({ ok: false, reason: "lease-ended" });
    expect(live.acquire(1000, "00000000-0000-4000-8000-000000000000")).toEqual({ ok: false, reason: "unknown-lease" });
  });

  it("honours the kill switch and drops agent frames while no lease runs", () => {
    let enabled = true;
    const { live, events, sent } = setup({ enabled: () => enabled });
    live.onRates(NODE, rates);
    expect(events).toHaveLength(0);
    live.acquire(250);
    live.onRates(NODE, rates);
    expect(events[0]).toMatchObject({ type: "net-rates", nodeId: NODE, intervalMs: 250 });
    enabled = false;
    expect(live.acquire(250)).toEqual({ ok: false, reason: "disabled" });
    live.stopAll();
    expect(sent.at(-1)!.msg).toMatchObject({ intervalMs: 0 });
    live.onRates(NODE, rates);
    expect(events).toHaveLength(1);
  });

  it("drops frames from nodes outside the stream's audience (review U3)", () => {
    const { live, events } = setup();
    live.acquire(250);
    live.onRates("99999999-9999-4999-8999-999999999999", rates);
    expect(events).toHaveLength(0);
  });

  it("tells a node that comes online about a running stream", () => {
    const { live, sent } = setup();
    live.onNodeOnline(NODE);
    expect(sent).toHaveLength(0);
    live.acquire(500);
    live.onNodeOnline(NODE);
    expect(sent.at(-1)).toEqual({ nodeId: NODE, msg: { type: "net-live", intervalMs: 500, durationMs: AGENT_DURATION_MS } });
  });
});

describe("live routes", () => {
  const deps = (live: ReturnType<typeof setup>["live"] | null) =>
    ({
      getStore: () => makeFakeStore().store,
      getLlmStore: () => null,
      getHistory: () => null,
      getLlmHistory: () => null,
      dbHealthy: async () => true,
      rings: createRings(),
      sse: createSseHub({ heartbeatMs: 0 }),
      getHub: () => null,
      getJobs: () => null,
      hfQuants: { listQuants: async () => ({}) } as never,
      version: "test",
      tag: null,
      staticDir: null,
      getNetLive: () => live,
    }) as unknown as AppDeps;

  it("takes, renews and releases a lease", async () => {
    const { live } = setup();
    const app = createApp(deps(live));
    const take = await request(app).post("/api/v1/network/live").send({ intervalMs: 500 });
    expect(take.status).toBe(200);
    expect(take.body).toMatchObject({ intervalMs: 500, effectiveIntervalMs: 500 });
    const renew = await request(app).post("/api/v1/network/live").send({ intervalMs: 250, leaseId: take.body.leaseId });
    expect(renew.body.effectiveIntervalMs).toBe(250);
    expect((await request(app).get("/api/v1/network/live")).body).toEqual({ enabled: true, effectiveIntervalMs: 250, leases: 1 });
    expect((await request(app).delete(`/api/v1/network/live/${take.body.leaseId}`)).status).toBe(204);
    expect(live.effectiveIntervalMs()).toBeNull();
  });

  it("rejects rates below the floor, unknown leases and a disabled switch", async () => {
    const { live } = setup();
    const app = createApp(deps(live));
    expect((await request(app).post("/api/v1/network/live").send({ intervalMs: 100 })).status).toBe(400);
    expect((await request(app).post("/api/v1/network/live").send({ intervalMs: 500, leaseId: "00000000-0000-4000-8000-000000000000" })).status).toBe(410);
    const off = setup({ enabled: () => false });
    expect((await request(createApp(deps(off.live))).post("/api/v1/network/live").send({ intervalMs: 500 })).status).toBe(409);
    expect((await request(createApp(deps(null))).get("/api/v1/network/live")).status).toBe(503);
  });
});

describe("SSE-only delivery", () => {
  it("never records net-rates in the feed or the journal", () => {
    expect(FEED_EXCLUDED["net-rates"]).toBe(true);
    const journal = vi.fn();
    const inner = { subscribe: vi.fn(), unsubscribe: vi.fn(), send: vi.fn(), stop: vi.fn() };
    const feed = createEventFeed(inner, 10, journal);
    feed.send({ type: "net-rates", serverTimeMs: 1, nodeId: NODE, intervalMs: 250, ifaces: [] });
    expect(inner.send).toHaveBeenCalledTimes(1);
    expect(journal).not.toHaveBeenCalled();
    expect(feed.recent()).toEqual([]);
  });
});
