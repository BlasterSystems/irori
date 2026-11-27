import { promises as fs } from "node:fs";
import path from "node:path";
import type { NetworkKind, RdmaPort } from "@irori/core";

/**
 * IRI-161 (ADR-0021): static link facts per interface — MAC, MTU, driver,
 * classification, RDMA port and IPv4 neighbours. Everything comes from sysfs
 * and procfs (world-readable), so no extra privilege is needed. The facts
 * change rarely: callers cache them (LINK_FACTS_TTL_MS).
 */

export const LINK_FACTS_TTL_MS = 30_000;

export interface LinkFacts {
  mac: string | null;
  mtu: number | null;
  driver: string | null;
  kind: NetworkKind;
  rdma: RdmaPort | null;
  /** Complete IPv4 neighbours (fabric interfaces only). */
  neighbors: Array<{ ip: string; mac: string }>;
}

/** Name prefixes that are always virtual, whatever sysfs says. */
const VIRTUAL_PREFIXES = ["lo", "docker", "veth", "br-", "virbr", "tailscale", "wg", "tun", "tap", "cni", "flannel", "vxlan", "zt", "bond-slave"];

/** RoCE/IB-capable drivers on the CX7 and its relatives. */
const FABRIC_DRIVERS = new Set(["mlx5_core", "mlx4_en", "mlx4_core"]);

/** Fabric threshold for drivers without an RDMA device: 100 Gb/s. */
const FABRIC_MIN_SPEED_MBPS = 100_000;

const ZERO_MAC = "00:00:00:00:00:00";

/**
 * Pure classification. Virtual when the name is a known virtual prefix or
 * the interface has no backing device; fabric when an RDMA port is bound, or
 * a fabric driver runs at ≥ 100 Gb/s; otherwise LAN.
 */
export function classifyIface(input: {
  iface: string;
  hasDevice: boolean;
  driver: string | null;
  rdma: RdmaPort | null;
  speedMbps: number | null;
}): NetworkKind {
  if (VIRTUAL_PREFIXES.some((p) => input.iface === p || input.iface.startsWith(p))) return "virtual";
  if (!input.hasDevice) return "virtual";
  if (input.rdma !== null) return "fabric";
  if (input.driver !== null && FABRIC_DRIVERS.has(input.driver) && (input.speedMbps ?? 0) >= FABRIC_MIN_SPEED_MBPS) return "fabric";
  return "lan";
}

/** `/proc/net/arp`: complete (flags & 0x2), non-zero entries grouped by device. */
export function parseProcNetArp(text: string): Map<string, Array<{ ip: string; mac: string }>> {
  const byDev = new Map<string, Array<{ ip: string; mac: string }>>();
  for (const line of text.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 6) continue;
    const [ip, , flagsRaw, macRaw, , dev] = f as [string, string, string, string, string, string];
    const flags = Number.parseInt(flagsRaw, 16);
    const mac = macRaw.toLowerCase();
    if (!Number.isFinite(flags) || (flags & 0x2) === 0 || mac === ZERO_MAC || !/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)) continue;
    const list = byDev.get(dev) ?? [];
    if (list.length < 64) list.push({ ip, mac });
    byDev.set(dev, list);
  }
  return byDev;
}

/** "200 Gb/sec (4X HDR)" → 200; "4: ACTIVE" → "ACTIVE". */
export function parseRdmaRate(raw: string): number | null {
  const m = /^\s*([\d.]+)\s*Gb\/sec/.exec(raw);
  return m === null ? null : Number.parseFloat(m[1]!);
}
export function parseRdmaState(raw: string): string | null {
  const t = raw.trim();
  if (t.length === 0) return null;
  const m = /^\d+:\s*(.+)$/.exec(t);
  return (m === null ? t : m[1]!).trim();
}

