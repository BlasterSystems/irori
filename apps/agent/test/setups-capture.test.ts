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

    const result = await h.driver.start(ID, RUN, start, stop, { PORT: "8081" }, null, { proxyPort: 9099 });
    expect(result.ok).toBe(true);
    await waitFor(() => existsSync(portFile));
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

    const result = await h.driver.start(ID, RUN, start, stop, {}, null, { proxyPort: 9099 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("capture proxy bind failed");
    expect(result.error).toContain("EADDRINUSE");
    // Nothing persisted, no proxy half-started.
    expect(existsSync(join(h.dir, "setups.json"))).toBe(false);
    expect(hooks.started).toHaveLength(0);
  });

  it("re-attaches the proxy for a surviving engine after an agent restart", async () => {
    const hooks = makeHooks();
    const h = makeHarness(hooks);
    const start = script(h.dir, "start.sh", "sleep 30");
    const stop = script(h.dir, "stop.sh", "true");
    const result = await h.driver.start(ID, RUN, start, stop, {}, null, { proxyPort: 9101 });
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
});
