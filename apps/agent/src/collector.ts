import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import type { StatsFs } from "node:fs";
import { statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { SCHEMA_VERSION } from "@irori/core";
import type { GpuSnapshot, HardwareSnapshot } from "@irori/core";
import { AGENT_VERSION } from "./version.js";

const execFileAsync = promisify(execFile);

/** Delay between the two sampling passes (CPU usage, network rates, RAPL energy). */
const CPU_SAMPLE_DELAY_MS = 200;
/** Hard timeout for nvidia-smi; a hung query must not stall the collector. */
const GPU_QUERY_TIMEOUT_MS = 3000;

/** Where /proc and /sys live; overridable for tests and container agents. */
const DEFAULT_PROC_ROOT = "/proc";
const DEFAULT_SYS_ROOT = "/sys";

export interface CollectorOptions {
  /** Root for procfs reads (meminfo, mounts, net/dev). Default "/proc". */
  procRoot?: string;
  /** Root for sysfs reads (hwmon, powercap, cpufreq). Default "/sys". */
  sysRoot?: string;
}

type GpuProcess = { pid: number; name: string; memBytes: number | null };
type NetCounters = Map<string, { rx: number; tx: number }>;
/** IRI-067: cumulative block-device sector counters from /sys/block/<dev>/stat. */
export type BlockCounters = Map<string, { readSectors: number; writeSectors: number }>;
/** IRI-067: static link detail keyed by interface name. */
export interface LinkDetail {
  speedMbps: number | null;
  operState: string | null;
  addrs: string[];
}

export interface Meminfo {
  memTotalBytes: number | null;
  memAvailableBytes: number | null;
  swapTotalBytes: number | null;
  swapFreeBytes: number | null;
}

interface MountEntry {
  device: string;
  mount: string;
  fsType: string;
}

interface SampleWindow {
  cpu0: os.CpuInfo[];
  cpu1: os.CpuInfo[];
  net0: NetCounters | null;
  net1: NetCounters | null;
  block0: BlockCounters | null;
  block1: BlockCounters | null;
  dtMs: number;
  packagePowerW: number | null;
}

// sparkControl-proven CPU sensor names plus the generic label match from the
// research brief (IRI-003): coretemp/k10temp/zenpower are the canonical
// package sensors on the fleet's CPUs even though they don't contain "cpu".
const CPU_TEMP_NAME_RE = /cpu|package|soc|coretemp|k10temp|zenpower/i;

// "loop" covers /dev/loop devices (no meaningful capacity); devfs/autofs are
// the macOS virtual filesystems, the rest is the IRI-003 exclusion list.
const EXCLUDED_FS_TYPES: Record<string, true> = {
  tmpfs: true,
  overlay: true,
  loop: true,
  squashfs: true,
  efivarfs: true,
  devtmpfs: true,
  proc: true,
  sysfs: true,
  devfs: true,
  autofs: true,
};

/**
 * Collect a hardware snapshot on the current host. Metrics that cannot be
 * read are null (or [] for lists) rather than omitted; see packages/core.
 *
 * The GPU query runs concurrently with a ~200 ms sampling window that feeds
 * CPU usage, per-interface network rates and (on Linux) the RAPL package
 * power delta. Filesystem roots are injectable for tests/container agents.
 */
export async function collect(opts: CollectorOptions = {}): Promise<HardwareSnapshot> {
  const procRoot = opts.procRoot ?? DEFAULT_PROC_ROOT;
  const sysRoot = opts.sysRoot ?? DEFAULT_SYS_ROOT;

  const gpusPromise = queryGpus();
  const window = await sampleWindow(procRoot, sysRoot);
  const gpus = await gpusPromise;

  const cpus = os.cpus();
  if (cpus.length === 0) {
    throw new Error("os.cpus() returned no CPU information");
  }
  const totalMem = os.totalmem();
  const [load1] = os.loadavg();

  const meminfo = await readMeminfo(procRoot);
  const [tempC, perCoreClocksKHz, perCoreMaxClocksKHz] = await Promise.all([
    readCpuTempC(sysRoot),
    readPerCoreClocksKHz(sysRoot),
    readPerCoreMaxClocksKHz(sysRoot),
  ]);
  const packagePowerW = window.packagePowerW ?? (await readHwmonPowerW(sysRoot));

  const swapTotalBytes = meminfo?.swapTotalBytes ?? null;
  const swapFreeBytes = meminfo?.swapFreeBytes ?? null;
  const swapUsedBytes =
    swapTotalBytes !== null && swapFreeBytes !== null
      ? Math.max(0, swapTotalBytes - swapFreeBytes)
      : null;

  return {
    schemaVersion: SCHEMA_VERSION,
    agentVersion: AGENT_VERSION,
    hostname: os.hostname(),
    transport: "ws",
    timestampMs: Date.now(),
    cpu: {
      model: cpus[0]?.model ?? "unknown",
      cores: cpus.length,
      usagePct: cpuUsagePct(window.cpu0, window.cpu1),
      tempC,
      packagePowerW,
      ...(perCoreClocksKHz === null ? {} : { perCoreClocksKHz }),
      ...(perCoreMaxClocksKHz === null ? {} : { perCoreMaxClocksKHz }),
    },
    memory: {
      totalBytes: totalMem,
      usedBytes: totalMem - os.freemem(),
      swapTotalBytes,
      swapUsedBytes,
    },
    unifiedMemory: resolveUnifiedMemory(gpus, meminfo),
    memoryBandwidth: memoryBandwidthReading(),
    kernel: kernelCountersReading(),
    storage: await readStorage(procRoot, blockRatesOf(window)),
    network: networkRates(window.net0, window.net1, window.dtMs, await readLinkDetail(sysRoot)),
    gpus,
    load1,
    uptimeS: Math.floor(os.uptime()),
  };
}

// ---------------------------------------------------------------------------
// Sampling window (CPU usage, network rates, package power)
// ---------------------------------------------------------------------------

async function sampleWindow(procRoot: string, sysRoot: string): Promise<SampleWindow> {
  const started = performance.now();
  const [cpu0, net0, block0, energy0] = await Promise.all([
    Promise.resolve(os.cpus()),
    sampleNetCounters(procRoot),
    sampleBlockCounters(sysRoot),
    readRaplEnergyUj(sysRoot),
  ]);
  const { promise: windowDelay, resolve: windowDelayDone } = Promise.withResolvers<void>();
  setTimeout(windowDelayDone, CPU_SAMPLE_DELAY_MS);
  await windowDelay;
  const [cpu1, net1, block1, energy1] = await Promise.all([
    Promise.resolve(os.cpus()),
    sampleNetCounters(procRoot),
    sampleBlockCounters(sysRoot),
    readRaplEnergyUj(sysRoot),
  ]);
  const dtMs = performance.now() - started;
  return { cpu0, cpu1, net0, net1, block0, block1, dtMs, packagePowerW: raplPowerW(energy0, energy1, dtMs) };
}

/** CPU busy percentage from two os.cpus() samples (M1 algorithm, injected). */
export function cpuUsagePct(start: os.CpuInfo[], end: os.CpuInfo[]): number | null {
  let idleDelta = 0;
  let totalDelta = 0;
  const n = Math.min(start.length, end.length);
  for (let i = 0; i < n; i++) {
    const s = start[i]?.times;
    const e = end[i]?.times;
    if (s === undefined || e === undefined) continue;
    idleDelta += e.idle - s.idle;
    totalDelta +=
      e.user + e.nice + e.sys + e.idle + e.irq - (s.user + s.nice + s.sys + s.idle + s.irq);
  }
  if (totalDelta <= 0) return null;
  const usage = (1 - idleDelta / totalDelta) * 100;
  return Math.min(100, Math.max(0, Math.round(usage * 10) / 10));
}

// ---------------------------------------------------------------------------
// GPU: nvidia-smi query set proven in sparkControl (IRI-003 §1)
// ---------------------------------------------------------------------------

const GPU_QUERY_ARGS = [
  "--query-gpu=temperature.gpu,utilization.gpu,power.draw,power.limit," +
    "clocks.current.sm,clocks.max.sm," +
    "clocks_throttle_reasons.hw_thermal_slowdown,clocks_throttle_reasons.sw_thermal_slowdown," +
    "clocks_throttle_reasons.hw_slowdown,clocks_throttle_reasons.sw_power_cap," +
    "index,name,uuid",
  "--format=csv,noheader,nounits",
];
const GPU_VRAM_ARGS = ["--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"];
const GPU_APPS_ARGS = [
  "--query-compute-apps=pid,process_name,used_memory",
  "--format=csv,noheader,nounits",
];

/**
 * Query GPUs via nvidia-smi. A failed main query (ENOENT, non-zero exit,
 * timeout) yields [] — nodes without NVIDIA tooling report no GPUs. The VRAM
 * and compute-apps queries are best-effort: on GB10 both are informational
 * (unified memory makes VRAM [N/A]).
 */
async function queryGpus(): Promise<GpuSnapshot[]> {
  const main = await runNvidiaSmi(GPU_QUERY_ARGS);
  if (main === null) return [];
  const [vram, apps] = await Promise.all([runNvidiaSmi(GPU_VRAM_ARGS), runNvidiaSmi(GPU_APPS_ARGS)]);
  return buildGpuSnapshots(main, vram, apps);
}

async function runNvidiaSmi(args: string[]): Promise<string | null> {
  try {
    const result = await execFileAsync("nvidia-smi", args, { timeout: GPU_QUERY_TIMEOUT_MS });
    return result.stdout;
  } catch {
    return null;
  }
}

/** Merge the three nvidia-smi query results into schema-shaped GPU rows. */
export function buildGpuSnapshots(
  mainCsv: string,
  vramCsv: string | null,
  appsCsv: string | null,
): GpuSnapshot[] {
  const gpus = parseGpuCsv(mainCsv);
  const vram = vramCsv !== null ? parseVramCsv(vramCsv) : [];
  // One process list per GPU: the fleet is single-GPU GB10 units where this is
  // exactly the host list. A PID spanning several GPUs is summed by the parser.
  const processes = parseComputeAppsCsv(appsCsv ?? "");
  return gpus.map((gpu, i) => ({
    ...gpu,
    memUsedBytes: vram[i]?.memUsedBytes ?? null,
    memTotalBytes: vram[i]?.memTotalBytes ?? null,
    processes,
  }));
}

/**
 * Parse the 13-field `--query-gpu` row set (metrics 0-9, identity 10-12).
 * Field order: temperature, utilization, power.draw, power.limit,
 * clocks.current.sm, clocks.max.sm, four throttle-reason hex masks,
 * index, name, uuid. Unreadable metrics become null, never fallback values.
 */
export function parseGpuCsv(stdout: string): GpuSnapshot[] {
  const gpus: GpuSnapshot[] = [];
  for (const lineRaw of stdout.split("\n")) {
    const line = lineRaw.trim();
    if (line.length === 0) continue;
    const fields = line.split(",").map(cleanField);
    if (fields.length < 13) continue;

    const parsedIndex = Number.parseInt(fields[10] ?? "", 10);
    const index = Number.isInteger(parsedIndex) && parsedIndex >= 0 ? parsedIndex : gpus.length;
    const nameRaw = fields[11] ?? "";
    // "[N/A]" and empty names fall back to a positional label (schema needs ≥1 char).
    const name = nameRaw.length === 0 || /^\[?n\/a\]?$/i.test(nameRaw) ? `GPU ${index}` : nameRaw;
    const uuidRaw = fields[12] ?? "";
    const uuid = /^GPU-/i.test(uuidRaw) ? uuidRaw : null;

    const tempC = parseNumber(fields[0]);
    const usagePctRaw = parseNumber(fields[1]);
    gpus.push({
      index,
      name,
      uuid,
      tempC,
      usagePct: usagePctRaw === null ? null : Math.min(100, Math.max(0, usagePctRaw)),
      powerW: parseNonNegNumber(fields[2], 2),
      powerLimitW: parseNonNegNumber(fields[3], 2),
      smClockMHz: parseNonNegNumber(fields[4], 0),
      smClockMaxMHz: parseNonNegNumber(fields[5], 0),
      throttleReasons: throttleReasons([fields[6], fields[7], fields[8], fields[9]]),
      memUsedBytes: null,
      memTotalBytes: null,
      processes: [],
    });
  }
  return gpus;
}

/** Parse `--query-gpu=memory.used,memory.total` — one row per GPU; [N/A] → null. */
export function parseVramCsv(
  stdout: string,
): Array<{ memUsedBytes: number | null; memTotalBytes: number | null }> {
  const rows: Array<{ memUsedBytes: number | null; memTotalBytes: number | null }> = [];
  for (const lineRaw of stdout.split("\n")) {
    const line = lineRaw.trim();
    if (line.length === 0) continue;
    const fields = line.split(",").map(cleanField);
    rows.push({
      memUsedBytes: mibToBytes(parseNumber(fields[0])),
      memTotalBytes: mibToBytes(parseNumber(fields[1])),
    });
  }
  return rows;
}

/**
 * Parse `--query-compute-apps=pid,process_name,used_memory`. A PID listed on
 * several GPUs is summed into one row (sparkControl semantics); rows whose
 * memory is unreadable keep memBytes null.
 */
export function parseComputeAppsCsv(stdout: string): GpuProcess[] {
  const byPid = new Map<number, { name: string; memBytes: number | null }>();
  for (const lineRaw of stdout.split("\n")) {
    const line = lineRaw.trim();
    if (line.length === 0) continue;
    const fields = line.split(",").map(cleanField);
    if (fields.length < 3) continue;
    const pid = Number.parseInt(fields[0] ?? "", 10);
    if (!Number.isInteger(pid) || pid < 0) continue;
    // Process names may contain commas: everything between pid and memory.
    const name = fields.slice(1, -1).join(",").trim() || "unknown";
    const memBytes = mibToBytes(parseNumber(fields[fields.length - 1]));
    const prev = byPid.get(pid);
    if (prev === undefined) {
      byPid.set(pid, { name, memBytes });
    } else if (prev.memBytes !== null && memBytes !== null) {
      prev.memBytes += memBytes;
    } else {
      prev.memBytes = prev.memBytes ?? memBytes;
    }
  }
  return [...byPid].map(([pid, proc]) => ({ pid, name: proc.name, memBytes: proc.memBytes }));
}

/**
 * Throttle reasons as short names, ordered thermal > power > hw
 * (IRI-003 §1: thermal = hw_thermal || sw_thermal, active = thermal ||
 * hw_slowdown || power_cap; the fields arrive in that query order).
 */
function throttleReasons(fields: Array<string | undefined>): string[] {
  const [hwThermal, swThermal, hwSlowdown, powerCap] = fields;
  const reasons: string[] = [];
  if (isThrottleActive(hwThermal) || isThrottleActive(swThermal)) reasons.push("thermal");
  if (isThrottleActive(powerCap)) reasons.push("power");
  if (isThrottleActive(hwSlowdown)) reasons.push("hw");
  return reasons;
}

/** nvidia-smi throttle-reason cell: hex (or decimal) bitmask; nonzero → active. */
function isThrottleActive(field: string | undefined): boolean {
  if (field === undefined) return false;
  const cleaned = cleanField(field);
  if (cleaned.length === 0 || cleaned.includes("[")) return false;
  const value = /^0x/i.test(cleaned) ? Number.parseInt(cleaned, 16) : Number.parseFloat(cleaned);
  return Number.isFinite(value) && value !== 0;
}

/** nvidia-smi number cell; "[N/A]", "[Not Supported]", "N/A" and blanks → null. */
function parseNumber(field: string | undefined): number | null {
  if (field === undefined) return null;
  const cleaned = cleanField(field);
  if (cleaned.length === 0 || cleaned.includes("[") || /^\[?n\/a\]?$/i.test(cleaned)) return null;
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : null;
}

/**
 * Non-negative metric cell rounded to `decimals`; negative readings are
 * treated as unreadable (null), matching "not detected = unknown".
 */
function parseNonNegNumber(field: string | undefined, decimals: number): number | null {
  const value = parseNumber(field);
  if (value === null || value < 0) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function mibToBytes(mib: number | null): number | null {
  if (mib === null) return null;
  return Math.max(0, Math.round(mib * 1024 * 1024));
}

function cleanField(field: string): string {
  return field.trim().replace(/^"|"$/g, "");
}

// ---------------------------------------------------------------------------
// CPU temperature / package power / per-core clocks
// ---------------------------------------------------------------------------

interface HwmonSensor {
  name: string;
  dir: string;
}

async function listHwmonSensors(sysRoot: string): Promise<HwmonSensor[]> {
  try {
    const hwmonDir = path.join(sysRoot, "class", "hwmon");
    const entries = (await fs.readdir(hwmonDir)).filter((e) => /^hwmon\d+$/.test(e));
    entries.sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
    const sensors: HwmonSensor[] = [];
    for (const entry of entries) {
      const dir = path.join(hwmonDir, entry);
      const name = await fs
        .readFile(path.join(dir, "name"), "utf8")
        .then((t) => t.trim())
        .catch(() => null);
      if (name !== null && name.length > 0) sensors.push({ name, dir });
    }
    return sensors;
  } catch {
    return [];
  }
}

/**
 * CPU temperature via hwmon: the hottest valid temp*_input of the first
 * CPU-labeled sensor; when no sensor is CPU-labeled, the hottest
 * temp*_input anywhere. Millidegrees outside (0, 200) are rejected.
 */
export async function readCpuTempC(sysRoot: string): Promise<number | null> {
  const sensors = await listHwmonSensors(sysRoot);
  if (sensors.length === 0) return null;
  const preferred = sensors.filter((s) => CPU_TEMP_NAME_RE.test(s.name));
  // A CPU-labeled sensor existing but yielding nothing stays null — a global
  // max could mislabel an NVMe or chipset sensor as the CPU temperature.
  for (const sensor of preferred.length > 0 ? preferred : sensors) {
    const tempC = await maxTempInputC(sensor.dir);
    if (tempC !== null) return tempC;
  }
  return null;
}

async function maxTempInputC(dir: string): Promise<number | null> {
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => /^temp\d+_input$/.test(f)).sort();
  } catch {
    return null;
  }
  let hottest: number | null = null;
  for (const file of files) {
    const raw = await fs
      .readFile(path.join(dir, file), "utf8")
      .then((t) => Number.parseInt(t.trim(), 10))
      .catch(() => Number.NaN);
    if (Number.isInteger(raw) && raw > 0 && raw < 200000) {
      hottest = Math.max(hottest ?? -Infinity, raw / 1000);
    }
  }
  return hottest === null ? null : Math.round(hottest * 100) / 100;
}

