import {
  setupInfoSchema,
  setupTransferSchema,
  type SetupInfo,
  type SetupTransfer,
} from "@irori/core";
import type { NodeInfo } from "@irori/core";

/**
 * Serve page (M5): setups API clients + pure shaping helpers. Payloads are
 * parsed once at this boundary via the @irori/core contracts.
 */

export type { SetupInfo, SetupTransfer, TransferStage } from "@irori/core";
import type { SetupCreateInput as CoreSetupCreateInput } from "@irori/core";
export type { SetupCreateInput } from "@irori/core";
type SetupCreateInput = CoreSetupCreateInput;

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal });
  if (!res.ok) throw new Error(`${url} failed: HTTP ${res.status}`);
  return res.json();
}

function parseSetup(raw: unknown): SetupInfo {
  const parsed = setupInfoSchema.safeParse(raw);
  if (!parsed.success) throw new Error("malformed setup payload");
  return parsed.data;
}

export async function fetchSetups(signal?: AbortSignal): Promise<SetupInfo[]> {
  const body = (await getJson("/api/v1/setups", signal)) as { setups?: unknown };
  if (typeof body !== "object" || body === null || !Array.isArray(body.setups)) {
    throw new Error("malformed setups payload");
  }
  return body.setups.map(parseSetup);
}

export interface SetupDetail {
  setup: SetupInfo;
  transfers: SetupTransfer[];
}

function parseSetupDetail(raw: unknown): SetupDetail {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("malformed setup payload");
  const o = raw as Record<string, unknown>;
  const setup = parseSetup(o.setup);
  const transfers = Array.isArray(o.transfers) ? o.transfers.map(parseTransfer) : [];
  return { setup, transfers };
}

function parseTransfer(raw: unknown): SetupTransfer {
  const parsed = setupTransferSchema.safeParse(raw);
  if (!parsed.success) throw new Error("malformed transfer payload");
  return parsed.data;
}

export async function fetchSetup(id: string, signal?: AbortSignal): Promise<SetupDetail> {
  return parseSetupDetail(await getJson(`/api/v1/setups/${encodeURIComponent(id)}`, signal));
}

export async function createSetup(input: SetupCreateInput, signal?: AbortSignal): Promise<SetupInfo> {
  const res = await fetch("/api/v1/setups", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  const body: unknown = await res.json();
  if (!res.ok) throw new Error(errorMessage(body) ?? `create failed: HTTP ${res.status}`);
  return parseSetup((body as { setup: unknown }).setup);
}

export async function patchSetup(id: string, patch: Partial<SetupCreateInput>, signal?: AbortSignal): Promise<SetupInfo> {
  const res = await fetch(`/api/v1/setups/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
    signal,
  });
  const body: unknown = await res.json();
  if (!res.ok) throw new Error(errorMessage(body) ?? `patch failed: HTTP ${res.status}`);
  return parseSetup((body as { setup: unknown }).setup);
}

export async function deleteSetup(id: string): Promise<void> {
  const res = await fetch(`/api/v1/setups/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok && res.status !== 204) throw new Error(`remove failed: HTTP ${res.status}`);
}

export async function startSetup(id: string, signal?: AbortSignal): Promise<SetupInfo> {
  const res = await fetch(`/api/v1/setups/${encodeURIComponent(id)}/start`, { method: "POST", signal });
  const body: unknown = await res.json();
  if (!res.ok && res.status !== 202) throw new Error(errorMessage(body) ?? `start failed: HTTP ${res.status}`);
  return parseSetup((body as { setup: unknown }).setup);
}

export async function stopSetup(id: string, signal?: AbortSignal): Promise<SetupInfo> {
  const res = await fetch(`/api/v1/setups/${encodeURIComponent(id)}/stop`, { method: "POST", signal });
  const body: unknown = await res.json();
  if (!res.ok && res.status !== 202) throw new Error(errorMessage(body) ?? `stop failed: HTTP ${res.status}`);
  return parseSetup((body as { setup: unknown }).setup);
}

export async function validateScripts(
  nodeId: string,
  scripts: string[],
  signal?: AbortSignal,
): Promise<Array<{ script: string; ok: boolean; error: string | null }>> {
  const res = await fetch("/api/v1/setups/validate-scripts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nodeId, scripts }),
    signal,
  });
  const body: unknown = await res.json();
  if (!res.ok) throw new Error(errorMessage(body) ?? `validation failed: HTTP ${res.status}`);
  const o = body as { results?: unknown };
  if (!Array.isArray(o.results)) throw new Error("malformed validation payload");
  return o.results.map((r) => {
    if (typeof r !== "object" || r === null) throw new Error("malformed validation payload");
    const row = r as Record<string, unknown>;
    if (typeof row.script !== "string" || typeof row.ok !== "boolean") throw new Error("malformed validation payload");
    return { script: row.script, ok: row.ok, error: typeof row.error === "string" ? row.error : null };
  });
}

