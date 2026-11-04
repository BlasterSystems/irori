import { describe, expect, it } from "vitest";
import { guardCounters, installProcessGuards } from "../src/process-guards.js";

/**
 * IR-179: process guards — rejections survive with diagnostics + counter,
 * uncaught exceptions log then exit non-zero. Fake process keeps the real
 * one untouched.
 */
describe("process guards", () => {
  function fakeProc() {
    const handlers = new Map<string, (arg: unknown) => void>();
    let exitCode: number | null = null;
    return {
      proc: {
        on: (ev: string, fn: (arg: unknown) => void) => handlers.set(ev, fn),
        exit: (c?: number) => {
          exitCode = c ?? null;
        },
      } as unknown as Pick<NodeJS.Process, "on" | "exit">,
      handlers,
      exited: () => exitCode,
    };
  }

  it("survives an unhandled rejection: logs + counts, no exit", () => {
    const { proc, handlers, exited } = fakeProc();
    const logs: string[] = [];
    installProcessGuards({ log: (m) => logs.push(m), proc });
    const before = guardCounters().unhandledRejection;
    handlers.get("unhandledRejection")!(new Error("boom"));
    expect(exited()).toBeNull();
    expect(guardCounters().unhandledRejection).toBe(before + 1);
    expect(logs.join("\n")).toContain("boom");
  });

  it("logs diagnostics then exits non-zero on uncaught exception", () => {
    const { proc, handlers, exited } = fakeProc();
    const logs: string[] = [];
    installProcessGuards({ log: (m) => logs.push(m), proc });
    handlers.get("uncaughtException")!(new Error("fatal"));
    expect(exited()).toBe(1);
    expect(logs.join("\n")).toContain("fatal");
    expect(guardCounters().uncaughtException).toBeGreaterThanOrEqual(1);
  });
});