/**
 * Summed RAPL package energy in µJ across top-level domains
 * (/sys/class/powercap/intel-rapl:*; deeper intel-rapl:N:M are subdomains and
 * would double-count). null when the platform exposes none.
 */
export async function readRaplEnergyUj(sysRoot: string): Promise<number | null> {
  try {
    const powercapDir = path.join(sysRoot, "class", "powercap");
    const entries = (await fs.readdir(powercapDir)).filter((e) => /^intel-rapl:\d+$/.test(e));
    entries.sort((a, b) => Number(a.split(":")[1]) - Number(b.split(":")[1]));
    let total: number | null = null;
    for (const entry of entries) {
      const raw = await fs
        .readFile(path.join(powercapDir, entry, "energy_uj"), "utf8")
        .then((t) => Number.parseInt(t.trim(), 10))
        .catch(() => Number.NaN);
      if (Number.isInteger(raw) && raw >= 0) total = (total ?? 0) + raw;
    }
    return total;
  } catch {
    return null;
  }
}

/** Package power from the RAPL energy delta over the sample window (J → W). */
export function raplPowerW(
  energyUj0: number | null,
  energyUj1: number | null,
  dtMs: number,
): number | null {
  if (energyUj0 === null || energyUj1 === null || !(dtMs > 0)) return null;
  const deltaUj = energyUj1 - energyUj0;
  if (deltaUj <= 0) return null; // counter wrap/reset — do not guess
  return Math.round((deltaUj / 1e6 / (dtMs / 1000)) * 100) / 100;
}

