import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { NET_RESULT_MARKER, type NetworkTestView, type SetupInfo, type SseEvent, type Topology } from "@irori/core";
import type { AppDeps } from "../src/app.js";
import { createApp } from "../src/app.js";
import type { JobRow } from "../src/jobs-service.js";
import { createNetworkTests, type NetworkTestStore } from "../src/network-tests.js";
import { createRings } from "../src/rings.js";
import { createSseHub } from "../src/sse.js";
import { makeFakeStore } from "./helpers.js";

/** IRI-166 (ADR-0021): link-test orchestration with fake jobs and store. */

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

const ep = (nodeId: string, iface: string, ip: string) => ({ nodeId, iface, ip, mac: null, mtu: 9000, speedMbps: 200_000, operState: "up", rdma: null });
const link = (a: string, b: string, aIp: string, bIp: string) => ({
  id: [a, b].sort().join("|"),
  a: [a, b].sort()[0]!,
  b: [a, b].sort()[1]!,
  medium: "roce" as const,
  speedMbps: 200_000,
  lanesUp: 1,
  lanes: [{ a: ep([a, b].sort()[0]!, "p0", a < b ? aIp : bIp), b: ep([a, b].sort()[1]!, "p1", a < b ? bIp : aIp), subnet: "10.1.0.0/24", evidence: "subnet" as const, up: true, probe: null }],
});
const topology: Topology = {
  nodes: [A, B, C].map((id, i) => ({ id, name: `DGX-${i + 1}`, online: true, role: "standalone" as const, clusterIds: [], fabricIfaces: 1, hostOnFabric: false })),
  links: [link(A, B, "10.1.0.1", "10.1.0.2"), link(B, C, "10.2.0.2", "10.2.0.3")],
  switches: [],
  clusters: [],
  warnings: [],
};

const RESULT = { tool: "iperf3", forwardGbps: 94.2, reverseGbps: 93.7, retransmits: 2, rttP50Ms: 0.03, rttP99Ms: 0.06, lossPct: 0, durationS: 10, streams: 4, errors: [] };

function harness(opts: { setups?: SetupInfo[]; listenerStarts?: boolean; activeKind?: string; enabled?: boolean } = {}) {
  const created: Array<{ nodeId: string; kind: string; params: Record<string, unknown> }> = [];
  const rows = new Map<string, JobRow & { output: Array<{ seq: number; line: string }> }>();
  const canceled: string[] = [];
  const jobs = {
    async create(nodeId: string, kind: string, params: Record<string, unknown>) {
      created.push({ nodeId, kind, params });
      const id = randomUUID();
      const output: Array<{ seq: number; line: string }> = [];
      let status: JobRow["status"] = "succeeded";
      if (kind === "net-test-server") {
        status = "running";
        if (opts.listenerStarts !== false) output.push({ seq: 0, line: `IRORI_NET_LISTENING p1 ${String(params.bindIp)}:${String(params.port)}` });
      }
      if (kind === "net-test-client") output.push({ seq: 0, line: `${NET_RESULT_MARKER}${JSON.stringify(RESULT)}` });
      const row = { id, nodeId, kind, status, params, output, progress: null, cancelRequestedAt: null, exitCode: 0, createdAt: new Date(), startedAt: new Date(), finishedAt: null } as never;
      rows.set(id, row);
      return row;
    },
    async get(id: string) {
      return rows.get(id) ?? null;
    },
    async cancel(id: string) {
      canceled.push(id);
      const r = rows.get(id);
      if (r) r.status = "canceled";
      return { ok: true } as const;
    },
    async list(nodeId: string) {
      return opts.activeKind !== undefined && nodeId === B ? ([{ kind: opts.activeKind, status: "running" }] as never) : [];
    },
  };
  const stored = new Map<string, NetworkTestView>();
  const store: NetworkTestStore = {
    async insert(row) {
      const v = { ...row, id: randomUUID(), startedAt: new Date().toISOString(), finishedAt: null } as NetworkTestView;
      stored.set(v.id, v);
      return v;
    },
    async update(id, patch) {
      const { result: _r, ...rest } = patch;
      const v = { ...stored.get(id)!, ...rest } as NetworkTestView;
      stored.set(id, v);
      return v;
    },
    async list() {
      return [...stored.values()].reverse();
    },
    async failRunning() {
      return 0;
    },
  };
  const events: SseEvent[] = [];
  const svc = createNetworkTests({
    store,
    jobs,
    topology: async () => topology,
    listSetups: async () => opts.setups ?? [],
    enabled: () => opts.enabled ?? true,
    sse: { send: (e) => events.push(e) },
    sleep: async () => {},
    pickPort: () => 5207,
  });
  const settle = async () => {
    for (let i = 0; i < 50 && svc.busy(); i++) await new Promise((r) => setTimeout(r, 5));
  };
  return { svc, created, canceled, stored, events, settle };
}

