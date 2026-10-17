import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { SCHEMA_VERSION } from "@irori/core";
import type { GpuSnapshot, HardwareSnapshot } from "@irori/core";
import { AGENT_VERSION } from "./version.js";

const execFileAsync = promisify(execFile);

/** Delay between the two CPU usage samples. */
const CPU_SAMPLE_DELAY_MS = 200;
/** Hard timeout for nvidia-smi; a hung query must not stall the collector. */
const GPU_QUERY_TIMEOUT_MS = 3000;

const NVIDIA_SMI_ARGS = [
  "--query-gpu=index,name,utilization.gpu,temperature.gpu,memory.used,memory.total,power.draw",
  "--format=csv,noheader,nounits",
];

/**
 * Collect a hardware snapshot on the current host. Metrics that cannot be
 * read are null (or [] for GPUs) rather than omitted; see packages/core.
 */
export async function collect(): Promise<HardwareSnapshot> {
  const [cpuUsagePct, gpus] = await Promise.all([sampleCpuUsagePct(), queryGpus()]);

  const cpus = os.cpus();
  if (cpus.length === 0) {
    throw new Error("os.cpus() returned no CPU information");
  }
  const totalMem = os.totalmem();
  const [load1] = os.loadavg();

  return {
    schemaVersion: SCHEMA_VERSION,
    agentVersion: AGENT_VERSION,
    hostname: os.hostname(),
    transport: "ws",
    timestampMs: Date.now(),
    cpu: {
      model: cpus[0]?.model ?? "unknown",
      cores: cpus.length,
      usagePct: cpuUsagePct,
      tempC: null, // M2
      packagePowerW: null, // M2
    },
    memory: { totalBytes: totalMem, usedBytes: totalMem - os.freemem() },
    gpus,
    load1,
    uptimeS: Math.floor(os.uptime()),
  };
}

/** CPU usage from two os.cpus() samples taken ~200 ms apart. */
async function sampleCpuUsagePct(): Promise<number | null> {
  const start = os.cpus();
  const settled = Promise.withResolvers<void>();
  setTimeout(settled.resolve, CPU_SAMPLE_DELAY_MS);
  await settled.promise;
  const end = os.cpus();

  let idleDelta = 0;
  let totalDelta = 0;
  const n = Math.min(start.length, end.length);
  for (let i = 0; i < n; i++) {
    const s = start[i]!.times;
    const e = end[i]!.times;
    idleDelta += e.idle - s.idle;
    totalDelta += e.user + e.nice + e.sys + e.idle + e.irq - (s.user + s.nice + s.sys + s.idle + s.irq);
  }
  if (totalDelta <= 0) return null;
  const usagePct = (1 - idleDelta / totalDelta) * 100;
  return Math.min(100, Math.max(0, Math.round(usagePct * 10) / 10));
}

/**
 * Query GPUs via nvidia-smi. Any failure (ENOENT, non-zero exit, timeout)
 * yields [] — homelab nodes without NVIDIA tooling simply report no GPUs.
 */
async function queryGpus(): Promise<GpuSnapshot[]> {
  let stdout: string;
  try {
    const result = await execFileAsync("nvidia-smi", NVIDIA_SMI_ARGS, {
      timeout: GPU_QUERY_TIMEOUT_MS,
    });
    stdout = result.stdout;
  } catch {
    return [];
  }
  return parseGpuCsv(stdout);
}

/** Parse `nvidia-smi --query-gpu=... --format=csv,noheader,nounits` output. */
export function parseGpuCsv(stdout: string): GpuSnapshot[] {
  const gpus: GpuSnapshot[] = [];
  for (const lineRaw of stdout.split("\n")) {
    const line = lineRaw.trim();
    if (line.length === 0) continue;
    const fields = line.split(",").map((f) => f.trim().replace(/^"|"$/g, ""));
    if (fields.length < 7) continue;

    const index = Number.parseInt(fields[0]!, 10);
    const name = fields[1] ?? "";
    if (!Number.isInteger(index) || index < 0 || name.length === 0) continue;

    gpus.push({
      index,
      name,
      usagePct: clampPct(parseNumber(fields[2])),
      tempC: parseNumber(fields[3]),
      // nvidia-smi reports memory in MiB even with nounits → convert to bytes.
      memUsedBytes: mibToBytes(parseNumber(fields[4])),
      memTotalBytes: mibToBytes(parseNumber(fields[5])),
      powerW: parseNumber(fields[6]),
      throttleReasons: [],
    });
  }
  return gpus;
}

/** nvidia-smi number cell; "[N/A]", "[Not Supported]", "N/A" and blanks → null. */
function parseNumber(field: string | undefined): number | null {
  if (field === undefined) return null;
  const cleaned = field.trim().replace(/^"|"$/g, "");
  if (cleaned.length === 0 || cleaned.includes("[") || /^n\/a$/i.test(cleaned)) return null;
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : null;
}

function clampPct(value: number | null): number | null {
  if (value === null) return null;
  return Math.min(100, Math.max(0, value));
}

function mibToBytes(mib: number | null): number | null {
  if (mib === null) return null;
  return Math.max(0, Math.round(mib * 1024 * 1024));
}
