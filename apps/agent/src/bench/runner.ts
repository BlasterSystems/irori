import type { BenchProgress, BenchType } from "@irori/core";
import { benchConfigFor } from "@irori/core";
import { runDecode } from "./decode.js";
import { runPrefill } from "./prefill.js";
import { runQuality } from "./quality.js";
import { runTooleval } from "./tooleval.js";

/**
 * One active bench per agent (SPEC §13). Progress events are throttled to
 * ~1/s; the terminal frame carries the typed result JSON.
 */

const PROGRESS_EMIT_MS = 1000;

export interface BenchEvents {
  onProgress: (runId: string, progress: BenchProgress) => void;
  onDone: (runId: string, status: "completed" | "failed" | "canceled", result: unknown | null, error: string | null) => void;
}

export interface BenchStartInput {
  runId: string;
  bench: BenchType;
  config: Record<string, unknown>;
  apiKey?: string | null;
}

export class BenchRunner {
  private active: { runId: string; cancel: () => void } | null = null;
  private lastEmit = 0;
  private pending: BenchProgress | null = null;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly events: BenchEvents,
    private readonly log: (message: string) => void = () => {},
  ) {}

  get activeRunId(): string | null {
    return this.active?.runId ?? null;
  }

  /** Starts a bench. Returns false when one is already active (caller maps to 409). */
  start(input: BenchStartInput): boolean {
    if (this.active) return false;
    let config: ReturnType<typeof benchConfigFor>;
    try {
      config = benchConfigFor(input.bench, input.config);
    } catch (err) {
      this.events.onDone(input.runId, "failed", null, `invalid config: ${err instanceof Error ? err.message : String(err)}`);
      return true;
    }

    const ctrl = new AbortController();
    this.active = { runId: input.runId, cancel: () => ctrl.abort() };
    const hooks = {
      apiKey: input.apiKey ?? null,
      signal: ctrl.signal,
      onProgress: (index: number, total: number, label: string, liveTps: number | null) => {
        this.emit({ phase: "running", index, total, label, liveTps });
      },
    };

    void (async () => {
      let result: unknown = null;
      let status: "completed" | "failed" | "canceled" = "failed";
      let error: string | null = null;
      try {
        switch (input.bench) {
          case "decode":
            result = await runDecode(config as never, hooks as never);
            break;
          case "prefill":
            result = await runPrefill(config as never, hooks as never);
            break;
          case "quality":
            result = await runQuality(config as never, hooks as never);
            break;
          case "tooleval":
            result = await runTooleval(config as never, hooks as never);
            break;
        }
        status = "completed";
      } catch (err) {
        if (ctrl.signal.aborted) {
          status = "canceled";
          error = null;
        } else {
          status = "failed";
          error = err instanceof Error ? err.message : String(err);
        }
        this.log(`bench ${input.bench} ${input.runId} ${status}: ${error ?? ""}`);
      }
      if (this.active?.runId === input.runId) this.active = null;
      clearInterval(this.flushTimer ?? undefined);
      this.flushTimer = null;
      this.events.onDone(input.runId, status, status === "completed" ? result : null, error);
    })();

    return true;
  }

  /** Cancels the active run (no-op otherwise). */
  cancel(runId: string): void {
    if (this.active?.runId === runId) this.active.cancel();
  }

  /** Throttled progress: at most one frame per PROGRESS_EMIT_MS. */
  private emit(progress: BenchProgress): void {
    const now = Date.now();
    this.pending = progress;
    if (this.flushTimer !== null || now - this.lastEmit < PROGRESS_EMIT_MS) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.lastEmit = Date.now();
      if (this.pending && this.active) {
        this.events.onProgress(this.active.runId, this.pending);
        this.pending = null;
      }
    }, PROGRESS_EMIT_MS - (now - this.lastEmit));
    this.flushTimer.unref?.();
  }
}
