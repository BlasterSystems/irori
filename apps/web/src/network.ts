import type { LinkProbe, NetLiveLease, NetRate, NetworkEntry, NetworkTestView, Topology, TopologyLink, TopologyNode } from "@irori/core";

/**
 * IRI-163 (ADR-0021): Overview Network card data — topology fetch, the SVG
 * layout and formatting. Pure helpers so the card stays a thin view.
 */

export type TopologyView = Topology & { generatedAt: string };

export async function fetchTopology(signal?: AbortSignal): Promise<TopologyView> {
  const res = await fetch("/api/v1/network/topology", { headers: { accept: "application/json" }, signal });
  if (!res.ok) throw new Error(`GET /api/v1/network/topology failed: HTTP ${res.status}`);
  const body = (await res.json()) as Partial<TopologyView> | null;
  const lists = ["nodes", "links", "switches", "clusters", "warnings"] as const;
  if (body === null || typeof body !== "object" || lists.some((k) => !Array.isArray(body[k]))) {
    throw new Error("malformed topology payload");
  }
  return body as TopologyView;
}

/**
 * Node order around the diagram: walk the links so a ring (or a chain)
 * comes out in cable order and its edges never cross; nodes without links
 * follow, by name.
 */
export function ringOrder(nodes: TopologyNode[], links: TopologyLink[]): string[] {
  const adj = new Map<string, Set<string>>();
  for (const l of links) {
    adj.set(l.a, (adj.get(l.a) ?? new Set()).add(l.b));
    adj.set(l.b, (adj.get(l.b) ?? new Set()).add(l.a));
  }
  const byName = [...nodes].sort((x, y) => x.name.localeCompare(y.name));
  const nameOf = new Map(nodes.map((n) => [n.id, n.name]));
  const seen = new Set<string>();
  const order: string[] = [];
  // Chains start at an end (degree 1) so they unroll instead of folding back.
  const starts = [...byName.filter((n) => (adj.get(n.id)?.size ?? 0) === 1), ...byName];
  for (const start of starts) {
    if (seen.has(start.id) || !adj.has(start.id)) continue;
    let cur: string | undefined = start.id;
    while (cur !== undefined) {
      seen.add(cur);
      order.push(cur);
      const next: string[] = [...(adj.get(cur) ?? [])].filter((x) => !seen.has(x)).sort((x, y) => (nameOf.get(x) ?? x).localeCompare(nameOf.get(y) ?? y));
      cur = next[0];
    }
  }
  for (const n of byName) if (!seen.has(n.id)) order.push(n.id);
  return order;
}

export interface DiagramLayout {
  width: number;
  height: number;
  pos: Map<string, { x: number; y: number }>;
}

/** Node tile size in diagram units (IR-286). */
export const TILE = { w: 132, h: 50 } as const;

/**
 * Positions on an ellipse, rotated so a ring of four sits as a square.
 * IR-286: a compact 520×380 box whose margins only clear the tiles, so the
 * ring fills its column instead of floating in a letterboxed band.
 */
export function diagramLayout(order: string[], width = 520, height = 380): DiagramLayout {
  const pos = new Map<string, { x: number; y: number }>();
  const n = order.length;
  const cx = width / 2;
  const cy = height / 2;
  if (n === 1) pos.set(order[0]!, { x: cx, y: cy });
  const rx = width / 2 - (TILE.w / 2 + 4);
  const ry = height / 2 - (TILE.h / 2 + 5);
  const start = n === 2 ? Math.PI : -Math.PI / 2 - Math.PI / n;
  if (n >= 2) {
    order.forEach((id, i) => {
      const t = start + (2 * Math.PI * i) / n;
      pos.set(id, { x: Math.round(cx + rx * Math.cos(t)), y: Math.round(cy + ry * Math.sin(t)) });
    });
  }
  return { width, height, pos };
}

