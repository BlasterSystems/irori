import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  ipv4InSubnet,
  NET_LISTENING_MARKER,
  NET_RESULT_MARKER,
  netTestClientParamsSchema,
  netTestServerParamsSchema,
  parseIpv4Cidr,
  type NetTestClientParams,
  type NetTestResult,
} from "@irori/core";

/**
 * IRI-166 (ADR-0021): link-test job runners. Both sides validate their params
 * against the core schemas AND against the node's own fabric interfaces:
 * the listener binds only an address this node holds on a fabric port, and
 * the client only targets an address inside that port's subnet, so neither
 * can become a general listener or a flood tool. execFile-style spawns only.
 */

export interface FabricAddr {
  iface: string;
  ip: string;
  /** e.g. 10.100.112.0/24 */
  subnet: string;
  /** IRI-168: the RoCE port bound to the interface (RDMA tests). */
  rdma?: { device: string; port: number } | null;
}

export interface NetTestDeps {
  /** This node's fabric IPv4 addresses (fabric kind + cidr). */
  fabricAddrs: () => Promise<FabricAddr[]>;
  /** Injectable process runner (tests). */
  run?: ProcRunner;
  sleep?: (ms: number) => Promise<void>;
  /** IRI-168: RoCE v2 GID index of an IPv4 address on a port; default reads sysfs. */
  rdmaGid?: (device: string, port: number, ip: string) => Promise<number | null>;
}

/** The IPv4-mapped GID string sysfs prints for an address, e.g. 0000:…:ffff:0a64:7002. */
export function ipv4Gid(ip: string): string {
  const o = ip.split(".").map(Number);
  const hex = (a: number, b: number) => ((a << 8) | b).toString(16).padStart(4, "0");
  return `0000:0000:0000:0000:0000:ffff:${hex(o[0]!, o[1]!)}:${hex(o[2]!, o[3]!)}`;
}

/** sysfs lookup: the RoCE v2 GID entry holding the address (gid_attrs/types/<n>). */
export function sysfsRdmaGid(sysRoot = "/sys"): (device: string, port: number, ip: string) => Promise<number | null> {
  return async (device, port, ip) => {
    const base = path.join(sysRoot, "class", "infiniband", device, "ports", String(port));
    const want = ipv4Gid(ip);
    let entries: string[];
    try {
      entries = (await fs.readdir(path.join(base, "gids"))).filter((e) => /^\d+$/.test(e)).sort((a, b) => Number(a) - Number(b));
    } catch {
      return null;
    }
    for (const n of entries) {
      try {
        const gid = (await fs.readFile(path.join(base, "gids", n), "utf8")).trim();
        if (gid !== want) continue;
        const type = (await fs.readFile(path.join(base, "gid_attrs", "types", n), "utf8")).trim();
        if (/RoCE v2/i.test(type)) return Number(n);
      } catch {
        // unreadable or unused GID slot
      }
    }
    return null;
  };
}

/** perftest flags shared by both sides: device, port, GID, report Gb/s. */
async function perftestBase(addr: FabricAddr, deps: NetTestDeps, port: number): Promise<string[] | string> {
  if (addr.rdma == null) return `${addr.iface} has no RDMA device`;
  const gid = await (deps.rdmaGid ?? sysfsRdmaGid())(addr.rdma.device, addr.rdma.port, addr.ip);
  if (gid === null) return `no RoCE v2 GID for ${addr.ip} on ${addr.rdma.device}`;
  return ["-d", addr.rdma.device, "-i", String(addr.rdma.port), "-x", String(gid), "-F", "-p", String(port)];
}

/** ib_write_bw result row: the BW average column (Gb/s with --report_gbits). */
export function parseIbWriteBw(stdout: string): number | null {
  let avg: number | null = null;
  for (const line of stdout.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length >= 5 && f.slice(0, 5).every((x) => /^[\d.]+$/.test(x))) avg = Number(f[3]);
  }
  return avg === null || !Number.isFinite(avg) ? null : Math.round(avg * 100) / 100;
}

/** ib_send_lat result row: t_typical and the 99 % percentile, µs → ms. */
export function parseIbSendLat(stdout: string): { p50: number | null; p99: number | null } {
  let out: { p50: number | null; p99: number | null } = { p50: null, p99: null };
  for (const line of stdout.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length >= 8 && f.slice(0, 8).every((x) => /^[\d.]+$/.test(x))) {
      // µs → ms at 1 ns resolution: RDMA latency is ~2 µs, coarser rounding erases it.
      out = { p50: Math.round(Number(f[4]) * 1000) / 1e6, p99: Math.round(Number(f[7]) * 1000) / 1e6 };
    }
  }
  return out;
}

export interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs a command to completion (or until the signal aborts / timeoutMs),
 * streaming stdout lines to onLine. Never a shell.
 */