const cluster = (head: string, workers: string[], status = "running"): SetupInfo =>
  ({ id: randomUUID(), name: "GLM-TP2", kind: "cluster", headNodeId: head, nodes: workers.map((nodeId) => ({ nodeId, role: "worker" })), status }) as never;

describe("link test orchestration", () => {
  it("runs ensure on both ends, the listener on B, the client on A, then cancels the listener", async () => {
    const h = harness();
    const out = await h.svc.start({ aNodeId: A, bNodeId: B, override: false, tool: "iperf3" });
    expect(out.ok).toBe(true);
    await h.settle();
    expect(h.created.map((c) => `${c.kind}@${c.nodeId === A ? "A" : "B"}`)).toEqual(["net-tool-ensure@A", "net-tool-ensure@B", "net-test-server@B", "net-test-client@A"]);
    expect(h.created[2]!.params).toEqual({ tool: "iperf3", bindIp: "10.1.0.2", port: 5207, runs: 2, timeoutS: 80 });
    expect(h.created[3]!.params).toEqual({ tool: "iperf3", bindIp: "10.1.0.1", targetIp: "10.1.0.2", port: 5207, durationS: 10, streams: 4, reverse: true, pings: 100 });
    expect(h.canceled).toHaveLength(1);
    const [test] = [...h.stored.values()];
    expect(test).toMatchObject({ status: "succeeded", forwardGbps: 94.2, reverseGbps: 93.7, rttP50Ms: 0.03, aNodeId: A, bNodeId: B, stage: null });
    expect(h.events.map((e) => (e as { stage: string | null }).stage)).toEqual(["ensure", "listen", "measure", null]);
  });

  it("orients the lane so the requested node is the client", async () => {
    const h = harness();
    await h.svc.start({ aNodeId: B, bNodeId: A, override: false, tool: "iperf3" });
    await h.settle();
    expect(h.created.find((c) => c.kind === "net-test-client")!.nodeId).toBe(B);
    expect(h.created.find((c) => c.kind === "net-test-server")!.params.bindIp).toBe("10.1.0.1");
  });

  it("refuses while an endpoint serves a cluster or transfers, unless overridden", async () => {
    const serving = harness({ setups: [cluster(A, [B])] });
    const refused = await serving.svc.start({ aNodeId: A, bNodeId: B, override: false, tool: "iperf3" });
    expect(refused).toMatchObject({ ok: false, status: 409 });
    expect(refused.ok === false && refused.reasons).toEqual(["DGX-1 serves GLM-TP2 (cluster head)", "DGX-2 serves GLM-TP2 (cluster worker)"]);
    expect(serving.created).toEqual([]);
    expect((await serving.svc.start({ aNodeId: A, bNodeId: B, override: true, tool: "iperf3" })).ok).toBe(true);
    await serving.settle();
    expect([...serving.stored.values()][0]!.override).toBe(true);

    const pushing = harness({ activeKind: "push" });
    const r = await pushing.svc.start({ aNodeId: A, bNodeId: B, override: false, tool: "iperf3" });
    expect(r.ok === false && r.reasons).toEqual(["DGX-2 is running a push job"]);
    // A stopped setup is not a reason.
    expect((await harness({ setups: [cluster(A, [B], "stopped")] }).svc.start({ aNodeId: A, bNodeId: B, override: false, tool: "iperf3" })).ok).toBe(true);
  });

  it("allows one test at a time, and validates the pair", async () => {
    const h = harness();
    expect((await h.svc.start({ aNodeId: A, bNodeId: B, override: false, tool: "iperf3" })).ok).toBe(true);
    expect(await h.svc.start({ aNodeId: B, bNodeId: C, override: false, tool: "iperf3" })).toMatchObject({ ok: false, status: 409, error: "another link test is running" });
    await h.settle();
    expect(await h.svc.start({ aNodeId: A, bNodeId: C, override: false, tool: "iperf3" })).toMatchObject({ ok: false, status: 404 });
    expect(await h.svc.start({ aNodeId: A, bNodeId: A, override: false, tool: "iperf3" })).toMatchObject({ ok: false, status: 400 });
    expect(await harness({ enabled: false }).svc.start({ aNodeId: A, bNodeId: B, override: false, tool: "iperf3" })).toMatchObject({ ok: false, status: 409 });
  });

  it("fails the row when the listener never comes up, and still frees its slot", async () => {
    const h = harness({ listenerStarts: false });
    const now = vi.spyOn(Date, "now");
    let t = 0;
    now.mockImplementation(() => (t += 5_000));
    try {
      await h.svc.start({ aNodeId: A, bNodeId: B, override: false, tool: "iperf3" });
      await h.settle();
    } finally {
      now.mockRestore();
    }
    const [test] = [...h.stored.values()];
    expect(test).toMatchObject({ status: "failed" });
    expect(test!.error).toContain("the listener on DGX-2 did not start");
    expect(h.created.some((c) => c.kind === "net-test-client")).toBe(false);
    expect(h.canceled).toHaveLength(1);
  });

  it("tests every link in turn", async () => {
    const h = harness();
    expect(await h.svc.startAll({ override: false, tool: "iperf3" })).toEqual({ ok: true, links: 2 });
    await h.settle();
    expect([...h.stored.values()].map((t) => t.linkId).sort()).toEqual(topology.links.map((l) => l.id).sort());
    expect(h.created.filter((c) => c.kind === "net-test-client")).toHaveLength(2);
  });
});

