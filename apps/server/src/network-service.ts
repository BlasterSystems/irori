import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { deriveTopology, expectedPeersOf, fabricHostsFor, nodeForFabricIp, type HardwareSnapshot, type LinkProbe, type NetworkEntry, type SetupInfo, type Topology } from "@irori/core";

/**
 * IRI-162 (ADR-0021): the hub's view of the RoCE fabric. The topology is
 * derived on request from the latest ring snapshot per node — never stored,
 * because the next snapshots rebuild it. Registry hosts are resolved (A
 * records, cached) so the push-path finding compares real addresses.
 */

export interface NetworkNodeRecord {
  id: string;
  name: string;
  kind: string;
  host: string;
}

export interface NetworkServiceDeps {
  listNodes: () => Promise<NetworkNodeRecord[]>;
  online: () => ReadonlySet<string>;
  latest: (nodeId: string) => HardwareSnapshot | undefined;
  listSetups: () => Promise<SetupInfo[]>;
  /** Injectable for tests; default resolves with the OS resolver. */
  resolveHost?: (host: string) => Promise<string[]>;
  now?: () => number;
}

export interface NetworkService {
  topology(): Promise<Topology & { generatedAt: string }>;
}

const HOST_CACHE_MS = 5 * 60_000;

async function defaultResolve(host: string): Promise<string[]> {
  const out = await lookup(host, { all: true, family: 4 });
  return out.map((a) => a.address);
}

export function createNetworkService(deps: NetworkServiceDeps): NetworkService {
  const now = deps.now ?? Date.now;
  const resolve = deps.resolveHost ?? defaultResolve;
  const hostCache = new Map<string, { at: number; addrs: string[] | undefined }>();

  async function hostAddrs(host: string): Promise<string[] | undefined> {
    if (isIP(host) !== 0) return [host];
    const hit = hostCache.get(host);
    if (hit !== undefined && now() - hit.at < HOST_CACHE_MS) return hit.addrs;
    let addrs: string[] | undefined;
    try {
      addrs = await resolve(host);
    } catch {
      addrs = undefined; // unresolvable: the finding stays unknown, never guessed
    }
    hostCache.set(host, { at: now(), addrs });
    return addrs;
  }

  return {
    async topology() {
      const [records, setups] = await Promise.all([deps.listNodes(), deps.listSetups().catch(() => [] as SetupInfo[])]);
      const online = deps.online();
      const network: Record<string, NetworkEntry[] | undefined> = {};
      const probes: Record<string, LinkProbe[] | undefined> = {};
      for (const r of records) {
        const snap = deps.latest(r.id);
        network[r.id] = snap?.network;
        probes[r.id] = snap?.linkProbes;
      }
      const nodes = await Promise.all(
        records.map(async (r) => {
          const addrs = r.kind === "nas" ? undefined : await hostAddrs(r.host);
          return { id: r.id, name: r.name, kind: r.kind, host: r.host, online: online.has(r.id), ...(addrs === undefined ? {} : { hostAddrs: addrs }) };
        }),
      );
      const topology = deriveTopology({
        nodes,
        network,
        probes,
        setups: setups.map((s) => ({ id: s.id, name: s.name, kind: s.kind, headNodeId: s.headNodeId, nodes: s.nodes, status: s.status })),
      });
      return { ...topology, generatedAt: new Date(now()).toISOString() };
    },
  };
}

/**
 * IRI-165: keeps each agent's expected fabric peers in step with the
 * topology. configFor() feeds the hub's config-update; tick() (every 60 s)
 * re-sends the config to online nodes whose peer set changed — a fresh
 * agent's first snapshot can arrive after its hello.
 */
export interface NetPeersSync {
  configFor(nodeId: string): Promise<{ netProbeIntervalS: number; netPeers: Array<{ iface: string; ip: string }> }>;
  tick(): Promise<void>;
  /** Forget what was sent (a settings change re-sends everything). */
  reset(): void;
}

export function createNetPeersSync(deps: {
  network: Pick<NetworkService, "topology">;
  probeIntervalS: () => number;
  online: () => ReadonlySet<string>;
  refreshConfig: (nodeId: string) => Promise<boolean>;
}): NetPeersSync {
  const sent = new Map<string, string>();
  const keyOf = (peers: Array<{ iface: string; ip: string }>): string => peers.map((p) => `${p.iface}/${p.ip}`).sort().join(",");
  return {
    async configFor(nodeId) {
      const netPeers = expectedPeersOf(await deps.network.topology(), nodeId);
      sent.set(nodeId, keyOf(netPeers));
      return { netProbeIntervalS: deps.probeIntervalS(), netPeers };
    },
    async tick() {
      const topology = await deps.network.topology();
      for (const nodeId of deps.online()) {
        if (!topology.nodes.some((n) => n.id === nodeId)) continue; // NAS / unknown
        const key = keyOf(expectedPeersOf(topology, nodeId));
        if (sent.get(nodeId) === key) continue;
        // configFor (called by the hub's config-update) records the new key.
        await deps.refreshConfig(nodeId).catch(() => false);
      }
    },
    reset() {
      sent.clear();
    },
  };
}

/**
 * IRI-167 (ADR-0021): pushes between directly cabled Sparks dial the
 * destination's fabric address on every up lane (modelctl `--host` fan-out)
 * instead of the registry host, which is on the management LAN. The original
 * hosts ride along as `_lanHosts` so push remediation can fall back once if
 * the fabric is unreachable. Anything unexpected leaves the params untouched.
 */
export async function rewritePushHosts(
  deps: { listNodes: () => Promise<NetworkNodeRecord[]>; network: Pick<NetworkService, "topology"> },
  sourceId: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // A remediation re-push or a LAN fallback keeps what it was given: the
  // remediator pinned host keys for exactly these hosts, so re-addressing
  // a remediated push would fail its preflight with no retry left.
  if (params._lanHosts !== undefined || params._fabricFallback === true || params._remediated === true) return params;
  const hosts = Array.isArray(params.hosts) ? params.hosts.filter((h): h is string => typeof h === "string" && h.length > 0) : [];
  if (hosts.length === 0 || hosts.length !== (params.hosts as unknown[]).length) return params;
  try {
    const [nodes, topology] = await Promise.all([deps.listNodes(), deps.network.topology()]);
    const out: string[] = [];
    for (const target of hosts) {
      const at = target.indexOf("@");
      const user = at >= 0 ? target.slice(0, at) : null;
      const host = at >= 0 ? target.slice(at + 1) : target;
      const dest = nodes.find((n) => n.host === host);
      const ips = dest === undefined ? [] : fabricHostsFor(topology, sourceId, dest.id);
      if (ips.length === 0) out.push(target);
      else out.push(...ips.map((ip) => (user === null ? ip : `${user}@${ip}`)));
    }
    if (out.length === hosts.length && out.every((h, i) => h === hosts[i])) return params;
    return { ...params, hosts: out, _lanHosts: hosts };
  } catch {
    return params; // topology unavailable: the registry host still works
  }
}

/** IRI-167: resolve a push target host (registry host or fabric address) to its node id. */
export async function nodeIdForHost(
  deps: { listNodes: () => Promise<NetworkNodeRecord[]>; network: Pick<NetworkService, "topology"> },
  host: string,
): Promise<string | null> {
  const nodes = await deps.listNodes();
  const byRegistry = nodes.find((n) => n.host === host);
  if (byRegistry !== undefined) return byRegistry.id;
  try {
    return nodeForFabricIp(await deps.network.topology(), host);
  } catch {
    return null;
  }
}