/** "RoCE v2", "Ethernet" or "Fabric" (agents that predate link facts). */
export function mediumLabel(link: Pick<TopologyLink, "medium">): string {
  return link.medium === "roce" ? "RoCE v2" : link.medium === "ethernet" ? "Ethernet" : "Fabric";
}

/** e.g. "RoCE v2 · 200G ×2 · MTU 9000", "… MTU 9000 ≠ 1500" on a mismatch. */
export function linkFormat(link: TopologyLink): string {
  const parts = [mediumLabel(link)];
  if (link.speedMbps !== null) parts.push(`${Math.round(link.speedMbps / 1000)}G${link.lanes.length > 1 ? ` ×${link.lanes.length}` : ""}`);
  const mtus = [...new Set(link.lanes.flatMap((l) => [l.a.mtu, l.b.mtu]).filter((m): m is number => m !== null))].sort((x, y) => y - x);
  if (mtus.length > 0) parts.push(`MTU ${mtus.join(" ≠ ")}`);
  return parts.join(" · ");
}

/** Bytes/s → "18.4 Gb/s"; sub-Gb/s values in Mb/s; null → "—". */
export function fmtBits(bps: number | null): string {
  if (bps === null) return "—";
  const bits = bps * 8;
  if (bits >= 1e9) return `${(bits / 1e9).toFixed(1)} Gb/s`;
  if (bits >= 1e6) return `${(bits / 1e6).toFixed(1)} Mb/s`;
  if (bits >= 1e3) return `${(bits / 1e3).toFixed(0)} kb/s`;
  return `${Math.round(bits)} b/s`;
}

/** Utilisation of the busier direction against the link speed, 0–100. */
export function utilPct(rates: { txBps: number | null; rxBps: number | null }, speedMbps: number | null): number | null {
  if (speedMbps === null || speedMbps <= 0) return null;
  const peak = Math.max(rates.txBps ?? 0, rates.rxBps ?? 0);
  if (rates.txBps === null && rates.rxBps === null) return null;
  return Math.min(100, Math.round(((peak * 8) / (speedMbps * 1e6)) * 1000) / 10);
}

/**
 * Latency of a link: the worst up lane's prober RTT and loss. Live probes
 * from the SSE snapshots (2 s) win over the topology's copy (30 s refresh),
 * so a fresh result shows within one probe interval.
 */
export function linkLatency(
  link: TopologyLink,
  live?: { a?: LinkProbe[]; b?: LinkProbe[] },
): { rttMs: number | null; lossPct: number | null; at: number | null } {
  const probes = link.lanes
    .filter((l) => l.up)
    .map((l) => {
      const fromA = l.b.ip === null ? undefined : live?.a?.find((p) => p.iface === l.a.iface && p.peerIp === l.b.ip);
      const fromB = l.a.ip === null ? undefined : live?.b?.find((p) => p.iface === l.b.iface && p.peerIp === l.a.ip);
      const p = fromA ?? fromB;
      return p === undefined ? l.probe : { rttAvgMs: p.rttAvgMs, rttMaxMs: p.rttMaxMs, lossPct: p.lossPct, at: p.at };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);
  if (probes.length === 0) return { rttMs: null, lossPct: null, at: null };
  const rtts = probes.map((p) => p.rttAvgMs).filter((r): r is number => r !== null);
  return {
    rttMs: rtts.length === 0 ? null : Math.max(...rtts),
    lossPct: Math.max(...probes.map((p) => p.lossPct)),
    at: Math.min(...probes.map((p) => p.at)),
  };
}

export function fmtRtt(ms: number | null): string {
  if (ms === null) return "—";
  // RDMA latency is a few µs: show it in µs rather than as "0.002 ms".
  if (ms < 0.01) return `${(ms * 1000).toFixed(2)} µs`;
  return ms < 1 ? `${ms.toFixed(3)} ms` : `${ms.toFixed(2)} ms`;
}

export function roleLabel(role: TopologyNode["role"]): string {
  return role === "head" ? "head" : role === "worker" ? "worker" : "standalone";
}

// ---------------------------------------------------------------------------
// IRI-164: opt-in live rates (leased; SSE `net-rates` frames).
// ---------------------------------------------------------------------------

/** How often the card renews its lease while visible (TTL is 60 s). */
export const LIVE_RENEW_MS = 30_000;

export class LiveLeaseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** 410 only: "lease-ended" (10-minute cap) or "unknown-lease" (lapsed). */
    readonly reason: string | null = null,
  ) {
    super(message);
  }
}

