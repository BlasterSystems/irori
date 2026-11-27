import type { LinkProbe, NetworkEntry, RdmaPort } from "./snapshot.js";

/**
 * IRI-162 (ADR-0021): fleet RoCE topology, derived — never stored — from the
 * latest snapshot per node. Pure and deterministic so it runs on the hub
 * (GET /api/v1/network/topology) and in tests from fixtures.
 *
 * Scope (owner, 2026-11-27): the RoCE fabric between Sparks only. NAS nodes
 * are dropped up front and LAN interfaces never become links.
 *
 * A **lane** is one netdev pair (one /24 on this fleet); a **link** groups
 * the lanes between one node pair (one CX7 cable carries two lanes here). A
 * subnet shared by more than two nodes becomes a **switch** pseudo-node:
 * L2 cannot prove a direct cable, so point-to-point is reported as a link and
 * never claimed as "direct cable" fact.
 */

export interface TopologyNodeInput {
  id: string;
  name: string;
  kind: string;
  host: string;
  online: boolean;
  /** The hub's resolution of `host` (A records); absent = unresolved. */
  hostAddrs?: string[];
}

export interface TopologySetupInput {
  id: string;
  name: string;
  kind: string;
  headNodeId: string;
  nodes: Array<{ nodeId: string }>;
  status: string;
}

export interface TopologyInput {
  nodes: TopologyNodeInput[];
  /** Latest `network[]` per node id (missing = no snapshot yet). */
  network: Readonly<Record<string, NetworkEntry[] | undefined>>;
  /** Latest `linkProbes` per node id (S4). */
  probes?: Readonly<Record<string, LinkProbe[] | undefined>>;
  setups: TopologySetupInput[];
}

export interface TopologyEndpoint {
  nodeId: string;
  iface: string;
  /** The IPv4 address on the lane's subnet (or the first IPv4 address). */
  ip: string | null;
  mac: string | null;
  mtu: number | null;
  speedMbps: number | null;
  operState: string | null;
  rdma: RdmaPort | null;
}

export type LaneEvidence = "confirmed" | "neighbor" | "subnet";

export interface TopologyLane {
  a: TopologyEndpoint;
  b: TopologyEndpoint;
  /** e.g. 10.100.112.0/24; null for a neighbour-only lane. */
  subnet: string | null;
  /** confirmed = both sides list the other's MAC; neighbor = one side; subnet = shared subnet only. */
  evidence: LaneEvidence;
  up: boolean;
  /** Latest prober result for the lane (either side), null before S4 data. */
  probe: { rttAvgMs: number | null; rttMaxMs: number | null; lossPct: number; at: number } | null;
}

export type LinkMedium = "roce" | "ethernet" | "unknown";

export interface TopologyLink {
  /** `${a}|${b}` with a < b (node ids). */
  id: string;
  a: string;
  b: string;
  medium: LinkMedium;
  /** Fastest lane speed (lanes are not summed: two netdevs share one cage). */
  speedMbps: number | null;
  lanes: TopologyLane[];
  lanesUp: number;
}

export interface TopologySwitch {
  id: string;
  subnet: string;
  members: TopologyEndpoint[];
}

export type TopologyRole = "head" | "worker" | "standalone";

export interface TopologyNode {
  id: string;
  name: string;
  online: boolean;
  role: TopologyRole;
  /** Cluster setups the node belongs to, in setup order. */
  clusterIds: string[];
  fabricIfaces: number;
  /** Whether the registry host resolves to one of the node's fabric addresses; null = unknown. */
  hostOnFabric: boolean | null;
}

export interface TopologyCluster {
  id: string;
  name: string;
  headNodeId: string;
  memberIds: string[];
  running: boolean;
  /** Every online member reaches the head over up fabric lanes; null = head offline. */
  fabricPath: boolean | null;
}

export type TopologyWarningCode =
  | "mtu-mismatch"
  | "speed-mismatch"
  | "lane-down"
  | "cluster-no-path"
  | "push-not-on-fabric"
  | "node-offline";

