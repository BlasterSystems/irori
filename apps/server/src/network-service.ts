import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { deriveTopology, type HardwareSnapshot, type LinkProbe, type NetworkEntry, type SetupInfo, type Topology } from "@irori/core";

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
