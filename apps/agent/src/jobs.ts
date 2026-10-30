import { join } from "node:path";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { buildCommand, runStreaming, type ModelctlCtx, type RunOutcome } from "./modelctl.js";

/** Job context: modelctl config + the hub URL the update script dials. */
export interface JobCtx extends ModelctlCtx {
  /** The agent's own IRORI_SERVER_URL (ws://host:port/agent-ws). */
  serverUrl: string;
  /** IRORI_STATE_DIR (IR-131): persists the active-job {jobId → pgid} registry. */
  stateDir?: string;
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
export type AgentJobRunner = (
  jobId: string,
  kind: string,
  params: Record<string, unknown>,
  emit: (line: string) => void,
  signal: AbortSignal,
) => Promise<{ ok: boolean }>;

/** Kinds executed by agent code rather than a single modelctl argv. */
const RUNNER_KINDS = new Set([
  "hygiene-audit",
  "hygiene-clean",
  "hygiene-prevent",
  "models-inventory",
  "nas-delete-apply",
]);

/** IR-131: persisted active-job registry — {jobId → pgid} so a crash leaves a
 *  killable handle (the detached modelctl child survives agent death). Same
 *  pattern as the setup drivers' setups.json. */
interface ActiveJobRecord {
  jobId: string;
  pgid: number;
  kind: string;
  startedAt: number;
}
const ACTIVE_JOBS_FILE = "active-jobs.json";
export { ACTIVE_JOBS_FILE };

function readActiveJobs(stateDir: string): ActiveJobRecord[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(stateDir, ACTIVE_JOBS_FILE), "utf8"));
    return Array.isArray(parsed) ? parsed.filter((j): j is ActiveJobRecord => j !== null && typeof j === "object" && typeof (j as ActiveJobRecord).jobId === "string" && typeof (j as ActiveJobRecord).pgid === "number") : [];
  } catch {
    return []; // missing/corrupt registry: nothing to reconcile
  }
}

/**
 * IR-131 boot reconcile: kill any persisted active-job process group (the
 * detached modelctl child can outlive the agent) and report each as failed.
 * Runs BEFORE the first hello — the job-done frames buffer offline and
 * replay on hello-ok, so the hub settles rows in arrival order.
 */
export async function reconcileOrphanedJobs(stateDir: string, events: Pick<JobEvents, "onOutput" | "onDone">): Promise<void> {
  const records = readActiveJobs(stateDir);
  if (records.length === 0) return;
  try {
    rmSync(join(stateDir, ACTIVE_JOBS_FILE));
  } catch {}
  for (const record of records) {
    try {
      // The registry stores the NEGATIVE pid (the process group id) — kill it directly.
      process.kill(record.pgid, "SIGKILL");
    } catch {
      // Already gone (systemd's cgroup kill got it first) — still settle the row.
    }
    events.onOutput(record.jobId, 0, "orphaned by agent restart — the transfer was killed and can be re-run");
    events.onDone(record.jobId, "failed", null);
  }
}

/**
 * One active job per node (SPEC §13). Additional run requests are rejected —
 * the server answers 409 before reaching here; this is the last line of defense.
 */
export class JobManager {
  private active: {
    jobId: string;
    kind: string;
    cancel: () => void;
  } | null = null;

  constructor(
    private readonly ctx: () => JobCtx,
    private readonly events: JobEvents,
    private readonly runner?: AgentJobRunner,
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

    if (RUNNER_KINDS.has(kind)) {
      if (this.runner === undefined) {
        this.events.onOutput(jobId, 0, "error: agent-side job runner not available on this agent build");
        this.events.onDone(jobId, "failed", null);
        return true;
      }
      const ctrl = new AbortController();
      let seq = 0;
      this.active = { jobId, kind, cancel: () => ctrl.abort() };
      void this.runner(jobId, kind, params, (line) => this.events.onOutput(jobId, seq++, line), ctrl.signal)
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
    // private repos). Agent config wins over any caller-supplied extraEnv;
    // the agent-update child (systemd-run, not modelctl) gets no token.
    const jobEnv: Record<string, string> = { ...extraEnv };
    const hfToken = this.ctx().hfToken;
    if (hfToken !== undefined && hfToken.length > 0 && kind !== "agent-update") jobEnv.HF_TOKEN = hfToken;
    const run = runStreaming(argv, {
      env: jobEnv,
      onLine: (line) => this.events.onOutput(jobId, seq++, line),
    });
    this.active = { jobId, kind, cancel: run.cancel };
    // IR-131: persist the process-group handle BEFORE the first output line —
    // the child can outlive the agent (detached), and a crash must leave a
    // killable registry entry. agent-update runs under systemd-run (own
    // cgroup) and runner kinds have no process group: neither persists.
    const startStateDir = this.ctx().stateDir;
    if (kind !== "agent-update" && run.pid !== undefined && startStateDir !== undefined) {
      this.persistActiveJobs([
        ...readActiveJobs(startStateDir).filter((r) => r.jobId !== jobId),
        { jobId, pgid: -run.pid, kind, startedAt: Date.now() },
      ]);
    }
    void run.done.then((outcome: RunOutcome) => {
      if (this.active?.jobId === jobId) this.active = null;
      const doneStateDir = this.ctx().stateDir;
      if (doneStateDir !== undefined) {
        this.persistActiveJobs(readActiveJobs(doneStateDir).filter((r) => r.jobId !== jobId));
      }
      const status = outcome.canceled ? "canceled" : outcome.exitCode === 0 ? "succeeded" : "failed";
      this.events.onDone(jobId, status, outcome.exitCode);
    });
    return true;
  }

  private persistActiveJobs(records: ActiveJobRecord[]): void {
    const stateDir = this.ctx().stateDir;
    if (stateDir === undefined) return;
    const file = join(stateDir, ACTIVE_JOBS_FILE);
    try {
      mkdirSync(stateDir, { recursive: true });
      if (records.length === 0) {
        rmSync(file, { force: true });
        return;
      }
      writeFileSync(file, JSON.stringify(records, null, 2));
    } catch {
      // A read-only state dir must not break the job — the row just loses
      // crash-kill coverage (the reaper still settles it).
    }
  }

  /** IR-131: job ids this process is running — the hello's activeJobs report. */
  activeJobs(): Array<{ jobId: string; kind: string }> {
    return this.active === null ? [] : [{ jobId: this.active.jobId, kind: this.active.kind }];
  }

  /**
   * Cancels the active job (no-op otherwise). Returns whether the kill signal
   * was actually issued — the caller turns true into a job-cancel-ack (IR-131).
   */
  cancel(jobId: string): boolean {
    if (this.active?.jobId !== jobId) return false;
    this.active.cancel();
    return true;
  }
}