export type ProcRunner = (
  cmd: string,
  args: string[],
  opts: { signal: AbortSignal; timeoutMs: number; onLine?: (line: string) => void },
) => Promise<ProcResult>;

export const defaultRunner: ProcRunner = (cmd, args, opts) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let buf = "";
    let settled = false;
    // Own process group: a wrapper (stdbuf) may fork the tool instead of
    // exec'ing it (uutils coreutils), so a kill must reach the whole group,
    // or the tool would outlive its job and keep listening.
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal.removeEventListener("abort", onAbort);
      if (buf.length > 0) opts.onLine?.(buf);
      resolve({ code, stdout, stderr });
    };
    const kill = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
    };
    const onAbort = (): void => kill();
    const timer = setTimeout(kill, opts.timeoutMs);
    opts.signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d: Buffer) => {
      const text = d.toString("utf8");
      if (stdout.length < 4 * 1024 * 1024) stdout += text;
      buf += text;
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        opts.onLine?.(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < 256 * 1024) stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      stderr += String(err.message);
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function paramError(prefix: string, issues: Array<{ path: PropertyKey[]; message: string }>): string {
  return `${prefix}: ${issues.map((i) => `${i.path.map(String).join(".") || "params"} ${i.message}`).join("; ")}`;
}

/**
 * A listener that has not exited this long after spawn is bound: iperf3 and
 * perftest fail within milliseconds on a bad address or a taken port. This
 * backs up the status-line match, which needs the tool to flush stdout.
 */
export const LISTEN_GRACE_MS = 1500;

/**
 * Runs one listener under `stdbuf -oL`: iperf3 and perftest print their
 * "listening" line with stdio, which a pipe fully buffers until exit. The
 * grace timer announces a listener that is still running even if the line
 * never arrives; the client retries a refused connect either way.
 */
async function runListener(
  run: ProcRunner,
  cmd: string,
  args: string[],
  ready: RegExp,
  announce: () => void,
  opts: { signal: AbortSignal; timeoutMs: number },
): Promise<ProcResult> {
  const grace = setTimeout(announce, LISTEN_GRACE_MS);
  try {
    return await run("stdbuf", ["-oL", cmd, ...args], {
      ...opts,
      onLine: (line) => {
        if (ready.test(line)) announce();
      },
    });
  } finally {
    clearTimeout(grace);
  }
}

/** net-test-server: N one-shot iperf3 listeners on a verified fabric address. */
export async function runNetTestServer(
  rawParams: Record<string, unknown>,
  emit: (line: string) => void,
  signal: AbortSignal,
  deps: NetTestDeps,
): Promise<{ ok: boolean }> {
  const parsed = netTestServerParamsSchema.safeParse(rawParams);
  if (!parsed.success) {
    emit(paramError("error: invalid net-test-server params", parsed.error.issues));
    return { ok: false };
  }
  const p = parsed.data;
  const mine = (await deps.fabricAddrs()).find((a) => a.ip === p.bindIp);
  if (mine === undefined) {
    emit(`error: ${p.bindIp} is not an address of a fabric interface on this node`);
    return { ok: false };
  }
  const run = deps.run ?? defaultRunner;
  const deadline = Date.now() + p.timeoutS * 1000;
  let announced = false;
  const announce = (): void => {
    if (announced) return;
    announced = true;
    emit(`${NET_LISTENING_MARKER} ${mine.iface} ${p.bindIp}:${p.port}`);
  };
  if (p.tool === "rdma") {
    // IRI-168: perftest server — one ib_write_bw then one ib_send_lat, each
    // serving a single client and exiting. RDMA rides the fabric port's GID;
    // the TCP rendezvous socket is one-shot and dies with the timeout.
    const base = await perftestBase(mine, deps, p.port);
    if (typeof base === "string") {
      emit(`error: ${base}`);
      return { ok: false };
    }
    for (const tool of ["ib_write_bw", "ib_send_lat"]) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || signal.aborted) break;
      const res = await runListener(run, tool, [...base, ...(tool === "ib_write_bw" ? ["--report_gbits", "-D", "10"] : ["-n", "1000"])], /Waiting for client/i, announce, {
        signal,
        timeoutMs: remaining,
      });
      if (res.code !== 0 && !signal.aborted) {
        emit(`error: ${tool} exited ${res.code ?? "on a signal"}: ${res.stderr.trim().split("\n").at(-1) ?? ""}`);
        return { ok: false };
      }
      emit(`${tool} served`);
    }
    return { ok: !signal.aborted };
  }
  for (let i = 0; i < p.runs; i++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0 || signal.aborted) break;
    const res = await runListener(run, "iperf3", ["-s", "-1", "-B", p.bindIp, "-p", String(p.port)], /Server listening on/, announce, {
      signal,
      timeoutMs: remaining,
    });
    if (res.code !== 0 && !signal.aborted) {
      emit(`error: iperf3 listener exited ${res.code ?? "on a signal"}: ${res.stderr.trim().split("\n").at(-1) ?? ""}`);
      return { ok: false };
    }
    emit(`listener run ${i + 1}/${p.runs} done`);
  }
  return { ok: !signal.aborted };
}

