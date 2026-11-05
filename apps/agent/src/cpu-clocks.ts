import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ClocksCpu, ClocksCpuPolicy, ClocksGpu } from "@irori/core";

/**
 * IRI-124: CPU clock ceiling via cpufreq.
 *
 * A cap is an upper bound, not an operating point: every policy receives
 * min(cap, cpuinfo_max_freq), so a cap above a cluster's maximum leaves that
 * cluster untouched (GB10 ships two clusters: 2,808 MHz and 3,900 MHz).
 * Clearing writes cpuinfo_max_freq back — the driver's own maximum.
 *
 * Spec §10: `scaling_max_freq`, not `max_perf` (the latter is accepted by GB10
 * but re-derived from the thermal/power policy). The agent runs as root, which
 * is what the root-owned sysfs files require.
 */

const execFileAsync = promisify(execFile);

const SYS_CPU_ROOT = "/sys/devices/system/cpu/cpufreq";
const SYSTEMD_UNIT_DIR = "/etc/systemd/system";
const SCRIPT_PATH = "/etc/irori/cpu-clock-cap.sh";

/** Cap re-apply oneshot (IRI-124) — same idiom as the GPU unit (IRI-068). */
export const CPU_CAP_UNIT = "irori-cpu-clock-cap.service";
/** Marker proving the unit/script are ours (collision guard for foreign files). */
export const UNIT_MARKER = "# irori-managed — do not edit";

interface PolicyDir {
  /** e.g. "policy0" — sorted numerically, not lexicographically. */
  name: string;
  path: string;
}

async function listPolicies(sysRoot: string): Promise<PolicyDir[]> {
  try {
    const entries = (await fs.readdir(sysRoot)).filter((e) => /^policy\d+$/.test(e));
    entries.sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)));
    return entries.map((name) => ({ name, path: `${sysRoot}/${name}` }));
  } catch {
    return [];
  }
}

async function readInt(file: string): Promise<number | null> {
  const raw = await fs
    .readFile(file, "utf8")
    .then((t) => Number.parseInt(t.trim(), 10))
    .catch(() => Number.NaN);
  return Number.isInteger(raw) && raw >= 0 ? raw : null;
}

async function readCpus(file: string): Promise<number[]> {
  const raw = await fs.readFile(file, "utf8").catch(() => "");
  return raw
    .split(/[\s,]+/)
    .map((v) => Number.parseInt(v, 10))
    .filter((v) => Number.isInteger(v) && v >= 0);
}

