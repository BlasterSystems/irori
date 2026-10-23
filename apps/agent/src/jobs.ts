import { buildCommand, runStreaming, type ModelctlCtx, type RunOutcome } from "./modelctl.js";

/** Job context: modelctl config + the hub URL the update script dials. */
export interface JobCtx extends ModelctlCtx {
  /** The agent's own IRORI_SERVER_URL (ws://host:port/agent-ws). */
  serverUrl: string;
}

/**
 * IRI-012 (ADR-0007): replace the agent bundle and restart the unit. Runs as
 * a `systemd-run --pipe --wait` transient service — its own cgroup, so the
 * restart inside it cannot kill it (the agent unit sets no KillMode and the
 * systemd default is control-group). Failure before the restart exits
 * nonzero and settles the job normally; the restart itself severs the
 * socket, so success is settled server-side on the next hello.
 */
const AGENT_UPDATE_SCRIPT = [
  "set -euo pipefail",
  'BASE="${IRORI_SERVER_URL:-}"',
  'case "$BASE" in',
  '  wss://*) BASE="https://${BASE#wss://}" ;;',
  '  ws://*)  BASE="http://${BASE#ws://}" ;;',
  "esac",
  'BASE="${BASE%/agent-ws}"',
  'BASE="${BASE%/}"',
  'echo "[irori] updating agent bundle from $BASE"',
  // The transient unit gets the manager's default PATH — the agent's pinned
  // node (/opt/irori/node/bin, node 24) is NOT on it, and the system node may
  // be too old. Prefer the pinned binary, fall back to PATH.
  'NODE_BIN="/opt/irori/node/bin/node"',
  'if [ ! -x "$NODE_BIN" ]; then NODE_BIN="$(command -v node)"; fi',
  '[ -n "$NODE_BIN" ] || { echo "no node binary found for the syntax check"; exit 1; }',
  // Check under a .mjs name: node --key refuses the ".new" extension
  // (ERR_UNKNOWN_FILE_EXTENSION), and a failed check must leave the old
  // bundle in place — the download only lands on the final name after it.
  'curl -fsSL --max-time 300 "$BASE/agent/irori-agent.mjs" -o /opt/irori/.irori-agent.check.mjs',
  '"$NODE_BIN" --check /opt/irori/.irori-agent.check.mjs',
  "if [ -f /opt/irori/irori-agent.mjs ]; then",
  "  cp -f /opt/irori/irori-agent.mjs /opt/irori/irori-agent.mjs.bak",
  "fi",
  "mv -f /opt/irori/.irori-agent.check.mjs /opt/irori/irori-agent.mjs",
  'echo "[irori] bundle replaced — restarting irori-agent"',
  "systemctl restart irori-agent.service",
].join("\n");

/** Transient-unit argv; the unit name embeds the job id (unique, --collect). */
export function buildAgentUpdateArgs(jobId: string, serverUrl: string): string[] {
  const unit = `irori-agent-update-${jobId.replace(/-/g, "").slice(0, 12)}`;
  return [
    "systemd-run",
    "--collect",
    "--pipe",
    "--wait",
    // systemd expands $-specifiers in transient-unit ExecStart argv against the
    // unit env — the script's bash expansions (${BASE#ws://}, ${BASE%/…}) would
    // be eaten to empty strings before bash ever ran. Ship the script verbatim.
    "--expand-environment=no",
    `--unit=${unit}`,
    `--setenv=IRORI_SERVER_URL=${serverUrl}`,
    "bash",
    "-c",
    AGENT_UPDATE_SCRIPT,
  ];
}

export interface JobEvents {
  onOutput: (jobId: string, seq: number, line: string) => void;
  onDone: (jobId: string, status: "succeeded" | "failed" | "canceled", exitCode: number | null) => void;
}

/**
 * Hygiene jobs (M7) run agent-side — not modelctl. The runner emits streamed
 * output lines; the FINAL line of a hygiene job is its JSON result (the
 * server persists it into cleanup_runs). `ok=false` marks the job failed
 * without throwing.
 */
