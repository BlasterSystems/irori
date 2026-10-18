import { buildCommand, runStreaming, type ModelctlCtx, type RunOutcome } from "./modelctl.js";

export interface JobEvents {
  onOutput: (jobId: string, seq: number, line: string) => void;
  onDone: (jobId: string, status: "succeeded" | "failed" | "canceled", exitCode: number | null) => void;
}

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
    private readonly ctx: () => ModelctlCtx,
    private readonly events: JobEvents,
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
    let argv: string[];
    try {
      const built = buildCommand(kind, params, this.ctx());
      argv = built.argv;
    } catch (e) {
      // Invalid params: report as failed output rather than throwing — the UI sees why.
      this.events.onOutput(jobId, 0, `error: ${e instanceof Error ? e.message : String(e)}`);
      this.events.onDone(jobId, "failed", null);
      return true;
    }
    let seq = 0;
    const run = runStreaming(argv, {
      env: extraEnv,
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