/**
 * hwmon power fallback (µW per the hwmon ABI): prefer power*_average across
 * all sensors before any power*_input, first plausible reading wins.
 */
export async function readHwmonPowerW(sysRoot: string): Promise<number | null> {
  const sensors = await listHwmonSensors(sysRoot);
  for (const suffix of ["_average", "_input"] as const) {
    for (const sensor of sensors) {
      let files: string[];
      try {
        files = (await fs.readdir(sensor.dir)).filter((f) => {
          return new RegExp(`^power\\d+${suffix}$`).test(f);
        });
      } catch {
        continue;
      }
      for (const file of files.sort()) {
        const raw = await fs
          .readFile(path.join(sensor.dir, file), "utf8")
          .then((t) => Number.parseFloat(t.trim()))
          .catch(() => Number.NaN);
        const watts = raw / 1e6;
        if (Number.isFinite(watts) && watts > 0 && watts < 10000) {
          return Math.round(watts * 100) / 100;
        }
      }
    }
  }
  return null;
}

/** Reads a per-cpu cpufreq kHz file (current/max), sorted by cpu index. */
async function readPerCoreFreqKHz(
  sysRoot: string,
  file: "scaling_cur_freq" | "scaling_max_freq",
): Promise<number[] | null> {
  try {
    const cpuDir = path.join(sysRoot, "devices", "system", "cpu");
    const entries = (await fs.readdir(cpuDir)).filter((e) => /^cpu\d+$/.test(e));
    entries.sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));
    const clocks: number[] = [];
    for (const entry of entries) {
      const raw = await fs
        .readFile(path.join(cpuDir, entry, "cpufreq", file), "utf8")
        .then((t) => Number.parseInt(t.trim(), 10))
        .catch(() => Number.NaN);
      if (Number.isInteger(raw) && raw >= 0) clocks.push(raw);
    }
    return clocks.length > 0 ? clocks : null;
  } catch {
    return null;
  }
}