export async function createTransfer(
  setupId: string,
  targetNodeIds: string[],
  signal?: AbortSignal,
): Promise<SetupTransfer> {
  const res = await fetch(`/api/v1/setups/${encodeURIComponent(setupId)}/transfers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetNodeIds }),
    signal,
  });
  const body: unknown = await res.json();
  if (!res.ok && res.status !== 202) throw new Error(errorMessage(body) ?? `transfer failed: HTTP ${res.status}`);
  return parseTransfer((body as { transfer: unknown }).transfer);
}

export async function cancelTransfer(transferId: string): Promise<void> {
  const res = await fetch(`/api/v1/setups/transfers/${encodeURIComponent(transferId)}/cancel`, { method: "POST" });
  if (!res.ok && res.status !== 202) throw new Error(`cancel failed: HTTP ${res.status}`);
}

function errorMessage(body: unknown): string | null {
  if (typeof body === "object" && body !== null && "error" in body && typeof (body as { error: unknown }).error === "string") {
    return (body as { error: string }).error;
  }
  return null;
}

/* ── Engine log SSE ──────────────────────────────────────────────────────── */

export interface SetupLogLine {
  seq: number;
  line: string;
  ts: number;
}

/** Opens the per-setup log stream; returns a closer. */
export function openSetupLog(setupId: string, onLine: (line: SetupLogLine) => void, onError?: () => void): () => void {
  const es = new EventSource(`/api/v1/setups/${encodeURIComponent(setupId)}/log`);
  es.onmessage = (ev: MessageEvent<string>) => {
    try {
      const parsed = JSON.parse(ev.data) as { seq?: unknown; line?: unknown; ts?: unknown };
      if (typeof parsed.seq !== "number" || typeof parsed.line !== "string") return;
      onLine({ seq: parsed.seq, line: parsed.line, ts: typeof parsed.ts === "number" ? parsed.ts : 0 });
    } catch {
      // Ignore malformed frames; the stream self-heals.
    }
  };
  es.onerror = () => onError?.();
  return () => es.close();
}

/* ── Pure shaping helpers (cards, chips, stage lines) ────────────────────── */

/**
 * Pure: worker ids the server will accept (setups-service validateWorkers) —
 * deduped (first occurrence kept, order preserved), no head-self, no
 * NAS-kind, no unknown ids. A pre-validation setup row shipped with the NAS
 * listed twice plus duplicated DGX workers and became uneditable: the wizard
 * round-tripped the stored rows verbatim (IRI-041).
 */
export function sanitizeWorkerIds(workerIds: string[], headNodeId: string, nodes: NodeInfo[]): string[] {
  const acceptable = new Set(nodes.filter((n) => n.kind !== "nas" && n.id !== headNodeId).map((n) => n.id));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const nodeId of workerIds) {
    if (seen.has(nodeId) || !acceptable.has(nodeId)) continue;
    seen.add(nodeId);
    out.push(nodeId);
  }
  return out;
}

/** Pure: chip state → DS dot/chip class per the thread budget. */
export function setupChipCls(chip: string): string {
  switch (chip) {
    case "healthy":
      return "chip--ok";
    case "failed":
    case "stopped":
      return "chip--halt";
    case "foreign":
      return "chip--warn";
    default:
      return "chip--run";
  }
}

/** Pure: one stage's progress line (mockup: "64% · 168 MB/s · ~4m left"). */
export function stageVal(stage: { status: string; progress: { percent: number | null; rateBytesPerSec: number | null; etaSeconds: number | null } | null; error: string | null }): string {
  switch (stage.status) {
    case "succeeded":
      return "done";
    case "failed":
      return stage.error ?? "failed";
    case "canceled":
      return "canceled";
    case "skipped":
      return "skipped";
    case "pending":
      return "waiting";
    case "queued":
      return "queued";
    default:
      break;
  }
  const p = stage.progress;
  if (p === null) return "transferring";
  const parts: string[] = [];
  if (p.percent !== null) parts.push(`${Math.round(p.percent)}%`);
  if (p.rateBytesPerSec !== null) parts.push(`${fmtRate(p.rateBytesPerSec)}`);
  if (p.etaSeconds !== null) parts.push(`~${fmtEta(p.etaSeconds)} left`);
  return parts.length > 0 ? parts.join(" · ") : "transferring";
}

/** Pure: bytes/s → human rate. */
export function fmtRate(rate: number): string {
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  let value = rate;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Pure: seconds → "3m 12s" / "48s" / "1h 04m". */
export function fmtEta(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m`;
}

/** Pure: stage percent for the bar fill (null progress → 0). */
export function stagePercent(stage: { status: string; progress: { percent: number | null } | null }): number {
  if (stage.status === "succeeded") return 100;
  if (stage.progress === null || stage.progress.percent === null) return 0;
  return Math.max(0, Math.min(100, stage.progress.percent));
}

export interface SetupNodeLine {
  nodeId: string;
  label: string;
  cls: string;
  detail: string;
}

/**
 * Pure: per-node chip lines for a card (mockup: "spark1 · head · :8000 · ●
 * 142.3 tok/s"). The head shows probe state (decode rate when present);
 * workers show model presence/transfer state — worker engines are script-orchestrated
 * and only visible to Irori through the probe ports declared on them.
 */
export function setupNodeLines(
  setup: SetupInfo,
  nodes: NodeInfo[],
  latest?: { decodeTps: number | null } | null,
): SetupNodeLine[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const lines: SetupNodeLine[] = [];
  const head = byId.get(setup.headNodeId);
  const headOnline = head?.online === true;
  const healthy = setup.status === "running" && setup.health === "healthy";
  const headDetail =
    healthy && latest?.decodeTps != null
      ? `${latest.decodeTps.toFixed(1)} tok/s`
      : healthy
        ? "serving"
        : headOnline
          ? "no probe"
          : "offline";
  lines.push({
    nodeId: setup.headNodeId,
    label: `${head?.name ?? setup.headNodeId.slice(0, 8)} · head · :${setup.port}`,
    cls: healthy ? "chip--ok" : setup.status === "failed" ? "chip--halt" : headOnline ? "chip--run" : "chip--halt",
    detail: headDetail,
  });
  for (const worker of setup.nodes) {
    const node = byId.get(worker.nodeId);
    const online = node?.online === true;
    lines.push({
      nodeId: worker.nodeId,
      label: `${node?.name ?? worker.nodeId.slice(0, 8)} · worker`,
      cls: online ? "chip--ok" : "chip--halt",
      detail: online ? "joined" : "offline",
    });
  }
  return lines;
}

/** Pure: setup summary line under a stopped card (mockup: "stopped 3d ago · …"). */
export function setupSubline(setup: SetupInfo): string {
  if (setup.status === "stopped") {
    const when = setup.lastStartedAt !== null ? ` · last start ${new Date(setup.lastStartedAt).toLocaleString()}` : "";
    return `stopped${when}`;
  }
  if (setup.status === "failed") return setup.lastError ?? "failed";
  if (setup.health === "foreign") {
    return `port ${setup.port} answers a different engine — another process took the port. Nothing was stopped.`;
  }
  if (setup.health === "timeout") return setup.lastError ?? "startup timeout";
  return "";
}

/**
 * IRI-051: composes a script path from an optional recipe folder and a script
 * name. A path-shaped name (starts with `/` or `~`, or contains `/`) is used
 * VERBATIM with the folder ignored — pasting a full path into the name field
 * is always safe; an empty folder yields the name as-is; a trailing slash on
 * the folder never produces double slashes.
 */
export function composeScriptPath(folder: string, name: string): string {
  const n = name.trim();
  const f = folder.trim().replace(/\/+$/, "");
  if (n === "") return "";
  if (n.startsWith("/") || n.startsWith("~") || n.includes("/")) return n;
  if (f === "") return n;
  return `${f}/${n}`;
}

export interface RecipeSplit {
  folder: string;
  startName: string;
  stopName: string;
}

/**
 * IRI-051: splits stored start/stop paths into recipe-folder + name fields for
 * the wizard prefill. Shared dirname → folder + basenames (round-trips through
 * composeScriptPath); differing dirnames (or paths without a folder) → empty
 * folder and the full paths as names, which compose passes through verbatim.
 */
export function splitRecipePaths(start: string, stop: string): RecipeSplit {
  const s = start.trim();
  const t = stop.trim();
  const dirOf = (p: string): string => {
    const i = p.lastIndexOf("/");
    return i <= 0 ? "" : p.slice(0, i);
  };
  const baseOf = (p: string): string => {
    const i = p.lastIndexOf("/");
    return i <= 0 ? p : p.slice(i + 1);
  };
  if (s === "" && t === "") return { folder: "", startName: "", stopName: "" };
  if (s === "" || t === "") {
    const only = s !== "" ? s : t;
    return { folder: dirOf(only), startName: s === "" ? t : s, stopName: s === "" ? s : t };
  }
  const ds = dirOf(s);
  const dt = dirOf(t);
  if (ds === dt) return { folder: ds, startName: baseOf(s), stopName: baseOf(t) };
  return { folder: "", startName: s, stopName: t };
}
