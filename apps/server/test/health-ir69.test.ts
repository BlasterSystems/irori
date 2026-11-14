import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDbHandle, nodes, type Db, type DbHandle } from "@irori/db";
import { breaches, metricValue } from "../src/health.js";
import { renderPrometheus, type MetricsNode } from "../src/metrics.js";
import { createHealthService } from "../src/health.js";
import { createEventJournalService } from "../src/event-journal.js";
import { makeSnapshot } from "./helpers.js";

/**
 * IRI-069 (IR-160): health rules engine — evaluation predicates, appear/clear
 * pairing with cooldown-enforced webhooks (fake fetch), thresholds, and the
 * Prometheus renderer. DB-gated for the rules/finding state machine.
 */

const url = process.env.IRORI_TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

describe("health predicates (pure)", () => {
  it("metricValue reads gpu temp, disk pct, xid, throttle, power", () => {
    const snap = makeSnapshot() as never as ReturnType<typeof Object>;
    // Use a compact literal snapshot instead of the shared fixture shape.
    const s = {
      gpus: [{ tempC: 74, throttleReasons: ["HW Slowdown"], usagePct: 50 }],
      storage: [{ totalBytes: 1000, usedBytes: 850 }],
      kernel: { xidCount: 3 },
      cpu: { packagePowerW: 55 },
    } as unknown as Parameters<typeof metricValue>[1];
    expect(metricValue("gpu_temp_c", s)).toBe(74);
    expect(metricValue("disk_pct", s)).toBe(85);
    expect(metricValue("kernel_xid", s)).toBe(3);
    expect(metricValue("throttle_active", s)).toBe(1);
    expect(metricValue("power_w", s)).toBe(55);
    expect(metricValue("telemetry_gap_s", s)).toBeNull();
    void snap;
  });

  it("breaches() covers all ops and treats null as no-breach", () => {
    expect(breaches("gte", 70, 70)).toBe(true);
    expect(breaches("gt", 70, 70)).toBe(false);
    expect(breaches("lt", 5, 10)).toBe(true);
    expect(breaches("eq", 1, 1)).toBe(true);
    expect(breaches("gte", null, 0)).toBe(false);
  });
});

describe("renderPrometheus", () => {
  it("renders irori_up, per-node gauges and base units", () => {
    const body = renderPrometheus([
      { id: randomUUID(), name: 'dgx"1', online: true, snapshot: null },
    ]);
    expect(body).toContain("irori_up 1");
    expect(body).toContain('irori_node_online{node="dgx\\"1"} 1');

    const withSnap = renderPrometheus([
      {
        id: randomUUID(),
        name: "dgx1",
        online: true,
        snapshot: {
          timestampMs: 1_793_000_000_000,
          cpu: { model: "x", cores: 20, usagePct: 1, tempC: 50, packagePowerW: 30 },
          memory: { totalBytes: 128e9, usedBytes: 64e9 },
          storage: [{ mount: "/", fs: "ext4", totalBytes: 4e12, usedBytes: 1e12, readBps: null, writeBps: null, device: null }],
          gpus: [{ index: 0, name: "GB10", uuid: null, usagePct: 20, tempC: 55, memUsedBytes: null, memTotalBytes: null, powerW: 42, powerLimitW: null, smClockMHz: null, smClockMaxMHz: null, throttleReasons: [], processes: [] }],
        } as never,
      },
    ]);
    expect(withSnap).toContain('irori_node_gpu_temp_celsius{node="dgx1",gpu="0"} 55');
    expect(withSnap).toContain('irori_node_gpu_power_watts{node="dgx1",gpu="0"} 42');
    expect(withSnap).toContain('irori_node_memory_used_bytes{node="dgx1"} 64000000000');
    expect(withSnap).toContain('irori_node_storage_used_bytes{node="dgx1",mount="/"} 1000000000000');
    expect(withSnap).toContain("irori_collector_last_success_timestamp_seconds{node=\"dgx1\"} 1793000000");
  });
});