/** Per-core current frequency (kHz) from cpufreq, sorted by cpu index. */
export async function readPerCoreClocksKHz(sysRoot: string): Promise<number[] | null> {
  return readPerCoreFreqKHz(sysRoot, "scaling_cur_freq");
}

/** Per-core maximum frequency (kHz) from cpufreq, sorted by cpu index. */
export async function readPerCoreMaxClocksKHz(sysRoot: string): Promise<number[] | null> {
  return readPerCoreFreqKHz(sysRoot, "scaling_max_freq");
}

// ---------------------------------------------------------------------------
// Memory, unified-memory detection (GB10)
// ---------------------------------------------------------------------------

export function parseMeminfo(text: string): Meminfo {
  const values = new Map<string, number>();
  for (const line of text.split("\n")) {
    const match = /^([A-Za-z0-9_]+):\s+(\d+)\s*kB/.exec(line);
    if (match !== null) values.set(match[1]!, Number(match[2]) * 1024);
  }
  return {
    memTotalBytes: values.get("MemTotal") ?? null,
    memAvailableBytes: values.get("MemAvailable") ?? values.get("MemFree") ?? null,
    swapTotalBytes: values.get("SwapTotal") ?? null,
    // meminfo has no "SwapAvailable": SwapFree is the available figure.
    swapFreeBytes: values.get("SwapFree") ?? null,
  };
}

