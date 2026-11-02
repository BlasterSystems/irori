import {
  MAX_SETUP_NODES,
  modelIdMatches,
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

/**
 * IR-151: true when the head node's LLM probe currently reports the setup's
 * declared engine answering the declared port — the escape hatch for a falsely
 * stopped row (a daemonizing recipe keeps the engine outside the recorded
 * group; hub demotion was pgid-only). Drives the card Stop button: the row's
 * status must never hide the only control that kills a live engine.
 */
export function probeSeesEngine(
  setup: Pick<SetupInfo, "headNodeId" | "port" | "model">,
  headLlm: Map<string, { ports: Array<{ port: number; detected: boolean; model: string | null }> } | null>,
): boolean {
  const snap = headLlm.get(setup.headNodeId);
  if (snap === undefined || snap === null) return false;
  const port = snap.ports.find((p) => p.port === setup.port);
  return port !== undefined && port.detected && modelIdMatches(port.model, setup.model);
}

/**
 * IR-152: the card/drawer chip as one honest presentation unit. The old
 * mapping rendered `failed` identical to `stopped` (both bare halt chips) and
 * one word ("stopped") covered three realities — never started, stopped on
 * purpose, and an engine still answering the port. `foreign` now reads
 * "wrong engine". failed/wrong-engine/serving-while-stopped are warn; idle
 * states are muted; only live states carry the run dot.
 */
export interface SetupChipView {
  label: string;
  cls: string;
  dot: string;
}

export function setupChipView(
  setup: Pick<SetupInfo, "status" | "health" | "lastStartedAt" | "port">,
  opts: { probeSees: boolean },
): SetupChipView {
  switch (setup.status) {
    case "running":
      if (setup.health === "foreign") return { label: "wrong engine", cls: "chip--warn", dot: "dot--warn" };
      if (setup.health === "healthy") return { label: "healthy", cls: "chip--ok", dot: "dot--ok" };
      if (setup.health === "timeout") return { label: "failed", cls: "chip--warn", dot: "dot--warn" };
      return { label: "starting", cls: "chip--run", dot: "dot--run" };
    case "starting":
    case "stopping":
      return { label: setup.status, cls: "chip--run", dot: "dot--run" };
    case "failed":
      return { label: "failed", cls: "chip--warn", dot: "dot--warn" };
    case "stopped":
      if (opts.probeSees) return { label: `serving :${setup.port}`, cls: "chip--warn", dot: "dot--warn" };
      return setup.lastStartedAt === null
        ? { label: "never started", cls: "chip--muted", dot: "dot--halt" }
        : { label: "stopped", cls: "chip--muted", dot: "dot--halt" };
  }
}

/** IR-152: board order — live work first, then failures, idle last; name
 *  keeps it stable so a running setup cannot sit below three stopped ones. */
const STATUS_RANK: Record<string, number> = { running: 0, starting: 0, stopping: 0, failed: 1, stopped: 2 };

export function sortSetupsForBoard<T extends { status: string; name: string }>(setups: T[]): T[] {
  return [...setups].sort(
    (a, b) => (STATUS_RANK[a.status] ?? 3) - (STATUS_RANK[b.status] ?? 3) || a.name.localeCompare(b.name),
  );
}

/** IR-152: pagehead summary ("1 running · 3 stopped · 1 failed"). */
export function setupSummaryLine<T extends { status: string }>(setups: T[]): string {
  const live = setups.filter((s) => s.status === "running" || s.status === "starting" || s.status === "stopping").length;
  const failed = setups.filter((s) => s.status === "failed").length;
  return `${live} running · ${setups.length - live - failed} stopped · ${failed} failed`;
}

/**
 * IR-152: the engine-log empty state explains itself. "no output yet" said
 * nothing about why; each state now states what is expected. (The label is
 * honest since IR-147 wired setup-log frames into telemetry.)
 */
export function engineLogEmptyText(setup: Pick<SetupInfo, "status" | "lastError" | "lastStartedAt">): string {
  switch (setup.status) {
    case "running":
      return "waiting for engine output — the first line lands here";
    case "starting":
      return "starting — driver markers and engine output land here as they arrive";
    case "stopping":
      return "stopping — the final lines land here";
    case "failed":
      return setup.lastError ?? "the start failed before any output was captured";
    default:
      return setup.lastStartedAt === null
        ? "never started — Start streams its output here"
        : "not running — start it again to stream engine output here";
  }
}

/**
 * IR-152: pre-save script path rules (the wizard used to accept anything the
 * head's `test -x` would later reject — an owner burned three starts on
 * "~/developer/..." paths the agent resolves literally, never by the shell).
 * Null = usable; otherwise the actionable message.
 */
export function scriptPathError(path: string): string | null {
  if (path.startsWith("~")) return "the head resolves paths literally — expand ~ to the absolute path (e.g. /home/you/…)";
  if (!path.startsWith("/")) return "the head needs an absolute path (it must start with /)";
  if (path.length > 1024) return "script path too long — the head caps script paths at 1024 characters";
  return null;
}

/** IR-152: cluster cap hint under the worker picker (server caps at
 *  MAX_SETUP_NODES total, head included — the 8th click used to be silent). */
export function workerCapHint(workerCount: number, kind: "single" | "cluster"): string | null {
  if (kind !== "cluster" || workerCount < MAX_SETUP_NODES - 1) return null;
  return `cluster cap reached — ${MAX_SETUP_NODES} nodes total (head + ${MAX_SETUP_NODES - 1} workers)`;
}

export interface RunningEngineRow {
  key: string;
  nodeId: string;
  nodeName: string;
  port: number;
  backend: string;
  model: string | null;
  decodeTps: number | null;
  managedSetupId: string | null;
  managedName: string | null;
}

/**
 * IR-152: the "Running now" section — every probe-detected engine on every
 * node, managed or not. Probe truth only (detected ports), so the section can
 * never lie; Serve's old stopped-cards-only view contradicted the Overview
 * hero for exactly the engines this lists.
 */
export function runningEnginesFromProbes(
  probes: Array<{ nodeId: string; ports: Array<{ port: number; detected: boolean; backend: string; model: string | null; decodeTps: number | null }> }>,
  nodes: Array<{ id: string; name: string }>,
  // IR-155: status/lastStartedAt are optional so callers that only know the
  // identity fields keep compiling; without them attribution falls back to the
  // first match, as before.
  setups: Array<{ id: string; name: string; headNodeId: string; port: number; status?: string; lastStartedAt?: string | null }>,
): RunningEngineRow[] {
  const rows: RunningEngineRow[] = [];
  const seen = new Set<string>();
  for (const probe of probes) {
    for (const p of probe.ports) {
      if (!p.detected) continue;
      const key = `${probe.nodeId}:${p.port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const node = nodes.find((n) => n.id === probe.nodeId);
      // IR-155: pre-guard fleets can hold several rows on one head port. The
      // probe cannot say which of them launched the engine, so name the owner by
      // the same rule the hub applies (a row that never started owns nothing;
      // among live rows, the most recent start) instead of the first row listed.
      const candidates = setups.filter((s) => s.headNodeId === probe.nodeId && s.port === p.port);
      const managed = pickPortOwner(candidates);
      rows.push({
        key,
        nodeId: probe.nodeId,
        nodeName: node?.name ?? probe.nodeId.slice(0, 8),
        port: p.port,
        backend: p.backend,
        model: p.model,
        decodeTps: p.decodeTps,
        managedSetupId: managed?.id ?? null,
        managedName: managed?.name ?? null,
      });
    }
  }
  return rows.sort(
    (a, b) =>
      (a.managedSetupId === null ? 1 : 0) - (b.managedSetupId === null ? 1 : 0) ||
      a.nodeName.localeCompare(b.nodeName) ||
      a.port - b.port,
  );
}

/**
 * IR-152: instant chips between polls — overlay the newest setup-state SSE
 * frame per setup on the REST rows (the 2.5 s poll stays the convergent
 * source of truth; events are newest-last in the feed ring). A frame older
 * than the row's own write never reverts it: the ring survives page mounts,
 * an empty ring (server restart) is a no-op.
 */
export function applySetupStates<
  T extends { id: string; status: SetupInfo["status"]; health: SetupInfo["health"]; lastError: string | null; updatedAt: string },
>(
  setups: T[],
  states: Array<{ setupId: string; status: SetupInfo["status"]; health: SetupInfo["health"]; lastError: string | null; serverTimeMs: number }>,
): T[] {
  if (states.length === 0) return setups;
  const last = new Map<string, (typeof states)[number]>();
  for (const e of states) last.set(e.setupId, e);
  return setups.map((s) => {
    const e = last.get(s.id);
    if (e === undefined || e.serverTimeMs <= Date.parse(s.updatedAt)) return s;
    return { ...s, status: e.status, health: e.health, lastError: e.lastError };
  });
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
 * workers show join state — worker engines are script-orchestrated
 * and only visible to Irori through the probe ports declared on them.
 *
 * IR-152 (P1): a stopped/failed setup renders IDLE chips. The old lines
 * derived purely from node online + probe and ignored setup.status, so a
 * stopped cluster showed green "JOINED" workers and a "no probe" head — live
 * vocabulary on a dead setup. `probeSees` (the IR-151 escape hatch) keeps the
 * head line honest on a falsely-stopped row that really is answering.
 */
export function setupNodeLines(
  setup: SetupInfo,
  nodes: NodeInfo[],
  latest?: { decodeTps?: number | null; probeSees?: boolean } | null,
): SetupNodeLine[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const lines: SetupNodeLine[] = [];
  const head = byId.get(setup.headNodeId);
  const headOnline = head?.online === true;
  const idle = setup.status === "stopped" || setup.status === "failed";
  const healthy = setup.status === "running" && setup.health === "healthy";
  const headLive = healthy || latest?.probeSees === true;
  const headDetail = headLive
    ? latest?.decodeTps != null
      ? `${latest.decodeTps.toFixed(1)} tok/s`
      : "serving"
    : idle
      ? headOnline
        ? "idle"
        : "offline"
      : headOnline
        ? "no probe"
        : "offline";
  lines.push({
    nodeId: setup.headNodeId,
    label: `${head?.name ?? setup.headNodeId.slice(0, 8)} · head · :${setup.port}`,
    cls: headLive ? "chip--ok" : idle ? "chip--muted" : setup.status === "failed" ? "chip--halt" : headOnline ? "chip--run" : "chip--halt",
    detail: headDetail,
  });
  for (const worker of setup.nodes) {
    const node = byId.get(worker.nodeId);
    const online = node?.online === true;
    if (idle) {
      lines.push({
        nodeId: worker.nodeId,
        label: `${node?.name ?? worker.nodeId.slice(0, 8)} · worker`,
        cls: "chip--muted",
        detail: online ? "idle" : "offline",
      });
      continue;
    }
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

/** A candidate row declaring an engine on a head port (subset of SetupInfo). */
type PortCandidate = { id: string; name: string; headNodeId: string; port: number; status?: string; lastStartedAt?: string | null };

/**
 * IR-155: which row a probe-detected engine on a head port belongs to. A live
 * row that has started wins (most recent start), then any row that has ever
 * started; a row that never started never wins. With no evidence at all — legacy
 * callers that pass identity fields only — the first candidate is named, as
 * before.
 */
function pickPortOwner(candidates: readonly PortCandidate[]): PortCandidate | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;
  const newest = (rows: PortCandidate[]): PortCandidate =>
    rows.reduce((best, r) => (Date.parse(r.lastStartedAt!) > Date.parse(best.lastStartedAt!) ? r : best), rows[0]!);
  const started = candidates.filter((c) => c.lastStartedAt != null);
  if (started.length === 0) return candidates[0]!;
  const live = started.filter((c) => c.status === undefined || isLiveSetup(c));
  return newest(live.length > 0 ? live : started);
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

/** A live setup row can still own the engine answering its head port. */
const LIVE_SETUP_STATUS: Record<string, true> = { starting: true, running: true, stopping: true };
const isLiveSetup = (s: { status?: string | null }): boolean => LIVE_SETUP_STATUS[s.status ?? ""] === true;

type PortRow = Pick<SetupInfo, "id" | "name" | "headNodeId" | "port" | "status" | "lastStartedAt">;

/**
 * IR-155: the sibling that outranks `setup` for its head port, mirroring the
 * server's rule in `setups-service.ts` — a row that never started owns nothing,
 * and among live rows the one started most recently owns it. The node probe can
 * only say that AN engine answers the port, so without this a second row sharing
 * the port reads "serving :PORT" beside the real one and offers a Stop whose
 * script pair can kill the sibling's engine.
 */
export function portRival(setup: PortRow, setups: readonly PortRow[]): PortRow | null {
  const others = setups.filter(
    (s) => s.id !== setup.id && s.headNodeId === setup.headNodeId && s.port === setup.port,
  );
  if (others.length === 0) return null;
  if (setup.lastStartedAt === null) return others.find((o) => o.lastStartedAt !== null) ?? null;
  const mine = Date.parse(setup.lastStartedAt);
  return others.find((o) => isLiveSetup(o) && o.lastStartedAt !== null && Date.parse(o.lastStartedAt) > mine) ?? null;
}

/** True when this row may claim the engine answering its head port. */
export function ownsProbePort(setup: PortRow, setups: readonly PortRow[]): boolean {
  return portRival(setup, setups) === null;
}

/**
 * IR-155: one head port hosts exactly one engine, so a second LIVE setup on the
 * same (head, port) is a configuration the platform cannot honour — probe truth
 * cannot attribute the engine between siblings, and the phantom row's Stop runs
 * the shared script pair, killing the real engine. The wizard warns at the port
 * field; the server refuses the save. An engine that answers the port with no
 * setup owning it is NOT a clash: adopting an unmanaged engine is intended.
 */
export function portClashMessage(
  setups: readonly PortRow[],
  draft: { editId: string | null; headNodeId: string; port: number },
  nodeName: (nodeId: string) => string,
): string | null {
  if (draft.headNodeId === "" || !Number.isInteger(draft.port) || draft.port <= 0) return null;
  const rival = setups.find(
    (s) => s.id !== draft.editId && s.headNodeId === draft.headNodeId && s.port === draft.port && isLiveSetup(s),
  );
  if (rival === undefined) return null;
  return `port ${draft.port} on ${nodeName(rival.headNodeId)} is already served by “${rival.name}” — stop it first, or pick another port`;
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
