import os from "node:os";
import { SCHEMA_VERSION } from "@irori/core";
import { BenchRunner } from "./bench/runner.js";
import { collect } from "./collector.js";
import { readClocks, setSmCap, persistClockCap, scheduleNodeShutdown, shouldPersist } from "./clocks.js";
import { mergeClocksReply, persistCpuCap, readCpuClocks, setCpuCap } from "./cpu-clocks.js";
import { readStore } from "./catalog-read.js";
import { applyDockerLogRotation, auditHygiene, cleanHygiene } from "./hygiene.js";
import { buildInventory, resolveCacheHome, resolveLocalUser } from "./inventory.js";
import { runNasDeleteApply, runNasDeleteBatch } from "./delete-preflight.js";
import { runPruneCleanupQuarantine, runQuarantinePrune, runStagingTreeAudit } from "./staging-trees.js";
import { hygieneCleanParamsSchema, recipeInstallParamsSchema, type HardwareSnapshot, type HygieneAudit } from "@irori/core";
import { JobManager, reconcileOrphanedJobs } from "./jobs.js";
import { SetupDriver, type SetupCaptureHooks } from "./setups.js";
import { MAX_USAGE_BATCH, MAX_LOG_BATCH } from "@irori/core";
import { UsageBuffer } from "./usage-buffer.js";
import { UsageSync } from "./usage-sync.js";
import { LogBuffer } from "./log-buffer.js";
import { LogSink } from "./log-sink.js";
import { CaptureProxy } from "@irori/proxy";
import { emitUsageSpan, initOtel, shutdownOtel } from "./otel.js";
import { DEFAULT_LLM_CADENCE_MS, loadConfig, type LlmTarget } from "./config.js";
import { LlmPortProbe } from "./llm-probe.js";
import { AgentTransport, type LlmRuntimeConfig } from "./transport.js";
import { selfBundleSha256Sync } from "./bundle.js";
import { AGENT_VERSION } from "./version.js";
import { log, logger } from "./logger.js";

function fail(message: string): never {
  logger.fatal(message);
  process.exit(1);
}