async function readMeminfo(procRoot: string): Promise<Meminfo | null> {
  try {
    return parseMeminfo(await fs.readFile(path.join(procRoot, "meminfo"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * GB10 unified memory: the pool is the OS-visible MemTotal (per-GPU VRAM is
 * [N/A] on unified hosts). Detection rule per the M2 contract: gpus present
 * and gpu[0] reports no discrete VRAM total. Discrete-VRAM hosts → null.
 */
export function resolveUnifiedMemory(
  gpus: GpuSnapshot[],
  meminfo: Meminfo | null,
): HardwareSnapshot["unifiedMemory"] {
  if (gpus.length === 0 || gpus[0]?.memTotalBytes !== null) return null;
  if (meminfo === null || meminfo.memTotalBytes === null) return null;
  return {
    poolBytes: meminfo.memTotalBytes,
    availableBytes: meminfo.memAvailableBytes ?? 0,
    gpuReservedBytes: null,
  };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function unescapeMount(value: string): string {
  // /proc/mounts escapes \040 (space), \011 (tab), \134 (backslash) as octal.
  return value.replace(/\\([0-7]{3})/g, (_, oct: string) => String.fromCharCode(Number.parseInt(oct, 8)));
}

export function parseProcMounts(text: string): MountEntry[] {
  const mounts: MountEntry[] = [];
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3) continue;
    mounts.push({
      device: unescapeMount(fields[0]!),
      mount: unescapeMount(fields[1]!),
      fsType: fields[2]!,
    });
  }
  return mounts;
}

/** macOS `mount` human output: `/dev/disk3s1s1 on / (apfs, local, journaled)`. */
export function parseMountOutput(text: string): MountEntry[] {
  const mounts: MountEntry[] = [];
  for (const line of text.split("\n")) {
    const match = /^(.+?) on (.+?) \((.*)\)$/.exec(line.trim());
    if (match === null) continue;
    const fsType = (match[3] ?? "").split(/[,\s]+/)[0] ?? "";
    if (fsType.length === 0) continue;
    mounts.push({ device: match[1]!, mount: match[2]!, fsType });
  }
  return mounts;
}

/** Real filesystems only, deduped by device (first mount wins). */
export function selectRealMounts(mounts: MountEntry[]): MountEntry[] {
  const selected: MountEntry[] = [];
  const seenDevices = new Set<string>();
  for (const entry of mounts) {
    const fsType = entry.fsType.toLowerCase();
    if (EXCLUDED_FS_TYPES[fsType] !== undefined || fsType.startsWith("cgroup")) continue;
    if (entry.device.startsWith("/dev/loop")) continue;
    if (seenDevices.has(entry.device)) continue;
    seenDevices.add(entry.device);
    selected.push(entry);
  }
  return selected;
}

async function readMounts(procRoot: string): Promise<MountEntry[] | null> {
  try {
    return parseProcMounts(await fs.readFile(path.join(procRoot, "mounts"), "utf8"));
  } catch {
    // No procfs (macOS dev boxes): fall back to the mount table.
  }
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("mount", [], { timeout: 2000 });
      return parseMountOutput(stdout);
    } catch {
      // fall through
    }
  }
  return null;
}

/**
 * IR-206: one statfs raced against a hard timer. A wedged network mount
 * (dead CIFS) never resolves and used to stall the whole snapshot; now the
 * mount is skipped (null) and a healthy NAS still reports capacity.
 */
async function statfsBounded(
  mount: string,
  timeoutMs: number,
  impl: typeof statfs,
): Promise<StatsFs | null> {
  const { promise: timerP, resolve } = Promise.withResolvers<null>();
  const timer = setTimeout(() => resolve(null), timeoutMs);
  timer.unref?.();
  try {
    return await Promise.race([impl(mount), timerP]);
  } catch {
    return null; // listed but not statfs-able (stale automount, permissions)
  } finally {
    clearTimeout(timer);
  }
}

export async function readStorage(
  procRoot: string,
  blockRates?: Map<string, { readBps: number; writeBps: number }>,
  opts?: { statfsImpl?: typeof statfs; timeoutMs?: number },
): Promise<HardwareSnapshot["storage"]> {
  const mounts = await readMounts(procRoot);
  if (mounts === null) return [];
  const impl = opts?.statfsImpl ?? statfs;
  const timeoutMs = opts?.timeoutMs ?? 2000;
  const selected = selectRealMounts(mounts);
  // Parallel: each statfs carries its own bound, so the worst case is one
  // timeout window regardless of how many mounts are wedged.
  const stats = await Promise.all(selected.map((entry) => statfsBounded(entry.mount, timeoutMs, impl)));
  const storage: HardwareSnapshot["storage"] = [];
  for (let i = 0; i < selected.length; i++) {
    const s = stats[i]!;
    if (s === null) continue; // timed out or failed — skip the mount
    const entry = selected[i]!;
    const totalBytes = s.blocks * s.bsize;
    if (!(totalBytes > 0)) continue;
    const usedBytes = Math.max(0, (s.blocks - s.bfree) * s.bsize);
    let device: string | null = null;
    let readBps: number | null = null;
    let writeBps: number | null = null;
    if (blockRates !== undefined) {
      device = resolveBlockDev(entry.device, blockRates);
      if (device !== null) {
        const rates = blockRates.get(device);
        if (rates !== undefined) {
          readBps = rates.readBps;
          writeBps = rates.writeBps;
        }
      }
    }
    storage.push({ mount: entry.mount, fs: entry.fsType, totalBytes, usedBytes, readBps, writeBps, device });
  }
  return storage;
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/** /proc/net/dev — two header lines, then `iface: rx_bytes ... tx_bytes ...`. */
export function parseProcNetDev(text: string): NetCounters {
  const counters: NetCounters = new Map();
  for (const line of text.split("\n").slice(2)) {
    const sep = line.indexOf(":");
    if (sep < 0) continue;
    const iface = line.slice(0, sep).trim();
    const fields = line.slice(sep + 1).trim().split(/\s+/);
    if (iface.length === 0 || fields.length < 10) continue;
    const rx = Number(fields[0]);
    const tx = Number(fields[8]);
    if (Number.isInteger(rx) && Number.isInteger(tx)) counters.set(iface, { rx, tx });
  }
  return counters;
}

/** macOS `netstat -ibn` — link rows carry cumulative Ibytes/Obytes counters. */
export function parseNetstatIbn(text: string): NetCounters {
  const counters: NetCounters = new Map();
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10 || !/^<Link/i.test(fields[2] ?? "")) continue;
    const rx = Number(fields[6]);
    const tx = Number(fields[9]);
    const iface = fields[0];
    if (Number.isInteger(rx) && Number.isInteger(tx) && iface !== undefined) {
      counters.set(iface, { rx, tx });
    }
  }
  return counters;
}

async function sampleNetCounters(procRoot: string): Promise<NetCounters | null> {
  try {
    return parseProcNetDev(await fs.readFile(path.join(procRoot, "net", "dev"), "utf8"));
  } catch {
    // No procfs — try the BSD/macOS tool below.
  }
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("netstat", ["-ibn"], { timeout: 2000 });
      return parseNetstatIbn(stdout);
    } catch {
      // fall through
    }
  }
  return null;
}

