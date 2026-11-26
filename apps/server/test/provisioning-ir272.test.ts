import { describe, expect, it } from "vitest";
import request from "supertest";
import type { NodeInventory } from "@irori/core";
import { createApp, type AppDeps } from "../src/app.js";
import { AUTO_INSTALL_COOLDOWN_MS, autoProvisionModelctl, JobBusyError, JobDispatchError, type JobRow } from "../src/jobs-service.js";
import { createProvisioner, needsProvisioning, RSYNC_RETRY_MS, type ProvisionerNode } from "../src/provisioning.js";
import { createRings } from "../src/rings.js";
import { createSseHub } from "../src/sse.js";
import { makeFakeStore } from "./helpers.js";

/** IR-272: node setup converges on install and on a cache-user change. */

type Cache = NodeInventory["local"][number];

function cache(user: string, modelctlVersion: string | null): Cache {
  const home = user === "root" ? "/root" : `/home/${user}`;
  return { user, home, cacheDir: `${home}/.cache/huggingface/hub`, modelctlVersion, error: modelctlVersion === null ? "modelctl is not installed for this user" : null, models: [], orphans: [], orphanStates: [] };
}

function report(local: Cache[]): NodeInventory {
  return { generatedAtMs: 1, store: null, local, versions: null, updates: null } as NodeInventory;
}

const SPARK: ProvisionerNode = { kind: "spark", cacheUser: "piresbruno" };
const NAS: ProvisionerNode = { kind: "nas", cacheUser: null };

describe("needsProvisioning", () => {
  it("is true with no report (fresh node or an invalidated cache)", () => {
    expect(needsProvisioning(null, SPARK, "0.25.0")).toBe(true);
  });

  it("is true when the configured cache user is not reported (pre-IR-272 agent, fresh user)", () => {
    expect(needsProvisioning(report([]), SPARK, "0.25.0")).toBe(true);
    expect(needsProvisioning(report([cache("root", "0.25.0")]), SPARK, "0.25.0")).toBe(true);
  });

  it("is true for a missing or below-pin modelctl, false once converged", () => {
    expect(needsProvisioning(report([cache("piresbruno", null)]), SPARK, "0.25.0")).toBe(true);
    expect(needsProvisioning(report([cache("piresbruno", "0.24.0")]), SPARK, "0.25.0")).toBe(true);
    expect(needsProvisioning(report([cache("piresbruno", "0.25.0")]), SPARK, "0.25.0")).toBe(false);
    expect(needsProvisioning(report([cache("piresbruno", "0.24.0")]), SPARK, null)).toBe(false);
  });

  it("checks the agent user's row on a node without a cache user (NAS)", () => {
    expect(needsProvisioning(report([]), NAS, null)).toBe(true);
    expect(needsProvisioning(report([cache("root", null)]), NAS, null)).toBe(true);
    expect(needsProvisioning(report([cache("root", "0.24.0")]), NAS, null)).toBe(false);
  });
});

interface Fake {
  created: Array<{ nodeId: string; kind: string; params: Record<string, unknown> }>;
  busy: boolean;
  offline: boolean;
}

function makeProvisioner(opts: { node?: ProvisionerNode | null; inventory?: NodeInventory | null; pin?: string | null; now?: () => number } = {}) {
  const fake: Fake = { created: [], busy: false, offline: false };
  const provisioner = createProvisioner({
    jobs: {
      create: async (nodeId, kind, params) => {
        if (fake.offline) throw new JobDispatchError("offline");
        if (fake.busy) throw new JobBusyError("busy");
        fake.created.push({ nodeId, kind, params });
        return {} as JobRow;
      },
    },
    getNode: async () => (opts.node === undefined ? SPARK : opts.node),
    getInventory: async () => (opts.inventory === undefined ? null : opts.inventory),
    getPin: async () => (opts.pin === undefined ? "0.25.0" : opts.pin),
    scriptPaths: async () => ["/opt/recipe/start.sh"],
    log: () => {},
    now: opts.now,
  });
  return { provisioner, fake };
}

const kinds = (fake: Fake): string[] => fake.created.map((c) => c.kind);