d("health service (db integration)", () => {
  let handle: DbHandle;
  let db: Db;

  beforeAll(async () => {
    handle = createDbHandle(url!);
    await handle.migrate();
    db = handle.db;
    await db.execute(sql`delete from health_rules`);
    await db.execute(sql`delete from nodes`);
  });

  afterAll(async () => {
    await handle.close();
  });

  function makeService(sink: { sseEvents: unknown[]; posts: Array<{ url: string; body: unknown }> }) {
    return createHealthService(db, "a".repeat(64), {
      sse: (e) => sink.sseEvents.push(e),
      journal: async () => {},
      fetchImpl: (async (input: string, init?: { body?: string }) => {
        sink.posts.push({ url: input, body: JSON.parse(init?.body ?? "{}") });
        return new Response("", { status: 200 });
      }) as typeof fetch,
      now: () => Date.now(),
    });
  }

  it("seeds the rule set and reports thresholds", async () => {
    const health = makeService({ sseEvents: [], posts: [] });
    await health.ensureSeed();
    const rules = await health.listRules();
    expect(rules.length).toBeGreaterThanOrEqual(8);
    expect(rules.find((r) => r.name === "GPU temp warn")?.threshold).toBe(70);
    const t = await health.thresholds();
    expect(t).toEqual({ tempWarnC: 70, tempCriticalC: 90, diskWarnPct: 80, hubDiskWarnPct: 80, dbUnavailable: 1 });
    // Idempotent.
    await health.ensureSeed();
    expect((await health.listRules()).length).toBe(rules.length);
  });

  it("pairs appear→clear exactly once per breach and enforces webhook cooldown", async () => {
    const sink: { sseEvents: unknown[]; posts: Array<{ url: string; body: unknown }> } = { sseEvents: [], posts: [] };
    const health = makeService(sink);
    await health.ensureSeed();
    const rules = await health.listRules();
    const warn = rules.find((r) => r.name === "GPU temp warn")!;
    await health.setRule(warn.id, { webhookUrl: "https://hooks.example/chan" });

    const nodeId = randomUUID();
    await db.insert(nodes).values({ id: nodeId, name: "h1", kind: "spark", role: "standalone", host: "localhost", agentTokenHash: "x", agentTokenEnc: "x" });

    const hot = { gpus: [{ tempC: 95, throttleReasons: [] }], storage: [], cpu: {}, memory: {} } as never;
    await health.onSnapshot(nodeId, hot);
    await health.onSnapshot(nodeId, hot); // still breaching — no second notification
    expect(sink.posts).toHaveLength(1);
    const openEvents = sink.sseEvents.filter((e) => (e as { state?: string; ruleName?: string }).ruleName === "GPU temp warn" && (e as { state?: string }).state === "open");
    expect(openEvents).toHaveLength(1); // the critical rule also opens — counted separately

    const findings = await health.findings();
    expect(findings.filter((f) => f.ruleId === warn.id)).toHaveLength(1); // critical rule has its own

    const cool = { gpus: [{ tempC: 50, throttleReasons: [] }], storage: [], cpu: {}, memory: {} } as never;
    await health.onSnapshot(nodeId, cool);
    const clearEvents = sink.sseEvents.filter((e) => (e as { state?: string; ruleName?: string }).ruleName === "GPU temp warn" && (e as { state?: string }).state === "clear");
    expect(clearEvents).toHaveLength(1);
    expect((await health.findings()).filter((f) => f.nodeId === nodeId)).toHaveLength(0);
  });

  it("sweep opens node_offline findings and clears on return", async () => {
    const sink: { sseEvents: unknown[]; posts: Array<{ url: string; body: unknown }> } = { sseEvents: [], posts: [] };
    const health = makeService(sink);
    await health.ensureSeed();
    const nodeId = randomUUID();
    await db.insert(nodes).values({ id: nodeId, name: "h2", kind: "spark", role: "standalone", host: "localhost", agentTokenHash: "x", agentTokenEnc: "x" });

    await health.sweep([{ id: nodeId, name: "h2" }], new Set([nodeId]), new Map([[nodeId, Date.now()]]));
    expect((await health.findings()).filter((f) => f.nodeId === nodeId)).toHaveLength(0);

    await health.sweep([{ id: nodeId, name: "h2" }], new Set(), new Map([[nodeId, Date.now() - 60_000]]));
    const offline = (await health.findings()).filter((f) => f.nodeId === nodeId && f.metric === "node_offline");
    expect(offline).toHaveLength(1);
    expect(offline[0]!.metric).toBe("node_offline");

    await health.sweep([{ id: nodeId, name: "h2" }], new Set([nodeId]), new Map([[nodeId, Date.now()]]));
    expect((await health.findings()).filter((f) => f.nodeId === nodeId)).toHaveLength(0);
  });
});

