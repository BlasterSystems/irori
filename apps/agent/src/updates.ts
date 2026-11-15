import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * IRI-081: on-node OS/firmware/driver update state. READ-ONLY — the only
 * invocation that touches the package system is `apt-get -s upgrade`
 * (simulate: no download, no install). Every probe degrades to null so a
 * missing tool never blanks the section.
 */
export interface UpdateState {
  osPrettyName: string | null;
  kernelVersion: string | null;
  dgxOsVersion: string | null;
  nvidiaDriverVersion: string | null;
  /** fwupdmgr get-updates --json: device → version pairs that are updatable. */
  firmwareUpdates: Array<{ device: string; toVersion: string }>;
  /** IR-256: false when fwupdmgr produced nothing (absent or failing) — the
   *  UI then says so instead of implying an up-to-date firmware. */
  fwupdPresent: boolean;
  /** Installed NVIDIA OTA packages (dpkg -l), with their versions. */
  otaPackages: Array<{ name: string; version: string }>;
  pendingReboot: boolean;
  unattendedUpgradesLastResult: string | null;
  upgradableCount: number | null;
  /** Tool absent → the posture is "update tooling absent", not "up to date". */
  aptPresent: boolean;
}

function firstLine(s: string): string | null {
  const line = s.trim().split("\n")[0]?.trim() ?? "";
  return line.length > 0 && line.length <= 300 ? line : null;
}

async function run(file: string, args: string[], timeout = 10_000): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(file, args, { timeout, maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  } catch {
    return null;
  }
}

/** /etc/os-release PRETTY_NAME, or null. */
export async function readOsPrettyName(osReleasePath = "/etc/os-release"): Promise<string | null> {
  try {
    const raw = await fs.readFile(osReleasePath, "utf8");
    const m = /^PRETTY_NAME="(.+)"$/m.exec(raw);
    return m === null ? null : m[1]!;
  } catch {
    return null;
  }
}

/** The DGX OS version: /etc/dgx-release (5.x style) or apt dgx-os meta.
 *  IR-243: prefer the DGX_OS_VERSION key — the old regex returned the FIRST
 *  line verbatim, which on DGX Spark is `DGX_NAME="DGX Spark"`. */
export async function readDgxOsVersion(paths: string[] = ["/etc/dgx-release", "/etc/nvidia-release"]): Promise<string | null> {
  for (const path of paths) {
    try {
      const raw = await fs.readFile(path, "utf8");
      const kv = /^DGX_OS_VERSION[=\s]+"?([^"\n]+)"?$/m.exec(raw);
      if (kv !== null) return kv[1]!.trim();
      const line = /^DGX_OS_LINE[=\s]+"?([^"\n]+)"?$/m.exec(raw);
      if (line !== null) return line[1]!.trim();
      // 5.x style: a single bare version line, no KEY= pairs at all.
      const bare = firstLine(raw);
      if (bare !== null && !/^DGX_[A-Z_]+[=\s]/.test(bare) && !bare.includes("=")) return bare;
    } catch {
      /* next */
    }
  }
  return null;
}

/** Installed NVIDIA OTA packages via dpkg -l (null when dpkg is absent). */
export async function readOtaPackages(dpkgQueryOut?: string | null): Promise<{ otaPackages: Array<{ name: string; version: string }>; aptPresent: boolean } | null> {
  // null = explicit "tool absent" (deterministic in tests); undefined = run.
  if (dpkgQueryOut === null) return null;
  const out = dpkgQueryOut ?? (await run("dpkg-query", ["-W", "-f", "${Package}\t${Version}\n", "nvidia-spark-ota-check", "dgx-spark-ota-update-meta"]));
  if (out === null) return null; // dpkg-query absent
  const otaPackages: Array<{ name: string; version: string }> = [];
  for (const line of out.split("\n")) {
    const [name, version] = line.split("\t");
    // "unknown/not-installed" rows carry no version — skip them.
    if (name === undefined || version === undefined) continue;
    if (version.length === 0 || version.startsWith("unknown")) continue;
    otaPackages.push({ name, version });
  }
  return { otaPackages, aptPresent: true };
}