export async function acquireLiveLease(intervalMs: number, leaseId?: string): Promise<NetLiveLease> {
  const res = await fetch("/api/v1/network/live", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(leaseId === undefined ? { intervalMs } : { intervalMs, leaseId }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string; reason?: string };
  if (!res.ok) throw new LiveLeaseError(body.error ?? `HTTP ${res.status}`, res.status, body.reason ?? null);
  return body as NetLiveLease;
}

export async function releaseLiveLease(leaseId: string): Promise<void> {
  await fetch(`/api/v1/network/live/${encodeURIComponent(leaseId)}`, { method: "DELETE" }).catch(() => undefined);
}

/**
 * Snapshot entries with a fresh live frame's rates laid over them (fresh =
 * received within STALE_INTERVALS of its interval). A stale frame, or none,
 * leaves the 2 s snapshot rates in place: the fallback for old agents.
 */
export function withLiveRates(
  entries: NetworkEntry[] | undefined,
  frame: { receivedAtMs: number; intervalMs: number; ifaces: NetRate[] } | undefined,
  nowMs: number,
): NetworkEntry[] | undefined {
  if (entries === undefined || frame === undefined || !liveFrameFresh(frame, nowMs)) return entries;
  const byIface = new Map(frame.ifaces.map((r) => [r.iface, r]));
  return entries.map((e) => {
    const r = byIface.get(e.iface);
    return r === undefined ? e : { ...e, rxBps: r.rxBps, txBps: r.txBps, rdmaRxBps: r.rdmaRxBps, rdmaTxBps: r.rdmaTxBps };
  });
}

// ---------------------------------------------------------------------------
// IRI-166: on-demand link tests.
// ---------------------------------------------------------------------------

export class LinkTestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** 409 guard: why an endpoint is busy (serving, transferring). */
    readonly reasons: string[] = [],
  ) {
    super(message);
  }
}

export async function fetchLinkTests(signal?: AbortSignal): Promise<{ tests: NetworkTestView[]; running: boolean }> {
  const res = await fetch("/api/v1/network/tests?limit=100", { headers: { accept: "application/json" }, signal });
  if (!res.ok) throw new Error(`GET /api/v1/network/tests failed: HTTP ${res.status}`);
  const body = (await res.json()) as { tests?: unknown; running?: unknown };
  if (!Array.isArray(body.tests)) throw new Error("malformed link tests payload");
  return { tests: body.tests as NetworkTestView[], running: body.running === true };
}

async function postTest(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
  const out = (await res.json().catch(() => ({}))) as { error?: string; reasons?: string[] };
  if (!res.ok) throw new LinkTestError(out.error ?? `HTTP ${res.status}`, res.status, Array.isArray(out.reasons) ? out.reasons : []);
  return out;
}

export const startLinkTest = (aNodeId: string, bNodeId: string, override: boolean, tool: string = "iperf3"): Promise<unknown> =>
  postTest("/api/v1/network/tests", { aNodeId, bNodeId, override, tool });

export const startAllLinkTests = (override: boolean, tool: string = "iperf3"): Promise<unknown> => postTest("/api/v1/network/tests/all", { override, tool });

/** Newest test per link (the list is newest first). */
export function latestTestByLink(tests: NetworkTestView[]): Map<string, NetworkTestView> {
  const out = new Map<string, NetworkTestView>();
  for (const t of tests) if (!out.has(t.linkId)) out.set(t.linkId, t);
  return out;
}