d("reconnect-storm rule (IR-179, db integration)", () => {
  let handle: DbHandle;
  let db: Db;

  beforeAll(async () => {
    handle = createDbHandle(url!);
    await handle.migrate();
    db = handle.db;
  });

  afterAll(async () => {
    await handle.close();
  });

  it("countByNodeSince groups journal bursts per node", async () => {
    const j = createEventJournalService(db);
    const nodeId = randomUUID();
    for (let i = 0; i < 12; i++) {
      await j.journal({ type: "node-online", serverTimeMs: Date.now(), nodeId } as never);
    }
    const counts = await j.countByNodeSince("node-online", 5 * 60_000);
    expect(counts.find((c) => c.nodeId === nodeId)?.n).toBeGreaterThanOrEqual(12);
  });

  it("trips the rule on a simulated burst, fires the webhook, then clears", async () => {
    const nodeId = randomUUID();
    await db.execute(sql`delete from nodes where id = ${nodeId}`);
    await db.insert(nodes).values({ id: nodeId, name: "stormy", kind: "spark", role: "head", host: "stormy.local", agentTokenHash: "x".repeat(64), agentTokenEnc: "y".repeat(64) }).onConflictDoNothing();
    const posts: Array<{ url: string; body: unknown }> = [];
    const fetchSpy = (async (input: string, init?: { body?: string }) => {
      posts.push({ url: input, body: JSON.parse(init?.body ?? "{}") });
      return new Response("", { status: 200 });
    }) as typeof fetch;
    const health = createHealthService(db, "a".repeat(64), {
      sse: () => {},
      journal: async () => {},
      journalCounts: async (type) => (type === "node-online" ? [{ nodeId, n: 12 }] : []),
      fetchImpl: fetchSpy,
      now: () => Date.now(),
    });
    await health.ensureSeed();
    const stormRule = (await health.listRules()).find((r) => r.name === "Reconnect storm");
    expect(stormRule).toBeDefined();
    await health.setRule(stormRule!.id, { webhookUrl: "https://hooks.test/storm" });

    await health.sweep([{ id: nodeId, name: "stormy" }], new Set([nodeId]), new Map([[nodeId, Date.now()]]));
    const findings = await health.findings();
    expect(findings.find((f) => f.metric === "reconnect_storm")?.nodeId).toBe(nodeId);
    expect(posts.some((p) => p.url === "https://hooks.test/storm")).toBe(true);

    // Quiet window: the finding clears.
    const quiet = createHealthService(db, "a".repeat(64), {
      sse: () => {},
      journal: async () => {},
      journalCounts: async () => [{ nodeId, n: 1 }],
      fetchImpl: fetchSpy,
      now: () => Date.now(),
    });
    await quiet.sweep([{ id: nodeId, name: "stormy" }], new Set([nodeId]), new Map([[nodeId, Date.now()]]));
    expect((await quiet.findings()).find((f) => f.metric === "reconnect_storm")).toBeUndefined();
  });
});