/** Per-interface byte rates over the sample window; unseen ifaces → nulls. */
export function networkRates(
  net0: NetCounters | null,
  net1: NetCounters | null,
  dtMs: number,
  link?: Map<string, LinkDetail>,
): HardwareSnapshot["network"] {
  if (net0 === null || net1 === null || !(dtMs > 0)) return [];
  const rates: HardwareSnapshot["network"] = [];
  for (const [iface, c1] of net1) {
    if (iface === "lo") continue;
    const c0 = net0.get(iface);
    const detail = link?.get(iface);
    rates.push({
      iface,
      rxBps: c0 ? Math.max(0, Math.round((c1.rx - c0.rx) / (dtMs / 1000))) : null,
      txBps: c0 ? Math.max(0, Math.round((c1.tx - c0.tx) / (dtMs / 1000))) : null,
      speedMbps: detail?.speedMbps ?? null,
      operState: detail?.operState ?? null,
      addrs: detail?.addrs ?? [],
    });
  }
  return rates;
}

// ---------------------------------------------------------------------------
// Storage I/O rates (IRI-067): /sys/block/<dev>/stat sector deltas
// ---------------------------------------------------------------------------

const BLOCK_SKIP_PREFIXES = ["loop", "ram", "zram", "dm-", "md", "sr", "fd"];