/** "3 h ago", "just now". */
export function ago(iso: string | null, nowMs: number): string {
  if (iso === null) return "";
  const s = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

/** The card's "last test" cell, labelled TCP so nobody reads it as NCCL bandwidth. */
export function testSummary(t: NetworkTestView | undefined, nowMs: number): string {
  if (t === undefined) return "never tested";
  if (t.status === "running") return `running · ${t.stage ?? "starting"}`;
  if (t.status === "failed") return `failed · ${ago(t.finishedAt ?? t.startedAt, nowMs)}`;
  // RDMA measures one direction (ib_write_bw); TCP measures both.
  const rate = t.tool === "rdma" ? `${t.forwardGbps ?? "—"} Gb/s RDMA write` : `${t.forwardGbps ?? "—"} / ${t.reverseGbps ?? "—"} Gb/s TCP`;
  const rtt = t.rttP50Ms === null ? "" : ` · p50 ${fmtRtt(t.rttP50Ms)}`;
  return `${rate}${rtt} · ${ago(t.finishedAt, nowMs)}`;
}

// ---------------------------------------------------------------------------
// IRI-168: per-link history (minute rows, 7 days) and the RDMA test tool.
// ---------------------------------------------------------------------------

export interface LinkHistoryPoint {
  t: string;
  txBps: number | null;
  rxBps: number | null;
  txMaxBps: number | null;
  rxMaxBps: number | null;
  rttMs: number | null;
  lossPct: number | null;
}

export async function fetchLinkHistory(linkId: string, range: "1h" | "24h" | "7d" = "24h"): Promise<LinkHistoryPoint[]> {
  const res = await fetch(`/api/v1/network/links/${encodeURIComponent(linkId)}/history?range=${range}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`link history failed: HTTP ${res.status}`);
  const body = (await res.json()) as { points?: unknown };
  return Array.isArray(body.points) ? (body.points as LinkHistoryPoint[]) : [];
}

/** Sparkline series: the busier direction per bin, in Gb/s. */
export function historySeries(points: LinkHistoryPoint[]): Array<number | null> {
  return points.map((p) => {
    const v = Math.max(p.txBps ?? -1, p.rxBps ?? -1);
    return v < 0 ? null : Math.round(((v * 8) / 1e9) * 100) / 100;
  });
}

export const LINK_TEST_TOOLS = [
  { value: "iperf3", label: "TCP (iperf3)" },
  { value: "rdma", label: "RDMA (perftest)" },
] as const;
export type LinkTestTool = (typeof LINK_TEST_TOOLS)[number]["value"];

// ---------------------------------------------------------------------------
// IRI-171 / IR-286: directional traffic motion, link state and the summary.
// ---------------------------------------------------------------------------

/** Fallback snapshot cadence for hubs that do not report `cadenceMs` (GET /api/v1/version, IR-87). */
export const SNAPSHOT_INTERVAL_MS = 2000;
/** A link's data is stale once its newest sample is older than this many intervals. */
export const STALE_INTERVALS = 2.5;

/** Bits/s at the bottom and top of the motion scale: 1 Mb/s and 400 Gb/s (one direction of 2×200G). */
const FLOW_MIN_BITS = 1e6;
const FLOW_MAX_BITS = 400e9;

/**
 * Motion intensity 0–1 for a per-direction rate in BYTES/s (the snapshot
 * contract's unit): log scale from 1 Mb/s (0) to 400 Gb/s (1), so 50 Mb/s and
 * 6 Gb/s both read as traffic on a 400G cable. Null or under 1 Mb/s → 0 (idle).
 */
export function flowIntensity(bytesPerSec: number | null): number {
  if (bytesPerSec === null || !Number.isFinite(bytesPerSec)) return 0;
  const bits = bytesPerSec * 8;
  if (bits < FLOW_MIN_BITS) return 0;
  return Math.min(1, Math.log10(bits / FLOW_MIN_BITS) / Math.log10(FLOW_MAX_BITS / FLOW_MIN_BITS));
}

/** Particle parameters for an intensity: px/s, dash gap (px) and opacity. Idle → no particles. */
export function flowParams(t: number): { speed: number; gap: number; opacity: number } | null {
  if (t <= 0) return null;
  return { speed: 18 + 150 * t, gap: 26 - 18 * t, opacity: 0.35 + 0.65 * t };
}

/**
 * Whether travel a → b runs clockwise around the drawing's centre, decided
 * from the DRAWN positions (screen coordinates, y down: a positive cross
 * product of the two centre-relative vectors is clockwise). Geometry, not list
 * order, so isolated nodes in the layout or chords cannot flip a lane. An edge
 * through the centre (two nodes, or a missing position) counts a → b as
 * clockwise.
 */
export function isClockwise(
  a: { x: number; y: number } | undefined,
  b: { x: number; y: number } | undefined,
  centre: { x: number; y: number },
): boolean {
  if (a === undefined || b === undefined) return true;
  const cross = (a.x - centre.x) * (b.y - centre.y) - (a.y - centre.y) * (b.x - centre.x);
  return Math.abs(cross) < 1e-6 ? true : cross > 0;
}

/**
 * Whether a live frame still overrides the snapshot rates. The same rule as
 * staleness (STALE_INTERVALS × the frame's interval), so the rates shown and
 * the freshness verdict always come from the same sample.
 */
export function liveFrameFresh(frame: { receivedAtMs: number; intervalMs: number }, nowMs: number): boolean {
  return nowMs - frame.receivedAtMs <= frame.intervalMs * STALE_INTERVALS;
}

/**
 * The sample a link's rates actually come from, and the cadence to judge it
 * by: a fresh live frame (Live on) at the frame's own interval, otherwise the
 * latest snapshot at the hub's snapshot cadence. Live on with no frames
 * arriving (old agent, lapsed lease) therefore stays judged as snapshots.
 */
export function sampleSource(input: {
  liveOn: boolean;
  frame: { receivedAtMs: number; intervalMs: number } | undefined;
  snapshotAtMs: number | undefined;
  snapshotIntervalMs: number;
  nowMs: number;
}): { lastSampleMs: number | null; intervalMs: number } {
  // A late frame hands over to the snapshot (rates and verdict together, via
  // the shared liveFrameFresh rule) instead of flagging a fresh link stale.
  const f = input.frame;
  if (input.liveOn && f !== undefined && liveFrameFresh(f, input.nowMs)) {
    return { lastSampleMs: f.receivedAtMs, intervalMs: f.intervalMs };
  }
  return { lastSampleMs: input.snapshotAtMs ?? null, intervalMs: input.snapshotIntervalMs };
}

export type LinkFlowState = "ok" | "idle" | "stale" | "offline" | "down";

/** Link state, first match wins: down → offline → stale → idle → ok. */
export function linkFlowState(input: {
  lanesUp: number;
  online: boolean;
  lastSampleMs: number | null;
  intervalMs: number;
  nowMs: number;
  cwBps: number | null;
  ccwBps: number | null;
}): LinkFlowState {
  if (input.lanesUp === 0) return "down";
  if (!input.online) return "offline";
  if (input.lastSampleMs === null || input.nowMs - input.lastSampleMs > input.intervalMs * STALE_INTERVALS) return "stale";
  if (input.cwBps === null && input.ccwBps === null) return "stale";
  if (flowIntensity(input.cwBps) === 0 && flowIntensity(input.ccwBps) === 0) return "idle";
  return "ok";
}

/** The format every link shares (header subtitle), or null when links differ. */
export function sharedFormat(links: TopologyLink[]): string | null {
  const formats = new Set(links.map(linkFormat));
  return formats.size === 1 ? [...formats][0]! : null;
}

/** Load bar width 0–100: the busier direction on the log motion scale (a linear bar is a dot under 2 %). */
export function loadBarPct(cwBps: number | null, ccwBps: number | null): number {
  return Math.round(Math.max(flowIntensity(cwBps), flowIntensity(ccwBps)) * 1000) / 10;
}

/** "1.7 %", "<0.1 %", "—": the busier direction against the link speed. */
export function fmtLoadPct(util: number | null): string {
  if (util === null) return "—";
  if (util > 0 && util < 0.1) return "<0.1 %";
  return `${util < 10 ? util.toFixed(1) : Math.round(util)} %`;
}

export interface FlowRow {
  id: string;
  title: string;
  /** Endpoint names in clockwise order: cw = from → to, ccw = to → from. */
  from: string;
  to: string;
  cwBps: number | null;
  ccwBps: number | null;
  rttMs: number | null;
  state: LinkFlowState;
  warn: boolean;
}

export interface FabricSummary {
  health: "healthy" | "warn" | "no-data";
  warnings: number;
  linksUp: number;
  links: number;
  totalBps: number | null;
  busiest: { bps: number; from: string; to: string } | null;
  worstRtt: { ms: number; title: string } | null;
}

/** Card summary: health, both-direction total, busiest direction and worst RTT, over fresh links only. */
export function fabricSummary(rows: FlowRow[]): FabricSummary {
  const fresh = rows.filter((r) => r.state === "ok" || r.state === "idle");
  const warnings = rows.filter((r) => r.warn || r.state === "down").length;
  let total: number | null = null;
  let busiest: FabricSummary["busiest"] = null;
  for (const r of fresh) {
    for (const [bps, from, to] of [
      [r.cwBps, r.from, r.to],
      [r.ccwBps, r.to, r.from],
    ] as const) {
      if (bps === null) continue;
      total = (total ?? 0) + bps;
      if (busiest === null || bps > busiest.bps) busiest = { bps, from, to };
    }
  }
  const worst = fresh.filter((r) => r.rttMs !== null).sort((x, y) => y.rttMs! - x.rttMs!)[0];
  return {
    health: warnings > 0 ? "warn" : rows.length > 0 && fresh.length === 0 ? "no-data" : "healthy",
    warnings,
    linksUp: rows.filter((r) => r.state !== "down").length,
    links: rows.length,
    totalBps: total,
    busiest,
    worstRtt: worst === undefined ? null : { ms: worst.rttMs!, title: worst.title },
  };
}

/**
 * Two lanes for an edge between two tile centres: each lane is shortened to
 * the tile borders and offset ±`offset` px across the edge; the clockwise lane
 * sits on the side away from the ring centre (outer), counter-clockwise inner.
 * `cw` runs from → to and `ccw` to → from, both in travel direction.
 */
export function laneGeometry(
  from: { x: number; y: number },
  to: { x: number; y: number },
  centre: { x: number; y: number },
  tile: { w: number; h: number },
  offset = 5,
): {
  cw: [{ x: number; y: number }, { x: number; y: number }];
  ccw: [{ x: number; y: number }, { x: number; y: number }];
  mid: { x: number; y: number };
  outer: { x: number; y: number };
} {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  // Distance from a tile centre to its border along the edge direction.
  const inset = Math.min(Math.abs(ux) > 1e-6 ? tile.w / 2 / Math.abs(ux) : Infinity, Math.abs(uy) > 1e-6 ? tile.h / 2 / Math.abs(uy) : Infinity);
  const p1 = { x: from.x + ux * inset, y: from.y + uy * inset };
  const p2 = { x: to.x - ux * inset, y: to.y - uy * inset };
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  // Normal pointing away from the ring centre.
  let nx = -uy;
  let ny = ux;
  if ((mid.x - centre.x) * nx + (mid.y - centre.y) * ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  const o = (p: { x: number; y: number }, s: number) => ({ x: p.x + nx * offset * s, y: p.y + ny * offset * s });
  return { cw: [o(p1, 1), o(p2, 1)], ccw: [o(p2, -1), o(p1, -1)], mid, outer: { x: nx, y: ny } };
}

/** Arrow glyph for travel from → to (screen coordinates: y grows downward). */
export function arrowFor(from: { x: number; y: number }, to: { x: number; y: number }): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "→" : "←";
  return dy >= 0 ? "↓" : "↑";
}
