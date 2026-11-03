import { execFile } from "node:child_process";
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
