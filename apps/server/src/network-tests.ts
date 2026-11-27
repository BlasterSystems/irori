import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import {
  NET_LISTENING_MARKER,
  NET_RESULT_MARKER,
  NET_TEST_PORT_MAX,
  NET_TEST_PORT_MIN,
  netTestResultSchema,
  type NetTestResult,
  type NetTestTool,
  type NetworkTestView,
  type SetupInfo,
  type SseEvent,
  type Topology,
  type TopologyLink,
} from "@irori/core";
import { networkTests } from "@irori/db";
import type { Db } from "@irori/db";
import { JobBusyError, JobDispatchError, type JobRow, type JobsService } from "./jobs-service.js";

/**
 * IRI-166 (ADR-0021): on-demand link tests, sequenced by the hub the way
 * ADR-0014 sequences push remediation: net-tool-ensure on both ends →
 * net-test-server on B (one-shot listener on its fabric address) → wait for
 * the listening marker → net-test-client on A → cancel the listener →
 * persist. One test at a time fleet-wide ("Test all" runs links in turn),
 * and endpoints that serve a setup or run a transfer are refused unless the
 * caller overrides.
 */

export const TEST_DURATION_S = 10;
export const TEST_STREAMS = 4;
export const TEST_PINGS = 100;
export const KEEP_PER_LINK = 50;
const POLL_MS = 500;
const ENSURE_TIMEOUT_MS = 300_000;
const LISTEN_TIMEOUT_MS = 20_000;
const TERMINAL = new Set(["succeeded", "failed", "canceled"]);
/** Job kinds that move data and must not share the link with a test. */
const TRANSFER_KINDS = new Set(["push", "sync-local", "download", "download-queue"]);

export interface NetworkTestStore {
  insert(row: Omit<NetworkTestView, "id" | "startedAt" | "finishedAt"> & { result?: unknown }): Promise<NetworkTestView>;
  update(id: string, patch: Partial<Omit<NetworkTestView, "id">> & { result?: unknown }): Promise<NetworkTestView | null>;
  list(limit: number): Promise<NetworkTestView[]>;
  /** Rows a crash left running: settle them failed at boot. */
  failRunning(error: string): Promise<number>;
}