d("hub disk rule (IR-201, db integration)", () => {
  let handle: DbHandle;
  let db: Db;

  beforeAll(async () => {
    handle = createDbHandle(url!);
    await handle.migrate();
    db = handle.db;
  });

  afterAll(async () => {
    await handle.close();
  });

  function makeService(sink: { sseEvents: unknown[] }, gauge: () => Promise<number | null>, hubDiskPath?: string) {
    return createHealthService(db, "a".repeat(64), {
      sse: (e) => sink.sseEvents.push(e),
      journal: async () => {},
      hubDiskPct: gauge,
      hubDiskPath,
      now: () => Date.now(),
    });
  }

  it("opens a fleet finding (null node id) on breach and clears on recovery", async () => {
    const sink: { sseEvents: unknown[] } = { sseEvents: [] };
    let pct: number | null = 85;
    const health = makeService(sink, async () => pct);
    await health.ensureSeed();
    const rule = (await health.listRules()).find((r) => r.name === "Hub disk warn");
    expect(rule?.threshold).toBe(80);
    expect(rule?.scope).toBe("fleet");

    await health.sweep([], new Set(), new Map());
    const open = (await health.findings()).filter((f) => f.metric === "hub_disk_pct");
    expect(open).toHaveLength(1);
    expect(open[0]!.nodeId).toBe(""); // fleet-scoped wire form; no node matches it
    expect(open[0]!.summary).toContain("Hub disk warn");

    const event = sink.sseEvents.find((e) => (e as { metric?: string }).metric === "hub_disk_pct") as { nodeId?: string | null } | undefined;
    expect(event?.nodeId).toBeNull();

    pct = 50;
    await health.sweep([], new Set(), new Map());
    expect((await health.findings()).filter((f) => f.metric === "hub_disk_pct")).toHaveLength(0);
  });

  it("names the measured filesystem and configured path in the summary (IR-239)", async () => {
    let pct: number | null = 81;
    const sink: { sseEvents: unknown[] } = { sseEvents: [] };
    const health = makeService(sink, async () => pct, "/hubfs");
    await health.ensureSeed();
    await health.sweep([], new Set(), new Map());
    const open = (await health.findings()).filter((f) => f.metric === "hub_disk_pct");
    expect(open).toHaveLength(1);
    expect(open[0]!.summary).toBe("Hub disk warn: 81 ≥ 80 (hub VM filesystem, HUB_DISK_PATH=/hubfs)");
    const event = sink.sseEvents.find((e) => (e as { metric?: string }).metric === "hub_disk_pct") as { summary?: string } | undefined;
    expect(event?.summary).toBe("Hub disk warn: 81 ≥ 80 (hub VM filesystem, HUB_DISK_PATH=/hubfs)");

    // Older harness (no hubDiskPath wired): same row, summary carries no suffix.
    const bare = makeService({ sseEvents: [] }, async () => pct);
    const bareOpen = (await bare.findings()).filter((f) => f.metric === "hub_disk_pct");
    expect(bareOpen).toHaveLength(1);
    expect(bareOpen[0]!.summary).not.toContain("HUB_DISK_PATH");

    pct = 50;
    await bare.sweep([], new Set(), new Map());
    expect((await bare.findings()).filter((f) => f.metric === "hub_disk_pct")).toHaveLength(0);
  });

  it("treats a failed gauge as not measurable and tolerates an absent dep", async () => {
    let calls = 0;
    const health = makeService({ sseEvents: [] }, async () => {
      calls += 1;
      throw new Error("statfs failed");
    });
    await health.ensureSeed();
    await health.sweep([], new Set(), new Map());
    expect(calls).toBe(1); // asked once per sweep, never per request
    expect((await health.findings()).filter((f) => f.metric === "hub_disk_pct")).toHaveLength(0);

    // No gauge wired (older harnesses): the sweep must not throw.
    const bare = createHealthService(db, "a".repeat(64), { sse: () => {}, journal: async () => {}, now: () => Date.now() });
    await expect(bare.sweep([], new Set(), new Map())).resolves.toBeUndefined();
  });
});