/** Group policies that share min/max/current into display clusters. */
function clusterPolicies(rows: ClocksCpuPolicy[]): ClocksCpuPolicy[] {
  const groups = new Map<string, ClocksCpuPolicy>();
  for (const row of rows) {
    const key = `${row.minKHz}:${row.maxKHz}:${row.curMaxKHz}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { ...row, cpus: [...row.cpus] });
    } else {
      existing.cpus.push(...row.cpus);
    }
  }
  const out = [...groups.values()];
  for (const group of out) group.cpus.sort((a, b) => a - b);
  out.sort((a, b) => b.curMaxKHz - a.curMaxKHz || b.maxKHz - a.maxKHz);
  return out;
}

/**
 * Read the CPU clock state. `cpu` is null when the platform exposes no cpufreq
 * policies (nothing to cap) — the UI hides the control instead of faking one.
 */
export async function readCpuClocks(
  sysRoot = SYS_CPU_ROOT,
): Promise<{ ok: boolean; cpu: ClocksCpu | null; error: string | null }> {
  const policies = await listPolicies(sysRoot);
  if (policies.length === 0) return { ok: true, cpu: null, error: null };
  const rows: ClocksCpuPolicy[] = [];
  for (const policy of policies) {
    const [cpus, minKHz, maxKHz, curMaxKHz] = await Promise.all([
      readCpus(`${policy.path}/related_cpus`),
      readInt(`${policy.path}/cpuinfo_min_freq`),
      readInt(`${policy.path}/cpuinfo_max_freq`),
      readInt(`${policy.path}/scaling_max_freq`),
    ]);
    if (minKHz === null || maxKHz === null || curMaxKHz === null) {
      return { ok: false, cpu: null, error: `unreadable cpufreq policy ${policy.name}` };
    }
    rows.push({ cpus: cpus.length > 0 ? cpus : [Number(policy.name.slice(6))], minKHz, maxKHz, curMaxKHz });
  }
  const clusters = clusterPolicies(rows);
  const ceilings = new Set(clusters.map((c) => c.curMaxKHz));
  // One uniform ceiling reads as "cap N MHz"; mixed policies stay null rather
  // than claiming a cap that is not in force everywhere.
  const capMHz = ceilings.size === 1 ? Math.round([...ceilings][0]! / 1000) : null;
  return { ok: true, cpu: { capMHz, policies: clusters }, error: null };
}

/**
 * Apply (or clear, null) the CPU ceiling. Every policy gets
 * min(cap, cpuinfo_max_freq), clamped up to cpuinfo_min_freq so a cap below a
 * cluster's floor cannot push an invalid value at the driver.
 */
export async function setCpuCap(
  capMHz: number | null,
  sysRoot = SYS_CPU_ROOT,
): Promise<{ ok: boolean; error: string | null; cpu: ClocksCpu | null }> {
  const policies = await listPolicies(sysRoot);
  if (policies.length === 0) {
    return { ok: false, error: "no cpufreq policies — CPU clock control unavailable", cpu: null };
  }
  try {
    for (const policy of policies) {
      const [minKHz, maxKHz] = await Promise.all([
        readInt(`${policy.path}/cpuinfo_min_freq`),
        readInt(`${policy.path}/cpuinfo_max_freq`),
      ]);
      if (minKHz === null || maxKHz === null) {
        return { ok: false, error: `unreadable cpufreq policy ${policy.name}`, cpu: null };
      }
      const requested = capMHz === null ? maxKHz : capMHz * 1000;
      const target = Math.max(minKHz, Math.min(requested, maxKHz));
      await fs.writeFile(`${policy.path}/scaling_max_freq`, `${target}\n`, "utf8");
    }
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), cpu: null };
  }
  const after = await readCpuClocks(sysRoot);
  return { ok: after.ok, error: after.error, cpu: after.cpu };
}

/**
 * IRI-124: composite clocks reply. The frame is ok when EITHER half produced a
 * reading — a gpu-host or NAS without `nvidia-smi` must still report usable CPU
 * clock state, and a box without cpufreq must still report its cards. The error
 * string keeps whichever half failed (empty when both worked).
 */
export function mergeClocksReply(
  gpu: { ok: boolean; gpus: ClocksGpu[]; error: string | null },
  cpu: { ok: boolean; cpu: ClocksCpu | null; error: string | null },
): { ok: boolean; gpus: ClocksGpu[]; cpu: ClocksCpu | null; error: string | null } {
  return {
    ok: gpu.ok || cpu.cpu !== null,
    gpus: gpu.gpus,
    cpu: cpu.cpu,
    error: gpu.error ?? cpu.error,
  };
}

/** Boot-time re-apply script; `capMHz` is an integer, never shell-interpolated input. */
export function cpuCapScriptBody(capMHz: number): string {
  return [
    "#!/bin/sh",
    UNIT_MARKER,
    "# Re-apply the Irori CPU clock ceiling after boot (IRI-124).",
    `cap=${Math.trunc(capMHz)}`,
    `for p in ${SYS_CPU_ROOT}/policy*/; do`,
    '  max=$(cat "$p/cpuinfo_max_freq" 2>/dev/null) || continue',
    '  min=$(cat "$p/cpuinfo_min_freq" 2>/dev/null) || continue',
    "  target=$((cap * 1000))",
    '  if [ "$target" -gt "$max" ]; then target=$max; fi',
    '  if [ "$target" -lt "$min" ]; then target=$min; fi',
    '  echo "$target" > "$p/scaling_max_freq" 2>/dev/null || true',
    "done",
    "",
  ].join("\n");
}

/** The oneshot unit pointing at the script. */
export function cpuCapUnitBody(scriptPath = SCRIPT_PATH): string {
  return [
    UNIT_MARKER,
    "[Unit]",
    "Description=Irori CPU clock cap re-apply",
    "After=multi-user.target",
    "",
    "[Service]",
    "Type=oneshot",
    `ExecStart=/bin/sh ${scriptPath}`,
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

async function defaultSystemctl(args: string[]): Promise<void> {
  await execFileAsync("systemctl", args, { timeout: 10_000 });
}

async function readOwned(file: string): Promise<{ exists: boolean; owned: boolean }> {
  try {
    const body = await fs.readFile(file, "utf8");
    return { exists: true, owned: body.includes(UNIT_MARKER) };
  } catch {
    return { exists: false, owned: true };
  }
}

/**
 * Install (capMHz > 0) or remove (null) the boot-time re-apply. A foreign unit
 * or script with the same path (no irori marker) is refused, never overwritten.
 */
export async function persistCpuCap(
  capMHz: number | null,
  opts: {
    unitDir?: string;
    scriptPath?: string;
    runSystemctl?: (args: string[]) => Promise<void>;
  } = {},
): Promise<{ ok: boolean; error: string | null }> {
  const unitDir = opts.unitDir ?? SYSTEMD_UNIT_DIR;
  const scriptPath = opts.scriptPath ?? SCRIPT_PATH;
  const run = opts.runSystemctl ?? defaultSystemctl;
  const unitPath = `${unitDir}/${CPU_CAP_UNIT}`;
  try {
    const unit = await readOwned(unitPath);
    if (!unit.owned) return { ok: false, error: `${CPU_CAP_UNIT} already exists and is not irori-managed` };
    const script = await readOwned(scriptPath);
    if (!script.owned) return { ok: false, error: `${scriptPath} already exists and is not irori-managed` };

    if (capMHz === null) {
      // Disable before the files go away, or the wants symlink lingers.
      await run(["disable", CPU_CAP_UNIT]).catch(() => {});
      await fs.rm(unitPath, { force: true });
      await fs.rm(scriptPath, { force: true });
    } else {
      await fs.mkdir(scriptPath.slice(0, scriptPath.lastIndexOf("/")), { recursive: true });
      await fs.writeFile(scriptPath, cpuCapScriptBody(capMHz), { mode: 0o755 });
      await fs.writeFile(unitPath, cpuCapUnitBody(scriptPath), { mode: 0o644 });
      await run(["enable", CPU_CAP_UNIT]);
    }
    await run(["daemon-reload"]);
    return { ok: true, error: null };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