export interface TopologyWarning {
  code: TopologyWarningCode;
  severity: "warn" | "info";
  message: string;
  nodeIds: string[];
  linkId?: string;
}

export interface Topology {
  nodes: TopologyNode[];
  links: TopologyLink[];
  switches: TopologySwitch[];
  clusters: TopologyCluster[];
  warnings: TopologyWarning[];
}

/** Linux interface names (IFNAMSIZ 16 incl. NUL); validated before any spawn. */
export const NET_IFACE_RE = /^[A-Za-z0-9_.:-]{1,15}$/;
/** Dotted-quad IPv4 literal (octet ranges checked by ipv4ToInt). */
export const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

const VIRTUAL_NAME = /^(lo|docker|veth|br-|virbr|tailscale|wg|tun|tap|cni|flannel|vxlan|zt)/;
const FABRIC_MIN_SPEED_MBPS = 100_000;

/**
 * Fabric interface test. New agents say so (`kind`); for old agents (kind
 * null) a non-virtual name at ≥ 100 Gb/s counts — that is the CX7 on every
 * Spark, so the card works before agents update.
 */
export function isFabricEntry(e: NetworkEntry): boolean {
  if (e.kind !== null && e.kind !== undefined) return e.kind === "fabric";
  return !VIRTUAL_NAME.test(e.iface) && (e.speedMbps ?? 0) >= FABRIC_MIN_SPEED_MBPS;
}

