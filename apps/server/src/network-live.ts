import { randomUUID } from "node:crypto";
import { NET_LIVE_LEASE_MS, NET_LIVE_MAX_LEASE_MS, type NetLiveLease, type NetRatesMsg, type SseEvent } from "@irori/core";

/**
 * IRI-164 (ADR-0021): the leased live-rate stream. Browsers take a 60 s
 * lease and renew it while the card is visible; one shared stream serves
 * every viewer at the fastest requested interval. Agents get `net-live`
 * with a relative duration (lease TTL + slack) and are re-told every
 * REBROADCAST_MS while a lease is active, so an agent that reconnects or
 * misses a frame catches up and one that loses the hub stops by itself.
 * Rates reach browsers as SSE only — never rings, rollups or the database.
 */

export const REBROADCAST_MS = 20_000;
/** Agents keep streaming this long past the last net-live frame. */
export const AGENT_DURATION_MS = NET_LIVE_LEASE_MS + 15_000;

interface Lease {
  id: string;
  intervalMs: number;
  createdAt: number;
  expiresAt: number;
}

export type NetLiveAcquire = { ok: true; lease: NetLiveLease } | { ok: false; reason: "disabled" | "unknown-lease" | "lease-ended" };

export interface NetLiveService {
  acquire(intervalMs: number, leaseId?: string): NetLiveAcquire;
  release(leaseId: string): boolean;
  /** Effective interval, or null when no lease is active. */
  effectiveIntervalMs(): number | null;
  status(): { enabled: boolean; effectiveIntervalMs: number | null; leases: number };
  /** Agent frame from the hub's first handler; dropped while no lease runs. */
  onRates(nodeId: string, msg: NetRatesMsg): void;
  /** A node came online: tell it the current stream (if any). */
  onNodeOnline(nodeId: string): void;
  /** Expire leases and (re)broadcast; called on a timer. */
  tick(): void;
  /** Kill switch flipped off: end every lease and stop the agents. */
  stopAll(): void;
}

export interface NetLiveDeps {
  enabled: () => boolean;
  /** Online Sparks with fabric interfaces (the stream's audience). */
  fabricNodes: () => string[];
  sendToNode: (nodeId: string, msg: unknown) => boolean;
  sse: { send(event: SseEvent): void };
  now?: () => number;
}

export function createNetLive(deps: NetLiveDeps): NetLiveService {
  const now = deps.now ?? Date.now;
  const leases = new Map<string, Lease>();
  let broadcastInterval: number | null = null;
  let lastBroadcastAt = 0;

  const effective = (): number | null => {
    const t = now();
    let best: number | null = null;
    for (const l of leases.values()) if (l.expiresAt > t && (best === null || l.intervalMs < best)) best = l.intervalMs;
    return best;
  };

  const frameFor = (interval: number | null) =>
    interval === null ? { type: "net-live", intervalMs: 0, durationMs: 0 } : { type: "net-live", intervalMs: interval, durationMs: AGENT_DURATION_MS };

  function broadcast(force = false): void {
    const interval = effective();
    if (!force && interval === broadcastInterval && (interval === null || now() - lastBroadcastAt < REBROADCAST_MS)) return;
    for (const nodeId of deps.fabricNodes()) deps.sendToNode(nodeId, frameFor(interval));
    broadcastInterval = interval;
    lastBroadcastAt = now();
  }

  const view = (l: Lease): NetLiveLease => ({
    leaseId: l.id,
    intervalMs: l.intervalMs,
    effectiveIntervalMs: effective() ?? l.intervalMs,
    expiresAt: new Date(l.expiresAt).toISOString(),
    endsAt: new Date(l.createdAt + NET_LIVE_MAX_LEASE_MS).toISOString(),
  });

  const expire = (): void => {
    const t = now();
    for (const [id, l] of leases) if (l.expiresAt <= t) leases.delete(id);
  };

  return {
    acquire(intervalMs, leaseId) {
      if (!deps.enabled()) return { ok: false, reason: "disabled" };
      const t = now();
      // The cap is checked before TTL expiry, so a renewal at the limit gets
      // "lease-ended" (stop) and one after a lapse gets "unknown-lease" (re-take).
      const existing = leaseId === undefined ? undefined : leases.get(leaseId);
      if (existing !== undefined && t >= existing.createdAt + NET_LIVE_MAX_LEASE_MS) {
        leases.delete(existing.id);
        broadcast();
        return { ok: false, reason: "lease-ended" };
      }
      expire();
      let lease: Lease | undefined;
      if (leaseId !== undefined) {
        lease = leases.get(leaseId);
        if (lease === undefined) return { ok: false, reason: "unknown-lease" };
        lease.intervalMs = intervalMs;
      } else {
        lease = { id: randomUUID(), intervalMs, createdAt: t, expiresAt: t };
        leases.set(lease.id, lease);
      }
      lease.expiresAt = Math.min(t + NET_LIVE_LEASE_MS, lease.createdAt + NET_LIVE_MAX_LEASE_MS);
      broadcast();
      return { ok: true, lease: view(lease) };
    },
    release(leaseId) {
      const had = leases.delete(leaseId);
      if (had) broadcast();
      return had;
    },
    effectiveIntervalMs: effective,
    status: () => ({ enabled: deps.enabled(), effectiveIntervalMs: effective(), leases: [...leases.values()].filter((l) => l.expiresAt > now()).length }),
    onRates(nodeId, msg) {
      if (effective() === null) return; // no viewer: a stray or late frame
      if (!deps.fabricNodes().includes(nodeId)) return; // only the stream's audience (never the NAS)
      deps.sse.send({ type: "net-rates", serverTimeMs: now(), nodeId, intervalMs: msg.intervalMs, ifaces: msg.ifaces });
    },
    onNodeOnline(nodeId) {
      const interval = effective();
      if (interval !== null) deps.sendToNode(nodeId, frameFor(interval));
    },
    tick() {
      expire();
      if (!deps.enabled() && leases.size > 0) leases.clear();
      broadcast();
    },
    stopAll() {
      leases.clear();
      broadcast(true);
    },
  };
}
