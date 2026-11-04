import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SetupDriver, type SetupCaptureHooks, type SetupDriverEvent } from "../src/setups.js";

/**
 * M8 capture lifecycle (ADR-0008 §7): the agent binds the proxy before spawn,
 * injects the chosen loopback engine port via $PORT, closes it on stop, and
 * re-attaches it for surviving engines after an agent restart.
 */

type RecordedEvent = SetupDriverEvent & { setupId: string };

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function makeDir(): string {
  const d = mkdtempSync(join(tmpdir(), "irori-capture-"));
  dirs.push(d);
  return d;
}

function script(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const ID = "0b6c1c26-1f1e-4a2f-9c2a-9d6a2f7b1e01";
const RUN = "0b6c1c26-1f1e-4a2f-9c2a-9d6a2f7b1e02";

interface Hooks {
  hooks: SetupCaptureHooks;
  started: Array<{ setupId: string; listenPort: number; targetPort: number }>;
  stopped: string[];
  logs: string[];
  failStart: boolean;
}

function makeHooks(): Hooks {
  const h: Hooks = { started: [], stopped: [], logs: [], failStart: false, hooks: null as unknown as SetupCaptureHooks };
  h.hooks = {
    start: async (setupId, listenPort, targetPort) => {
      if (h.failStart) throw new Error("EADDRINUSE");
      h.started.push({ setupId, listenPort, targetPort });
    },
    stop: async (setupId) => {
      h.stopped.push(setupId);
    },
    log: (setupId, line) => {
      h.logs.push(`${setupId}: ${line}`);
    },
  };
  return h;
}

interface Harness {
  driver: SetupDriver;
  dir: string;
  events: RecordedEvent[];
  hooks: Hooks;
}

function makeHarness(hooks: Hooks): Harness {
  const dir = makeDir();
  const events: RecordedEvent[] = [];
  const driver = new SetupDriver({
    stateDir: dir,
    modelctlPath: "/nonexistent-modelctl",
    events: {
      onEvent: (setupId, event) => events.push({ setupId, ...event }),
      onLog: () => {},
    },
    capture: hooks.hooks,
    log: () => {},
  });
  driver.init();
  return { driver, dir, events, hooks };
}

async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("SetupDriver capture lifecycle", () => {
  it("binds the proxy before spawn and injects the engine port via $PORT", async () => {
    const hooks = makeHooks();
    const h = makeHarness(hooks);
    const portFile = join(h.dir, "port.txt");
    const start = script(h.dir, "start.sh", `echo $PORT > ${portFile}\nsleep 30`);
    const stop = script(h.dir, "stop.sh", "true");

    const result = await h.driver.start(ID, RUN, start, stop, { PORT: "8081" }, null, { proxyPort: 9099, retention: null });
    expect(result.ok).toBe(true);
    // The shell creates the file before writing it — wait for CONTENT, not
    // existence (an empty file raced the write on slow CI disks).
    await waitFor(() => existsSync(portFile) && readFileSync(portFile, "utf8").trim().length > 0);
    const enginePort = Number.parseInt(readFileSync(portFile, "utf8").trim(), 10);
    expect(enginePort).toBeGreaterThan(0);
    expect(enginePort).not.toBe(8081); // overridden — loopback engine port
    expect(enginePort).not.toBe(9099);
    expect(hooks.started).toEqual([{ setupId: ID, listenPort: 9099, targetPort: enginePort }]);

    // Persisted for agent-restart re-attach.
    const persisted = JSON.parse(readFileSync(join(h.dir, "setups.json"), "utf8")) as Array<{ proxyPort: number | null; enginePort: number | null }>;
    expect(persisted[0]?.proxyPort).toBe(9099);
    expect(persisted[0]?.enginePort).toBe(enginePort);

    const stopped = await h.driver.stop(ID, 2000);
    expect(stopped.ok).toBe(true);
    expect(hooks.stopped).toEqual([ID]);
  });

  it("refuses the launch when the proxy bind fails", async () => {
    const hooks = makeHooks();
    hooks.failStart = true;
    const h = makeHarness(hooks);
    const start = script(h.dir, "start.sh", "sleep 30");
    const stop = script(h.dir, "stop.sh", "true");

    const result = await h.driver.start(ID, RUN, start, stop, {}, null, { proxyPort: 9099, retention: null });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("capture proxy bind failed");
    expect(result.error).toContain("EADDRINUSE");
    // Nothing persisted, no proxy half-started.
    expect(existsSync(join(h.dir, "setups.json"))).toBe(false);
    expect(hooks.started).toHaveLength(0);
  });

  it("stops the capture proxy when the start script fails to spawn", async () => {
    const hooks = makeHooks();
    const h = makeHarness(hooks);
    // The proxy binds BEFORE spawn; a spawn-time failure must not leak the
    // listener (the next start would EADDRINUSE and serve 502s). The script
    // passes the driver's executable pre-check — it fails at exec time via
    // a broken interpreter shebang.
    const start = join(h.dir, "start-bad-shebang.sh");
    writeFileSync(start, "#!/nonexistent-interpreter-xyz\necho never\n");
    chmodSync(start, 0o755);
    const result = await h.driver.start(
      ID, RUN,
      start,
      script(h.dir, "stop.sh", "true"),
      { PORT: "8081" }, null, { proxyPort: 9100, retention: null },
    );
    expect(result.ok).toBe(true); // spawn accepted; failure arrives async
    // The stop is idempotent: node may emit BOTH 'error' and 'exit' for a
    // failed spawn, so the exact call count is not pinned — the listener
    // must simply be closed.
    await waitFor(() => hooks.stopped.includes(ID));
    expect(new Set(hooks.stopped)).toEqual(new Set([ID]));
    // The run settles as failed once the proxy teardown completes.
    await waitFor(() => h.events.some((e) => e.setupId === ID && e.state === "failed"));
  });

  it("re-attaches the proxy for a surviving engine after an agent restart", async () => {
    const hooks = makeHooks();
    const h = makeHarness(hooks);
    const start = script(h.dir, "start.sh", "sleep 30");
    const stop = script(h.dir, "stop.sh", "true");
    const result = await h.driver.start(ID, RUN, start, stop, {}, null, { proxyPort: 9101, retention: null });
    expect(result.ok).toBe(true);

    // A fresh driver on the same state dir re-attaches to the live group.
    const hooks2 = makeHooks();
    const driver2 = new SetupDriver({
      stateDir: h.dir,
      modelctlPath: "/nonexistent-modelctl",
      events: { onEvent: () => {}, onLog: () => {} },
      capture: hooks2.hooks,
      log: () => {},
    });
    driver2.init();
    await waitFor(() => hooks2.started.length > 0);
    expect(hooks2.started[0]?.listenPort).toBe(9101);

    await h.driver.stop(ID, 2000);
  });

  /**
   * IR-156: a daemonizing recipe whose engine then died left the capture proxy
   * bound forever — the port stayed occupied (the recipe's own restart failed
   * with "port already in use") until someone pressed Stop. The driver owns the
   * proxy, so the driver must release it on the same truth that reports stopped.
   */
  function makeDaemonHarness(opts: {
    engineAlive: boolean;
    warmupMs?: number;
    idleMs?: number;
  }): { h: Harness; hooks: Hooks; engineChecks: number[] } {
    const hooks = makeHooks();
    const dir = makeDir();
    const events: RecordedEvent[] = [];
    const engineChecks: number[] = [];
    const driver = new SetupDriver({
      stateDir: dir,
      modelctlPath: "/nonexistent-modelctl",
      events: { onEvent: (setupId, event) => events.push({ setupId, ...event }), onLog: () => {} },
      capture: hooks.hooks,
      engineAlive: async (port) => {
        engineChecks.push(port);
        return opts.engineAlive;
      },
      daemonEngineWarmupMs: opts.warmupMs ?? 0,
      daemonLogIdleMs: opts.idleMs ?? 0,
      log: () => {},
    });
    driver.init();
    return { h: { driver, dir, events, hooks }, hooks, engineChecks };
  }

  /** A daemonizing start: the script exits 0 while the engine lives outside it. */
  async function daemonize(h: Harness, proxyPort: number): Promise<number> {
    const start = script(h.dir, "start-daemon.sh", `echo $PORT > ${join(h.dir, "p.txt")}\nexit 0`);
    const result = await h.driver.start(ID, RUN, start, script(h.dir, "stop.sh", "true"), {}, null, { proxyPort, retention: null });
    expect(result.ok).toBe(true);
    await waitFor(() => h.events.some((e) => e.state === "stopped" && e.exitCode === 0));
    return Number.parseInt(readFileSync(join(h.dir, "p.txt"), "utf8").trim(), 10);
  }

  /** The hub polls driver truth every 15 s; a driver only reclaims on a poll
   *  that finds the run over, so the tests poll the way production does. */
  async function pollUntil(driver: SetupDriver, pred: () => boolean, ms = 4000): Promise<boolean> {
    const deadline = Date.now() + ms;
    for (;;) {
      driver.reportStatus(ID);
      if (pred()) return true;
      if (Date.now() > deadline) return false;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  it("releases the capture proxy of a daemonized run whose engine died (IR-156)", async () => {
    const { h, hooks, engineChecks } = makeDaemonHarness({ engineAlive: false });
    const enginePort = await daemonize(h, 9110);
    // Retained after the script's exit 0 (the daemonizing contract).
    expect(hooks.stopped).toEqual([]);

    expect(await pollUntil(h.driver, () => hooks.stopped.includes(ID))).toBe(true);
    expect(engineChecks).toContain(enginePort);
    // The leaked listener AND its retained record are gone — the next start can
    // bind the port and is not blocked by "setup is already running".
    expect(JSON.parse(readFileSync(join(h.dir, "setups.json"), "utf8"))).toEqual([]);
    const again = await h.driver.start(ID, RUN, script(h.dir, "start.sh", "sleep 30"), script(h.dir, "stop.sh", "true"), {}, null, {
      proxyPort: 9110,
      retention: null,
    });
    expect(again.ok).toBe(true);
    await h.driver.stop(ID, 2000);
  });

  it("keeps the proxy when the daemonized engine still answers (IR-156)", async () => {
    const { h, hooks } = makeDaemonHarness({ engineAlive: true });
    await daemonize(h, 9111);
    // Many polls, engine answering every time: nothing may be torn down.
    await pollUntil(h.driver, () => hooks.stopped.length > 0, 300);
    expect(hooks.stopped).toEqual([]);
    expect(JSON.parse(readFileSync(join(h.dir, "setups.json"), "utf8"))).toHaveLength(1);
    // Stop still reaches the retained record and closes it.
    expect((await h.driver.stop(ID, 2000)).ok).toBe(true);
    expect(hooks.stopped).toEqual([ID]);
  });

  it("never reclaims inside the warmup window (IR-156)", async () => {
    const { h, hooks } = makeDaemonHarness({ engineAlive: false, warmupMs: 60_000 });
    await daemonize(h, 9112);
    await pollUntil(h.driver, () => hooks.stopped.length > 0, 300);
    expect(hooks.stopped).toEqual([]);
    expect((await h.driver.stop(ID, 2000)).ok).toBe(true);
  });
});
