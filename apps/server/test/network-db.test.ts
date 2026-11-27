import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { createDbHandle, networkTests, nodes, settings, type Db, type DbHandle } from "@irori/db";
import { createNetworkSettingsService, NETWORK_SETTINGS_KEY } from "../src/network-settings.js";
import { createNetworkTestStore, KEEP_PER_LINK } from "../src/network-tests.js";

/**
 * ADR-0021 against a REAL Postgres (IRORI_TEST_DATABASE_URL): migration 0030
 * applies, the link-test store persists/updates/prunes, crash leftovers are
 * settled, and the network settings row round-trips with validation.
 */
const url = process.env.IRORI_TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d("network tables (db integration)", () => {
  let handle: DbHandle;
  let db: Db;
  const a = randomUUID();
  const b = randomUUID();
  const linkId = [a, b].sort().join("|");

  beforeAll(async () => {
    handle = createDbHandle(url!);
    await handle.migrate();
    db = handle.db;
    for (const id of [a, b]) {
      await db.insert(nodes).values({ id, name: `net-${id.slice(0, 8)}`, kind: "spark", role: "standalone", host: "localhost", agentTokenHash: `x-${id}`, agentTokenEnc: "x" });
    }
  });

  afterAll(async () => {
    await db.delete(nodes).where(inArray(nodes.id, [a, b]));
    await db.delete(settings).where(eq(settings.key, NETWORK_SETTINGS_KEY));
    await handle.close();
  });

  const row = () => ({
    linkId,
    aNodeId: a,
    bNodeId: b,
    aIface: "enp1s0f0np0",
    bIface: "enp1s0f1np1",
    aIp: "10.100.112.2",
    bIp: "10.100.112.1",
    tool: "iperf3" as const,
    status: "running" as const,
    stage: "ensure",
    override: false,
    forwardGbps: null,
    reverseGbps: null,
    retransmits: null,
    rttP50Ms: null,
    rttP99Ms: null,
    lossPct: null,
    durationS: 10,
    streams: 4,
    error: null,
  });

  it("inserts, updates and lists a test", async () => {
    const store = createNetworkTestStore(db);
    const t = await store.insert(row());
    expect(t).toMatchObject({ linkId, status: "running", stage: "ensure", finishedAt: null });
    const done = await store.update(t.id, { status: "succeeded", stage: null, forwardGbps: 94.2, reverseGbps: 93.7, rttP50Ms: 0.031, finishedAt: new Date().toISOString(), result: { ok: true } });
    expect(done).toMatchObject({ status: "succeeded", forwardGbps: expect.closeTo(94.2, 3), finishedAt: expect.any(String) });
    expect((await store.list(10)).some((x) => x.id === t.id)).toBe(true);
  });

  it("keeps only the newest rows per link", async () => {
    const store = createNetworkTestStore(db);
    for (let i = 0; i < KEEP_PER_LINK + 3; i++) await store.insert({ ...row(), status: "succeeded" as never });
    const count = (await db.select({ id: networkTests.id }).from(networkTests).where(eq(networkTests.linkId, linkId))).length;
    expect(count).toBe(KEEP_PER_LINK);
  });

  it("settles rows a restart left running", async () => {
    const store = createNetworkTestStore(db);
    const t = await store.insert(row());
    expect(await store.failRunning("the hub restarted during the test")).toBeGreaterThanOrEqual(1);
    const [fresh] = await db.select().from(networkTests).where(eq(networkTests.id, t.id));
    expect(fresh).toMatchObject({ status: "failed", error: "the hub restarted during the test" });
  });

  it("cascades with the node", async () => {
    const c = randomUUID();
    await db.insert(nodes).values({ id: c, name: `net-${c.slice(0, 8)}`, kind: "spark", role: "standalone", host: "localhost", agentTokenHash: `x-${c}`, agentTokenEnc: "x" });
    const store = createNetworkTestStore(db);
    const t = await store.insert({ ...row(), bNodeId: c, linkId: [a, c].sort().join("|") });
    await db.delete(nodes).where(eq(nodes.id, c));
    expect(await db.select().from(networkTests).where(eq(networkTests.id, t.id))).toEqual([]);
  });

  it("round-trips the network settings row and ignores invalid stored values", async () => {
    const svc = createNetworkSettingsService(db);
    await db.delete(settings).where(eq(settings.key, NETWORK_SETTINGS_KEY));
    expect(await svc.get()).toEqual({ testsEnabled: true, liveEnabled: true, probeIntervalS: 10 });
    expect(await svc.set({ probeIntervalS: 30, liveEnabled: false })).toEqual({ testsEnabled: true, liveEnabled: false, probeIntervalS: 30 });
    expect(await createNetworkSettingsService(db).get()).toEqual({ testsEnabled: true, liveEnabled: false, probeIntervalS: 30 });
    await db.update(settings).set({ value: { probeIntervalS: -5, testsEnabled: "yes" } }).where(eq(settings.key, NETWORK_SETTINGS_KEY));
    expect(await svc.get()).toEqual({ testsEnabled: true, liveEnabled: true, probeIntervalS: 10 });
    await expect(svc.set({ probeIntervalS: 99_999 })).rejects.toThrow();
  });
});
