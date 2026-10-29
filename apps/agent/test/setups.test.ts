import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { serveSpawnArgv, SetupDriver, type SetupDriverEvent } from "../src/setups.js";

/** The harness records the setupId alongside the event (the source splits them). */
type RecordedEvent = SetupDriverEvent & { setupId: string };
type RecordedLog = { setupId: string; seq: number; line: string; ts: number };

const ID = "0b6c1c26-1f1e-4a2f-9c2a-9d6a2f7b1e01";
const RUN = "0b6c1c26-1f1e-4a2f-9c2a-9d6a2f7b1e02";
const UUID3 = "0b6c1c26-1f1e-4a2f-9c2a-9d6a2f7b1e03";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function makeDir(): string {
  const d = mkdtempSync(join(tmpdir(), "irori-setup-"));
  dirs.push(d);
  return d;
}

interface Harness {
  driver: SetupDriver;
  dir: string;
  events: RecordedEvent[];
  logs: RecordedLog[];
}

function makeHarness(modelctlScript?: string): Harness {
  const dir = makeDir();
  const events: RecordedEvent[] = [];
  const logs: RecordedLog[] = [];
  const driver = new SetupDriver({
    stateDir: dir,
    modelctlPath: modelctlScript ?? "/nonexistent-modelctl",
    events: {
      onEvent: (setupId, event) => events.push({ setupId, ...event }),
      onLog: (setupId, seq, line, ts) => logs.push({ setupId, seq, line, ts }),
    },
    log: () => {},
  });
  driver.init();
  return { driver, dir, events, logs };
}