async function run(): Promise<void> {
  const config = loadConfig();
  // IRI-039/IR-116: env-gated OTLP export — no-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set.
  initOtel({ serviceName: "irori-agent", version: AGENT_VERSION, log });

  /** The cache owner for the agent's own modelctl registrations. */
  const agentUser = os.userInfo().username;
  log(
    `irori agent ${AGENT_VERSION} (schema v${SCHEMA_VERSION}) starting — ` +
      `server ${config.serverUrl}, cadence ${config.cadenceMs} ms` +
      (config.llmTargets.length > 0
        ? `, llm targets ${config.llmTargets.map((t) => `${t.host}:${t.port}`).join(",")}`
        : ""),
  );

  // One probe instance per host:port; surviving ports keep their detection
  // cache and counter windows across config-update rebuilds.
  const probes = new Map<string, LlmPortProbe>();
  const probeKey = (t: LlmTarget): string => `${t.host}:${t.port}`;

  function ensureProbes(targets: LlmTarget[]): void {
    const wanted = new Set(targets.map((t) => probeKey(t)));
    for (const key of [...probes.keys()]) {
      if (!wanted.has(key)) probes.delete(key);
    }
    for (const target of targets) {
      const key = probeKey(target);
      if (!probes.has(key)) {
        probes.set(key, new LlmPortProbe({ port: target.port, host: target.host }));
      }
    }
  }

  /** Server assignment, extended by IRORI_LLM_TARGETS (env host wins per port). */
  function mergeLlmConfig(server: LlmRuntimeConfig): LlmRuntimeConfig {
    const byPort = new Map<number, string>();
    for (const p of server.llmPorts) byPort.set(p.port, p.host);
    for (const t of config.llmTargets) byPort.set(t.port, t.host);
    const llmPorts = [...byPort].map(([port, host]) => ({ port, host }));
    // Server-assigned ports must instantiate probes too — a setup injects its
    // port via config-update and the node may have no IRORI_LLM_TARGETS.
    ensureProbes(llmPorts);
    const llmCadenceMs =
      server.llmCadenceMs > 0
        ? server.llmCadenceMs
        : llmPorts.length > 0
          ? DEFAULT_LLM_CADENCE_MS
          : 0;
    return {
      llmPorts,
      llmCadenceMs,
      llmDetectOnly: server.llmDetectOnly || config.llmDetectOnly,
    };
  }

  // Disk-hygiene audit cache (SPEC §11.6: cached ~5 min) — invalidated by cleans.
  let hygieneCache: { at: number; audit: HygieneAudit } | null = null;
  const HYGIENE_AUDIT_TTL_MS = 5 * 60_000;

  // M8 capture proxy hooks: one listener per running flagged setup (ADR-0008).
  const proxies = new Map<string, CaptureProxy>();
  const captureHooks: SetupCaptureHooks = {
    start: async (setupId, listenPort, targetPort, retention) => {
      await captureHooks.stop(setupId);
      const proxy = new CaptureProxy({
        listenPort,
        targetHost: "127.0.0.1",
        targetPort,
        setupId,
        retention,
        onEvent: (request) => {
          // IRI-039/IR-116: fail-open OTLP export of one GenAI span per capture.
          emitUsageSpan(request);
          try {
            buffer.add(request);
          } catch (err) {
            log(`usage buffer insert failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
          }
        },
        log: (message) => captureHooks.log(setupId, message),
      });
      await proxy.start();
      proxies.set(setupId, proxy);
    },
    stop: async (setupId) => {
      const proxy = proxies.get(setupId);
      if (proxy === undefined) return;
      proxies.delete(setupId);
      await proxy.stop();
    },
    log: (setupId, line) => driver.pushSetupLog(setupId, line),
  };

  let usageAckHandler: ((ids: string[]) => void) | null = null;
  const buffer = new UsageBuffer(config.stateDir);
  const usageSync = new UsageSync({
    buffer,
    connected: () => transport.isReady(),
    send: (events) => transport.sendUsageBatch(events),
    onAck: (handler) => {
      usageAckHandler = handler;
    },
    lastCloseCode: () => transport.lastCloseCode(),
    flushMs: config.usageFlushMs,
    batchSize: MAX_USAGE_BATCH,
    keepDays: 90,
    maxRows: config.usageMaxRows,
    log,
  });

  // IRI-078: durable log path — bounded queue → node buffer → hub `logs`.
  // Constructed before the driver (its events reference the sink).
  let logAckHandler: ((ids: string[]) => void) | null = null;
  const logBuffer = new LogBuffer(config.stateDir);
  const logSink = new LogSink({
    buffer: logBuffer,
    connected: () => transport.isReady(),
    send: (events, dropped) => transport.sendLogBatch(events, dropped),
    onAck: (handler) => {
      logAckHandler = handler;
    },
    flushMs: config.logFlushMs,
    batchSize: MAX_LOG_BATCH,
    queueMax: config.logQueueMax,
    log: (message) => logger.warn(message), // never the wrapper — no recursion
  });
  /** Agent-lifecycle lines (transport/driver chatter) also go durable. */
  const durableLog = (message: string): void => {
    log(message);
    logSink.emit({ scope: "agent", source: "system", line: message });
  };

  // IR-213: latest store free bytes from the agent's own telemetry (updated on
  // every snapshot; null until the nasRoot mount appears in one).
  let storeFreeBytesCache: number | null = null;
  const noteStoreFree = (snapshot: HardwareSnapshot, nasRoot: string | null): void => {
    if (nasRoot === null) return;
    const entry = snapshot.storage.find((s) => s.mount === nasRoot);
    if (entry !== undefined) storeFreeBytesCache = entry.totalBytes - entry.usedBytes;
  };

  const jobs: JobManager = new JobManager(
    () => ({
      nasRoot: transport.getNasRoot(),
      cacheUser: transport.getCacheUser(),
      pin: transport.getModelctlPin() ?? config.modelctlPin,
      modelctlPath: config.modelctlPath,
      hfToken: transport.getHfToken() ?? config.hfToken,
      serverUrl: config.serverUrl,
      stateDir: config.stateDir,
      agentUser,
      storeFreeBytes: () => storeFreeBytesCache,
      minStoreFreeBytes: config.minStoreFreeBytes,
      unscoopedRunningSetups: () => driver.unscoopedRunningSetups(),
      resolveLocalUser: (user) => resolveLocalUser(user, { agentUser, modelctlPath: config.modelctlPath }),
      // IR-247: separates "no passwd entry" from "no per-user modelctl" in
      // the per-user job error wording.
      resolveCacheHome: (user) => resolveCacheHome(user, { agentUser }),
    }),
    {
      onOutput: (jobId, seq, line) => {
        transport.sendAgentServer({ type: "job-output", jobId, seq, line });
        // IRI-078: job output also persists (was a 400-line ring only).
        logSink.emit({ scope: "job", jobId, source: "system", seq, line });
      },
      onDone: (jobId, status, exitCode) => {
        log(`job ${jobId} done: ${status} (exit ${exitCode})`);
        transport.sendAgentServer({ type: "job-done", jobId, status, exitCode });
      },
    },
    async (jobId, kind, params, emit, signal) => {
      void jobId;
      const hygieneCtx = { nasRoot: transport.getNasRoot(), modelctlPath: config.modelctlPath };
      if (kind === "models-inventory") {
        const report = await buildInventory({
          nasRoot: transport.getNasRoot(),
          modelctlPath: config.modelctlPath,
          agentUser,
          scriptPaths: Array.isArray(params.scriptPaths) ? (params.scriptPaths as unknown[]).filter((p): p is string => typeof p === "string") : [],
        });
        emit(JSON.stringify(report));
        return { ok: true };
      }
      if (kind === "recipe-install") {
        // IRI-082: stage the recipe's scripts onto the node (AGPL hygiene —
        // fetched from the pinned URL hub-side, checksum-verified here, never
        // vendored into the bundle).
        const parsed = recipeInstallParamsSchema.safeParse(params);
        if (!parsed.success) return { ok: false, error: "invalid recipe-install params" };
        const { dir, files } = parsed.data;
        const { mkdir, writeFile, chmod } = await import("node:fs/promises");
        const { createHash } = await import("node:crypto");
        await mkdir(dir, { recursive: true });
        for (const f of files) {
          const digest = createHash("sha256").update(f.content).digest("hex");
          if (digest !== f.sha256) return { ok: false, error: `checksum mismatch for ${f.rel}` };
          const path = `${dir}/${f.rel}`;
          await writeFile(path, f.content, { mode: 0o755 });
          await chmod(path, 0o755);
          emit(JSON.stringify({ staged: path, sha256: digest }));
        }
        emit(JSON.stringify({ paths: files.map((f) => `${dir}/${f.rel}`) }));
        return { ok: true };
      }
      if (kind === "nas-delete-apply" || kind === "nas-delete-batch") {
        // Dry-run plan → writability probe → apply (IRI-028): a denied object
        // tree fails before the model is deactivated. The batch (IR-208) runs
        // the same sequence per name; one failed model never stops the batch.
        const deleteCtx = {
          nasRoot: transport.getNasRoot(),
          pin: transport.getModelctlPin() ?? config.modelctlPin,
          modelctlPath: config.modelctlPath,
          hfToken: transport.getHfToken() ?? config.hfToken,
          agentUser,
        };
        return kind === "nas-delete-apply"
          ? runNasDeleteApply(params, deleteCtx, emit, signal)
          : runNasDeleteBatch(params, deleteCtx, emit, signal);
      }
      if (kind === "staging-tree-audit") {
        // IR-211: read-only walk of the store's .staging incl. hidden
        // quarantine trees — staging-audit cannot see dot-dirs.
        return runStagingTreeAudit(
          params,
          {
            nasRoot: transport.getNasRoot(),
            pin: transport.getModelctlPin() ?? config.modelctlPin,
            modelctlPath: config.modelctlPath,
            hfToken: transport.getHfToken() ?? config.hfToken,
            agentUser,
          },
          emit,
          signal,
        );
      }
      if (kind === "quarantine-prune") {
        // IR-211: armed prune per model NAME via modelctl cleanup-quarantine
        // (validates the repaired reference before deleting).
        return runQuarantinePrune(
          params,
          {
            nasRoot: transport.getNasRoot(),
            pin: transport.getModelctlPin() ?? config.modelctlPin,
            modelctlPath: config.modelctlPath,
            hfToken: transport.getHfToken() ?? config.hfToken,
            agentUser,
          },
          emit,
          signal,
        );
      }
      if (kind === "prune-cleanup-quarantine") {
        // IR-207: dry-run / armed removal of the .staging/.cleanup-quarantine
        // debris an interrupted cleanup-staging --apply leaves behind
        // (modelctl 0.24.0; confirm:"prune" arms it, quarantine-prune rule).
        return runPruneCleanupQuarantine(
          params,
          {
            nasRoot: transport.getNasRoot(),
            pin: transport.getModelctlPin() ?? config.modelctlPin,
            modelctlPath: config.modelctlPath,
            hfToken: transport.getHfToken() ?? config.hfToken,
            agentUser,
          },
          emit,
          signal,
        );
      }
      if (kind === "hygiene-prevent") {
        const result = await applyDockerLogRotation(emit);
        return { ok: result.error === null };
      }
      if (kind === "hygiene-audit") {
        if (hygieneCache !== null && Date.now() - hygieneCache.at < HYGIENE_AUDIT_TTL_MS) {
          emit(JSON.stringify(hygieneCache.audit));
          return { ok: true };
        }
        const audit = await auditHygiene(hygieneCtx);
        hygieneCache = { at: Date.now(), audit };
        emit(JSON.stringify(audit));
        return { ok: true };
      }
      const parsed = hygieneCleanParamsSchema.parse(params);
      const result = await cleanHygiene(parsed, hygieneCtx, emit, signal);
      hygieneCache = null; // a clean invalidates the cached audit
      emit(JSON.stringify(result));
      return { ok: result.outcomes.every((o) => o.status !== "failed") };
    },
  );

  const driver: SetupDriver = new SetupDriver({
    stateDir: config.stateDir,
    modelctlPath: config.modelctlPath,
    cacheUser: () => transport.getCacheUser(),
    agentUser,
    resolveLocalUser: (user) => resolveLocalUser(user, { agentUser, modelctlPath: config.modelctlPath }),
    resolveCacheHome: (user) => resolveCacheHome(user, { agentUser }),
    events: {
      onEvent: (setupId, event) => transport.sendAgentMsg({ type: "setup-event", setupId, ...event }),
      onLog: (setupId, seq, line, ts) => transport.sendAgentMsg({ type: "setup-log", setupId, seq, line, ts }),
      onDurableLog: (setupId, entry) =>
        logSink.emit({
          scope: "setup",
          setupId,
          runId: entry.runId,
          source: entry.source,
          seq: entry.seq,
          line: entry.line,
        }),
    },
    capture: captureHooks,
    // Agent chatter (open failures, watchdog notes) is operator-relevant
    // after a restart — durable, not just stdout.
    log: durableLog,
  });

  const benches = new BenchRunner(
    {
      onProgress: (runId, progress) => transport.sendAgentServer({ type: "bench-progress", runId, progress }),
      onDone: (runId, status, result, error) => {
        log(`bench ${runId} done: ${status}${error ? ` (${error})` : ""}`);
        transport.sendAgentServer({
          type: "bench-done",
          runId,
          status,
          error,
          ...(status === "completed" && result !== null ? { result } : {}),
        });
      },
    },
    log,
  );

  const transport = new AgentTransport({
    token: config.token,
    hostname: os.hostname(),
    agentVersion: AGENT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    // IR-260: self-report the running bundle; null on dev runs from sources.
    bundleSha256: selfBundleSha256Sync(),
    cadenceMs: config.cadenceMs,
    collect: async () => {
      const snapshot = await collect();
      noteStoreFree(snapshot, transport?.getNasRoot() ?? null);
      return snapshot;
    },
    collectLlm: async (detectOnly) =>
      Promise.all([...probes.values()].map((probe) => probe.probe(detectOnly))),
    onLlmConfig: mergeLlmConfig,
    onJobRequest: (jobId, kind, params) => {
      if (!jobs.start(jobId, kind, params)) {
        transport.sendAgentServer({
          type: "job-output",
          jobId,
          seq: 0,
          line: "error: another job is active on this node",
        });
        transport.sendAgentServer({ type: "job-done", jobId, status: "failed", exitCode: null });
      }
    },
    onJobCancel: (jobId) => {
      // IR-131: ack only when the kill signal was actually issued — the hub
      // settles the row canceled on this, or on the eventual job-done.
      if (jobs.cancel(jobId)) transport.sendAgentServer({ type: "job-cancel-ack", jobId });
    },
    onBenchRun: (runId, bench, cfg) => {
      if (!benches.start({ runId, bench, config: cfg })) {
        transport.sendAgentServer({ type: "bench-done", runId, status: "failed", error: "another benchmark is active on this node" });
      }
    },
    onBenchCancel: (runId) => benches.cancel(runId),
    onSetupStart: (setupId, runId, scriptStart, scriptStop, env, modelPathName, capture) =>
      driver.start(setupId, runId, scriptStart, scriptStop, env, modelPathName, capture),
    onSetupStop: (setupId, gracefulMs) => driver.stop(setupId, gracefulMs),
    onSetupStatus: (setupId) => driver.reportStatus(setupId),
    onSetupLogAttach: (setupId, lastSeq) => {
      for (const entry of driver.ring(setupId)) {
        if (entry.seq > lastSeq) {
          transport.sendAgentMsg({ type: "setup-log", setupId, seq: entry.seq, line: entry.line, ts: entry.ts });
        }
      }
    },
    onSetupValidate: (validateId, scripts) => {
      transport.sendAgentServer({ type: "setup-validate-result", validateId, results: driver.validate(scripts) });
    },
    onClocksGet: (id) => {
      // IRI-124: GPU and CPU are read independently — a node with no cpufreq
      // policies still reports its cards (cpu: null), and a failed GPU query
      // (e.g. a NAS or gpu-host without nvidia-smi) must not hide usable CPU
      // clock state, so the frame is ok when either half produced a reading.
      void Promise.all([readClocks(), readCpuClocks()])
        .then(([gpu, cpu]) =>
          transport.sendAgentServer({ type: "clocks-get-result", id, ...mergeClocksReply(gpu, cpu) }),
        )
        .catch((err: unknown) =>
          transport.sendAgentServer({ type: "clocks-get-result", id, ok: false, gpus: [], cpu: null, error: err instanceof Error ? err.message : String(err) }),
        );
    },
    onClocksSet: (id, caps, persist) => {
      void (async () => {
        const errors: string[] = [];
        // IRI-068/IRI-124 persistence rules, per side:
        //  - a FAILED live apply never touches the boot unit (removing it would
        //    leave a live cap nothing re-applies after a reboot);
        //  - a CLEAR always removes the unit, even without `persist` — "cleared
        //    live, re-applied at boot" has no coherent meaning and was how a
        //    cleared cap resurrected itself;
        //  - a successful cap is installed only when `persist` is set.
        if (caps.smMaxMHz !== undefined) {
          const apply = await setSmCap(caps.smMaxMHz);
          if (!apply.ok) errors.push(`gpu: ${apply.error ?? "unknown error"}`);
          else if (shouldPersist(caps.smMaxMHz, persist, apply.ok)) {
            const persisted = await persistClockCap(caps.smMaxMHz);
            if (!persisted.ok) errors.push(`gpu persist: ${persisted.error ?? "unknown error"}`);
          }
        }
        if (caps.cpuMaxMHz !== undefined) {
          const apply = await setCpuCap(caps.cpuMaxMHz);
          if (!apply.ok) errors.push(`cpu: ${apply.error ?? "unknown error"}`);
          else if (shouldPersist(caps.cpuMaxMHz, persist, apply.ok)) {
            const persisted = await persistCpuCap(caps.cpuMaxMHz);
            if (!persisted.ok) errors.push(`cpu persist: ${persisted.error ?? "unknown error"}`);
          }
        }
        transport.sendAgentServer({
          type: "clocks-set-result",
          id,
          ok: errors.length === 0,
          error: errors.length === 0 ? null : errors.join("; "),
        });
      })().catch((err: unknown) =>
        transport.sendAgentServer({ type: "clocks-set-result", id, ok: false, error: err instanceof Error ? err.message : String(err) }),
      );
    },
    onNodeShutdown: (id, graceS, origin) => {
      scheduleNodeShutdown(graceS, origin, (line) => log(line));
      transport.sendAgentServer({ type: "node-shutdown-ack", id, ok: true, error: null });
    },
    onCatalogRequest: () => {
      const root = transport.getNasRoot();
      if (!root) {
        log("catalog-request ignored: node has no nasRoot");
        return;
      }
      void (async () => {
        try {
          const read = await readStore(root);
          transport.sendAgentServer({ type: "catalog", source: read.source, entries: read.entries });
          if (read.warning) log(`catalog: ${read.warning}`);
          log(`catalog: ${read.entries.length} models (${read.source})`);
        } catch (err) {
          log(`catalog read failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    },
    llm: {
      llmPorts: config.llmTargets.map((t) => ({ port: t.port, host: t.host })),
      llmCadenceMs: config.llmTargets.length > 0 ? DEFAULT_LLM_CADENCE_MS : 0,
      llmDetectOnly: config.llmDetectOnly,
    },
    onUsageAck: (ids) => usageAckHandler?.(ids),
    onLogAck: (ids) => logAckHandler?.(ids),
    onReconnect: () => {
      void usageSync.flush();
      void logSink.flush();
    },
    getActiveJobIds: () => jobs.activeJobs(),
    getScopeIsolation: () => driver.hostSupportsScopes(),
    // Transport chatter (handshakes, dropped frames, reconnects) explains
    // node flapping after the fact — durable alongside the setups (IRI-078).
    log: durableLog,
  });
  // Persisted-driver re-attach runs only after `transport` exists: init
  // re-announces live records through the event callbacks, which close over
  // it — invoked earlier they hit the TDZ and crash-looped dgx3 (IR-125).
  // Awaited so scope adoption (ADR-0017) settles before the first hello.
  await driver.init();
  ensureProbes(config.llmTargets);
  // IR-131: kill orphans left by a previous process BEFORE the first hello —
  // the job-done frames buffer offline and replay on hello-ok.
  await reconcileOrphanedJobs(config.stateDir, {
    onOutput: (jobId, seq, line) => {
      transport.sendAgentServer({ type: "job-output", jobId, seq, line });
      logSink.emit({ scope: "job", jobId, source: "system", seq, line });
    },
    onDone: (jobId) => transport.sendAgentServer({ type: "job-done", jobId, status: "failed", exitCode: null }),
  });
  transport.connect(config.serverUrl);
  usageSync.start();
  logSink.start();

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    durableLog(`${signal} received, stopping`);
    usageSync.stop();
    buffer.close();
    logSink.stop();
    // IRI-039/IR-116: flush the last batching window before exit.
    void shutdownOtel();
    // Best-effort tail ship, BOUNDED at 5 s so a huge backlog can never stall
    // the stop past systemd's patience. Anything unsent stays durable in the
    // node buffer and replays on the next hello (hub dedupes by eventId).
    const ship = Promise.race([logSink.flush().catch(() => {}), new Promise<void>((r) => setTimeout(r, 5_000).unref())]);
    void ship.finally(() => {
      try {
        logBuffer.close();
      } catch {
        /* already closed */
      }
      void transport.stop().then(() => process.exit(0));
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

try {
  await run();
} catch (err) {
  fail(`fatal: ${err instanceof Error ? err.message : String(err)}`);
}
