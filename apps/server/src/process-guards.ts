/**
 * IR-179: process-level guards. An unexpected rejection must not kill the
 * hub silently (the IR-176 crash loop had a single unguarded socket path,
 * but any future one must surface, not fatal). An uncaught exception is
 * logged with full diagnostics, counted on /metrics, and the process exits
 * non-zero so the supervisor restarts a defined state — Node guidance is
 * that the process is in an undefined state after an uncaught exception.
 */

export type GuardKey = "unhandledRejection" | "uncaughtException";

const counters: Record<GuardKey, number> = { unhandledRejection: 0, uncaughtException: 0 };

/** Current guard counters for the /metrics renderer. */
export function guardCounters(): Record<GuardKey, number> {
  return { ...counters };
}

export interface ProcessGuardsOpts {
  log: (message: string) => void;
  /** Injectable for tests; defaults to the real process. */
  proc?: Pick<NodeJS.Process, "on" | "exit">;
}

export function installProcessGuards(opts: ProcessGuardsOpts): void {
  const proc = opts.proc ?? process;
  proc.on("unhandledRejection", (reason) => {
    counters.unhandledRejection += 1;
    const detail = reason instanceof Error ? `${reason.message}\n${reason.stack ?? ""}` : String(reason);
    opts.log(`unhandled rejection survived (count ${counters.unhandledRejection}): ${detail}`);
  });
  proc.on("uncaughtException", (err) => {
    counters.uncaughtException += 1;
    opts.log(`uncaught exception (count ${counters.uncaughtException}): ${err.message}\n${err.stack ?? ""}`);
    proc.exit(1);
  });
}
