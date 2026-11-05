import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import type { ClocksGpu } from "@irori/core";

const execFileAsync = promisify(execFile);

/** Hard timeout for nvidia-smi; a hung query must not wedge the agent. */
const GPU_QUERY_TIMEOUT_MS = 3000;

const CLOCKS_QUERY_ARGS = [
  "--query-gpu=index,name,clocks.current.sm,clocks.max.sm,clocks.current.memory,clocks.max.memory,clocks.applications.sm",
  "--format=csv,noheader,nounits",
];

function cleanField(raw: string): string {
  return raw.trim().replace(/\s*\[N\/?A\]$/i, "").trim();
}

function intOrNull(raw: string): number | null {
  const v = Number.parseInt(raw, 10);
  return Number.isInteger(v) && v >= 0 ? v : null;
}

/**
 * Parse the 7-field clocks CSV row set (IRI-067). `[N/A]` cells (common on
 * GB10 where memory clocks are unified) become null, never zero.
 */
export function parseClocksCsv(stdout: string): ClocksGpu[] {
  const gpus: ClocksGpu[] = [];
  for (const lineRaw of stdout.split("\n")) {
    const line = lineRaw.trim();
    if (line.length === 0) continue;
    const fields = line.split(",").map(cleanField);
    if (fields.length < 7) continue;
    const index = intOrNull(fields[0] ?? "");
    if (index === null) continue;
    gpus.push({
      index,
      name: (fields[1] ?? "").length > 0 ? fields[1]! : null,
      smMHz: intOrNull(fields[2] ?? ""),
      smMaxMHz: intOrNull(fields[3] ?? ""),
      memMHz: intOrNull(fields[4] ?? ""),
      memMaxMHz: intOrNull(fields[5] ?? ""),
      smCapMHz: intOrNull(fields[6] ?? ""),
    });
  }
  return gpus;
}

/** Read per-GPU clocks + cap state. ok=false carries the tool error. */
export async function readClocks(): Promise<{ ok: boolean; gpus: ClocksGpu[]; error: string | null }> {
  try {
    const { stdout } = await execFileAsync("nvidia-smi", CLOCKS_QUERY_ARGS, { timeout: GPU_QUERY_TIMEOUT_MS });
    return { ok: true, gpus: parseClocksCsv(stdout), error: null };
  } catch (err: unknown) {
    return { ok: false, gpus: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Apply (or reset, null) the SM application clock cap on every GPU via
 * `nvidia-smi -lgc 0,<max>` / `-rgc`. Requires root (the agent is root by
 * design); a non-zero exit surfaces as ok=false with stderr.
 */
export async function setSmCap(smMaxMHz: number | null): Promise<{ ok: boolean; error: string | null }> {
  const args = smMaxMHz === null ? ["-rgc"] : ["-lgc", `0,${smMaxMHz}`];
  try {
    await execFileAsync("nvidia-smi", args, { timeout: GPU_QUERY_TIMEOUT_MS });
    return { ok: true, error: null };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// IRI-068: cap persistence (systemd oneshot) + node shutdown
// ---------------------------------------------------------------------------

export const CLOCK_CAP_UNIT = "irori-gpu-clock-cap.service";
/** Marker proving the unit file is ours (collision guard for foreign units). */
const UNIT_MARKER = "# irori-managed — do not edit";

/**
 * Whether a clocks-set side touches its boot-time unit (IRI-068/IRI-124).
 * - a failed live apply never does: removing the unit would leave a live cap
 *   that nothing re-applies after a reboot;
 * - a CLEAR always removes it, even without `persist` — "cleared live but
 *   re-applied at boot" has no coherent meaning, and the stale unit was how a
 *   cleared cap resurrected itself;
 * - a cap is installed only when the caller asked for persistence.
 */
export function shouldPersist(value: number | null, persist: boolean, applied: boolean): boolean {
  if (!applied) return false;
  return persist || value === null;
}

/** The oneshot body; `capMHz` is an integer (never shell-interpolated input). */
export function clockCapUnitBody(capMHz: number): string {
  return [
    UNIT_MARKER,
    "[Unit]",
    "Description=Irori GPU clock cap re-apply",
    "After=multi-user.target",
    "",
    "[Service]",
    "Type=oneshot",
    `ExecStart=/usr/bin/nvidia-smi -lgc 0,${capMHz}`,
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

const SYSTEMD_UNIT_DIR = "/etc/systemd/system";

/** Default systemd runner (production); tests inject a no-op. */
async function defaultSystemctl(args: string[]): Promise<void> {
  await execFileAsync("systemctl", args, { timeout: 10_000 });
}

/**
 * Install (capMHz > 0) or remove (null) the re-apply oneshot. A foreign unit
 * with the same name (no irori marker) is refused — never overwrite another
 * tool's file. `runSystemctl` is injectable for tests on non-systemd hosts.
 */
export async function persistClockCap(capMHz: number | null, unitDir = SYSTEMD_UNIT_DIR, runSystemctl: (args: string[]) => Promise<void> = defaultSystemctl): Promise<{ ok: boolean; error: string | null }> {
  const unitPath = `${unitDir}/${CLOCK_CAP_UNIT}`;
  try {
    if (capMHz === null) {
      // Disable first: once the unit file is gone `systemctl disable` cannot
      // find the name and the multi-user.target.wants symlink lingers.
      await runSystemctl(["disable", CLOCK_CAP_UNIT]).catch(() => {});
      await fs.rm(unitPath, { force: true });
    } else {
      try {
        const existing = await fs.readFile(unitPath, "utf8");
        if (!existing.includes(UNIT_MARKER)) {
          return { ok: false, error: `${CLOCK_CAP_UNIT} already exists and is not irori-managed` };
        }
      } catch {
        // Absent — fresh install.
      }
      await fs.writeFile(unitPath, clockCapUnitBody(capMHz), { mode: 0o644 });
      await runSystemctl(["enable", CLOCK_CAP_UNIT]);
    }
    await runSystemctl(["daemon-reload"]);
    return { ok: true, error: null };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Power the node off after `graceS` seconds: the ack reaches the hub first,
 * the WS has time to close, then `systemctl poweroff` runs. Logs the request
 * origin before scheduling (IRI-077 companion evidence on the hub side).
 */
export function scheduleNodeShutdown(graceS: number, origin: string, log: (line: string) => void): void {
  log(`node shutdown armed by ${origin} — powering off in ${graceS}s`);
  setTimeout(() => {
    void execFileAsync("systemctl", ["poweroff"], { timeout: 30_000 }).catch((err: unknown) => {
      log(`poweroff failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, graceS * 1000);
}
