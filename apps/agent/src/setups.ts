import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { accessSync, constants, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";
import type { BodyRetention } from "@irori/core";
import { asCacheUser, type CacheUserCtx } from "./modelctl.js";

/**
 * Setup supervision on the agent (M5, SPEC §7 + ADR-0003): one start/stop
 * script pair per setup, spawned detached in its own process group. The stop
 * script is required; if it fails or times out, the recorded process group is
 * killed as the fallback. Engine stdout/stderr is the log: a bounded ring for
 * streaming + an append file persisted per run. Driver state is persisted in
 * the agent state dir so a restarted agent re-attaches to a still-running
 * engine (pid/pgid alive probe) and so detached drivers survive server (and
 * agent) restarts.
 */

export interface SetupDriverEvent {
  runId: string | null;
  state: "starting" | "running" | "stopping" | "stopped" | "failed";
  exitCode: number | null;
  pid: number | null;
  pgid: number | null;
  error: string | null;
}

export interface SetupDriverEvents {
  onEvent(setupId: string, event: SetupDriverEvent): void;
  onLog(setupId: string, seq: number, line: string, ts: number): void;
}

export interface SetupDriverDeps {
  /** Persistent agent state directory (IRORI_STATE_DIR). */
  stateDir: string;
  /** modelctl binary for `path --local` (MODEL_PATH resolution). */
  modelctlPath: string;
  /** IR-120: node cache owner for MODEL_PATH resolution — a getter keeps the
   *  value fresh across config-update frames (null/absent = the agent user). */
  cacheUser?: () => string | null;
  /** The agent's own user (root); a cacheUser equal to it skips the wrap. */
  agentUser?: string;
  /** Resolves a cache owner's home + modelctl binary; null = not installed. */
  resolveLocalUser?: (user: string) => { home: string; binary: string } | null;
  events: SetupDriverEvents;
  /** M8 capture proxy hooks (ADR-0008 §7); absent = capture unsupported. */
  capture?: SetupCaptureHooks;
  log?: (message: string) => void;
}

/** Agent-side capture proxy control surface (injected for tests). */
export interface SetupCaptureHooks {
  /** Binds `listenPort` → loopback `targetPort`; throws on bind failure.
   *  `retention` (IR-52) opts the proxy into body capture; null = off. */
  start(setupId: string, listenPort: number, targetPort: number, retention: BodyRetention | null): Promise<void>;
  /** Closes the listener; idempotent, never throws. */
  stop(setupId: string): Promise<void>;
  /** Routes a proxy log line into the setup's log ring. */
  log(setupId: string, line: string): void;
}

const LOG_RING_LINES = 1000;
const LOG_DIR = "setup-logs";
const STATE_FILE = "setups.json";
const STOP_FALLBACK_GRACE_MS = 5_000;

interface DriverRecord {
  setupId: string;
  runId: string;
  scriptStart: string;
  scriptStop: string;
  env: Record<string, string>;
  pid: number | null;
  pgid: number | null;
  startedAt: number;
  logPath: string;
  /** M8: bound proxy port and the loopback engine port behind it. */
  proxyPort: number | null;
  enginePort: number | null;
  /** IR-52: retention caps the proxy was started with (re-attach restores). */
  retention: BodyRetention | null;
}

interface RingEntry {
  seq: number;
  line: string;
  ts: number;
}

/** Best-effort "is this process group alive" probe. */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM"; // exists but not ours — still running
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Ephemeral free loopback port for the engine behind the capture proxy. */
async function pickFreeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export class SetupDriver {
  private readonly records = new Map<string, DriverRecord>();
  private readonly children = new Map<string, ChildProcess>();
  private readonly streams = new Map<string, WriteStream>();
  private readonly rings = new Map<string, RingEntry[]>();
  private readonly seqs = new Map<string, number>();
  private readonly stopping = new Set<string>();

  constructor(private readonly deps: SetupDriverDeps) {}

  /** Loads persisted drivers, drops dead ones, reports live ones. */
  init(): void {
    mkdirSync(join(this.deps.stateDir, LOG_DIR), { recursive: true });
    const file = join(this.deps.stateDir, STATE_FILE);
    if (!existsSync(file)) return;
    let records: DriverRecord[] = [];
    try {
      records = JSON.parse(readFileSync(file, "utf8")) as DriverRecord[];
      if (!Array.isArray(records)) records = [];
    } catch (err) {
      this.deps.log?.(`setup state unreadable, ignoring (${err instanceof Error ? err.message : String(err)})`);
      return;
    }
    const kept: DriverRecord[] = [];
    for (const record of records) {
      if (record.pgid !== null && groupAlive(record.pgid)) {
        // Re-attached: the engine survived the agent restart, but the old
        // stdout pipes died with the previous agent process — log capture
        // resumes on the next start.
        this.records.set(record.setupId, record);
        kept.push(record);
        if (record.proxyPort !== null && record.enginePort !== null && this.deps.capture !== undefined) {
          void this.deps.capture
            .start(record.setupId, record.proxyPort, record.enginePort, record.retention ?? null)
            .then(() =>
              this.deps.capture?.log(record.setupId, `driver: capture proxy re-attached :${record.proxyPort} → 127.0.0.1:${record.enginePort}`),
            )
            .catch((err: unknown) =>
              this.deps.capture?.log(
                record.setupId,
                `driver: capture proxy re-attach failed on :${record.proxyPort} (${err instanceof Error ? err.message : String(err)})`,
              ),
            );
        }
        this.deps.events.onEvent(record.setupId, {
          runId: record.runId,
          state: "running",
          exitCode: null,
          pid: record.pid,
          pgid: record.pgid,
          error: null,
        });
      } else {
        this.deps.events.onEvent(record.setupId, {
          runId: record.runId,
          state: "stopped",
          exitCode: null,
          pid: record.pid,
          pgid: record.pgid,
          error: null,
        });
      }
    }
    this.persist(kept);
    this.pruneRunLogs();
  }

  /** Public log route for capture-proxy lifecycle lines (M8). */
  pushSetupLog(setupId: string, line: string): void {
    this.pushLog(setupId, line);
  }

  /** Per-run log files grow with engine stdout — keep the newest few per setup. */
  private pruneRunLogs(keep = 5): void {
    try {
      const dir = join(this.deps.stateDir, LOG_DIR);
      const bySetup = new Map<string, Array<{ name: string; mtimeMs: number }>>();
      for (const entry of readdirSync(dir)) {
        // <setupId>-<runId>.log — both UUIDs, so the runId is exactly the
        // last 36 chars before the extension.
        const m = /^(.+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.log$/.exec(entry);
        if (m === null) continue;
        const setupId = m[1]!;
        const st = statSync(join(dir, entry));
        const list = bySetup.get(setupId) ?? [];
        list.push({ name: entry, mtimeMs: st.mtimeMs });
        bySetup.set(setupId, list);
      }
      for (const list of bySetup.values()) {
        if (list.length <= keep) continue;
        list.sort((a, b) => b.mtimeMs - a.mtimeMs);
        for (const stale of list.slice(keep)) rmSync(join(dir, stale.name), { force: true });
      }
    } catch (err) {
      this.deps.log?.(`setup log pruning skipped (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  /** Agent ring for the setup (bounded, oldest dropped). */
  ring(setupId: string): RingEntry[] {
    return this.rings.get(setupId) ?? [];
  }

  /** Create-time `test -x` validation of script paths (no side effects). */
  validate(scripts: string[]): Array<{ script: string; ok: boolean; error: string | null }> {
    return scripts.map((script) => {
      if (script.length === 0) return { script, ok: false, error: "empty path" };
      if (isExecutable(script)) return { script, ok: true, error: null };
      if (!existsSync(script)) return { script, ok: false, error: "not found" };
      return { script, ok: false, error: "not executable (test -x failed)" };
    });
  }

  /**
   * Validates and spawns the start script. Resolves once the process is up
   * (or on validation/resolution failure) — engine readiness is the server's
   * health watcher's job.
   */
  async start(
    setupId: string,
    runId: string,
    scriptStart: string,
    scriptStop: string,
    env: Record<string, string>,
    modelPathName: string | null,
    capture: { proxyPort: number; retention: BodyRetention | null } | null = null,
  ): Promise<{ ok: boolean; error: string | null }> {
    const existing = this.records.get(setupId);
    if (existing && (this.children.has(setupId) || (existing.pgid !== null && groupAlive(existing.pgid)))) {
      return { ok: false, error: "setup is already running" };
    }
    if (!isExecutable(scriptStart)) {
      return { ok: false, error: `start script is not executable: ${scriptStart} (test -x failed)` };
    }
    if (scriptStop.length === 0) {
      return { ok: false, error: "a stop script is required — launch refused" };
    }
    if (!isExecutable(scriptStop)) {
      return { ok: false, error: `stop script is not executable: ${scriptStop} (test -x failed)` };
    }

    const finalEnv = { ...env };
    if (modelPathName !== null) {
      const resolved = await this.resolveModelPath(modelPathName);
      if (resolved.path === null) {
        return {
          ok: false,
          error: `MODEL_PATH resolution failed for ${modelPathName} (modelctl path --local)${resolved.error === null ? "" : `: ${resolved.error}`}`,
        };
      }
      finalEnv.MODEL_PATH = resolved.path;
    }

    // Capture mode: bind the proxy BEFORE spawn; the engine gets a fresh
    // loopback port via $PORT (the documented contract for flagged setups).
    let enginePort: number | null = null;
    if (capture !== null) {
      if (this.deps.capture === undefined) {
        return { ok: false, error: "capture requested but this agent has no capture proxy support" };
      }
      enginePort = await pickFreeLoopbackPort();
      try {
        await this.deps.capture.start(setupId, capture.proxyPort, enginePort, capture.retention ?? null);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `capture proxy bind failed on :${capture.proxyPort} — ${message}` };
      }
      finalEnv.PORT = String(enginePort);
    }

    const logPath = join(this.deps.stateDir, LOG_DIR, `${setupId}-${runId}.log`);
    const child = spawn(scriptStart, [], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...finalEnv },
    });
    const record: DriverRecord = {
      setupId,
      runId,
      scriptStart,
      scriptStop,
      env: finalEnv,
      pid: child.pid ?? null,
      pgid: child.pid ?? null, // detached → the child leads its own group
      startedAt: Date.now(),
      logPath,
      proxyPort: capture !== null ? capture.proxyPort : null,
      enginePort,
      retention: capture !== null ? capture.retention ?? null : null,
    };
    this.records.set(setupId, record);
    this.children.set(setupId, child);
    this.persist([...this.records.values()]);
    if (capture !== null) {
      this.pushLog(setupId, `driver: capture proxy :${capture.proxyPort} → 127.0.0.1:${enginePort} (requests captured, engine on loopback)`);
    }

    const stream = createWriteStream(logPath, { flags: "a" });
    this.streams.set(setupId, stream);
    const onChunk = (buf: Buffer): void => {
      for (const line of buf.toString("utf8").split(/\r\n|\r|\n/)) {
        if (line.length > 0) this.pushLog(setupId, line);
      }
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    child.on("error", (err) => {
      this.pushLog(setupId, `driver: spawn failed: ${err.message}`);
      // The proxy is already bound — a leaked listener would EADDRINUSE the
      // next start attempt and serve 502s until the agent restarts.
      void this.stopCaptureProxy(setupId, record.proxyPort).then(() => {
        // Mirror the exit path: the server must learn the run failed (node
        // emits 'exit' only MAYBE alongside 'error' for a failed spawn).
        this.deps.events.onEvent(setupId, {
          runId: record.runId,
          state: "failed",
          exitCode: null,
          pid: record.pid,
          pgid: record.pgid,
          error: `spawn failed: ${err.message}`,
        });
        this.finish(setupId, null, `spawn failed: ${err.message}`);
      });
    });
    child.on("exit", async (code) => {
      if (this.stopping.has(setupId)) return; // stop() reports the outcome
      this.pushLog(setupId, `driver: start script exited with code ${code ?? "null"}`);
      // exit 0 → the script completed (blocking or daemonizing); nonzero is a
      // failure. Whether the engine is up is derived from the LLM probe.
      this.deps.events.onEvent(setupId, {
        runId: record.runId,
        state: code === 0 ? "stopped" : "failed",
        exitCode: code,
        pid: record.pid,
        pgid: record.pgid,
        error: code === 0 ? null : `start script exited with code ${code}`,
      });
      this.children.delete(setupId);
      if (code === 0) {
        // Daemonizing pattern (docker start …, setsid …): the engine outlives
        // the script. Retain the record so stop() can reach the engine and
        // the start guard refuses a double start — polls still report driver
        // truth from the record (a dead group reports stopped, and only a
        // start's own exit event may promote via the probe).
        this.persist([...this.records.values()]);
        return;
      }
      await this.stopCaptureProxy(setupId, record.proxyPort);
      this.finish(setupId, code, `start script exited with code ${code}`);
    });

    this.deps.events.onEvent(setupId, {
      runId,
      state: "running",
      exitCode: null,
      pid: record.pid,
      pgid: record.pgid,
      error: null,
    });
    return { ok: true, error: null };
  }

  /**
   * Runs the stop script, then enforces the recorded process group:
   * at `gracefulMs` the recorded group gets the TERM→KILL fallback while the
   * stop script keeps running (it may manage an external engine — killing it
   * mid-call would abort the very stop it performs). The script itself gets
   * `gracefulMs + 30 s`; a still-running script is killed and reported.
   */
  async stop(setupId: string, gracefulMs: number): Promise<{ ok: boolean; error: string | null }> {
    const record = this.records.get(setupId);
    if (!record) return { ok: false, error: "setup is not running" };
    if (this.stopping.has(setupId)) return { ok: false, error: "stop already in progress" };
    this.stopping.add(setupId);
    this.deps.events.onEvent(setupId, {
      runId: record.runId,
      state: "stopping",
      exitCode: null,
      pid: record.pid,
      pgid: record.pgid,
      error: null,
    });

    let stopError: string | null = null;
    if (isExecutable(record.scriptStop)) {
      this.pushLog(setupId, `driver: running stop script ${record.scriptStop}`);
      const { promise: scriptDone, resolve: settleScript } = Promise.withResolvers<void>();
      const exit = this.spawnStopScript(setupId, record, settleScript);

      // Fallback deadline: the recorded group must die even if the script
      // hangs or fails — TERM, then KILL after the grace.
      const fallback = setTimeout(() => {
        if (record.pgid !== null && groupAlive(record.pgid)) {
          this.pushLog(setupId, "driver: grace elapsed — killing recorded process group (SIGTERM)");
          try {
            process.kill(-record.pgid, "SIGTERM");
          } catch {}
          setTimeout(() => {
            if (record.pgid !== null && groupAlive(record.pgid)) {
              try {
                process.kill(-record.pgid, "SIGKILL");
              } catch {}
            }
          }, STOP_FALLBACK_GRACE_MS).unref();
        }
      }, gracefulMs);
      fallback.unref();

      // The script's own leash: gracefulMs for its work + 30 s slack.
      const scriptCap = setTimeout(() => {
        stopError = `stop script timed out after ${gracefulMs + 30_000} ms`;
        if (exit.pgid !== null) {
          try {
            process.kill(-exit.pgid, "SIGKILL");
          } catch {}
        }
        settleScript();
      }, gracefulMs + 30_000);
      scriptCap.unref();
      await scriptDone;
      clearTimeout(scriptCap);
      clearTimeout(fallback);
      if (exit.code !== null && exit.code !== 0 && stopError === null) {
        stopError = `stop script exited with code ${exit.code}`;
        this.pushLog(setupId, `driver: ${stopError}`);
      }
      await this.drainGroup(setupId, record.pgid);
    } else {
      stopError = `stop script is not executable: ${record.scriptStop}`;
      this.pushLog(setupId, `driver: ${stopError}`);
      await this.drainGroup(setupId, record.pgid, gracefulMs);
    }

    this.stopping.delete(setupId);
    await this.stopCaptureProxy(setupId, record.proxyPort);
    this.finish(setupId, null, stopError);
    this.deps.events.onEvent(setupId, {
      runId: record.runId,
      state: "stopped",
      exitCode: null,
      pid: record.pid,
      pgid: record.pgid,
      error: stopError,
    });
    return stopError === null ? { ok: true, error: null } : { ok: false, error: stopError };
  }

  /** Closes the capture proxy for a setup (idempotent, fail-open). */
  private async stopCaptureProxy(setupId: string, proxyPort: number | null): Promise<void> {
    if (proxyPort === null || this.deps.capture === undefined) return;
    try {
      await this.deps.capture.stop(setupId);
      this.pushLog(setupId, `driver: capture proxy closed (:${proxyPort})`);
    } catch (err) {
      this.pushLog(setupId, `driver: capture proxy stop failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Waits for the recorded group to die; TERM→KILL fallback when still alive. */
  private async drainGroup(setupId: string, pgid: number | null, graceMs = 5_000): Promise<void> {
    if (pgid === null || !groupAlive(pgid)) return;
    this.pushLog(setupId, "driver: recorded process group still alive — killing it (SIGTERM)");
    try {
      process.kill(-pgid, "SIGTERM");
    } catch {}
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && groupAlive(pgid)) {
      await new Promise((r) => setTimeout(r, 250));
    }
    if (groupAlive(pgid)) {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  /** Replies to a server status poll with the current driver truth. */
  reportStatus(setupId: string): void {
    const record = this.records.get(setupId);
    if (!record) {
      this.deps.events.onEvent(setupId, {
        runId: null,
        state: "stopped",
        exitCode: null,
        pid: null,
        pgid: null,
        error: null,
      });
      return;
    }
    const child = this.children.get(setupId);
    const alive = (child !== undefined && child.exitCode === null) || (record.pgid !== null && groupAlive(record.pgid));
    this.deps.events.onEvent(setupId, {
      runId: record.runId,
      state: alive ? "running" : "stopped",
      exitCode: null,
      pid: record.pid,
      pgid: record.pgid,
      error: null,
    });
  }

  /** Spawns the stop script (own group); logs its output; resolves on exit. */
  private spawnStopScript(
    setupId: string,
    record: DriverRecord,
    settle: () => void,
  ): { pgid: number | null; code: number | null } {
    const stop = spawn(record.scriptStop, [], {
      env: { ...process.env, ...record.env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const handle = { pgid: stop.pid ?? null, code: null as number | null };
    const onChunk = (buf: Buffer): void => {
      for (const line of buf.toString("utf8").split(/\r\n|\r|\n/)) {
        if (line.length > 0) this.pushLog(setupId, `stop: ${line}`);
      }
    };
    stop.stdout?.on("data", onChunk);
    stop.stderr?.on("data", onChunk);
    stop.on("error", (err) => {
      this.pushLog(setupId, `driver: stop script failed to run: ${err.message}`);
      handle.code = -1;
      settle();
    });
    stop.on("exit", (code) => {
      handle.code = code;
      settle();
    });
    return handle;
  }

  /** `modelctl path --local NAME` → first stdout line, resolved as the node's
   *  cache user when one is set (IR-120): the modelctl registration lives in
   *  that user's home, so a root invocation would silently miss it. */
  private resolveModelPath(name: string): Promise<{ path: string | null; error: string | null }> {
    const ctx: CacheUserCtx = {
      cacheUser: this.deps.cacheUser?.() ?? null,
      agentUser: this.deps.agentUser,
      resolveLocalUser: this.deps.resolveLocalUser,
    };
    let argv: string[];
    try {
      const built = asCacheUser(["path", "--local", name], ctx, "model-path");
      argv = built.raw === true ? built.argv : [this.deps.modelctlPath, ...built.argv];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.log?.(`modelctl path --local ${name} failed: ${message}`);
      return Promise.resolve({ path: null, error: message });
    }
    const { promise, resolve } = Promise.withResolvers<{ path: string | null; error: string | null }>();
    execFile(argv[0], argv.slice(1), { timeout: 20_000 }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr ?? "").split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? err.message;
        this.deps.log?.(`modelctl path --local ${name} failed: ${detail}`);
        resolve({ path: null, error: detail });
        return;
      }
      const line = stdout.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
      resolve({ path: line ?? null, error: line === undefined ? "no output" : null });
    });
    return promise;
  }

  private pushLog(setupId: string, line: string): void {
    const seq = this.seqs.get(setupId) ?? 0;
    const entry: RingEntry = { seq, line, ts: Date.now() };
    this.seqs.set(setupId, seq + 1);
    const ring = this.rings.get(setupId) ?? [];
    ring.push(entry);
    if (ring.length > LOG_RING_LINES) ring.splice(0, ring.length - LOG_RING_LINES);
    this.rings.set(setupId, ring);
    this.streams.get(setupId)?.write(`${line}\n`);
    this.deps.events.onLog(setupId, entry.seq, entry.line, entry.ts);
  }

  private finish(setupId: string, exitCode: number | null, error: string | null): void {
    const record = this.records.get(setupId);
    this.children.delete(setupId);
    this.streams.get(setupId)?.end();
    this.streams.delete(setupId);
    if (record) {
      this.records.delete(setupId);
      this.persist([...this.records.values()]);
    }
    void exitCode;
    void error;
  }

  private persist(records: DriverRecord[]): void {
    try {
      writeFileSync(join(this.deps.stateDir, STATE_FILE), JSON.stringify(records, null, 2));
    } catch (err) {
      this.deps.log?.(`failed to persist setup state (${err instanceof Error ? err.message : String(err)})`);
    }
  }
}
