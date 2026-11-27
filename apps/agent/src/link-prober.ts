import { execFile } from "node:child_process";
import { IPV4_RE, NET_IFACE_RE, type LinkProbe } from "@irori/core";
import type { LinkFacts } from "./link-facts.js";

/**
 * IRI-165 (ADR-0021): fabric latency prober. Every interval it pings each
 * fabric peer — its ARP neighbours plus the hub's expected peers — with a
 * short burst bound to the fabric netdev. ~25 packets per 10 s per peer, at
 * most MAX_PEERS peers, execFile only (no shell), inputs validated first.
 */

export const DEFAULT_PROBE_INTERVAL_S = 10;
export const MAX_PEERS = 16;
const PING_ARGS = ["-n", "-q", "-c", "5", "-i", "0.2", "-W", "1"];
const PING_TIMEOUT_MS = 4_000;

export interface PingSummary {
  transmitted: number;
  received: number;
  lossPct: number;
  rttMinMs: number | null;
  rttAvgMs: number | null;
  rttMaxMs: number | null;
  mdevMs: number | null;
}

/**
 * iputils `ping -q` summary. 100 % loss prints no rtt line; garbage (or a
 * ping that failed to start) is null so the caller reports 100 % loss.
 */
export function parsePingSummary(stdout: string): PingSummary | null {
  const counts = /(\d+) packets transmitted, (\d+) (?:packets )?received/.exec(stdout);
  if (counts === null) return null;
  const transmitted = Number(counts[1]);
  const received = Number(counts[2]);
  const loss = /([\d.]+)% packet loss/.exec(stdout);
  const lossPct = loss !== null ? Number(loss[1]) : transmitted > 0 ? Math.round((1 - received / transmitted) * 1000) / 10 : 100;
  const rtt = /= ([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+) ms/.exec(stdout);
  return {
    transmitted,
    received,
    lossPct: Math.min(100, Math.max(0, lossPct)),
    rttMinMs: rtt === null ? null : Number(rtt[1]),
    rttAvgMs: rtt === null ? null : Number(rtt[2]),
    rttMaxMs: rtt === null ? null : Number(rtt[3]),
    mdevMs: rtt === null ? null : Number(rtt[4]),
  };
}

export type PingRunner = (iface: string, ip: string) => Promise<string>;

/** Runs ping; a non-zero exit (no replies) still yields its stdout. */
export const defaultPingRunner: PingRunner = (iface, ip) =>
  new Promise((resolve) => {
    execFile("ping", [...PING_ARGS, "-I", iface, ip], { timeout: PING_TIMEOUT_MS }, (_err, stdout) => resolve(String(stdout ?? "")));
  });

/** Peers to probe: hub-expected first, then fabric ARP neighbours; validated, deduped, capped. */
export function probeTargets(
  facts: ReadonlyMap<string, LinkFacts>,
  hubPeers: ReadonlyArray<{ iface: string; ip: string }>,
): Array<{ iface: string; ip: string }> {
  const seen = new Set<string>();
  const out: Array<{ iface: string; ip: string }> = [];
  const add = (iface: string, ip: string): void => {
    if (!NET_IFACE_RE.test(iface) || !IPV4_RE.test(ip)) return;
    // Only probe out of an interface this node classifies as fabric (RoCE scope).
    if (facts.size > 0 && facts.get(iface)?.kind !== "fabric") return;
    const key = `${iface}/${ip}`;
    if (seen.has(key) || out.length >= MAX_PEERS) return;
    seen.add(key);
    out.push({ iface, ip });
  };
  for (const p of hubPeers) add(p.iface, p.ip);
  for (const [iface, f] of facts) if (f.kind === "fabric") for (const n of f.neighbors) add(iface, n.ip);
  return out;
}

export interface LinkProberOptions {
  facts: () => ReadonlyMap<string, LinkFacts>;
  ping?: PingRunner;
  now?: () => number;
  log?: (m: string) => void;
}

export class LinkProber {
  private intervalS = DEFAULT_PROBE_INTERVAL_S;
  private hubPeers: Array<{ iface: string; ip: string }> = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  /** start() was called (and stop() not since): an interval change re-arms it. */
  private started = false;
  private latest = new Map<string, LinkProbe>();
  private readonly ping: PingRunner;
  private readonly now: () => number;

  constructor(private readonly opts: LinkProberOptions) {
    this.ping = opts.ping ?? defaultPingRunner;
    this.now = opts.now ?? Date.now;
  }

  /** Apply config-update values; undefined keeps the current value. */
  configure(intervalS: number | undefined, peers: Array<{ iface: string; ip: string }> | undefined): void {
    if (peers !== undefined) this.hubPeers = peers;
    if (intervalS !== undefined && intervalS !== this.intervalS) {
      this.intervalS = intervalS;
      // 0 → 10 must re-arm too: a disabled prober has no timer but is still started.
      if (this.started) this.start();
    }
  }

  start(): void {
    this.stop();
    this.started = true;
    if (this.intervalS <= 0) {
      this.latest.clear();
      return;
    }
    this.timer = setInterval(() => void this.tick(), this.intervalS * 1000);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.started = false;
  }

  /** Latest result per (iface, peer), dropping peers no longer targeted. */
  results(): LinkProbe[] {
    return [...this.latest.values()];
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const targets = probeTargets(this.opts.facts(), this.hubPeers);
      const keep = new Set(targets.map((t) => `${t.iface}/${t.ip}`));
      for (const key of [...this.latest.keys()]) if (!keep.has(key)) this.latest.delete(key);
      await Promise.all(
        targets.map(async (t) => {
          let summary: PingSummary | null = null;
          try {
            summary = parsePingSummary(await this.ping(t.iface, t.ip));
          } catch {
            summary = null;
          }
          this.latest.set(`${t.iface}/${t.ip}`, {
            iface: t.iface,
            peerIp: t.ip,
            rttMinMs: summary?.rttMinMs ?? null,
            rttAvgMs: summary?.rttAvgMs ?? null,
            rttMaxMs: summary?.rttMaxMs ?? null,
            mdevMs: summary?.mdevMs ?? null,
            // An unreachable peer (or a ping that could not run) is 100 % loss — never a throw.
            lossPct: summary?.lossPct ?? 100,
            at: this.now(),
          });
        }),
      );
    } catch (err) {
      this.opts.log?.(`link prober tick failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }
  }
}
