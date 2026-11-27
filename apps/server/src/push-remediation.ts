import { JobBusyError, JobDispatchError, parsePushBlocked, type JobsService, type PushBlockedEvent } from "./jobs-service.js";

/**
 * ADR-0014 push remediation: when a push job fails because its preflight
 * reported a provisionable gap (ssh trust, destination rsync/modelctl), the
 * hub dispatches the provisioning jobs and re-creates the push once. Private
 * keys stay on the node that generated them — only public material moves
 * through job output.
 */

export interface RemediationNode {
  id: string;
  host: string;
  cacheUser: string | null;
}

export interface PushRemediationDeps {
  jobs: Pick<JobsService, "create" | "get">;
  getNode: (id: string) => Promise<RemediationNode | null>;
  getNodes: () => Promise<RemediationNode[]>;
  /** IRI-167: resolve a push host (registry host or fabric address) to a node id. */
  resolveNodeId?: (host: string) => Promise<string | null>;
  log?: (message: string) => void;
}

const TERMINAL = new Set(["succeeded", "failed", "canceled"]);
const BUSY_RETRIES = 6;
const BUSY_BACKOFF_MS = 5_000;
const TERMINAL_TIMEOUT_MS = 300_000;
const TERMINAL_POLL_MS = 2_000;
const PUBKEY_MARKER = "IRORI_TRANSFER_PUBKEY=";
const HOSTKEY_MARKER = "IRORI_HOSTKEY=";