async function readTrim(file: string): Promise<string | null> {
  try {
    const t = (await fs.readFile(file, "utf8")).trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

/**
 * The RDMA port bound to a netdev: /sys/class/net/<if>/device/infiniband/<dev>,
 * then the port whose gid_attrs/ndevs/0 names the netdev (mlx5 RoCE has one
 * port per device, so a single port is taken as-is).
 */
export async function readRdmaPort(sysRoot: string, iface: string): Promise<RdmaPort | null> {
  let devices: string[];
  try {
    devices = await fs.readdir(path.join(sysRoot, "class", "net", iface, "device", "infiniband"));
  } catch {
    return null;
  }
  for (const device of devices.sort()) {
    const portsDir = path.join(sysRoot, "class", "infiniband", device, "ports");
    let ports: string[];
    try {
      ports = (await fs.readdir(portsDir)).filter((p) => /^\d+$/.test(p)).sort((a, b) => Number(a) - Number(b));
    } catch {
      continue;
    }
    let chosen: string | null = ports.length === 1 ? ports[0]! : null;
    if (chosen === null) {
      for (const p of ports) {
        if ((await readTrim(path.join(portsDir, p, "gid_attrs", "ndevs", "0"))) === iface) {
          chosen = p;
          break;
        }
      }
    }
    chosen ??= ports[0] ?? null;
    if (chosen === null) continue;
    const dir = path.join(portsDir, chosen);
    const [linkLayer, state, rate] = await Promise.all([
      readTrim(path.join(dir, "link_layer")),
      readTrim(path.join(dir, "state")),
      readTrim(path.join(dir, "rate")),
    ]);
    return {
      device,
      port: Number(chosen),
      linkLayer,
      state: state === null ? null : parseRdmaState(state),
      rateGbps: rate === null ? null : parseRdmaRate(rate),
    };
  }
  return null;
}

/** Reads the facts for every interface under /sys/class/net (Linux only). */
export async function readLinkFacts(
  sysRoot: string,
  procRoot: string,
  speeds: ReadonlyMap<string, number | null>,
): Promise<Map<string, LinkFacts>> {
  const facts = new Map<string, LinkFacts>();
  let ifaces: string[];
  try {
    ifaces = await fs.readdir(path.join(sysRoot, "class", "net"));
  } catch {
    return facts; // no sysfs (macOS dev boxes)
  }
  let arp = new Map<string, Array<{ ip: string; mac: string }>>();
  try {
    arp = parseProcNetArp(await fs.readFile(path.join(procRoot, "net", "arp"), "utf8"));
  } catch {
    // no procfs arp table — neighbours stay empty
  }
  await Promise.all(
    ifaces.map(async (iface) => {
      const base = path.join(sysRoot, "class", "net", iface);
      const macRaw = await readTrim(path.join(base, "address"));
      const mtuRaw = await readTrim(path.join(base, "mtu"));
      let hasDevice = false;
      let driver: string | null = null;
      try {
        await fs.access(path.join(base, "device"));
        hasDevice = true;
        driver = path.basename(await fs.realpath(path.join(base, "device", "driver")));
      } catch {
        // virtual interface, or a device without a bound driver
      }
      const rdma = hasDevice ? await readRdmaPort(sysRoot, iface) : null;
      const kind = classifyIface({ iface, hasDevice, driver, rdma, speedMbps: speeds.get(iface) ?? null });
      const mac = macRaw !== null && /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(macRaw) && macRaw !== ZERO_MAC ? macRaw.toLowerCase() : null;
      const mtu = mtuRaw === null ? null : Number.parseInt(mtuRaw, 10);
      facts.set(iface, {
        mac,
        mtu: Number.isInteger(mtu) && mtu! > 0 ? mtu : null,
        driver,
        kind,
        rdma,
        neighbors: kind === "fabric" ? (arp.get(iface) ?? []) : [],
      });
    }),
  );
  return facts;
}

/** Cumulative RDMA port byte counters (port_*_data counts 4-byte words). */
export type RdmaCounters = Map<string, { rx: number; tx: number }>;

export async function sampleRdmaCounters(
  sysRoot: string,
  ports: ReadonlyMap<string, { device: string; port: number }>,
): Promise<RdmaCounters> {
  const out: RdmaCounters = new Map();
  await Promise.all(
    [...ports].map(async ([iface, p]) => {
      const dir = path.join(sysRoot, "class", "infiniband", p.device, "ports", String(p.port), "counters");
      const [rx, tx] = await Promise.all([readTrim(path.join(dir, "port_rcv_data")), readTrim(path.join(dir, "port_xmit_data"))]);
      const rxN = rx === null ? Number.NaN : Number(rx);
      const txN = tx === null ? Number.NaN : Number(tx);
      if (Number.isFinite(rxN) && Number.isFinite(txN)) out.set(iface, { rx: rxN * 4, tx: txN * 4 });
    }),
  );
  return out;
}

/** Byte rate from two counter samples; null when unseen or the counter went backwards. */
export function counterRate(c0: number | undefined, c1: number | undefined, dtMs: number): number | null {
  if (c0 === undefined || c1 === undefined || !(dtMs > 0) || c1 < c0) return null;
  return Math.round((c1 - c0) / (dtMs / 1000));
}

/** Cache wrapper: one read per TTL, concurrent callers share the in-flight read. */
export function createLinkFactsCache(ttlMs = LINK_FACTS_TTL_MS, now: () => number = Date.now) {
  let value = new Map<string, LinkFacts>();
  let readAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<Map<string, LinkFacts>> | null = null;
  return {
    async get(sysRoot: string, procRoot: string, speeds: ReadonlyMap<string, number | null>): Promise<Map<string, LinkFacts>> {
      if (now() - readAt < ttlMs) return value;
      inFlight ??= readLinkFacts(sysRoot, procRoot, speeds)
        .then((v) => {
          value = v;
          readAt = now();
          return v;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
    /** Last read without refreshing (live stream, prober). */
    peek(): Map<string, LinkFacts> {
      return value;
    },
  };
}
