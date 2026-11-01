import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { accessSync, appendFileSync, constants, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync, openSync, closeSync, readSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { BodyRetention } from "@irori/core";
import { asCacheUser, CommandBuildError, type CacheUserCtx } from "./modelctl.js";
import { runuserWrap } from "./cache-user.js";

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
  /** IRI-045: resolves a cache owner's passwd home (no modelctl needed);
   *  null = unknown user. Serve execution must never silently fall back to
   *  root when a cache user is configured. */
  resolveCacheHome?: (user: string) => string | null;
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

/** Size of the run log, 0 when it does not exist yet (append-only file). */
function fileSizeOrZero(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

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
  /** IRI-045: the cache user the start script runs as + its passwd home
   *  (null = agent user). Persisted so a stop after an agent restart keeps
   *  the run's execution context, even if the node setting changes mid-run. */
  runUser: string | null;
  runHome: string | null;
  /** IR-149: next ring seq, persisted at every state write so seqs stay
   *  monotonic across agent restarts (the ServeView panel keys by seq). */
  nextSeq: number;
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

/** systemd's default PATH — the fallback when the agent env has none. */
const SYSTEMD_DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** A cache user's serve execution context (IRI-045). */
export interface ServeWrap {
  user: string;
  home: string;
}

/**
 * Pure: spawn argv for a serve start/stop script. With a cache user the
 * ADR-0011 runuser shape applies — scrubbed HF/XDG env, the owner's HOME —
 * plus USER/LOGNAME (the agent unit's env has neither; `set -u` scripts
 * dereference them) and the ambient PATH (an engine needs more than
 * modelctl's 4-dir PATH). Without a wrap the script runs as the agent user
 * and the HOME fallback is injected at the env level instead.
 */
export function serveSpawnArgv(script: string, wrap: ServeWrap | null, ambientPath: string | undefined): string[] {
  if (wrap === null) return [script];
  return runuserWrap(wrap.user, wrap.home, {
    PATH: ambientPath ?? SYSTEMD_DEFAULT_PATH,
    USER: wrap.user,
    LOGNAME: wrap.user,
  }, [script]);
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
  private readonly rings = new Map<string, RingEntry[]>();
  private readonly seqs = new Map<string, number>();
  private readonly tailers = new Map<string, { timer: NodeJS.Timeout; offset: number; carry: string }>();
  /** IR-149/150 fix: setup ids with a tailer drain in flight (guards the
   *  self-append offset bump against a concurrent read). */
  private readonly draining = new Set<string>();
  /** IR-149/150 fix: run-log path per setup, registered in start() BEFORE the
   *  record exists so early driver markers are written durably. */
  private readonly logPaths = new Map<string, string>();
  private readonly stopping = new Set<string>();

  constructor(private readonly deps: SetupDriverDeps) {}

  /** Run-log dir, created lazily so a start before init() still lands durably. */
  private mkLogDir(): void {
    try {
      mkdirSync(join(this.deps.stateDir, LOG_DIR), { recursive: true });
    } catch {
      /* append falls back to ring-only */
    }
  }

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
        // Re-attached: the engine survived the agent restart. Its stdout/stderr
        // ride an inherited fd straight into record.logPath (IR-149), so the
        // file kept growing while the agent was gone — resume capture by
        // tailing it from EOF and seed the seq counter monotonically.
        this.records.set(record.setupId, record);
        this.seqs.set(record.setupId, this.seedSeq(record));
        this.startTailer(record.setupId, record.logPath, "eof");
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
    // IR-150: every launch attempt and its outcome enter the log ring (and
    // from there the shared feed) — a plain start used to be silent until the
    // engine printed, and pre-spawn failures left only a bare failed
    // setup-state transition with no reason. The run-log path is registered
    // before the first marker so those early lines also reach the durable
    // file (review fix: the ring alone is not what an operator tails).
    this.mkLogDir();
    this.logPaths.set(setupId, join(this.deps.stateDir, LOG_DIR, `${setupId}-${runId}.log`));
    this.pushLog(setupId, `driver: starting ${scriptStart}`);
    const startFailed = (error: string): { ok: false; error: string } => {
      this.pushLog(setupId, `driver: start failed: ${error}`);
      return { ok: false, error };
    };
    if (!isExecutable(scriptStart)) {
      return startFailed(`start script is not executable: ${scriptStart} (test -x failed)`);
    }
    if (scriptStop.length === 0) {
      return startFailed("a stop script is required — launch refused");
    }
    if (!isExecutable(scriptStop)) {
      return startFailed(`stop script is not executable: ${scriptStop} (test -x failed)`);
    }

    // IRI-045: resolve the serve execution context before anything binds —
    // a configured-but-unresolvable cache user refuses the start instead of
    // silently running root (the ADR-0011 rule).
    let wrap: ServeWrap | null = null;
    try {
      wrap = this.resolveServeWrap();
    } catch (err) {
      return startFailed(err instanceof Error ? err.message : String(err));
    }

    const finalEnv = { ...env };
    if (modelPathName !== null) {
      const resolved = await this.resolveModelPath(modelPathName);
      if (resolved.path === null) {
        return startFailed(
          `MODEL_PATH resolution failed for ${modelPathName} (modelctl path --local)${resolved.error === null ? "" : `: ${resolved.error}`}`,
        );
      }
      finalEnv.MODEL_PATH = resolved.path;
    }

    // Capture mode: bind the proxy BEFORE spawn; the engine gets a fresh
    // loopback port via $PORT (the documented contract for flagged setups).
    let enginePort: number | null = null;
    if (capture !== null) {
      if (this.deps.capture === undefined) {
        return startFailed("capture requested but this agent has no capture proxy support");
      }
      enginePort = await pickFreeLoopbackPort();
      try {
        await this.deps.capture.start(setupId, capture.proxyPort, enginePort, capture.retention ?? null);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return startFailed(`capture proxy bind failed on :${capture.proxyPort} — ${message}`);
      }
      finalEnv.PORT = String(enginePort);
    }

    // HOME fallback for the unwrapped case: the agent's systemd unit is
    // HOME-less (systemd sets no HOME for system services), so `set -u`
    // start/stop scripts dereferencing $HOME die unbound. Default to the
    // agent user's passwd home; the wrapped case gets its HOME from the
    // runuser argv instead.
    if (wrap === null && finalEnv.HOME === undefined && process.env.HOME === undefined) {
      finalEnv.HOME = homedir();
    }

    const logPath = this.logPaths.get(setupId) ?? join(this.deps.stateDir, LOG_DIR, `${setupId}-${runId}.log`);
    const argv = serveSpawnArgv(scriptStart, wrap, process.env.PATH);
    // IR-149: the engine writes stdout/stderr straight into the run log
    // through an inherited fd, so output keeps flowing while the agent is
    // down and init() resumes tailing the file after a restart. If the fd
    // cannot be opened (broken state dir), fall back to pipe capture.
    let logFd: number | null = null;
    try {
      logFd = openSync(logPath, "a");
    } catch (err) {
      this.deps.log?.(`setup log open failed (${err instanceof Error ? err.message : String(err)})`);
    }
    // Everything in the file so far is the driver's own pre-spawn markers.
    // Tail from here (never from 0) so the tailer cannot re-emit them as
    // engine lines; measured BEFORE spawn so no engine byte is skipped.
    const tailFrom = logFd === null ? 0 : fileSizeOrZero(logPath);
    const child = spawn(argv[0]!, argv.slice(1), {
      detached: true,
      stdio: logFd !== null ? ["ignore", logFd, logFd] : ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...finalEnv },
    });
    if (logFd !== null) closeSync(logFd); // the child holds its own copy
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
      runUser: wrap?.user ?? null,
      runHome: wrap?.home ?? null,
      nextSeq: 0,
    };
    this.records.set(setupId, record);
    this.children.set(setupId, child);
    this.seqs.set(setupId, 0);
    this.persist([...this.records.values()]);
    if (logFd !== null) {
      // Engine output reaches the file through its own fd — tail it into the
      // ring + setup-log frames (IR-149) from the marker boundary.
      this.startTailer(setupId, logPath, tailFrom);
    }
    if (wrap !== null) {
      this.pushLog(setupId, `driver: serving as cache user ${wrap.user} (HOME=${wrap.home})`);
    }
    if (capture !== null) {
      this.pushLog(setupId, `driver: capture proxy :${capture.proxyPort} → 127.0.0.1:${enginePort} (requests captured, engine on loopback)`);
    }

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
    // The stop script runs in the run's execution context (IRI-045): the
    // persisted run user, even if the node's cache user changed mid-run —
    // the script must reach an engine owned by the user that started it.
    // typeof checks, not !== null: records persisted before IRI-045 lack the
    // fields entirely.
    const wrap =
      typeof record.runUser === "string" && typeof record.runHome === "string"
        ? { user: record.runUser, home: record.runHome }
        : null;
    const argv = serveSpawnArgv(record.scriptStop, wrap, process.env.PATH);
    const env = { ...process.env, ...record.env };
    // Pre-IRI-045 records carry no HOME; the HOME-less agent unit would break
    // `set -u` stop scripts the same way the start did.
    if (wrap === null && env.HOME === undefined) env.HOME = homedir();
    const stop = spawn(argv[0]!, argv.slice(1), {
      env,
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

  /** IRI-045: the node's cache user (≠ agent user) → its passwd home; null =
   *  run as the agent user. Throws CommandBuildError when the user has no
   *  passwd entry — never a silent root fallback (the ADR-0011 rule). Serve
   *  needs no per-user modelctl, so resolution is passwd-only. */
  private resolveServeWrap(): ServeWrap | null {
    const user = (this.deps.cacheUser?.() ?? "").trim() || null;
    if (user === null || user === (this.deps.agentUser ?? "root")) return null;
    const home = this.deps.resolveCacheHome?.(user) ?? null;
    if (home === null) {
      throw new CommandBuildError(
        `serve start: no passwd entry for cache user "${user}" — create that user on this node or clear the node's cache user setting`,
      );
    }
    return { user, home };
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
    execFile(argv[0]!, argv.slice(1), { timeout: 20_000 }, (err, stdout, stderr) => {
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

  private pushLog(setupId: string, line: string, opts?: { durable?: boolean }): void {
    const seq = this.seqs.get(setupId) ?? 0;
    const entry: RingEntry = { seq, line, ts: Date.now() };
    this.seqs.set(setupId, seq + 1);
    const ring = this.rings.get(setupId) ?? [];
    ring.push(entry);
    if (ring.length > LOG_RING_LINES) ring.splice(0, ring.length - LOG_RING_LINES);
    this.rings.set(setupId, ring);
    // IR-149/150 fix: the engine writes its own stdout/stderr into the run log
    // through the inherited fd, so pushLog no longer mirrors lines to the file
    // — driver and stop-script markers were hub/ring-only, and the durable log
    // an operator tails on the node lost exactly the lines explaining a start
    // attempt. Mirror them here (tailer-sourced engine lines are already in
    // the file: durable:false). Appending moves the tailer's read offset past
    // our own bytes so the file is never re-emitted as a duplicate; when a
    // drain is mid-flight the offset is left alone (a duplicate, never a skip).
    if (opts?.durable !== false) {
      const path = this.records.get(setupId)?.logPath ?? this.logPaths.get(setupId);
      if (path !== undefined) {
        const buf = Buffer.from(`${line}\n`);
        try {
          appendFileSync(path, buf);
          const tailer = this.tailers.get(setupId);
          if (tailer !== undefined && !this.draining.has(setupId)) tailer.offset += buf.length;
        } catch {
          /* state dir unwritable — the ring/feed still carries the line */
        }
      }
    }
    this.deps.events.onLog(setupId, entry.seq, entry.line, entry.ts);
  }

  private finish(setupId: string, exitCode: number | null, error: string | null): void {
    const record = this.records.get(setupId);
    this.children.delete(setupId);
    this.drainTailer(setupId);
    this.stopTailer(setupId);
    // logPaths keeps this run's file so late markers (stop script outcome,
    // capture-proxy close) still land durably; start() overwrites it per run.
    if (record) {
      this.records.delete(setupId);
      this.persist([...this.records.values()]);
    }
    void exitCode;
    void error;
  }

  private persist(records: DriverRecord[]): void {
    // Stamp the live seq counter onto each surviving record (IR-149) so a
    // re-attach resumes numbering where this process left off.
    for (const record of records) {
      const live = this.seqs.get(record.setupId);
      if (live !== undefined) record.nextSeq = live;
    }
    try {
      writeFileSync(join(this.deps.stateDir, STATE_FILE), JSON.stringify(records, null, 2));
    } catch (err) {
      this.deps.log?.(`failed to persist setup state (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  /** IR-149: seed the seq counter for a re-attached run. Pre-IR-149 records
   *  lack nextSeq — fall back to 0 (their lines are gone from the ring too). */
  private seedSeq(record: DriverRecord): number {
    return typeof record.nextSeq === "number" && Number.isFinite(record.nextSeq) ? record.nextSeq : 0;
  }

  /**
   * Starts tailing the run log into the ring + setup-log frames. `from` = 0
   * for a fresh run (the file was just opened), "eof" for a re-attach (the
   * backlog written while the agent was down stays in the durable file; the
   * live view joins from now, per IR-149).
   */
  private startTailer(setupId: string, logPath: string, from: number | "eof"): void {
    this.stopTailer(setupId);
    let offset = 0;
    if (from === "eof") {
      offset = fileSizeOrZero(logPath); // no file yet — the engine wrote nothing
    } else {
      offset = from;
    }
    const tailer = { timer: setInterval(() => this.drainTailer(setupId), 250), offset, carry: "" };
    tailer.timer.unref();
    this.tailers.set(setupId, tailer);
  }

  /** Reads whatever the engine appended since the last drain; emits lines. */
  private drainTailer(setupId: string): void {
    const tailer = this.tailers.get(setupId);
    const record = this.records.get(setupId);
    if (tailer === undefined || record === undefined) return;
    let fd: number | null = null;
    this.draining.add(setupId); // a pushLog append must not bump the offset mid-read
    try {
      fd = openSync(record.logPath, "r");
      const size = statSync(record.logPath).size;
      if (size < tailer.offset) tailer.offset = 0; // truncated/rotated
      if (size === tailer.offset) return;
      const chunk = Buffer.alloc(Math.min(size - tailer.offset, 256 * 1024));
      let emitted = false;
      for (;;) {
        const read = readSync(fd, chunk, 0, chunk.length, tailer.offset);
        if (read === 0) break;
        tailer.offset += read;
        const text = tailer.carry + chunk.toString("utf8", 0, read);
        const parts = text.split(/\r\n|\r|\n/);
        tailer.carry = parts.pop() ?? "";
        for (const line of parts) {
          if (line.length > 0) {
            // Already in the durable file — don't mirror it back (durable:false).
            this.pushLog(setupId, line, { durable: false });
            emitted = true;
          }
        }
        if (read < chunk.length) break;
      }
      if (emitted) this.persist([...this.records.values()]); // keep nextSeq fresh
    } catch {
      // File missing or unreadable — keep the timer; a slow filesystem or a
      // pruned file must not kill the tail (finish() clears it at run end).
    } finally {
      this.draining.delete(setupId);
      if (fd !== null) closeSync(fd);
    }
  }

  private stopTailer(setupId: string): void {
    const tailer = this.tailers.get(setupId);
    if (tailer === undefined) return;
    clearInterval(tailer.timer);
    this.tailers.delete(setupId);
  }
}