/** Cumulative read/write sectors per block device (null without sysfs). */
export async function sampleBlockCounters(sysRoot: string): Promise<BlockCounters | null> {
  const counters: BlockCounters = new Map();
  try {
    const devs = await fs.readdir(path.join(sysRoot, "block"));
    await Promise.all(
      devs
        .filter((d) => !BLOCK_SKIP_PREFIXES.some((p) => d.startsWith(p)))
        .map(async (d) => {
          try {
            // Kernel block stat fields: read I/Os, merged, SECTORS (idx 2), time, write I/Os, merged, SECTORS (idx 6), …
            const fields = (await fs.readFile(path.join(sysRoot, "block", d, "stat"), "utf8")).trim().split(/\s+/);
            const readSectors = Number(fields[2]);
            const writeSectors = Number(fields[6]);
            if (Number.isFinite(readSectors) && Number.isFinite(writeSectors)) {
              counters.set(d, { readSectors, writeSectors });
            }
          } catch {
            // Device vanished mid-scan or stat unreadable — skip it.
          }
        }),
    );
  } catch {
    return null; // no sysfs (macOS dev boxes, containers without /sys)
  }
  return counters;
}

/** Map a mount's device path to its /sys/block entry (strip partition suffix). */
export function resolveBlockDev(mountDevice: string, known: { has(dev: string): boolean }): string | null {
  const base = mountDevice.split("/").pop() ?? "";
  if (known.has(base)) return base;
  // nvme0n1p2 → nvme0n1 and mmcblk0p1 → mmcblk0 (p-suffixed partitions), then
  // sda2 → sda (plain digit suffix). Disk names ending in digits (nvme0n1)
  // resolve via the `known` check above, never by stripping.
  const pSuffix = /^(.+)(p\d+)$/.exec(base);
  if (pSuffix !== null && known.has(pSuffix[1]!)) return pSuffix[1]!;
  const digitSuffix = /^([a-z]+)\d+$/.exec(base);
  if (digitSuffix !== null && known.has(digitSuffix[1]!)) return digitSuffix[1]!;
  return null;
}

/** Per-device byte rates over the sample window (sector = 512 B). */
export function blockRatesOf(window: Pick<SampleWindow, "block0" | "block1" | "dtMs">): Map<string, { readBps: number; writeBps: number }> {
  const rates = new Map<string, { readBps: number; writeBps: number }>();
  if (window.block0 === null || window.block1 === null || !(window.dtMs > 0)) return rates;
  for (const [dev, c1] of window.block1) {
    const c0 = window.block0.get(dev);
    if (c0 === undefined) continue;
    const ds = 512 / (window.dtMs / 1000);
    rates.set(dev, {
      readBps: Math.max(0, Math.round((c1.readSectors - c0.readSectors) * ds)),
      writeBps: Math.max(0, Math.round((c1.writeSectors - c0.writeSectors) * ds)),
    });
  }
  return rates;
}

// ---------------------------------------------------------------------------
// Network link detail (IRI-067): speed/operstate from sysfs, addrs from os
// ---------------------------------------------------------------------------

/** /sys/class/net link details; addrs come from os.networkInterfaces() everywhere. */
export async function readLinkDetail(sysRoot: string): Promise<Map<string, LinkDetail>> {
  const detail = new Map<string, LinkDetail>();
  const addrsByIface = new Map<string, string[]>();
  for (const [iface, infos] of Object.entries(os.networkInterfaces())) {
    const list = infos ?? [];
    const v4 = list.filter((i) => i.family === "IPv4").map((i) => i.address);
    const v6 = list.filter((i) => i.family === "IPv6").map((i) => i.address);
    addrsByIface.set(iface, [...v4, ...v6]);
  }
  let ifaces: string[];
  try {
    ifaces = await fs.readdir(path.join(sysRoot, "class", "net"));
  } catch {
    // No sysfs (macOS): address detail only; speed/operstate stay null.
    for (const [iface, addrs] of addrsByIface) detail.set(iface, { speedMbps: null, operState: null, addrs });
    return detail;
  }
  await Promise.all(
    ifaces.map(async (iface) => {
      let speedMbps: number | null = null;
      let operState: string | null = null;
      try {
        const speedRaw = await fs.readFile(path.join(sysRoot, "class", "net", iface, "speed"), "utf8");
        const speed = Number.parseInt(speedRaw.trim(), 10);
        // EINVAL/ENOTTY surfaces as a non-numeric read (lo, tun devices).
        speedMbps = Number.isInteger(speed) && speed > 0 ? speed : null;
      } catch {
        // Interface without a speed concept (lo, wg, tun) — null.
      }
      try {
        operState = (await fs.readFile(path.join(sysRoot, "class", "net", iface, "operstate"), "utf8")).trim() || null;
      } catch {
        // operstate is optional in old kernels.
      }
      detail.set(iface, { speedMbps, operState, addrs: addrsByIface.get(iface) ?? [] });
    }),
  );
  return detail;
}

// ---------------------------------------------------------------------------
// Unified-memory bandwidth (IRI-067): nvidia-smi dmon -s B, cached
// ---------------------------------------------------------------------------