describe("createProvisioner", () => {
  it("reads the inventory when a fresh agent comes online", async () => {
    const { provisioner, fake } = makeProvisioner();
    await provisioner.onAgentOnline("n1");
    expect(fake.created).toEqual([{ nodeId: "n1", kind: "models-inventory", params: { scriptPaths: ["/opt/recipe/start.sh"] } }]);
  });

  it("only ensures rsync on an online spark whose setup is complete", async () => {
    const { provisioner, fake } = makeProvisioner({ inventory: report([cache("piresbruno", "0.25.0")]) });
    await provisioner.onAgentOnline("n1");
    expect(kinds(fake)).toEqual(["ensure-rsync"]);
  });

  it("does nothing for a converged NAS (no rsync step)", async () => {
    const { provisioner, fake } = makeProvisioner({ node: NAS, inventory: report([cache("root", "0.25.0")]) });
    await provisioner.onAgentOnline("nas");
    expect(fake.created).toEqual([]);
  });

  it("reads the inventory on a cache-user change", async () => {
    const { provisioner, fake } = makeProvisioner({ inventory: report([cache("piresbruno", "0.25.0")]) });
    await provisioner.onCacheUserChanged("n1");
    expect(kinds(fake)).toEqual(["models-inventory"]);
  });

  it("keeps a busy node's step pending and runs it when a job on that node settles", async () => {
    const { provisioner, fake } = makeProvisioner();
    fake.busy = true;
    await provisioner.onAgentOnline("n1");
    await provisioner.onAgentOnline("n1"); // a second trigger does not queue twice
    expect(fake.created).toEqual([]);
    fake.busy = false;
    await provisioner.onJobSettled({ nodeId: "other", kind: "push", status: "succeeded" });
    expect(fake.created).toEqual([]); // another node's settle does not flush n1
    await provisioner.onJobSettled({ nodeId: "n1", kind: "sync-local", status: "failed" });
    expect(kinds(fake)).toEqual(["models-inventory"]);
    await provisioner.retryPending();
    expect(kinds(fake)).toEqual(["models-inventory"]); // nothing left pending
  });

  it("retries pending steps on the periodic tick", async () => {
    const { provisioner, fake } = makeProvisioner();
    fake.busy = true;
    await provisioner.onCacheUserChanged("n1");
    fake.busy = false;
    await provisioner.retryPending();
    expect(kinds(fake)).toEqual(["models-inventory"]);
  });

  it("drops the step for an offline node (its next hello re-evaluates)", async () => {
    const { provisioner, fake } = makeProvisioner();
    fake.offline = true;
    await provisioner.onAgentOnline("n1");
    fake.offline = false;
    await provisioner.retryPending();
    expect(fake.created).toEqual([]);
  });

  it("re-reads the inventory after a successful modelctl-install, not after a failed one", async () => {
    const { provisioner, fake } = makeProvisioner();
    await provisioner.onJobSettled({ nodeId: "n1", kind: "modelctl-install", status: "failed" });
    expect(fake.created).toEqual([]);
    await provisioner.onJobSettled({ nodeId: "n1", kind: "modelctl-install", status: "succeeded" });
    expect(kinds(fake)).toEqual(["models-inventory"]);
  });

  it("runs ensure-rsync after a spark inventory until it succeeds once", async () => {
    const { provisioner, fake } = makeProvisioner();
    await provisioner.onJobSettled({ nodeId: "n1", kind: "models-inventory", status: "succeeded" });
    expect(kinds(fake)).toEqual(["ensure-rsync"]);
    await provisioner.onJobSettled({ nodeId: "n1", kind: "ensure-rsync", status: "succeeded" });
    await provisioner.onJobSettled({ nodeId: "n1", kind: "models-inventory", status: "succeeded" });
    expect(kinds(fake)).toEqual(["ensure-rsync"]);
  });

  it("backs off a failing ensure-rsync instead of re-running it after every inventory", async () => {
    let t = 0;
    const { provisioner, fake } = makeProvisioner({ now: () => t });
    await provisioner.onJobSettled({ nodeId: "n1", kind: "models-inventory", status: "succeeded" });
    await provisioner.onJobSettled({ nodeId: "n1", kind: "ensure-rsync", status: "failed" });
    await provisioner.onJobSettled({ nodeId: "n1", kind: "models-inventory", status: "succeeded" });
    expect(kinds(fake)).toEqual(["ensure-rsync"]);
    t = RSYNC_RETRY_MS;
    await provisioner.onJobSettled({ nodeId: "n1", kind: "models-inventory", status: "succeeded" });
    expect(kinds(fake)).toEqual(["ensure-rsync", "ensure-rsync"]);
  });

  it("runs the queued inventory before the queued rsync once the node frees up", async () => {
    const { provisioner, fake } = makeProvisioner();
    fake.busy = true;
    await provisioner.onCacheUserChanged("n1");
    await provisioner.onJobSettled({ nodeId: "n1", kind: "models-inventory", status: "succeeded" }); // queues rsync, still busy
    fake.busy = false;
    await provisioner.retryPending();
    expect(kinds(fake)).toEqual(["models-inventory", "ensure-rsync"]);
  });
});