export function createPushRemediation(deps: PushRemediationDeps): (event: PushBlockedEvent) => void {
  return (event) => {
    void remediate(event).catch((err) =>
      deps.log?.(`[irori-server] push remediation failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  };

  async function remediate(event: PushBlockedEvent): Promise<void> {
    const params = event.params as {
      name?: unknown;
      hosts?: unknown;
      jobs?: unknown;
      cacheDir?: unknown;
      ssh?: unknown;
      _remediated?: unknown;
      _lanHosts?: unknown;
    };
    // IRI-167: a fabric push whose destination did not answer falls back to
    // the registry (LAN) hosts once; that push may still remediate normally.
    if (Array.isArray(params._lanHosts) && event.output.some((o) => /^IRORI_PREFLIGHT \(.*\): unreachable/.test(o.line))) {
      const { _lanHosts, _remediated: _r, ...rest } = params;
      await deps.jobs.create(event.nodeId, "push", { ...rest, hosts: _lanHosts, _fabricFallback: true });
      deps.log?.(`[irori-server] push remediation: fabric unreachable — push re-dispatched over the registry hosts`);
      return;
    }
    // The `_remediated` guard makes the re-push single-shot: if the gap
    // persists, the second preflight failure stands for the owner to read.
    if (params._remediated === true) return;
    const parsed = parsePushBlocked(event.output);
    if (parsed === null) return;
    const hosts = Array.isArray(params.hosts)
      ? params.hosts.filter((h): h is string => typeof h === "string" && h.length > 0)
      : [];
    if (hosts.length === 0 || typeof params.name !== "string") return;

    // The destination is addressed `user@host` (ADR-0011); resolve it to a
    // node so the provisioning jobs ride the agents' authenticated channels.
    const destTarget = hosts[0]!;
    const at = destTarget.indexOf("@");
    const destUser = at >= 0 ? destTarget.slice(0, at) : null;
    const destHost = at >= 0 ? destTarget.slice(at + 1) : destTarget;
    const nodes = await deps.getNodes();
    const destId = deps.resolveNodeId === undefined ? null : await deps.resolveNodeId(destHost).catch(() => null);
    const dest = nodes.find((n) => n.host === destHost) ?? (destId === null ? null : (nodes.find((n) => n.id === destId) ?? null));
    if (dest === null) {
      deps.log?.(`[irori-server] push remediation: no node for host ${destHost}`);
      return;
    }
    const source = await deps.getNode(event.nodeId);
    if (source === null) return;
    const sourceUser = source.cacheUser ?? "root";
    const destCacheUser = destUser ?? dest.cacheUser ?? sourceUser;

    if (parsed.needsRsync) {
      if ((await runJob(dest.id, "ensure-rsync", {}, deps.log)) === null) return;
    }
    if (parsed.needsModelctl) {
      if ((await runJob(dest.id, "modelctl-install", destUser === null ? {} : { user: destCacheUser }, deps.log)) === null) return;
    }
    if (parsed.needsKeys) {
      const ensure = await runJob(event.nodeId, "transfer-key-ensure", { user: sourceUser }, deps.log);
      if (ensure === null) return;
      const publicKey = ensure.output
        .map((o) => o.line)
        .find((l) => l.startsWith(PUBKEY_MARKER))
        ?.slice(PUBKEY_MARKER.length)
        .trim();
      if (publicKey === undefined || publicKey.length === 0) {
        deps.log?.("[irori-server] push remediation: transfer-key-ensure produced no public key");
        return;
      }
      const authorize = await runJob(dest.id, "transfer-key-authorize", { user: destCacheUser, publicKey }, deps.log);
      if (authorize === null) return;
      const rawKeys = authorize.output.map((o) => o.line).filter((l) => l.startsWith(HOSTKEY_MARKER)).map((l) => l.slice(HOSTKEY_MARKER.length));
      if (rawKeys.length === 0) {
        deps.log?.("[irori-server] push remediation: transfer-key-authorize produced no host keys");
        return;
      }
      // IRI-167: a fabric push dials one address per lane; every address of
      // this destination needs its own known_hosts entry.
      const destHosts = [destHost];
      for (const h of hosts.slice(1)) {
        const name = h.includes("@") ? h.slice(h.indexOf("@") + 1) : h;
        if (destHosts.includes(name)) continue;
        const owner = deps.resolveNodeId === undefined ? null : await deps.resolveNodeId(name).catch(() => null);
        if (owner === dest.id || nodes.find((n) => n.host === name)?.id === dest.id) destHosts.push(name);
      }
      for (const host of destHosts) {
        const hostKeys = rawKeys.map((k) => normalizeHostKey(host, k));
        if ((await runJob(event.nodeId, "transfer-hostkey-pin", { user: sourceUser, host, hostKeys }, deps.log)) === null) return;
      }
    }
    await deps.jobs.create(event.nodeId, "push", { ...params, _remediated: true });
    deps.log?.(`[irori-server] push remediation: wire complete — push re-dispatched to ${destHost}`);
  }

  async function runJob(
    nodeId: string,
    kind: string,
    params: Record<string, unknown>,
    log?: (message: string) => void,
  ): Promise<{ output: Array<{ line: string }> } | null> {
    let jobId: string | null = null;
    for (let attempt = 0; attempt < BUSY_RETRIES; attempt += 1) {
      try {
        const row = await deps.jobs.create(nodeId, kind, params);
        jobId = row.id;
        break;
      } catch (err) {
        // One active job per node: wait out inventory reads and other stages.
        if (err instanceof JobBusyError || err instanceof JobDispatchError) {
          await sleep(BUSY_BACKOFF_MS);
          continue;
        }
        throw err;
      }
    }
    if (jobId === null) {
      log?.(`[irori-server] push remediation: ${kind} on ${nodeId} stayed busy`);
      return null;
    }
    const deadline = Date.now() + TERMINAL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const row = await deps.jobs.get(jobId);
      if (row === null) return null;
      if (TERMINAL.has(row.status)) {
        if (row.status !== "succeeded") log?.(`[irori-server] push remediation: ${kind} on ${nodeId} ${row.status}`);
        return row.status === "succeeded" ? row : null;
      }
      await sleep(TERMINAL_POLL_MS);
    }
    log?.(`[irori-server] push remediation: ${kind} on ${nodeId} timed out`);
    return null;
  }

  function sleep(ms: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms);
    return promise;
  }
}

/** Normalizes an `/etc/ssh/ssh_host_*.pub` line to a `host type base64` known_hosts entry. */
function normalizeHostKey(host: string, line: string): string {
  const t = line.trim().split(/\s+/);
  return `${host} ${t[0] ?? "ssh-ed25519"} ${t[1] ?? ""}`.trimEnd();
}
