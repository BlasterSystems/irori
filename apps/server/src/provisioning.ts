import { compareVersions, type NodeInventory, type NodeKind } from "@irori/core";
import { JobBusyError, JobDispatchError, type JobSettledEvent, type JobsService } from "./jobs-service.js";

/**
 * IR-272: node setup is converged, not assumed. The signal is the
 * `models-inventory` report: it lists every local cache user with its
 * modelctl version, and its settle already auto-dispatches `modelctl-install`
 * (ADR-0013, `autoProvisionModelctl` in jobs-service). This module only makes
 * sure that report is read when it matters:
 *
 * - an agent comes online and its node is not provisioned yet (fresh install,
 *   missing or below-pin modelctl, the configured cache user not reported);
 * - the node's model cache user is set or changed;
 * - a `modelctl-install` succeeded (re-read, so the next user converges and
 *   the node page shows the new version).
 *
 * Serving nodes (not the NAS) also get the idempotent `ensure-rsync` job
 * (ADR-0014) once per hub process (a failure retries after RSYNC_RETRY_MS),
 * so a first sync or push does not have to fail its preflight first.
 *
 * One active job per node: a busy node keeps the step pending and retries it
 * when any job on that node settles, or on the periodic `retryPending` tick.
 * Offline nodes drop the step — their next hello re-evaluates.
 */

type Step = "models-inventory" | "ensure-rsync";

/** A failed ensure-rsync (no apt-get, offline mirror) is retried at most this
 *  often, so every inventory settle does not re-run a doomed job. */
export const RSYNC_RETRY_MS = 6 * 3_600_000;

/** A hello re-reads a node that already has a report at most this often. A
 *  user the agent cannot report (pre-IR-272 bundle, no passwd entry, home
 *  outside /root and /home) would otherwise cost a read on every reconnect. */
export const HELLO_REREAD_MS = 30 * 60_000;

export interface ProvisionerNode {
  kind: NodeKind;
  cacheUser: string | null;
}

export interface ProvisionerDeps {
  jobs: Pick<JobsService, "create">;
  getNode: (nodeId: string) => Promise<ProvisionerNode | null>;
  getInventory: (nodeId: string) => Promise<NodeInventory | null>;
  getPin: () => Promise<string | null>;
  /** The models-inventory params' setup script paths (stale-recipe chip). */
  scriptPaths: () => Promise<string[]>;
  log: (message: string) => void;
  now?: () => number;
}

export interface Provisioner {
  /** After hello + config-update: converge a node that is not set up yet. */
  onAgentOnline(nodeId: string): Promise<void>;
  /** After the config-update carrying a new (non-empty) cache user. */
  onCacheUserChanged(nodeId: string): Promise<void>;
  /** Every job settle: follow-up steps, then flush this node's pending steps. */
  onJobSettled(event: Pick<JobSettledEvent, "nodeId" | "kind" | "status">): Promise<void>;
  /** Periodic retry for nodes that stayed busy. */
  retryPending(): Promise<void>;
}

/**
 * True when the node's last report says setup is incomplete. No report at all
 * (fresh node, or invalidated by a model-mutating settle) counts: re-reading
 * is how the hub finds out.
 */
export function needsProvisioning(report: NodeInventory | null, node: ProvisionerNode, pin: string | null): boolean {
  if (report === null) return true;
  const cacheUser = node.cacheUser?.trim() || null;
  if (cacheUser !== null && !report.local.some((c) => c.user === cacheUser)) return true;
  // No cache user: the agent user's row (NAS root modelctl) must be there.
  if (cacheUser === null && report.local.length === 0) return true;
  for (const cache of report.local) {
    if (cache.modelctlVersion === null) return true;
    if (pin !== null && /^\d+\.\d+\.\d+$/.test(cache.modelctlVersion) && compareVersions(cache.modelctlVersion, pin) < 0) return true;
  }
  return false;
}