/** Dotted IPv4 → uint32, or null. */
export function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (m === null) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function intToIpv4(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

/** "10.100.112.2/24" → { ip, prefix, subnet: "10.100.112.0/24" }; IPv4 only. */
export function parseIpv4Cidr(cidr: string): { ip: string; prefix: number; subnet: string } | null {
  const [ip, prefixRaw] = cidr.split("/");
  if (ip === undefined || prefixRaw === undefined) return null;
  const prefix = Number(prefixRaw);
  const n = ipv4ToInt(ip);
  if (n === null || !Number.isInteger(prefix) || prefix < 1 || prefix > 32) return null;
  const mask = prefix === 32 ? 0xffffffff : (~((1 << (32 - prefix)) - 1)) >>> 0;
  return { ip, prefix, subnet: `${intToIpv4((n & mask) >>> 0)}/${prefix}` };
}

/** True when `ip` lies inside `subnet` (both IPv4). */
export function ipv4InSubnet(ip: string, subnet: string): boolean {
  const s = parseIpv4Cidr(subnet);
  const n = ipv4ToInt(ip);
  if (s === null || n === null) return false;
  return parseIpv4Cidr(`${ip}/${s.prefix}`)?.subnet === s.subnet;
}

/** IPv4 subnets of an entry; old agents without cidrs fall back to /24 (the fleet's per-lane plan). */
export function ipv4SubnetsOf(e: NetworkEntry): Array<{ ip: string; subnet: string }> {
  const fromCidrs = e.cidrs.map(parseIpv4Cidr).filter((c): c is NonNullable<typeof c> => c !== null);
  if (fromCidrs.length > 0) return fromCidrs.map((c) => ({ ip: c.ip, subnet: c.subnet }));
  return e.addrs
    .filter((a) => ipv4ToInt(a) !== null)
    .map((a) => ({ ip: a, subnet: parseIpv4Cidr(`${a}/24`)!.subnet }));
}

/** Fabric IPv4 addresses of a node's network entries. */
export function fabricIpv4Of(entries: NetworkEntry[]): Array<{ iface: string; ip: string; subnet: string }> {
  const out: Array<{ iface: string; ip: string; subnet: string }> = [];
  for (const e of entries) if (isFabricEntry(e)) for (const s of ipv4SubnetsOf(e)) out.push({ iface: e.iface, ...s });
  return out;
}

interface Ep {
  nodeId: string;
  entry: NetworkEntry;
  subnets: Array<{ ip: string; subnet: string }>;
}

function endpointOf(ep: Ep, subnet: string | null): TopologyEndpoint {
  const ip = (subnet === null ? undefined : ep.subnets.find((s) => s.subnet === subnet)?.ip) ?? ep.subnets[0]?.ip ?? null;
  return {
    nodeId: ep.nodeId,
    iface: ep.entry.iface,
    ip,
    mac: ep.entry.mac,
    mtu: ep.entry.mtu,
    speedMbps: ep.entry.speedMbps,
    operState: ep.entry.operState,
    rdma: ep.entry.rdma,
  };
}

const epKey = (ep: Ep): string => `${ep.nodeId}/${ep.entry.iface}`;

export function deriveTopology(input: TopologyInput): Topology {
  const sparks = input.nodes.filter((n) => n.kind !== "nas");
  const sparkIds = new Set(sparks.map((n) => n.id));
  const byId = new Map(sparks.map((n) => [n.id, n]));
  const nameOf = (id: string): string => byId.get(id)?.name ?? id;

  // 1. Fabric endpoints of online Sparks (an offline node's last snapshot is stale).
  const eps: Ep[] = [];
  for (const n of [...sparks].sort((x, y) => x.name.localeCompare(y.name))) {
    if (!n.online) continue;
    for (const entry of [...(input.network[n.id] ?? [])].sort((x, y) => x.iface.localeCompare(y.iface))) {
      if (isFabricEntry(entry)) eps.push({ nodeId: n.id, entry, subnets: ipv4SubnetsOf(entry) });
    }
  }
  const byMac = new Map<string, Ep>();
  for (const ep of eps) if (ep.entry.mac !== null) byMac.set(ep.entry.mac, ep);

  // 2. Subnet membership → lanes (2 nodes) or switches (> 2 nodes).
  const bySubnet = new Map<string, Ep[]>();
  for (const ep of eps) {
    for (const s of ep.subnets) {
      const list = bySubnet.get(s.subnet) ?? [];
      list.push(ep);
      bySubnet.set(s.subnet, list);
    }
  }
  const switches: TopologySwitch[] = [];
  const switchedEps = new Set<string>();
  interface LaneAcc {
    x: Ep;
    y: Ep;
    subnet: string | null;
    xSeesY: boolean;
    ySeesX: boolean;
  }
  const lanes = new Map<string, LaneAcc>();
  const laneKey = (p: Ep, q: Ep): string => [epKey(p), epKey(q)].sort().join("~");
  const sees = (p: Ep, q: Ep): boolean => q.entry.mac !== null && p.entry.neighbors.some((n) => n.mac === q.entry.mac);
  const addLane = (p: Ep, q: Ep, subnet: string | null): void => {
    const key = laneKey(p, q);
    if (lanes.has(key)) return;
    const [x, y] = epKey(p) < epKey(q) ? [p, q] : [q, p];
    lanes.set(key, { x, y, subnet, xSeesY: sees(x, y), ySeesX: sees(y, x) });
  };
  for (const [subnet, members] of [...bySubnet].sort(([a], [b]) => a.localeCompare(b))) {
    const nodeIds = new Set(members.map((m) => m.nodeId));
    if (nodeIds.size > 2) {
      switches.push({ id: `switch:${subnet}`, subnet, members: members.map((m) => endpointOf(m, subnet)) });
      for (const m of members) switchedEps.add(epKey(m));
    } else if (nodeIds.size === 2) {
      const [p, ...rest] = members;
      const q = rest.find((m) => m.nodeId !== p!.nodeId)!;
      addLane(p!, q, subnet);
    }
  }
  // 3. Neighbour evidence without a shared subnet (e.g. IPv6/link-local only lanes).
  for (const ep of eps) {
    if (switchedEps.has(epKey(ep))) continue;
    for (const n of ep.entry.neighbors) {
      const peer = byMac.get(n.mac);
      if (peer === undefined || peer.nodeId === ep.nodeId || switchedEps.has(epKey(peer))) continue;
      addLane(ep, peer, null);
    }
  }

  // 4. Group lanes into links per node pair.
  const probesOf = (nodeId: string): LinkProbe[] => input.probes?.[nodeId] ?? [];
  const findProbe = (from: TopologyEndpoint, to: TopologyEndpoint): LinkProbe | undefined =>
    to.ip === null ? undefined : probesOf(from.nodeId).find((p) => p.iface === from.iface && p.peerIp === to.ip);
  const linkMap = new Map<string, TopologyLink>();
  for (const acc of lanes.values()) {
    const [aEp, bEp] = acc.x.nodeId < acc.y.nodeId ? [acc.x, acc.y] : [acc.y, acc.x];
    const aSeesB = aEp === acc.x ? acc.xSeesY : acc.ySeesX;
    const bSeesA = aEp === acc.x ? acc.ySeesX : acc.xSeesY;
    const a = endpointOf(aEp, acc.subnet);
    const b = endpointOf(bEp, acc.subnet);
    const probe = findProbe(a, b) ?? findProbe(b, a);
    const lane: TopologyLane = {
      a,
      b,
      subnet: acc.subnet,
      evidence: aSeesB && bSeesA ? "confirmed" : aSeesB || bSeesA ? "neighbor" : "subnet",
      up: a.operState === "up" && b.operState === "up",
      probe: probe === undefined ? null : { rttAvgMs: probe.rttAvgMs, rttMaxMs: probe.rttMaxMs, lossPct: probe.lossPct, at: probe.at },
    };
    const id = `${a.nodeId}|${b.nodeId}`;
    const link = linkMap.get(id) ?? { id, a: a.nodeId, b: b.nodeId, medium: "unknown" as LinkMedium, speedMbps: null, lanes: [], lanesUp: 0 };
    link.lanes.push(lane);
    linkMap.set(id, link);
  }
  const oldAgent = (ep: TopologyEndpoint): boolean => (input.network[ep.nodeId] ?? []).find((e) => e.iface === ep.iface)?.kind == null;
  const links = [...linkMap.values()];
  for (const link of links) {
    link.lanes.sort((x, y) => x.a.iface.localeCompare(y.a.iface));
    link.lanesUp = link.lanes.filter((l) => l.up).length;
    const speeds = link.lanes.flatMap((l) => [l.a.speedMbps, l.b.speedMbps]).filter((s): s is number => s !== null);
    link.speedMbps = speeds.length === 0 ? null : Math.max(...link.lanes.map((l) => Math.min(l.a.speedMbps ?? Infinity, l.b.speedMbps ?? Infinity)).filter(Number.isFinite));
    const roce = (ep: TopologyEndpoint): boolean => ep.rdma !== null && (ep.rdma.linkLayer ?? "Ethernet") === "Ethernet";
    link.medium = link.lanes.some((l) => oldAgent(l.a) || oldAgent(l.b))
      ? "unknown"
      : link.lanes.every((l) => roce(l.a) && roce(l.b))
        ? "roce"
        : "ethernet";
  }
  links.sort((x, y) => `${nameOf(x.a)}|${nameOf(x.b)}`.localeCompare(`${nameOf(y.a)}|${nameOf(y.b)}`));

  // 5. Clusters, roles, node summaries.
  const clusterSetups = input.setups.filter((s) => s.kind === "cluster" && sparkIds.has(s.headNodeId));
  const adjacency = new Map<string, Set<string>>();
  const connect = (p: string, q: string): void => {
    adjacency.set(p, (adjacency.get(p) ?? new Set()).add(q));
    adjacency.set(q, (adjacency.get(q) ?? new Set()).add(p));
  };
  for (const l of links) if (l.lanesUp > 0) connect(l.a, l.b);
  for (const sw of switches) {
    const up = sw.members.filter((m) => m.operState === "up").map((m) => m.nodeId);
    for (const p of up) for (const q of up) if (p < q) connect(p, q);
  }
  const reaches = (from: string, to: string, allowed: Set<string>): boolean => {
    const seen = new Set([from]);
    const queue = [from];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (cur === to) return true;
      for (const nxt of adjacency.get(cur) ?? []) {
        if (!seen.has(nxt) && allowed.has(nxt)) {
          seen.add(nxt);
          queue.push(nxt);
        }
      }
    }
    return false;
  };

  const warnings: TopologyWarning[] = [];
  const clusters: TopologyCluster[] = clusterSetups.map((s) => {
    const memberIds = [s.headNodeId, ...s.nodes.map((n) => n.nodeId).filter((id) => id !== s.headNodeId && sparkIds.has(id))];
    const head = byId.get(s.headNodeId);
    let fabricPath: boolean | null = null;
    if (head?.online === true) {
      const allowed = new Set(memberIds.filter((id) => byId.get(id)?.online === true));
      const stranded = [...allowed].filter((id) => id !== s.headNodeId && !reaches(id, s.headNodeId, allowed));
      fabricPath = stranded.length === 0;
      for (const id of stranded) {
        warnings.push({
          code: "cluster-no-path",
          severity: "warn",
          message: `${nameOf(id)} has no RoCE path to ${nameOf(s.headNodeId)}, the head of ${s.name}.`,
          nodeIds: [id, s.headNodeId],
        });
      }
    }
    return { id: s.id, name: s.name, headNodeId: s.headNodeId, memberIds, running: s.status === "running", fabricPath };
  });

  const nodes: TopologyNode[] = [...sparks]
    .sort((x, y) => x.name.localeCompare(y.name))
    .map((n) => {
      const own = eps.filter((e) => e.nodeId === n.id);
      const fabricIps = new Set(own.flatMap((e) => e.subnets.map((s) => s.ip)));
      const hostAddrs = n.hostAddrs ?? (ipv4ToInt(n.host) !== null ? [n.host] : undefined);
      const hostOnFabric = own.length === 0 || hostAddrs === undefined ? null : hostAddrs.some((a) => fabricIps.has(a));
      const role: TopologyRole = clusterSetups.some((s) => s.headNodeId === n.id)
        ? "head"
        : clusterSetups.some((s) => s.nodes.some((m) => m.nodeId === n.id))
          ? "worker"
          : "standalone";
      return {
        id: n.id,
        name: n.name,
        online: n.online,
        role,
        clusterIds: clusterSetups.filter((s) => s.headNodeId === n.id || s.nodes.some((m) => m.nodeId === n.id)).map((s) => s.id),
        fabricIfaces: own.length,
        hostOnFabric,
      };
    });

  // 6. Link and node warnings.
  for (const link of links) {
    const mtu = link.lanes.filter((l) => l.a.mtu !== null && l.b.mtu !== null && l.a.mtu !== l.b.mtu);
    if (mtu.length > 0) {
      const l = mtu[0]!;
      warnings.push({
        code: "mtu-mismatch",
        severity: "warn",
        message: `${nameOf(link.a)} ${l.a.iface} is MTU ${l.a.mtu} and ${nameOf(link.b)} ${l.b.iface} is MTU ${l.b.mtu}${mtu.length > 1 ? ` (${mtu.length} lanes)` : ""}.`,
        nodeIds: [link.a, link.b],
        linkId: link.id,
      });
    }
    const slow = link.lanes.filter((l) => l.a.speedMbps !== null && l.b.speedMbps !== null && l.a.speedMbps !== l.b.speedMbps);
    if (slow.length > 0) {
      const l = slow[0]!;
      warnings.push({
        code: "speed-mismatch",
        severity: "warn",
        message: `${nameOf(link.a)} ${l.a.iface} negotiated ${l.a.speedMbps! / 1000}G and ${nameOf(link.b)} ${l.b.iface} ${l.b.speedMbps! / 1000}G.`,
        nodeIds: [link.a, link.b],
        linkId: link.id,
      });
    }
    for (const l of link.lanes.filter((x) => !x.up)) {
      const down = l.a.operState !== "up" ? l.a : l.b;
      warnings.push({
        code: "lane-down",
        severity: "warn",
        message: `${nameOf(down.nodeId)} ${down.iface} is ${down.operState ?? "in an unknown state"} on the lane to ${nameOf(down === l.a ? l.b.nodeId : l.a.nodeId)}.`,
        nodeIds: [link.a, link.b],
        linkId: link.id,
      });
    }
  }
  for (const n of sparks.filter((x) => !x.online).sort((x, y) => x.name.localeCompare(y.name))) {
    warnings.push({ code: "node-offline", severity: "info", message: `${n.name} is offline; its links are not shown.`, nodeIds: [n.id] });
  }
  const offFabric = nodes.filter((n) => n.hostOnFabric === false);
  if (offFabric.length > 0) {
    warnings.push({
      code: "push-not-on-fabric",
      severity: "info",
      message: `${offFabric.map((n) => n.name).join(", ")} ${offFabric.length === 1 ? "is" : "are"} registered by a management-LAN address. Pushes use the fabric only between directly cabled Sparks.`,
      nodeIds: offFabric.map((n) => n.id),
    });
  }

  return { nodes, links, switches, clusters, warnings };
}