function script(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("SetupDriver", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it("validates scripts and refuses to launch without an executable stop script", async () => {
    const dir = makeDir();
    const start = script(dir, "start.sh", "sleep 30");
    const notExec = join(dir, "not-exec.sh");
    writeFileSync(notExec, "#!/bin/bash\ntrue\n");

    const noStop = await h.driver.start(ID, RUN, start, "", {}, null);
    expect(noStop.ok).toBe(false);
    expect(noStop.error).toContain("stop script is required");

    const badStart = await h.driver.start(ID, RUN, notExec, start, {}, null);
    expect(badStart.ok).toBe(false);
    expect(badStart.error).toContain("not executable");

    const badStop = await h.driver.start(ID, RUN, start, notExec, {}, null);
    expect(badStop.ok).toBe(false);
    expect(badStop.error).toContain("not executable");

    const validation = h.driver.validate([start, notExec, join(dir, "missing.sh")]);
    expect(validation[0]!.ok).toBe(true);
    expect(validation[1]!.ok).toBe(false);
    expect(validation[1]!.error).toContain("not executable");
    expect(validation[2]!.ok).toBe(false);
    expect(validation[2]!.error).toContain("not found");
  });

  it("spawns the start script detached, captures logs, and stops via the stop script", async () => {
    const dir = makeDir();
    const marker = join(dir, "engine.touch");
    const start = script(dir, "start.sh", `touch "${marker}"; echo engine: listening on 0.0.0.0:8081; echo -e "progress 45% 1.00MB/s\\rprogress 64% 2.00MB/s"; sleep 60`);
    const stop = script(dir, "stop.sh", "echo stop: graceful");
    const result = await h.driver.start(ID, RUN, start, stop, { PORT: "8081" }, null);
    expect(result.ok).toBe(true);

    await waitFor(() => h.logs.some((l) => l.line.includes("listening on 0.0.0.0:8081")));
    await waitFor(() => h.logs.some((l) => l.line.includes("progress 64% 2.00MB/s")));
    expect(h.events[0]).toMatchObject({ setupId: ID, state: "running" });
    // \r-split progress chunks stream as lines
    expect(h.logs.some((l) => l.line.includes("progress 45%"))).toBe(true);
    expect(existsSync(join(h.dir, "setup-logs", `${ID}-${RUN}.log`))).toBe(true);

    const stopped = await h.driver.stop(ID, 2000);
    expect(stopped.ok).toBe(true);
    expect(stopped.error).toBeNull();
    await waitFor(() => h.events.some((e) => e.state === "stopped"));
    // the stop script's output lands in the log ring
    expect(h.logs.some((l) => l.line.includes("stop: graceful"))).toBe(true);
  });

  it("falls back to killing the process group when the stop script fails", async () => {
    const dir = makeDir();
    const start = script(dir, "start.sh", "sleep 60");
    const stop = script(dir, "stop.sh", "exit 3");
    await h.driver.start(ID, RUN, start, stop, {}, null);
    const stopped = await h.driver.stop(ID, 1000);
    expect(stopped.ok).toBe(false);
    expect(stopped.error).toContain("exited with code 3");
    await waitFor(() => h.events.some((e) => e.state === "stopped"));
  });

  it("refuses double starts and stopping an unknown setup", async () => {
    const dir = makeDir();
    const start = script(dir, "start.sh", "sleep 60");
    const stop = script(dir, "stop.sh", "true");
    const first = await h.driver.start(ID, RUN, start, stop, {}, null);
    expect(first.ok).toBe(true);
    const second = await h.driver.start(ID, UUID3, start, stop, {}, null);
    expect(second.ok).toBe(false);
    expect(second.error).toContain("already running");
    const unknown = await h.driver.stop(UUID3, 1000);
    expect(unknown.ok).toBe(false);
    await h.driver.stop(ID, 1000);
  });

  it("re-attaches to a live driver from the persisted state and drops dead ones", async () => {
    const dir = makeDir();
    const start = script(dir, "start.sh", "sleep 60");
    const stop = script(dir, "stop.sh", "true");
    const events: RecordedEvent[] = [];
    const driver = new SetupDriver({
      stateDir: dir,
      modelctlPath: "/nonexistent",
      events: {
        onEvent: (setupId, event) => events.push({ setupId, ...event }),
        onLog: () => {},
      },
      log: () => {},
    });
    driver.init();
    const result = await driver.start(ID, RUN, start, stop, {}, null);
    expect(result.ok).toBe(true);

    const stateFile = join(dir, "setups.json");
    expect(existsSync(stateFile)).toBe(true);
    const persisted = JSON.parse(readFileSync(stateFile, "utf8")) as Array<{ setupId: string; pgid: number | null }>;
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.pgid).not.toBeNull();

    // A fresh agent process re-attaches: alive → running.
    const events2: RecordedEvent[] = [];
    const driver2 = new SetupDriver({
      stateDir: dir,
      modelctlPath: "/nonexistent",
      events: { onEvent: (setupId, event) => events2.push({ setupId, ...event }), onLog: () => {} },
      log: () => {},
    });
    driver2.init();
    expect(events2.some((e) => e.setupId === ID && e.state === "running")).toBe(true);

    await driver.stop(ID, 1000);
    await driver2.stop(ID, 1000).catch(() => {});

    // Dead pgid in the state file → reported stopped, record dropped.
    const deadDir = makeDir();
    mkdirSync(deadDir, { recursive: true });
    writeFileSync(join(deadDir, "setups.json"), JSON.stringify([{ setupId: ID, runId: RUN, scriptStart: "x", scriptStop: "y", env: {}, pid: 999999, pgid: 999999, startedAt: 0, logPath: "x" }]));
    const events3: RecordedEvent[] = [];
    const driver3 = new SetupDriver({
      stateDir: deadDir,
      modelctlPath: "/nonexistent",
      events: { onEvent: (setupId, event) => events3.push({ setupId, ...event }), onLog: () => {} },
      log: () => {},
    });
    driver3.init();
    expect(events3.some((e) => e.setupId === ID && e.state === "stopped")).toBe(true);
  });

  it("resolves MODEL_PATH via modelctl path --local and fails the start when it errors", async () => {
    const dir = makeDir();
    const modelctl = script(dir, "modelctl", 'echo "/hf/models--GLM-5.3-Flash-EXL3/snapshots/abc"; # args: ');
    const h2 = makeHarness(modelctl);
    const start = script(dir, "start.sh", 'echo "MODEL_PATH=$MODEL_PATH"; sleep 60');
    const stop = script(dir, "stop.sh", "true");
    const result = await h2.driver.start(ID, RUN, start, stop, {}, "GLM-5.3-Flash-EXL3");
    expect(result.ok).toBe(true);
    await waitFor(() => h2.logs.some((l) => l.line.includes("MODEL_PATH=/hf/models--GLM-5.3-Flash-EXL3/snapshots/abc")));
    await h2.driver.stop(ID, 1000);

    const failing = script(dir, "modelctl-fail", "exit 1");
    const h3 = makeHarness(failing);
    const refusal = await h3.driver.start(ID, RUN, start, stop, {}, "GLM-5.3-Flash-EXL3");
    expect(refusal.ok).toBe(false);
    expect(refusal.error).toContain("MODEL_PATH resolution failed");
  });

  it("refuses MODEL_PATH starts with the cache-user reason when the wrap cannot build (IR-120)", async () => {
    const dir = makeDir();
    const start = script(dir, "start.sh", "sleep 30");
    const stop = script(dir, "stop.sh", "true");
    const driver = new SetupDriver({
      stateDir: dir,
      modelctlPath: "/nonexistent-modelctl",
      cacheUser: () => "piresbruno",
      agentUser: "root",
      resolveLocalUser: () => null,
      resolveCacheHome: () => "/home/piresbruno",
      events: { onEvent: () => {}, onLog: () => {} },
    });
    driver.init();
    const refusal = await driver.start(ID, RUN, start, stop, {}, "GLM-5.3-Flash-EXL3");
    expect(refusal.ok).toBe(false);
    expect(refusal.error).toContain("MODEL_PATH resolution failed");
    expect(refusal.error).toContain(`no modelctl for cache user "piresbruno"`);
  });

  it("builds the runuser wrap argv for a cache user and passes unwrapped scripts through (IRI-045)", () => {
    expect(serveSpawnArgv("/opt/serve/start.sh", { user: "piresbruno", home: "/home/piresbruno" }, "/usr/bin:/bin")).toEqual([
      "runuser",
      "-u",
      "piresbruno",
      "--",
      "env",
      "-u",
      "XDG_STATE_HOME",
      "-u",
      "HF_HOME",
      "-u",
      "HF_HUB_CACHE",
      "HOME=/home/piresbruno",
      "PATH=/usr/bin:/bin",
      "USER=piresbruno",
      "LOGNAME=piresbruno",
      "/opt/serve/start.sh",
    ]);
    expect(serveSpawnArgv("/opt/serve/start.sh", null, undefined)).toEqual(["/opt/serve/start.sh"]);
    // No ambient PATH → systemd's default (the agent unit sets none itself).
    expect(serveSpawnArgv("/s.sh", { user: "u", home: "/h" }, undefined)).toContain(
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    );
  });

  it("skips the wrap when the cache user getter returns null (IRI-045)", async () => {
    const dir = makeDir();
    const start = script(dir, "start.sh", 'echo "ran HOME=$HOME"; sleep 60');
    const stop = script(dir, "stop.sh", "true");
    const logs: RecordedLog[] = [];
    const driver = new SetupDriver({
      stateDir: dir,
      modelctlPath: "/nonexistent-modelctl",
      cacheUser: () => null, // hub without the node setting (IR-101 default)
      agentUser: "root",
      resolveCacheHome: () => {
        throw new Error("must not resolve a home when there is no cache user");
      },
      events: { onEvent: () => {}, onLog: (s, seq, line, ts) => logs.push({ setupId: s, seq, line, ts }) },
    });
    driver.init();
    const result = await driver.start(ID, RUN, start, stop, {}, null);
    expect(result.ok).toBe(true);
    await waitFor(() => logs.some((l) => l.line.includes("ran HOME=")));
    expect(logs.some((l) => l.line.includes("serving as cache user"))).toBe(false);
    await driver.stop(ID, 1000);
  });

  it("refuses to start when the configured cache user has no passwd entry (IRI-045)", async () => {
    const dir = makeDir();
    const start = script(dir, "start.sh", "sleep 30");
    const stop = script(dir, "stop.sh", "true");
    const driver = new SetupDriver({
      stateDir: dir,
      modelctlPath: "/nonexistent-modelctl",
      cacheUser: () => "ghost",
      agentUser: "root",
      resolveCacheHome: () => null,
      events: { onEvent: () => {}, onLog: () => {} },
    });
    driver.init();
    const refusal = await driver.start(ID, RUN, start, stop, {}, null);
    expect(refusal.ok).toBe(false);
    expect(refusal.error).toContain(`no passwd entry for cache user "ghost"`);
    // Refusal happens before anything binds or persists.
    expect(existsSync(join(dir, "setups.json"))).toBe(false);
  });

  it("runs the start and stop scripts as the cache user through the wrap (IRI-045)", async () => {
    const dir = makeDir();
    // A faithful test double for runuser (there is no setuid tool tests may
    // call on macOS/CI): applies the env modifications, then execs.
    const bin = makeDir();
    const fakeRunuser = join(bin, "runuser");
    writeFileSync(
      fakeRunuser,
      [
        "#!/bin/bash",
        "# test double: runuser -u USER -- env [-u NAME]... [K=V]... CMD...",
        "[ \"$1\" = \"-u\" ] && shift 2",
        "[ \"$1\" = \"--\" ] && shift",
        "[ \"$1\" = \"env\" ] && shift",
        "while [ \"$1\" = \"-u\" ]; do unset \"$2\"; shift 2; done",
        'while [ $# -gt 0 ] && [ "${1#*=}" != "$1" ]; do export "$1"; shift; done',
        'exec "$@"',
      ].join("\n"),
    );
    chmodSync(fakeRunuser, 0o755);

    const oldPath = process.env.PATH;
    const oldHfHome = process.env.HF_HOME;
    process.env.PATH = `${bin}:${oldPath ?? ""}`;
    process.env.HF_HOME = "/root/.cache/huggingface"; // must be scrubbed for the wrapped child
    const events: RecordedEvent[] = [];
    const logs: RecordedLog[] = [];
    try {
      const start = script(dir, "start.sh", 'echo "start HOME=$HOME USER=$USER LOGNAME=$LOGNAME"; echo "HF_HOME=${HF_HOME-UNSET}"; sleep 60');
      const stop = script(dir, "stop.sh", 'echo "stop HOME=$HOME USER=$USER"');
      const driver = new SetupDriver({
        stateDir: dir,
        modelctlPath: "/nonexistent-modelctl",
        cacheUser: () => "piresbruno",
        agentUser: "root",
        resolveCacheHome: () => "/home/piresbruno",
        events: { onEvent: (setupId, event) => events.push({ setupId, ...event }), onLog: (s, seq, line, ts) => logs.push({ setupId: s, seq, line, ts }) },
      });
      driver.init();
      const result = await driver.start(ID, RUN, start, stop, {}, null);
      expect(result.ok).toBe(true);
      expect(logs.some((l) => l.line.includes("driver: serving as cache user piresbruno (HOME=/home/piresbruno)"))).toBe(true);
      await waitFor(() => logs.some((l) => l.line.includes("start HOME=/home/piresbruno USER=piresbruno LOGNAME=piresbruno")));
      // The root agent's HF_HOME must not leak into the wrapped engine.
      expect(logs.some((l) => l.line.includes("HF_HOME=UNSET"))).toBe(true);
      // The run context persists so a stop after an agent restart keeps it.
      const persisted = JSON.parse(readFileSync(join(dir, "setups.json"), "utf8")) as Array<{ runUser: string | null }>;
      expect(persisted[0]!.runUser).toBe("piresbruno");

      const stopped = await driver.stop(ID, 2000);
      expect(stopped.ok).toBe(true);
      await waitFor(() => events.some((e) => e.state === "stopped"));
      expect(logs.some((l) => l.line.includes("stop HOME=/home/piresbruno USER=piresbruno"))).toBe(true);
    } finally {
      if (oldPath !== undefined) process.env.PATH = oldPath;
      else delete process.env.PATH;
      if (oldHfHome !== undefined) process.env.HF_HOME = oldHfHome;
      else delete process.env.HF_HOME;
    }
  });

  it("injects a HOME fallback for unwrapped starts when the agent env has none (IRI-045)", async () => {
    const dir = makeDir();
    const start = script(dir, "start.sh", 'echo "HOME=$HOME"; sleep 60');
    const stop = script(dir, "stop.sh", "true");
    const oldHome = process.env.HOME;
    delete process.env.HOME; // the systemd agent unit ships no HOME
    try {
      const expected = homedir();
      const result = await h.driver.start(ID, RUN, start, stop, {}, null);
      expect(result.ok).toBe(true);
      await waitFor(() => h.logs.some((l) => l.line === `HOME=${expected}`));
      // Persisted on the record so the stop script inherits it too.
      const persisted = JSON.parse(readFileSync(join(h.dir, "setups.json"), "utf8")) as Array<{ env: Record<string, string> }>;
      expect(persisted[0]!.env.HOME).toBe(expected);
    } finally {
      if (oldHome !== undefined) process.env.HOME = oldHome;
    }
    await h.driver.stop(ID, 1000);
  });
});