export function createProvisioner(deps: ProvisionerDeps): Provisioner {
  const pending = new Map<string, Set<Step>>();
  const now = deps.now ?? Date.now;
  /** ensure-rsync succeeded on these nodes during this hub process. */
  const rsyncOk = new Set<string>();
  /** Last ensure-rsync dispatch per node (failure back-off). */
  const rsyncTried = new Map<string, number>();
  /** Last hello-triggered read per node (HELLO_REREAD_MS throttle). */
  const helloRead = new Map<string, number>();
  /** Steps being dispatched right now: concurrent triggers must not both
   *  dispatch (the loser would queue a redundant second read). */
  const inFlight = new Set<string>();

  /** Dispatches a step; true when it was created (or the node is gone/offline). */
  async function dispatch(nodeId: string, step: Step): Promise<boolean> {
    try {
      const params = step === "models-inventory" ? { scriptPaths: await deps.scriptPaths() } : {};
      await deps.jobs.create(nodeId, step, params);
      if (step === "ensure-rsync") rsyncTried.set(nodeId, now());
      deps.log(`provisioning: ${step} dispatched to ${nodeId}`);
      return true;
    } catch (err) {
      if (err instanceof JobBusyError) return false;
      if (err instanceof JobDispatchError) return true; // offline: the next hello re-evaluates
      deps.log(`provisioning: ${step} for ${nodeId} failed to dispatch (${err instanceof Error ? err.message : String(err)})`);
      return true;
    }
  }

  async function request(nodeId: string, step: Step): Promise<void> {
    const key = `${nodeId}\u0000${step}`;
    if (pending.get(nodeId)?.has(step) || inFlight.has(key)) return; // one of each step per node
    inFlight.add(key);
    try {
      if (await dispatch(nodeId, step)) return;
      pending.set(nodeId, (pending.get(nodeId) ?? new Set<Step>()).add(step));
    } finally {
      inFlight.delete(key);
    }
  }

  /** Inventory first (it may dispatch an install), then rsync. */
  async function flush(nodeId: string): Promise<void> {
    const queued = pending.get(nodeId);
    if (queued === undefined) return;
    for (const step of ["models-inventory", "ensure-rsync"] as const) {
      if (!queued.has(step)) continue;
      if (!(await dispatch(nodeId, step))) return; // still busy: keep the rest queued
      queued.delete(step);
    }
    if (queued.size === 0) pending.delete(nodeId);
  }

  async function wantsRsync(nodeId: string): Promise<boolean> {
    if (rsyncOk.has(nodeId)) return false;
    const tried = rsyncTried.get(nodeId);
    if (tried !== undefined && now() - tried < RSYNC_RETRY_MS) return false;
    const node = await deps.getNode(nodeId);
    return node !== null && node.kind !== "nas";
  }

  return {
    async onAgentOnline(nodeId) {
      const node = await deps.getNode(nodeId);
      if (node === null) return;
      const [report, pin] = await Promise.all([deps.getInventory(nodeId), deps.getPin()]);
      if (needsProvisioning(report, node, pin)) {
        const last = helloRead.get(nodeId);
        if (report !== null && last !== undefined && now() - last < HELLO_REREAD_MS) return;
        helloRead.set(nodeId, now());
        await request(nodeId, "models-inventory");
      } else if (await wantsRsync(nodeId)) {
        await request(nodeId, "ensure-rsync");
      }
    },

    async onCacheUserChanged(nodeId) {
      await request(nodeId, "models-inventory");
    },

    async onJobSettled(event) {
      const { nodeId, kind, status } = event;
      if (status === "succeeded") {
        if (kind === "modelctl-install") {
          pending.set(nodeId, (pending.get(nodeId) ?? new Set<Step>()).add("models-inventory"));
        } else if (kind === "ensure-rsync") {
          rsyncOk.add(nodeId);
          pending.get(nodeId)?.delete("ensure-rsync");
        } else if (kind === "models-inventory" && (await wantsRsync(nodeId))) {
          pending.set(nodeId, (pending.get(nodeId) ?? new Set<Step>()).add("ensure-rsync"));
        }
      }
      await flush(nodeId);
    },

    async retryPending() {
      for (const nodeId of [...pending.keys()]) await flush(nodeId);
    },
  };
}