export interface NetworkTestsDeps {
  store: NetworkTestStore;
  jobs: Pick<JobsService, "create" | "get" | "cancel" | "list">;
  topology: () => Promise<Topology>;
  listSetups: () => Promise<SetupInfo[]>;
  enabled: () => boolean;
  sse: { send(event: SseEvent): void };
  log?: (m: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Test hooks: deterministic port. */
  pickPort?: () => number;
}

export type StartOutcome =
  | { ok: true; test: NetworkTestView }
  | { ok: false; status: 400 | 404 | 409; error: string; reasons?: string[] };

export type StartAllOutcome = { ok: true; links: number } | { ok: false; status: 404 | 409; error: string; reasons?: string[] };

export interface NetworkTestsService {
  start(req: { aNodeId: string; bNodeId: string; override: boolean; tool: NetTestTool }): Promise<StartOutcome>;
  startAll(req: { override: boolean; tool: NetTestTool }): Promise<StartAllOutcome>;
  list(limit?: number): Promise<NetworkTestView[]>;
  /** True while a test or a "test all" run is in progress. */
  busy(): boolean;
}

interface Plan {
  link: TopologyLink;
  /** Client (A) and listener (B) endpoints of the chosen lane. */
  a: { nodeId: string; iface: string; ip: string };
  b: { nodeId: string; iface: string; ip: string };
}

/** The first up lane with IPv4 on both ends, oriented so `client` is A. */
function planFor(link: TopologyLink, clientId: string): Plan | null {
  for (const lane of link.lanes) {
    if (!lane.up || lane.a.ip === null || lane.b.ip === null) continue;
    const [a, b] = lane.a.nodeId === clientId ? [lane.a, lane.b] : [lane.b, lane.a];
    return { link, a: { nodeId: a.nodeId, iface: a.iface, ip: a.ip! }, b: { nodeId: b.nodeId, iface: b.iface, ip: b.ip! } };
  }
  return null;
}

export function createNetworkTests(deps: NetworkTestsDeps): NetworkTestsService {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pickPort = deps.pickPort ?? (() => NET_TEST_PORT_MIN + Math.floor(Math.random() * (NET_TEST_PORT_MAX - NET_TEST_PORT_MIN + 1)));
  let running: Promise<void> | null = null;

  const nameMap = (t: Topology): Map<string, string> => new Map(t.nodes.map((n) => [n.id, n.name]));

  /** Why a test on these endpoints would disturb live traffic (empty = clear). */
  async function guardReasons(nodeIds: string[], names: Map<string, string>): Promise<string[]> {
    const reasons: string[] = [];
    const setups = await deps.listSetups().catch(() => [] as SetupInfo[]);
    for (const id of nodeIds) {
      const name = names.get(id) ?? id;
      for (const s of setups) {
        if (s.status !== "running" && s.status !== "starting") continue;
        const member = s.headNodeId === id || s.nodes.some((n) => n.nodeId === id);
        if (member) reasons.push(`${name} serves ${s.name} (${s.kind === "cluster" ? (s.headNodeId === id ? "cluster head" : "cluster worker") : "single node"})`);
      }
      const [job] = await deps.jobs.list(id, 1).catch(() => [] as JobRow[]);
      if (job !== undefined && (job.status === "running" || job.status === "queued") && TRANSFER_KINDS.has(job.kind)) {
        reasons.push(`${name} is running a ${job.kind} job`);
      }
    }
    return [...new Set(reasons)];
  }

  async function waitJob(jobId: string, timeoutMs: number, until?: (row: { output: Array<{ line: string }> }) => boolean) {
    const deadline = (deps.now ?? Date.now)() + timeoutMs;
    for (;;) {
      const row = await deps.jobs.get(jobId);
      if (row === null) return null;
      if (until?.(row) === true || TERMINAL.has(row.status)) return row;
      if ((deps.now ?? Date.now)() >= deadline) return row;
      await sleep(POLL_MS);
    }
  }

  async function createJob(nodeId: string, kind: string, params: Record<string, unknown>): Promise<JobRow> {
    // One active job per node: a short inventory read may hold the slot.
    for (let attempt = 0; ; attempt++) {
      try {
        return await deps.jobs.create(nodeId, kind, params);
      } catch (err) {
        if (err instanceof JobBusyError && attempt < 5) {
          await sleep(2_000);
          continue;
        }
        throw err;
      }
    }
  }

  function emit(test: NetworkTestView, names: Map<string, string>): void {
    const pair = `${names.get(test.aNodeId) ?? test.aNodeId} → ${names.get(test.bNodeId) ?? test.bNodeId}`;
    const summary =
      test.status === "running"
        ? `link test ${pair}: ${test.stage ?? "starting"}`
        : test.status === "succeeded"
          ? `link test ${pair}: ${test.forwardGbps ?? "?"} / ${test.reverseGbps ?? "?"} Gb/s, p50 ${test.rttP50Ms ?? "?"} ms`
          : `link test ${pair} failed: ${test.error ?? "unknown"}`;
    deps.sse.send({ type: "network-test", serverTimeMs: Date.now(), testId: test.id, linkId: test.linkId, status: test.status, stage: test.stage, summary });
  }

  async function execute(
    plan: Plan,
    override: boolean,
    tool: NetTestTool,
    names: Map<string, string>,
    onInserted?: (test: NetworkTestView) => void,
  ): Promise<NetworkTestView> {
    let test = await deps.store.insert({
      linkId: plan.link.id,
      aNodeId: plan.a.nodeId,
      bNodeId: plan.b.nodeId,
      aIface: plan.a.iface,
      bIface: plan.b.iface,
      aIp: plan.a.ip,
      bIp: plan.b.ip,
      tool,
      status: "running",
      stage: "ensure",
      override,
      forwardGbps: null,
      reverseGbps: null,
      retransmits: null,
      rttP50Ms: null,
      rttP99Ms: null,
      lossPct: null,
      durationS: TEST_DURATION_S,
      streams: TEST_STREAMS,
      error: null,
    });
    onInserted?.(test);
    emit(test, names);
    const step = async (patch: Partial<NetworkTestView> & { result?: unknown }): Promise<void> => {
      test = (await deps.store.update(test.id, patch)) ?? { ...test, ...patch };
      emit(test, names);
    };
    let serverJobId: string | null = null;
    try {
      for (const nodeId of [plan.a.nodeId, plan.b.nodeId]) {
        const ensure = await createJob(nodeId, "net-tool-ensure", {});
        const done = await waitJob(ensure.id, ENSURE_TIMEOUT_MS);
        if (done?.status !== "succeeded") throw new Error(`installing the test tools on ${names.get(nodeId) ?? nodeId} ${done?.status ?? "failed"}`);
      }
      await step({ stage: "listen" });
      const port = pickPort();
      const server = await createJob(plan.b.nodeId, "net-test-server", {
        tool,
        bindIp: plan.b.ip,
        port,
        runs: 2,
        timeoutS: Math.min(120, TEST_DURATION_S * 2 + 60),
      });
      serverJobId = server.id;
      const listening = await waitJob(server.id, LISTEN_TIMEOUT_MS, (row) => row.output.some((o) => o.line.startsWith(NET_LISTENING_MARKER)));
      if (listening === null || !listening.output.some((o) => o.line.startsWith(NET_LISTENING_MARKER))) {
        const last = listening?.output.at(-1)?.line;
        throw new Error(`the listener on ${names.get(plan.b.nodeId) ?? plan.b.nodeId} did not start${last ? `: ${last}` : ""}`);
      }
      await step({ stage: "measure" });
      const client = await createJob(plan.a.nodeId, "net-test-client", {
        tool,
        bindIp: plan.a.ip,
        targetIp: plan.b.ip,
        port,
        durationS: TEST_DURATION_S,
        streams: TEST_STREAMS,
        reverse: true,
        pings: TEST_PINGS,
      });
      const done = await waitJob(client.id, (TEST_DURATION_S * 2 + 60) * 1000);
      const line = done?.output.map((o) => o.line).find((l) => l.startsWith(NET_RESULT_MARKER));
      const parsed = line === undefined ? null : netTestResultSchema.safeParse(safeJson(line.slice(NET_RESULT_MARKER.length)));
      if (parsed === null || !parsed.success) {
        const last = done?.output.at(-1)?.line;
        throw new Error(`the client reported no result${last ? `: ${last}` : ""}`);
      }
      const r: NetTestResult = parsed.data;
      await step({
        status: r.forwardGbps === null ? "failed" : "succeeded",
        stage: null,
        forwardGbps: r.forwardGbps,
        reverseGbps: r.reverseGbps,
        retransmits: r.retransmits,
        rttP50Ms: r.rttP50Ms,
        rttP99Ms: r.rttP99Ms,
        lossPct: r.lossPct,
        error: r.errors.length > 0 ? r.errors.join("; ") : null,
        finishedAt: new Date().toISOString(),
        result: r,
      });
    } catch (err) {
      const message = err instanceof JobDispatchError ? `a node went offline (${err.message})` : err instanceof Error ? err.message : String(err);
      await step({ status: "failed", stage: null, error: message.slice(0, 500), finishedAt: new Date().toISOString() });
    } finally {
      // The listener is one-shot and timed out by itself; cancel it so the
      // node's job slot frees now rather than at its timeout.
      if (serverJobId !== null) {
        const row = await deps.jobs.get(serverJobId).catch(() => null);
        if (row !== null && !TERMINAL.has(row.status)) await deps.jobs.cancel(serverJobId).catch(() => undefined);
      }
    }
    deps.log?.(`[irori-server] link test ${test.id}: ${test.status}${test.error ? ` (${test.error})` : ""}`);
    return test;
  }

  function track(work: Promise<unknown>): void {
    running = work.then(
      () => undefined,
      (err) => deps.log?.(`[irori-server] link test run failed: ${err instanceof Error ? err.message : String(err)}`),
    ).finally(() => {
      running = null;
    });
  }

  return {
    busy: () => running !== null,

    async start(req) {
      if (!deps.enabled()) return { ok: false, status: 409, error: "link tests are disabled in the network settings" };
      if (req.aNodeId === req.bNodeId) return { ok: false, status: 400, error: "pick two different nodes" };
      if (running !== null) return { ok: false, status: 409, error: "another link test is running" };
      const topology = await deps.topology();
      const id = [req.aNodeId, req.bNodeId].sort().join("|");
      const link = topology.links.find((l) => l.id === id);
      if (link === undefined) return { ok: false, status: 404, error: "no fabric link between these nodes" };
      const plan = planFor(link, req.aNodeId);
      if (plan === null) return { ok: false, status: 409, error: "the link has no up lane with addresses on both ends" };
      const names = nameMap(topology);
      if (!req.override) {
        const reasons = await guardReasons([plan.a.nodeId, plan.b.nodeId], names);
        if (reasons.length > 0) return { ok: false, status: 409, error: "an endpoint is busy; a test saturates the link for about 20 s", reasons };
      }
      if (running !== null) return { ok: false, status: 409, error: "another link test is running" };
      // The caller gets the row as soon as it exists; the run continues in the background.
      const { promise: firstRow, resolve } = Promise.withResolvers<NetworkTestView>();
      const work = execute(plan, req.override, req.tool, names, resolve);
      track(work);
      const test = await Promise.race([firstRow, work]);
      return { ok: true, test };
    },

    async startAll(req) {
      if (!deps.enabled()) return { ok: false, status: 409, error: "link tests are disabled in the network settings" };
      if (running !== null) return { ok: false, status: 409, error: "another link test is running" };
      const topology = await deps.topology();
      const plans = topology.links.map((l) => planFor(l, l.a)).filter((p): p is Plan => p !== null);
      if (plans.length === 0) return { ok: false, status: 404, error: "no fabric link with an up lane to test" };
      const names = nameMap(topology);
      if (!req.override) {
        const nodeIds = [...new Set(plans.flatMap((p) => [p.a.nodeId, p.b.nodeId]))];
        const reasons = await guardReasons(nodeIds, names);
        if (reasons.length > 0) return { ok: false, status: 409, error: "an endpoint is busy; each test saturates its link for about 20 s", reasons };
      }
      if (running !== null) return { ok: false, status: 409, error: "another link test is running" };
      track(
        (async () => {
          for (const plan of plans) await execute(plan, req.override, req.tool, names);
        })(),
      );
      return { ok: true, links: plans.length };
    },

    list: (limit = 50) => deps.store.list(Math.min(Math.max(limit, 1), 200)),
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Postgres store
// ---------------------------------------------------------------------------

type Row = typeof networkTests.$inferSelect;

function toView(r: Row): NetworkTestView {
  return {
    id: r.id,
    linkId: r.linkId,
    aNodeId: r.aNodeId,
    bNodeId: r.bNodeId,
    aIface: r.aIface,
    bIface: r.bIface,
    aIp: r.aIp,
    bIp: r.bIp,
    tool: r.tool as NetTestTool,
    status: r.status as NetworkTestView["status"],
    stage: r.stage,
    override: r.override,
    forwardGbps: r.forwardGbps,
    reverseGbps: r.reverseGbps,
    retransmits: r.retransmits,
    rttP50Ms: r.rttP50Ms,
    rttP99Ms: r.rttP99Ms,
    lossPct: r.lossPct,
    durationS: r.durationS,
    streams: r.streams,
    error: r.error,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt === null ? null : r.finishedAt.toISOString(),
  };
}

export function createNetworkTestStore(db: Db): NetworkTestStore {
  return {
    async insert(row) {
      const [inserted] = await db.insert(networkTests).values({ ...row, result: row.result ?? null }).returning();
      // Retention: the newest KEEP_PER_LINK rows per link.
      await db.execute(sql`
        DELETE FROM network_tests WHERE link_id = ${row.linkId} AND id NOT IN (
          SELECT id FROM network_tests WHERE link_id = ${row.linkId} ORDER BY started_at DESC LIMIT ${KEEP_PER_LINK}
        )
      `);
      return toView(inserted!);
    },
    async update(id, patch) {
      const { finishedAt, startedAt: _startedAt, ...rest } = patch;
      const [row] = await db
        .update(networkTests)
        .set({ ...rest, ...(finishedAt === undefined ? {} : { finishedAt: finishedAt === null ? null : new Date(finishedAt) }) })
        .where(eq(networkTests.id, id))
        .returning();
      return row === undefined ? null : toView(row);
    },
    async list(limit) {
      const rows = await db.select().from(networkTests).orderBy(desc(networkTests.startedAt)).limit(limit);
      return rows.map(toView);
    },
    async failRunning(error) {
      const rows = await db
        .update(networkTests)
        .set({ status: "failed", stage: null, error, finishedAt: new Date() })
        .where(and(inArray(networkTests.status, ["running"]), lt(networkTests.startedAt, new Date())))
        .returning({ id: networkTests.id });
      return rows.length;
    },
  };
}