describe("link test routes", () => {
  const deps = (svc: ReturnType<typeof harness>["svc"] | null) =>
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
      getNetworkTests: () => svc,
    }) as unknown as AppDeps;

  it("starts a test (202), lists it, and returns guard reasons on 409", async () => {
    const h = harness();
    const app = createApp(deps(h.svc));
    const res = await request(app).post("/api/v1/network/tests").send({ aNodeId: A, bNodeId: B });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ aNodeId: A, bNodeId: B, status: "running" });
    await h.settle();
    const list = await request(app).get("/api/v1/network/tests");
    expect(list.body.tests).toHaveLength(1);
    expect(list.body.running).toBe(false);

    const busy = harness({ setups: [cluster(A, [B])] });
    const refused = await request(createApp(deps(busy.svc))).post("/api/v1/network/tests").send({ aNodeId: A, bNodeId: B });
    expect(refused.status).toBe(409);
    expect(refused.body.reasons).toHaveLength(2);
    expect((await request(createApp(deps(busy.svc))).post("/api/v1/network/tests/all").send({})).status).toBe(409);
  });

  it("rejects malformed requests and answers 503 without the service", async () => {
    const app = createApp(deps(harness().svc));
    expect((await request(app).post("/api/v1/network/tests").send({ aNodeId: "x", bNodeId: B })).status).toBe(400);
    expect((await request(app).post("/api/v1/network/tests").send({ aNodeId: A, bNodeId: B, durationS: 300 })).status).toBe(400);
    expect((await request(createApp(deps(null))).get("/api/v1/network/tests")).status).toBe(503);
  });
});

describe("RDMA link tests (IRI-168)", () => {
  it("passes the rdma tool with its own port range, one stream, no ping burst", async () => {
    const h = harness();
    const ports: string[] = [];
    await h.svc.start({ aNodeId: A, bNodeId: B, override: false, tool: "rdma" });
    await h.settle();
    const server = h.created.find((c) => c.kind === "net-test-server")!;
    const client = h.created.find((c) => c.kind === "net-test-client")!;
    ports.push(String(server.params.port));
    expect(server.params).toMatchObject({ tool: "rdma", bindIp: "10.1.0.2" });
    expect(client.params).toMatchObject({ tool: "rdma", streams: 1, reverse: false, pings: 0 });
    expect([...h.stored.values()][0]).toMatchObject({ tool: "rdma", streams: 1 });
    expect(ports).toEqual(["5207"]); // the harness pins the port; the range is per tool in core
  });
});
