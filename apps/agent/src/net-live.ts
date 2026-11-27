import { promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { NET_LIVE_FLOOR_MS, NET_LIVE_MAX_DURATION_MS, type NetRate, type NetRatesMsg } from "@irori/core";
import { counterRate, sampleRdmaCounters, type LinkFacts, type RdmaCounters } from "./link-facts.js";

/**
 * IRI-164 (ADR-0021): the leased live-rate stream. On `net-live` the agent
 * samples its fabric interfaces' netdev and RDMA counters every intervalMs
 * and sends one `net-rates` frame per sample, until durationMs elapses, a
 * stop frame arrives, or the socket closes. Frames are never buffered: a
 * live sample is worthless later.
 */

export interface NetLiveOptions {
  procRoot?: string;
  sysRoot?: string;
  facts: () => ReadonlyMap<string, LinkFacts>;
  /** Returns false when the frame could not be sent (socket not ready). */
  send: (msg: NetRatesMsg) => boolean;
  now?: () => number;
  log?: (m: string) => void;
}

type Counters = Map<string, { rx: number; tx: number }>;

async function readNetDev(procRoot: string, ifaces: ReadonlySet<string>): Promise<Counters> {
  const out: Counters = new Map();
  try {
    const text = await fs.readFile(path.join(procRoot, "net", "dev"), "utf8");
    for (const line of text.split("\n").slice(2)) {
      const sep = line.indexOf(":");
      if (sep < 0) continue;
      const iface = line.slice(0, sep).trim();
      if (!ifaces.has(iface)) continue;
      const f = line.slice(sep + 1).trim().split(/\s+/);
      const rx = Number(f[0]);
      const tx = Number(f[8]);
      if (Number.isFinite(rx) && Number.isFinite(tx)) out.set(iface, { rx, tx });
    }
  } catch {
    // no procfs — netdev rates stay null
  }
  return out;
}

export class NetLive {
  private timer: ReturnType<typeof setInterval> | undefined;
  private deadline = 0;
  private intervalMs = 0;
  private prev: { at: number; net: Counters; rdma: RdmaCounters } | null = null;
  private sampling = false;
  private readonly now: () => number;

  constructor(private readonly opts: NetLiveOptions) {
    this.now = opts.now ?? Date.now;
  }

  get active(): boolean {
    return this.timer !== undefined;
  }

  /** Apply a net-live frame. Values are clamped again here (defence in depth). */
  apply(intervalMs: number, durationMs: number): void {
    if (intervalMs <= 0 || durationMs <= 0) {
      this.stop();
      return;
    }
    const interval = Math.max(NET_LIVE_FLOOR_MS, Math.min(10_000, Math.round(intervalMs)));
    this.deadline = this.now() + Math.min(durationMs, NET_LIVE_MAX_DURATION_MS);
    if (this.timer !== undefined && interval === this.intervalMs) return; // renewal only
    this.stop();
    this.intervalMs = interval;
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref?.();
    void this.tick(); // baseline sample
    this.opts.log?.(`live fabric rates every ${interval} ms`);
  }

  stop(): void {
    if (this.timer !== undefined) this.opts.log?.("live fabric rates stopped");
    clearInterval(this.timer);
    this.timer = undefined;
    this.prev = null;
  }

  async tick(): Promise<void> {
    if (this.now() >= this.deadline) {
      this.stop();
      return;
    }
    if (this.sampling) return;
    this.sampling = true;
    try {
      const facts = this.opts.facts();
      const fabric = new Set([...facts].filter(([, f]) => f.kind === "fabric").map(([iface]) => iface));
      const ports = new Map<string, { device: string; port: number }>();
      for (const iface of fabric) {
        const r = facts.get(iface)?.rdma;
        if (r) ports.set(iface, { device: r.device, port: r.port });
      }
      const at = performance.now();
      const [net, rdma] = await Promise.all([
        readNetDev(this.opts.procRoot ?? "/proc", fabric),
        sampleRdmaCounters(this.opts.sysRoot ?? "/sys", ports),
      ]);
      const prev = this.prev;
      this.prev = { at, net, rdma };
      if (prev === null || this.timer === undefined) return;
      const dt = at - prev.at;
      const ifaces: NetRate[] = [...fabric].sort().slice(0, 16).map((iface) => ({
        iface,
        rxBps: counterRate(prev.net.get(iface)?.rx, net.get(iface)?.rx, dt),
        txBps: counterRate(prev.net.get(iface)?.tx, net.get(iface)?.tx, dt),
        rdmaRxBps: counterRate(prev.rdma.get(iface)?.rx, rdma.get(iface)?.rx, dt),
        rdmaTxBps: counterRate(prev.rdma.get(iface)?.tx, rdma.get(iface)?.tx, dt),
      }));
      if (ifaces.length === 0) return;
      // A failed send means the socket is gone: stop rather than sample into the void.
      if (!this.opts.send({ type: "net-rates", intervalMs: this.intervalMs, ifaces })) this.stop();
    } catch (err) {
      this.opts.log?.(`live fabric sample failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.sampling = false;
    }
  }
}