/**
 * Live per-link throughput from the latest snapshots, from node `a`'s side:
 * tx = a → b, rx = b → a, summed over lanes. Per lane the larger of the
 * RDMA and netdev rates is used: RoCE traffic bypasses /proc/net/dev, and
 * whether the port counters also include TCP depends on the firmware, so
 * taking the maximum never double counts.
 */
export function linkRates(
  link: Pick<TopologyLink, "lanes">,
  networkA: NetworkEntry[] | undefined,
): { txBps: number | null; rxBps: number | null } {
  let tx: number | null = null;
  let rx: number | null = null;
  for (const lane of link.lanes) {
    const e = networkA?.find((x) => x.iface === lane.a.iface);
    if (e === undefined) continue;
    const t = maxNullable(e.txBps, e.rdmaTxBps);
    const r = maxNullable(e.rxBps, e.rdmaRxBps);
    if (t !== null) tx = (tx ?? 0) + t;
    if (r !== null) rx = (rx ?? 0) + r;
  }
  return { txBps: tx, rxBps: rx };
}

function maxNullable(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a == null) return b ?? null;
  if (b == null) return a;
  return Math.max(a, b);
}

/**
 * IRI-165: the far end of every lane that touches `nodeId` — the prober's
 * expected peers (iface = this node's netdev, ip = the peer's address).
 */