/** dmon -c 1 -d 1 blocks ~1 s: refresh in the background at most every 10 s. */
const DMON_REFRESH_MS = 10_000;

export interface MemoryBandwidthReading {
  readBps: number | null;
  writeBps: number | null;
  sampledAtMs: number | null;
}

let dmonCache: MemoryBandwidthReading = { readBps: null, writeBps: null, sampledAtMs: null };
let dmonLastAttemptMs = 0;
let dmonInFlight: Promise<void> | null = null;

/**
 * sparkDash-proven parse: the last data row of `dmon -c 1 -d 1 -s B` carries
 * read and write MB/s in columns 2 and 3 (0 = gpu index). Returns null when
 * the tool is absent or the output shape is unrecognized.
 */
export function parseDmonBw(stdout: string): { readBps: number; writeBps: number } | null {
  const rows = stdout.split("\n").filter((l) => !l.startsWith("#") && l.trim().length > 0);
  const last = rows.at(-1);
  if (last === undefined) return null;
  const parts = last.trim().split(/\s+/);
  if (parts.length < 4) return null;
  const readMBs = Number.parseFloat(parts[2] ?? "");
  const writeMBs = Number.parseFloat(parts[3] ?? "");
  if (!Number.isFinite(readMBs) || !Number.isFinite(writeMBs) || (readMBs === 0 && writeMBs === 0)) return null;
  return { readBps: Math.round(readMBs * 1e6), writeBps: Math.round(writeMBs * 1e6) };
}

function refreshDmonCache(): void {
  if (dmonInFlight !== null || Date.now() - dmonLastAttemptMs < DMON_REFRESH_MS) return;
  dmonLastAttemptMs = Date.now();
  dmonInFlight = (async () => {
    try {
      const out = await runNvidiaSmi(["dmon", "-c", "1", "-d", "1", "-s", "B"]);
      if (out !== null) {
        const parsed = parseDmonBw(out);
        if (parsed !== null) dmonCache = { ...parsed, sampledAtMs: Date.now() };
      }
    } finally {
      dmonInFlight = null;
    }
  })();
}

/** Cached dmon reading; kicks a background refresh when older than 10 s. */
export function memoryBandwidthReading(): MemoryBandwidthReading {
  refreshDmonCache();
  return dmonCache;
}

// ---------------------------------------------------------------------------
// Kernel Xid/OOM counters (IRI-067): journalctl -k, 60 s cadence
// ---------------------------------------------------------------------------

const KERNEL_REFRESH_MS = 60_000;
const KERNEL_LINE_CAP = 512;
const KERNEL_RECENT_CAP = 20;

export interface KernelCounters {
  xidCount: number;
  xidRecent: string[];
  oomCount: number;
  oomRecent: string[];
}

let kernelCache: KernelCounters | null = null;
let kernelLastAttemptMs = 0;
let kernelInFlight: Promise<void> | null = null;
/** Dedupe keys (unix-ts + message head) of already-counted journal lines. */
const kernelSeen = new Set<string>();

/**
 * Pure journal parser: Xid GPU-fault lines and oom-killer events since boot.
 * `seen` dedupes across refreshes (journal re-reads replay old lines); the
 * recent lists are newest-first and bounded. Returns null when the line set
 * is unusable (caller keeps its previous cache).
 */
export function parseKernelJournal(
  text: string,
  seen: Set<string>,
): { xidCount: number; xidRecent: string[]; oomCount: number; oomRecent: string[] } {
  const xidRecent: string[] = [];
  const oomRecent: string[] = [];
  let xidCount = 0;
  let oomCount = 0;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.length === 0) continue;
    const isXid = /Xid/.test(line);
    const isOom = /oom-kill|Out of memory: Killed process/i.test(line);
    if (!isXid && !isOom) continue;
    const key = line.slice(0, 200);
    if (seen.has(key)) continue;
    seen.add(key);
    const msg = line.slice(-KERNEL_LINE_CAP);
    if (isXid) {
      xidCount += 1;
      xidRecent.unshift(msg);
      if (xidRecent.length > KERNEL_RECENT_CAP) xidRecent.pop();
    } else {
      oomCount += 1;
      oomRecent.unshift(msg);
      if (oomRecent.length > KERNEL_RECENT_CAP) oomRecent.pop();
    }
  }
  return { xidCount, xidRecent, oomCount, oomRecent };
}

function refreshKernelCache(): void {
  if (kernelInFlight !== null || Date.now() - kernelLastAttemptMs < KERNEL_REFRESH_MS) return;
  kernelLastAttemptMs = Date.now();
  kernelInFlight = (async () => {
    try {
      // Bounded tail of the current boot's kernel ring; the dedupe set makes
      // re-reads idempotent. 16 MiB buffer guards long-uptime nodes.
      const { stdout } = await execFileAsync(
        "journalctl",
        ["-k", "-b", "-n", "5000", "-o", "short-unix", "--no-pager", "-q"],
        { timeout: 8000, maxBuffer: 16 * 1024 * 1024 },
      );
      const parsed = parseKernelJournal(stdout, kernelSeen);
      kernelCache = parsed;
    } catch {
      // No systemd journal (macOS dev boxes, containers) — keep the cache.
    } finally {
      kernelInFlight = null;
    }
  })();
}

/** Cached kernel counters; kicks a background refresh when older than 60 s. */
export function kernelCountersReading(): KernelCounters | null {
  refreshKernelCache();
  return kernelCache;
}