describe("autoProvisionModelctl (IR-272 changes)", () => {
  function recorder() {
    const created: Array<{ kind: string; params: Record<string, unknown> }> = [];
    const create = async (_nodeId: string, kind: string, params: Record<string, unknown>): Promise<JobRow> => {
      created.push({ kind, params });
      return {} as JobRow;
    };
    return { created, create };
  }

  it("installs a missing binary even with no hub pin, but never upgrades without one", async () => {
    const { created, create } = recorder();
    await autoProvisionModelctl(create, async () => null, "n1", report([cache("piresbruno", null), cache("root", "0.20.1")]));
    expect(created).toEqual([{ kind: "modelctl-install", params: { user: "piresbruno" } }]);
  });

  it("dispatches one auto-install per node and user per cooldown", async () => {
    const { created, create } = recorder();
    const attempts = new Map<string, number>();
    let t = 0;
    const rep = report([cache("piresbruno", null)]);
    await autoProvisionModelctl(create, async () => "0.25.0", "n1", rep, attempts, () => t);
    t = AUTO_INSTALL_COOLDOWN_MS - 1;
    await autoProvisionModelctl(create, async () => "0.25.0", "n1", rep, attempts, () => t);
    expect(created).toHaveLength(1);
    // Another node with the same user name is independent.
    await autoProvisionModelctl(create, async () => "0.25.0", "n2", rep, attempts, () => t);
    expect(created).toHaveLength(2);
    t = AUTO_INSTALL_COOLDOWN_MS;
    await autoProvisionModelctl(create, async () => "0.25.0", "n1", rep, attempts, () => t);
    expect(created).toHaveLength(3);
  });

  it("does not start the cooldown when the node was busy", async () => {
    const created: string[] = [];
    let busy = true;
    const create = async (_n: string, kind: string): Promise<JobRow> => {
      if (busy) throw new JobBusyError("busy");
      created.push(kind);
      return {} as JobRow;
    };
    const attempts = new Map<string, number>();
    const rep = report([cache("piresbruno", null)]);
    await autoProvisionModelctl(create, async () => "0.25.0", "n1", rep, attempts, () => 0);
    busy = false;
    await autoProvisionModelctl(create, async () => "0.25.0", "n1", rep, attempts, () => 0);
    expect(created).toEqual(["modelctl-install"]);
  });
});

describe("node PATCH cache-user hook", () => {
  function makeApp(opts: { online?: boolean } = {}) {
    const fake = makeFakeStore();
    const events: string[] = [];
    const deps: AppDeps = {
      getStore: () => fake.store,
      getLlmStore: () => null,
      getHistory: () => null,
      getLlmHistory: () => null,
      dbHealthy: async () => true,
      rings: createRings(),
      sse: createSseHub({ heartbeatMs: 0 }),
      getHub: () => ({
        online: () => new Set<string>(),
        sendToNode: () => true,
        refreshConfig: async (nodeId: string) => {
          events.push(`config:${nodeId}`);
          return opts.online ?? true;
        },
      }),
      getJobs: () => null,
      getInventory: () => null,
      hfQuants: { listQuants: async () => ({}) } as never,
      version: "test",
      tag: null,
      staticDir: null,
      onCacheUserChanged: (nodeId) => events.push(`provision:${nodeId}`),
    };
    return { app: createApp(deps), fake, events };
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

  it("provisions after the config-update when the cache user is set or changed", async () => {
    const { app, fake, events } = makeApp();
    const { id } = await fake.store.create({ name: "dgx-4", kind: "spark", role: "head", host: "dgx-4.local" });
    expect((await request(app).patch(`/api/v1/nodes/${id}`).send({ cacheUser: "piresbruno" })).status).toBe(200);
    await settle();
    expect(events).toEqual([`config:${id}`, `provision:${id}`]);
    events.length = 0;
    await request(app).patch(`/api/v1/nodes/${id}`).send({ cacheUser: "operator" });
    await settle();
    expect(events).toEqual([`config:${id}`, `provision:${id}`]);
  });

  it("does not provision for an unchanged, cleared or unrelated patch, or an offline node", async () => {
    const { app, fake, events } = makeApp();
    const { id } = await fake.store.create({ name: "dgx-4", kind: "spark", role: "head", host: "dgx-4.local" });
    await fake.store.patch(id, { cacheUser: "piresbruno" });
    await request(app).patch(`/api/v1/nodes/${id}`).send({ cacheUser: "piresbruno" });
    await request(app).patch(`/api/v1/nodes/${id}`).send({ cacheUser: null });
    await request(app).patch(`/api/v1/nodes/${id}`).send({ llmPorts: [8000] });
    await settle();
    expect(events.filter((e) => e.startsWith("provision:"))).toEqual([]);

    const offline = makeApp({ online: false });
    const node = await offline.fake.store.create({ name: "dgx-5", kind: "spark", role: "head", host: "dgx-5.local" });
    await request(offline.app).patch(`/api/v1/nodes/${node.id}`).send({ cacheUser: "piresbruno" });
    await settle();
    // Offline: the hello re-evaluates (the configured user is not reported yet).
    expect(offline.events).toEqual([`config:${node.id}`]);
  });
});