export type HygieneJobRunner = (
  jobId: string,
  kind: "hygiene-audit" | "hygiene-clean" | "hygiene-prevent",
  params: Record<string, unknown>,
  emit: (line: string) => void,
  signal: AbortSignal,
) => Promise<{ ok: boolean }>;

/**
 * One active job per node (SPEC §13). Additional run requests are rejected —
 * the server answers 409 before reaching here; this is the last line of defense.
 */
export class JobManager {
  private active: {
    jobId: string;
    cancel: () => void;
  } | null = null;

  constructor(
    private readonly ctx: () => JobCtx,
    private readonly events: JobEvents,
    private readonly hygiene?: HygieneJobRunner,
  ) {}

  get activeJobId(): string | null {
    return this.active?.jobId ?? null;
  }

  /**
   * Starts a job. Returns false when a job is already running (caller maps to 409).
   * Output lines stream to events.onOutput; completion fires events.onDone.
   */
  start(jobId: string, kind: string, params: Record<string, unknown>, extraEnv: Record<string, string> = {}): boolean {
    if (this.active) return false;

    if (kind === "hygiene-audit" || kind === "hygiene-clean" || kind === "hygiene-prevent") {
      if (this.hygiene === undefined) {
        this.events.onOutput(jobId, 0, "error: hygiene runner not available on this agent build");
        this.events.onDone(jobId, "failed", null);
        return true;
      }
      const ctrl = new AbortController();
      let seq = 0;
      this.active = { jobId, cancel: () => ctrl.abort() };
      void this.hygiene(jobId, kind, params, (line) => this.events.onOutput(jobId, seq++, line), ctrl.signal)
        .then((result) => {
          if (this.active?.jobId === jobId) this.active = null;
          this.events.onDone(jobId, result.ok ? "succeeded" : "failed", result.ok ? 0 : 1);
        })
        .catch((err) => {
          if (this.active?.jobId === jobId) this.active = null;
          this.events.onOutput(jobId, seq++, `error: ${err instanceof Error ? err.message : String(err)}`);
          this.events.onDone(jobId, "failed", null);
        });
      return true;
    }

    let argv: string[];
    if (kind === "agent-update") {
      // IRI-012 (ADR-0007): guards live server-side; the script is agent code
      // and takes no params. A missing hub URL is an agent config bug.
      const url = this.ctx().serverUrl;
      if (url.length === 0) {
        this.events.onOutput(jobId, 0, "error: agent has no IRORI_SERVER_URL configured");
        this.events.onDone(jobId, "failed", null);
        return true;
      }
      argv = buildAgentUpdateArgs(jobId, url);
    } else {
      try {
        const built = buildCommand(kind, params, this.ctx());
        argv = built.argv;
      } catch (e) {
        // Invalid params: report as failed output rather than throwing — the UI sees why.
        this.events.onOutput(jobId, 0, `error: ${e instanceof Error ? e.message : String(e)}`);
        this.events.onDone(jobId, "failed", null);
        return true;
      }
    }
    let seq = 0;
    // IRI-017: hand the optional HF token to modelctl as HF_TOKEN (gated and
    // private repos). Per-job extraEnv still wins if a caller sets it.
    const jobEnv: Record<string, string> = { ...extraEnv };
    const hfToken = this.ctx().hfToken;
    if (hfToken !== undefined && hfToken.length > 0) jobEnv.HF_TOKEN = hfToken;
    const run = runStreaming(argv, {
      env: jobEnv,
      onLine: (line) => this.events.onOutput(jobId, seq++, line),
    });
    this.active = { jobId, cancel: run.cancel };
    void run.done.then((outcome: RunOutcome) => {
      if (this.active?.jobId === jobId) this.active = null;
      const status = outcome.canceled ? "canceled" : outcome.exitCode === 0 ? "succeeded" : "failed";
      this.events.onDone(jobId, status, outcome.exitCode);
    });
    return true;
  }

  /** Cancels the active job (no-op otherwise). */
  cancel(jobId: string): void {
    if (this.active?.jobId === jobId) this.active.cancel();
  }
}
