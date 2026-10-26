import os from "node:os";
import { SCHEMA_VERSION } from "@irori/core";
import { BenchRunner } from "./bench/runner.js";
import { collect } from "./collector.js";
import { readStore } from "./catalog-read.js";
import { applyDockerLogRotation, auditHygiene, cleanHygiene } from "./hygiene.js";
import { buildInventory, resolveLocalUser } from "./inventory.js";
import { runNasDeleteApply } from "./delete-preflight.js";
import { hygieneCleanParamsSchema, type HygieneAudit } from "@irori/core";
import { JobManager } from "./jobs.js";
import { SetupDriver, type SetupCaptureHooks } from "./setups.js";
import { MAX_USAGE_BATCH } from "@irori/core";
import { UsageBuffer } from "./usage-buffer.js";
import { UsageSync } from "./usage-sync.js";
import { CaptureProxy } from "@irori/proxy";
import { DEFAULT_LLM_CADENCE_MS, loadConfig, type LlmTarget } from "./config.js";
import { LlmPortProbe } from "./llm-probe.js";
import { AgentTransport, type LlmRuntimeConfig } from "./transport.js";
import { AGENT_VERSION } from "./version.js";

function log(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

function fail(message: string): never {
  console.error(`${new Date().toISOString()} ${message}`);
  process.exit(1);
}

async function run(): Promise<void> {
  const config = loadConfig();
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
    flushMs: config.usageFlushMs,
    batchSize: MAX_USAGE_BATCH,
    keepDays: 90,
    maxRows: config.usageMaxRows,
    log,
  });

  const jobs = new JobManager(
    () => ({
      nasRoot: transport.getNasRoot(),
      cacheUser: transport.getCacheUser(),
      pin: config.modelctlPin,
      modelctlPath: config.modelctlPath,
      hfToken: transport.getHfToken() ?? config.hfToken,
      serverUrl: config.serverUrl,
      agentUser,
      resolveLocalUser: (user) => resolveLocalUser(user, { agentUser, modelctlPath: config.modelctlPath }),
    }),
    {
      onOutput: (jobId, seq, line) => transport.sendAgentServer({ type: "job-output", jobId, seq, line }),
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
        });
        emit(JSON.stringify(report));
        return { ok: true };
      }
      if (kind === "nas-delete-apply") {
        // Dry-run plan → writability probe → apply (IRI-028): a denied object
        // tree fails before the model is deactivated.
        return runNasDeleteApply(
          params,
          {
            nasRoot: transport.getNasRoot(),
            pin: config.modelctlPin,
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

  const driver = new SetupDriver({
    stateDir: config.stateDir,
    modelctlPath: config.modelctlPath,
    events: {
      onEvent: (setupId, event) => transport.sendAgentMsg({ type: "setup-event", setupId, ...event }),
      onLog: (setupId, seq, line, ts) => transport.sendAgentMsg({ type: "setup-log", setupId, seq, line, ts }),
    },
    capture: captureHooks,
    log,
  });
  driver.init();

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
    cadenceMs: config.cadenceMs,
    collect,
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
    onJobCancel: (jobId) => jobs.cancel(jobId),
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
    onReconnect: () => void usageSync.flush(),
    log,
  });
  ensureProbes(config.llmTargets);
  transport.connect(config.serverUrl);
  usageSync.start();

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log(`${signal} received, stopping`);
    usageSync.stop();
    buffer.close();
    void transport.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

try {
  await run();
} catch (err) {
  fail(`fatal: ${err instanceof Error ? err.message : String(err)}`);
}