/** iperf3 -J: the receiver-side rate (what reached the far end) and retransmits. */
export function parseIperfJson(stdout: string): { gbps: number | null; retransmits: number | null; error: string | null } {
  try {
    const j = JSON.parse(stdout) as {
      error?: string;
      end?: { sum_received?: { bits_per_second?: number }; sum_sent?: { retransmits?: number } };
    };
    if (typeof j.error === "string") return { gbps: null, retransmits: null, error: j.error };
    const bps = j.end?.sum_received?.bits_per_second;
    return {
      gbps: typeof bps === "number" ? Math.round((bps / 1e9) * 100) / 100 : null,
      retransmits: typeof j.end?.sum_sent?.retransmits === "number" ? j.end.sum_sent.retransmits : null,
      error: typeof bps === "number" ? null : "iperf3 reported no receiver summary",
    };
  } catch {
    return { gbps: null, retransmits: null, error: "iperf3 output was not JSON" };
  }
}

/** Per-packet `time=0.031 ms` lines → p50/p99 and loss. */
export function parsePingBurst(stdout: string, sent: number): { p50: number | null; p99: number | null; lossPct: number | null } {
  const times = [...stdout.matchAll(/time[=<]([\d.]+) ms/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
  if (sent <= 0) return { p50: null, p99: null, lossPct: null };
  const pick = (q: number): number | null => (times.length === 0 ? null : times[Math.min(times.length - 1, Math.ceil(q * times.length) - 1)]!);
  return { p50: pick(0.5), p99: pick(0.99), lossPct: Math.round((1 - Math.min(times.length, sent) / sent) * 1000) / 10 };
}

/** net-test-client: forward, optional reverse, then a latency burst; one result line. */
export async function runNetTestClient(
  rawParams: Record<string, unknown>,
  emit: (line: string) => void,
  signal: AbortSignal,
  deps: NetTestDeps,
): Promise<{ ok: boolean }> {
  const parsed = netTestClientParamsSchema.safeParse(rawParams);
  if (!parsed.success) {
    emit(paramError("error: invalid net-test-client params", parsed.error.issues));
    return { ok: false };
  }
  const p = parsed.data;
  const mine = (await deps.fabricAddrs()).find((a) => a.ip === p.bindIp);
  if (mine === undefined) {
    emit(`error: ${p.bindIp} is not an address of a fabric interface on this node`);
    return { ok: false };
  }
  if (p.targetIp === p.bindIp || !ipv4InSubnet(p.targetIp, mine.subnet)) {
    emit(`error: target ${p.targetIp} is not a peer inside ${mine.subnet}`);
    return { ok: false };
  }
  const run = deps.run ?? defaultRunner;
  const sleep = deps.sleep ?? defaultSleep;
  const errors: string[] = [];
  if (p.tool === "rdma") return runRdmaClient(p, mine, emit, signal, deps, run, sleep);

  const iperf = async (reverse: boolean): Promise<{ gbps: number | null; retransmits: number | null }> => {
    const args = ["-c", p.targetIp, "-B", p.bindIp, "-p", String(p.port), "-J", "-t", String(p.durationS), "-P", String(p.streams), ...(reverse ? ["-R"] : [])];
    // The listener restarts between one-shot runs: retry a refused connect briefly.
    for (let attempt = 0; attempt < 8 && !signal.aborted; attempt++) {
      emit(`${reverse ? "reverse" : "forward"}: iperf3 ${p.streams} stream(s), ${p.durationS} s${attempt > 0 ? ` (retry ${attempt})` : ""}`);
      const res = await run("iperf3", args, { signal, timeoutMs: (p.durationS + 15) * 1000 });
      const out = parseIperfJson(res.stdout);
      if (out.gbps !== null) {
        emit(`${reverse ? "reverse" : "forward"}: ${out.gbps} Gb/s, ${out.retransmits ?? "?"} retransmits`);
        return out;
      }
      if (out.error !== null && /unable to connect|connection refused|busy/i.test(out.error)) {
        await sleep(400);
        continue;
      }
      errors.push(`${reverse ? "reverse" : "forward"}: ${out.error ?? "failed"}`.slice(0, 300));
      return { gbps: null, retransmits: null };
    }
    errors.push(`${reverse ? "reverse" : "forward"}: could not connect to ${p.targetIp}:${p.port}`);
    return { gbps: null, retransmits: null };
  };

  const fwd = await iperf(false);
  const rev = p.reverse && !signal.aborted ? await iperf(true) : { gbps: null, retransmits: null };
  let lat: { p50: number | null; p99: number | null; lossPct: number | null } = { p50: null, p99: null, lossPct: null };
  if (p.pings > 0 && !signal.aborted) {
    emit(`latency: ${p.pings} pings`);
    // -i 0.01 needs root (the agent is root); bound by count × interval + 2 s.
    const res = await run("ping", ["-n", "-c", String(p.pings), "-i", "0.01", "-W", "1", "-I", p.bindIp, p.targetIp], {
      signal,
      timeoutMs: p.pings * 10 + 5000,
    });
    lat = parsePingBurst(res.stdout, p.pings);
  }
  const result: NetTestResult = {
    tool: "iperf3",
    forwardGbps: fwd.gbps,
    reverseGbps: rev.gbps,
    retransmits: fwd.retransmits === null && rev.retransmits === null ? null : (fwd.retransmits ?? 0) + (rev.retransmits ?? 0),
    rttP50Ms: lat.p50,
    rttP99Ms: lat.p99,
    lossPct: lat.lossPct,
    durationS: p.durationS,
    streams: p.streams,
    errors: errors.slice(0, 4),
  };
  emit(`${NET_RESULT_MARKER}${JSON.stringify(result)}`);
  return { ok: fwd.gbps !== null && !signal.aborted };
}

/** IRI-168: RDMA client — write bandwidth, then send latency; one result line. */
async function runRdmaClient(
  p: NetTestClientParams,
  mine: FabricAddr,
  emit: (line: string) => void,
  signal: AbortSignal,
  deps: NetTestDeps,
  run: ProcRunner,
  sleep: (ms: number) => Promise<void>,
): Promise<{ ok: boolean }> {
  const errors: string[] = [];
  const base = await perftestBase(mine, deps, p.port);
  if (typeof base === "string") {
    emit(`error: ${base}`);
    return { ok: false };
  }
  // The server restarts between tools: retry a refused rendezvous briefly.
  const attempt = async (tool: "ib_write_bw" | "ib_send_lat", extra: string[], parse: (out: string) => boolean): Promise<string | null> => {
    for (let i = 0; i < 8 && !signal.aborted; i++) {
      emit(`${tool}${i > 0 ? ` (retry ${i})` : ""}`);
      const res = await run(tool, [...base, ...extra, p.targetIp], { signal, timeoutMs: (p.durationS + 20) * 1000 });
      if (parse(res.stdout)) return res.stdout;
      if (/Couldn't connect|Unable to open|connection refused/i.test(res.stdout + res.stderr)) {
        await sleep(400);
        continue;
      }
      errors.push(`${tool}: ${(res.stderr.trim().split("\n").at(-1) ?? "no result").slice(0, 280)}`);
      return null;
    }
    errors.push(`${tool}: could not reach ${p.targetIp}:${p.port}`);
    return null;
  };
  const bwOut = await attempt("ib_write_bw", ["--report_gbits", "-D", String(p.durationS)], (o) => parseIbWriteBw(o) !== null);
  const forwardGbps = bwOut === null ? null : parseIbWriteBw(bwOut);
  if (forwardGbps !== null) emit(`ib_write_bw: ${forwardGbps} Gb/s`);
  const latOut = signal.aborted ? null : await attempt("ib_send_lat", ["-n", "1000"], (o) => parseIbSendLat(o).p50 !== null);
  const lat = latOut === null ? { p50: null, p99: null } : parseIbSendLat(latOut);
  const result: NetTestResult = {
    tool: "rdma",
    forwardGbps,
    reverseGbps: null,
    retransmits: null,
    rttP50Ms: lat.p50,
    rttP99Ms: lat.p99,
    lossPct: null,
    durationS: p.durationS,
    streams: 1,
    errors: errors.slice(0, 4),
  };
  emit(`${NET_RESULT_MARKER}${JSON.stringify(result)}`);
  return { ok: forwardGbps !== null && !signal.aborted };
}

/** This node's fabric IPv4 addresses from link detail + facts. */
export function fabricAddrsOf(
  detail: ReadonlyMap<string, { cidrs?: string[] }>,
  facts: ReadonlyMap<string, { kind: string; rdma?: { device: string; port: number } | null }>,
): FabricAddr[] {
  const out: FabricAddr[] = [];
  for (const [iface, d] of detail) {
    const f = facts.get(iface);
    if (f?.kind !== "fabric") continue;
    for (const c of d.cidrs ?? []) {
      const parsed = parseIpv4Cidr(c);
      if (parsed !== null) out.push({ iface, ip: parsed.ip, subnet: parsed.subnet, rdma: f.rdma == null ? null : { device: f.rdma.device, port: f.rdma.port } });
    }
  }
  return out;
}