d("db unavailable rule (IR-202, db integration)", () => {
  let handle: DbHandle;
  let db: Db;

  beforeAll(async () => {
    handle = createDbHandle(url!);
    await handle.migrate();
    db = handle.db;
  });

  afterAll(async () => {
    await handle.close();
  });

  function makeService(sink: { sseEvents: unknown[] }, dep: () => Promise<boolean>) {
    return createHealthService(db, "a".repeat(64), {
      sse: (e) => sink.sseEvents.push(e),
      journal: async () => {},
      dbHealthy: dep,
      now: () => Date.now(),
    });
  }

  it("opens a fleet finding when the db is unreachable and clears on recovery", async () => {
    const sink: { sseEvents: unknown[] } = { sseEvents: [] };
    let healthy = false;
    const health = makeService(sink, async () => healthy);
    await health.ensureSeed();
    const rule = (await health.listRules()).find((r) => r.name === "Database unavailable");
    expect(rule?.threshold).toBe(1);
    expect(rule?.severity).toBe("critical");
    expect(rule?.scope).toBe("fleet");

    await health.sweep([], new Set(), new Map());
    const open = (await health.findings()).filter((f) => f.metric === "db_unavailable");
    expect(open).toHaveLength(1);
    expect(open[0]!.nodeId).toBe(""); // fleet-scoped wire form

    const event = sink.sseEvents.find((e) => (e as { metric?: string }).metric === "db_unavailable") as
      | { severity?: string; nodeId?: string | null }
      | undefined;
    expect(event?.severity).toBe("critical");
    expect(event?.nodeId).toBeNull();

    healthy = true;
    await health.sweep([], new Set(), new Map());
    expect((await health.findings()).filter((f) => f.metric === "db_unavailable")).toHaveLength(0);
  });

  it("treats a failed probe as not measurable and tolerates an absent dep", async () => {
    let calls = 0;
    const health = makeService({ sseEvents: [] }, async () => {
      calls += 1;
      throw new Error("probe failed");
    });
    await health.ensureSeed();
    await health.sweep([], new Set(), new Map());
    expect(calls).toBe(1); // asked once per sweep, never per request
    expect((await health.findings()).filter((f) => f.metric === "db_unavailable")).toHaveLength(0);

    // No dep wired (older harnesses): the sweep must not throw.
    const bare = createHealthService(db, "a".repeat(64), { sse: () => {}, journal: async () => {}, now: () => Date.now() });
    await expect(bare.sweep([], new Set(), new Map())).resolves.toBeUndefined();
  });
});

d("clock-cap drift rule (IR-189, db integration)", () => {
  let handle: DbHandle;
  let db: Db;

  beforeAll(async () => {
    handle = createDbHandle(url!);
    await handle.migrate();
    db = handle.db;
  });

  afterAll(async () => {
    await handle.close();
  });

  it("opens only after the streak threshold and clears when the cap is back", async () => {
    const nodeId = randomUUID();
    await db.insert(nodes).values({ id: nodeId, name: "drifty", kind: "spark", role: "head", host: "drifty.local", agentTokenHash: "x".repeat(64), agentTokenEnc: "y".repeat(64) }).onConflictDoNothing();
    let streak = 1;
    const health = createHealthService(db, "a".repeat(64), {
      sse: () => {},
      journal: async () => {},
      clockDrift: async () => streak,
      now: () => Date.now(),
    });
    await health.ensureSeed();
    const rule = (await health.listRules()).find((r) => r.name === "Clock cap drift");
    expect(rule?.threshold).toBe(4);

    const nodesArg = [{ id: nodeId, name: "drifty" }];
    const online = new Set([nodeId]);
    const seen = new Map([[nodeId, Date.now()]]);

    // One drifting sweep is below the threshold — no finding yet.
    await health.sweep(nodesArg, online, seen);
    expect((await health.findings()).filter((f) => f.nodeId === nodeId && f.metric === "clock_cap_drift")).toHaveLength(0);

    streak = 4;
    await health.sweep(nodesArg, online, seen);
    expect((await health.findings()).filter((f) => f.nodeId === nodeId && f.metric === "clock_cap_drift")).toHaveLength(1);

    streak = 0;
    await health.sweep(nodesArg, online, seen);
    expect((await health.findings()).filter((f) => f.nodeId === nodeId && f.metric === "clock_cap_drift")).toHaveLength(0);
  });

  it("skips offline nodes and unmeasurable readings", async () => {
    const nodeId = randomUUID();
    await db.insert(nodes).values({ id: nodeId, name: "quiet", kind: "spark", role: "head", host: "quiet.local", agentTokenHash: "x".repeat(64), agentTokenEnc: "y".repeat(64) }).onConflictDoNothing();
    let calls = 0;
    const health = createHealthService(db, "a".repeat(64), {
      sse: () => {},
      journal: async () => {},
      clockDrift: async () => {
        calls += 1;
        return null;
      },
      now: () => Date.now(),
    });
    await health.ensureSeed();
    await health.sweep([{ id: nodeId, name: "quiet" }], new Set(), new Map([[nodeId, Date.now()]]));
    expect(calls).toBe(0); // offline: never asked
    await health.sweep([{ id: nodeId, name: "quiet" }], new Set([nodeId]), new Map([[nodeId, Date.now()]]));
    expect(calls).toBe(1); // asked, answered "not measurable" — no finding
    expect((await health.findings()).filter((f) => f.nodeId === nodeId && f.metric === "clock_cap_drift")).toHaveLength(0);
  });
});
