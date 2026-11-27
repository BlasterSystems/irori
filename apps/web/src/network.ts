import type { Topology, TopologyLink, TopologyNode } from "@irori/core";

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

/** Positions on an ellipse, rotated so a ring of four sits as a square. */
export function diagramLayout(order: string[], width = 720, height = 340): DiagramLayout {
  const pos = new Map<string, { x: number; y: number }>();
  const n = order.length;
  const cx = width / 2;
  const cy = height / 2;
  if (n === 1) pos.set(order[0]!, { x: cx, y: cy });
  const rx = width / 2 - 110;
  const ry = height / 2 - 50;
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

/** Latency of a link: the worst up lane's prober RTT and loss. */
export function linkLatency(link: TopologyLink): { rttMs: number | null; lossPct: number | null; at: number | null } {
  const probes = link.lanes.filter((l) => l.up && l.probe !== null).map((l) => l.probe!);
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
  return ms < 1 ? `${ms.toFixed(3)} ms` : `${ms.toFixed(2)} ms`;
}

export function roleLabel(role: TopologyNode["role"]): string {
  return role === "head" ? "head" : role === "worker" ? "worker" : "standalone";
}
