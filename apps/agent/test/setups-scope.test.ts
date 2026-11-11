import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { SetupDriver, systemdScope, type ScopeSurface, type SetupDriverEvent } from "../src/setups.js";

/**
 * ADR-0017: setups spawn inside `iroori-setup-<slug>` transient scope units
 * so an agent restart cannot kill running engines. Fully hermetic: the scope
 * surface AND the start spawn are fakes, so nothing here really systemd-runs
 * (CI hosts have no usable systemd manager).
 */

type RecordedEvent = SetupDriverEvent & { setupId: string };

const ID = "0b6c1c26-1f1e-4a2f-9c2a-9d6a2f7b1e01";
const RUN = "0b6c1c26-1f1e-4a2f-9c2a-9d6a2f7b1e02";
/** A pgid that cannot exist anywhere — probing/killing it is a safe no-op. */
const FAKE_PID = 2_147_483_647;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function makeDir(): string {
  const d = mkdtempSync(join(tmpdir(), "irori-setup-scope-"));
  dirs.push(d);
  return d;
}

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  child.pid = FAKE_PID;
  return child;
}

function script(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

interface FakeScope extends ScopeSurface {
  units: string[]; // unitName() results, in order
  stopped: string[]; // stop() calls
  active: Set<string>; // units reported active
  avail: boolean;
}

function fakeScope(opts: { available?: boolean } = {}): FakeScope {
  const fake: FakeScope = {
    units: [],
    stopped: [],
    active: new Set(),
    avail: opts.available ?? true,
    available() {
      return fake.avail;
    },
    unitName(setupId: string) {
      const unit = `irori-setup-fake-${(fake.units.length + 1).toString(16)}`;
      fake.units.push(unit);
      return unit;
    },
    argv(unit: string, argv: string[]) {
      return ["systemd-run", "--scope", "--quiet", `--unit=${unit}`, "--", ...argv];
    },
    async isActive(unit: string) {
      return fake.active.has(unit);
    },
    async stop(unit: string) {
      fake.stopped.push(unit);
    },
  };
  return fake;
}

interface Harness {
  driver: SetupDriver;
  dir: string;
  events: RecordedEvent[];
  scope: FakeScope;
  spawned: string[][];
}

function makeHarness(scope: FakeScope): Harness {
  const dir = makeDir();
  const events: RecordedEvent[] = [];
  const spawned: string[][] = [];
  const driver = new SetupDriver({
    stateDir: dir,
    modelctlPath: "/nonexistent-modelctl",
    events: { onEvent: (setupId, event) => events.push({ setupId, ...event }), onLog: () => {} },
    scope,
    startSpawn: ((...args: unknown[]) => {
      spawned.push([args[0] as string, ...((args[1] as string[]) ?? [])]);
      return fakeChild();
    }) as unknown as typeof import("node:child_process").spawn,
    log: () => {},
  });
  return { driver, dir, events, scope, spawned };
}

function readRecords(dir: string): Array<{ scopeUnit: string | null }> {
  return JSON.parse(readFileSync(join(dir, "setups.json"), "utf8"));
}

describe("setup scope isolation (ADR-0017)", () => {
  it("wraps the start script in a scope unit and records it when available", async () => {
    const scope = fakeScope();
    const h = makeHarness(scope);
    const dir = makeDir();
    const start = script(dir, "start.sh", "sleep 30");
    const stop = script(dir, "stop.sh", "true");

    const result = await h.driver.start(ID, RUN, start, stop, {}, null);
    expect(result.ok).toBe(true);
    expect(scope.units).toHaveLength(1);
    expect(scope.units[0]).toMatch(/^irori-setup-fake-[0-9a-f]+$/);
    // The spawned argv is the scope wrap around the (unwrapped) service argv.
    expect(h.spawned[0]).toEqual(["systemd-run", "--scope", "--quiet", `--unit=${scope.units[0]}`, "--", start]);

    expect(readRecords(h.dir)[0]).toMatchObject({ scopeUnit: scope.units[0] });
  });

  it("falls back to the plain spawn when systemd is unavailable", async () => {
    const scope = fakeScope({ available: false });
    const h = makeHarness(scope);
    const dir = makeDir();
    const start = script(dir, "start.sh", "sleep 30");
    const stop = script(dir, "stop.sh", "true");

    const result = await h.driver.start(ID, RUN, start, stop, {}, null);
    expect(result.ok).toBe(true);
    expect(scope.units).toHaveLength(0);
    expect(h.spawned[0]).toEqual([start]);
    expect(readRecords(h.dir)[0]).toMatchObject({ scopeUnit: null });
    await h.driver.stop(ID, 1000);
    expect(scope.stopped).toHaveLength(0);
  });

  it("refuses a start while the recorded scope is still active", async () => {
    const scope = fakeScope();
    const h = makeHarness(scope);
    const dir = makeDir();
    const start = script(dir, "start.sh", "sleep 30");
    const stop = script(dir, "stop.sh", "true");

    await h.driver.start(ID, RUN, start, stop, {}, null);
    // Simulate an agent restart: fresh driver, same state dir, engine daemonized
    // out of its process group (the record's pgid is dead) but scope alive.
    scope.active.add(scope.units[0]!);
    const events: RecordedEvent[] = [];
    const revived = new SetupDriver({
      stateDir: h.dir,
      modelctlPath: "/nonexistent-modelctl",
      events: { onEvent: (setupId, event) => events.push({ setupId, ...event }), onLog: () => {} },
      scope,
      startSpawn: (() => fakeChild()) as unknown as typeof import("node:child_process").spawn,
      log: () => {},
    });
    await revived.init();
    const second = await revived.start(ID, `${RUN}-2`, start, stop, {}, null);
    expect(second.ok).toBe(false);
    expect(second.error).toContain("systemd scope still active");
  });

  it("adopts a still-active scope at boot when the process group is dead", async () => {
    const scope = fakeScope();
    const h = makeHarness(scope);
    const dir = makeDir();
    const start = script(dir, "start.sh", "sleep 30");
    const stop = script(dir, "stop.sh", "true");

    const first = await h.driver.start(ID, RUN, start, stop, {}, null);
    expect(first.ok).toBe(true);

    const events: RecordedEvent[] = [];
    const revived = new SetupDriver({
      stateDir: h.dir,
      modelctlPath: "/nonexistent-modelctl",
      events: { onEvent: (setupId, event) => events.push({ setupId, ...event }), onLog: () => {} },
      scope,
      startSpawn: (() => fakeChild()) as unknown as typeof import("node:child_process").spawn,
      log: () => {},
    });
    scope.active.add(scope.units[0]!);
    await revived.init();

    const adopted = events.find((e) => e.setupId === ID && e.state === "running");
    expect(adopted).toBeDefined();
    expect(scope.stopped).toHaveLength(0); // not stopped — adopted

    // A dead scope reports stopped, like today's dead-group path.
    const events2: RecordedEvent[] = [];
    const deadScope = new SetupDriver({
      stateDir: h.dir,
      modelctlPath: "/nonexistent-modelctl",
      events: { onEvent: (setupId, event) => events2.push({ setupId, ...event }), onLog: () => {} },
      scope: fakeScope(),
      startSpawn: (() => fakeChild()) as unknown as typeof import("node:child_process").spawn,
      log: () => {},
    });
    await deadScope.init();
    expect(events2.find((e) => e.setupId === ID && e.state === "stopped")).toBeDefined();
  });

  it("default surface: argv shape, unit-name format, and darwin availability", () => {
    expect(systemdScope.available()).toBe(process.platform === "linux");
    const unit = systemdScope.unitName(ID);
    expect(unit).toMatch(/^irori-setup-0b6c1c26-[0-9a-f]{4}$/);
    const argv = systemdScope.argv(unit, ["/bin/true"]);
    expect(argv[0]).toBe("systemd-run");
    expect(argv).toContain("--scope");
    expect(argv[argv.indexOf("--") + 1]).toBe("/bin/true");
  });
});