/** IR-256: parse `fwupdmgr get-updates --json`. `null` = the tool produced
 *  nothing (absent or failed) — an empty list; the caller reports presence. */
export function readFirmwareUpdates(fwupdmgrOut: string | null): Array<{ device: string; toVersion: string }> {
  if (fwupdmgrOut === null) return [];
  try {
    const parsed = JSON.parse(fwupdmgrOut) as { Devices?: Array<{ Name?: string; UpdateVersion?: string }> };
    const devices = parsed.Devices ?? [];
    return devices
      .filter((d) => typeof d.UpdateVersion === "string" && d.UpdateVersion.length > 0)
      .map((d) => ({ device: typeof d.Name === "string" ? d.Name : "unknown", toVersion: d.UpdateVersion! }));
  } catch {
    return [];
  }
}

/** Unattended-upgrades last-run result (newest /var/log/unattended-upgrades dir). */
export async function readUnattendedUpgradesResult(logDir = "/var/log/unattended-upgrades"): Promise<string | null> {
  try {
    const entries = await fs.readdir(logDir);
    const dirs = entries.filter((e) => /^\d{8}/.test(e)).sort().reverse();
    if (dirs.length === 0) return null;
    const raw = await fs.readFile(`${logDir}/${dirs[0]!}/result`, "utf8").catch(() => null);
    return raw === null ? null : firstLine(raw);
  } catch {
    return null;
  }
}

/** Upgradable package count via `apt-get -s upgrade` (SIMULATE — read-only). */
export async function readUpgradableCount(dryRunOut?: string | null): Promise<{ count: number | null; aptPresent: boolean }> {
  // null = explicit "tool absent" (deterministic in tests); undefined = run.
  if (dryRunOut === null) return { count: null, aptPresent: false };
  const raw = dryRunOut ?? (await run("apt-get", ["-s", "upgrade"], 20_000));
  if (raw === null) return { count: null, aptPresent: false };
  let count = 0;
  for (const line of raw.split("\n")) {
    if (/^(Inst|Conf)/.test(line.trim()) === false) continue;
    if (line.trim().startsWith("Conf")) continue; // only count Inst lines
    count += 1;
  }
  return { count, aptPresent: true };
}

/** Full on-node collection. Never throws — a probe failure degrades to null. */
export async function collectUpdateState(
  opts: { fwupdmgrOut?: string | null; aptGetSimOut?: string | null; dpkgQueryOut?: string | null; unattendedDir?: string } = {},
): Promise<UpdateState> {
  const [unameOut, driverOut, osPrettyName, dgxOsVersion, ota, pendingReboot, unattended, upgradable, fwupdOut] = await Promise.all([
    run("uname", ["-r"]),
    run("nvidia-smi", ["--query-gpu=driver_version", "--format=csv,noheader"]),
    readOsPrettyName(),
    readDgxOsVersion(),
    readOtaPackages(opts.dpkgQueryOut),
    fs
      .stat("/var/run/reboot-required")
      .then(() => true)
      .catch(() => false),
    readUnattendedUpgradesResult(opts.unattendedDir),
    readUpgradableCount(opts.aptGetSimOut),
    // undefined = run the probe; null = explicitly absent (tests).
    opts.fwupdmgrOut === undefined ? run("fwupdmgr", ["get-updates", "--json"], 15_000) : opts.fwupdmgrOut,
  ]);
  const firmwareUpdates = readFirmwareUpdates(fwupdOut);
  return {
    osPrettyName,
    kernelVersion: firstLine(unameOut ?? ""),
    dgxOsVersion,
    nvidiaDriverVersion: firstLine(driverOut ?? ""),
    firmwareUpdates,
    fwupdPresent: fwupdOut !== null,
    otaPackages: ota?.otaPackages ?? [],
    pendingReboot,
    unattendedUpgradesLastResult: unattended,
    upgradableCount: upgradable.count,
    aptPresent: ota?.aptPresent ?? upgradable.aptPresent,
  };
}
