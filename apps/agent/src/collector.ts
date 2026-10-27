import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
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
  const [tempC, perCoreClocksKHz, perCoreMaxClocksKHz, storage] = await Promise.all([
    readCpuTempC(sysRoot),
    readPerCoreClocksKHz(sysRoot),
    readPerCoreMaxClocksKHz(sysRoot),
    readStorage(procRoot),
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
    storage,
    network: networkRates(window.net0, window.net1, window.dtMs),
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
  const [cpu0, net0, energy0] = await Promise.all([
    Promise.resolve(os.cpus()),
    sampleNetCounters(procRoot),
    readRaplEnergyUj(sysRoot),
  ]);
  const { promise: windowDelay, resolve: windowDelayDone } = Promise.withResolvers<void>();
  setTimeout(windowDelayDone, CPU_SAMPLE_DELAY_MS);
  await windowDelay;
  const [cpu1, net1, energy1] = await Promise.all([
    Promise.resolve(os.cpus()),
    sampleNetCounters(procRoot),
    readRaplEnergyUj(sysRoot),
  ]);
  const dtMs = performance.now() - started;
  return { cpu0, cpu1, net0, net1, dtMs, packagePowerW: raplPowerW(energy0, energy1, dtMs) };
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

export async function readStorage(procRoot: string): Promise<HardwareSnapshot["storage"]> {
  const mounts = await readMounts(procRoot);
  if (mounts === null) return [];
  const storage: HardwareSnapshot["storage"] = [];
  for (const entry of selectRealMounts(mounts)) {
    try {
      const stats = await statfs(entry.mount);
      const totalBytes = stats.blocks * stats.bsize;
      if (!(totalBytes > 0)) continue;
      const usedBytes = Math.max(0, (stats.blocks - stats.bfree) * stats.bsize);
      storage.push({ mount: entry.mount, fs: entry.fsType, totalBytes, usedBytes });
    } catch {
      // Listed but not statfs-able (stale automount, permissions) — skip.
    }
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
): HardwareSnapshot["network"] {
  if (net0 === null || net1 === null || !(dtMs > 0)) return [];
  const rates: HardwareSnapshot["network"] = [];
  for (const [iface, c1] of net1) {
    if (iface === "lo") continue;
    const c0 = net0.get(iface);
    rates.push({
      iface,
      rxBps: c0 ? Math.max(0, Math.round((c1.rx - c0.rx) / (dtMs / 1000))) : null,
      txBps: c0 ? Math.max(0, Math.round((c1.tx - c0.tx) / (dtMs / 1000))) : null,
    });
  }
  return rates;
}