export function expectedPeersOf(topology: Pick<Topology, "links">, nodeId: string): Array<{ iface: string; ip: string }> {
  const out: Array<{ iface: string; ip: string }> = [];
  for (const link of topology.links) {
    for (const lane of link.lanes) {
      const [mine, theirs] = lane.a.nodeId === nodeId ? [lane.a, lane.b] : lane.b.nodeId === nodeId ? [lane.b, lane.a] : [null, null];
      if (mine === null || theirs === null || theirs.ip === null || !IPV4_RE.test(theirs.ip) || !NET_IFACE_RE.test(mine.iface)) continue;
      out.push({ iface: mine.iface, ip: theirs.ip });
    }
  }
  return out.slice(0, 32);
}

/**
 * IRI-167: the destination's fabric address on every up lane of a DIRECT
 * link between `sourceId` and `destId` (lane order), or [] when the two are
 * not directly cabled. Multi-hop paths are never used for pushes.
 */
export function fabricHostsFor(topology: Pick<Topology, "links">, sourceId: string, destId: string): string[] {
  const link = topology.links.find((l) => (l.a === sourceId && l.b === destId) || (l.a === destId && l.b === sourceId));
  if (link === undefined) return [];
  const out: string[] = [];
  for (const lane of link.lanes) {
    if (!lane.up) continue;
    const dest = lane.a.nodeId === destId ? lane.a : lane.b;
    if (dest.ip !== null && IPV4_RE.test(dest.ip)) out.push(dest.ip);
  }
  return out;
}

/** IRI-167: the node that owns a fabric address in the topology, if any. */
export function nodeForFabricIp(topology: Pick<Topology, "links" | "switches">, ip: string): string | null {
  for (const link of topology.links) for (const lane of link.lanes) for (const ep of [lane.a, lane.b]) if (ep.ip === ip) return ep.nodeId;
  for (const sw of topology.switches) for (const m of sw.members) if (m.ip === ip) return m.nodeId;
  return null;
}
