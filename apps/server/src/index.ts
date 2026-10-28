import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDbHandle, createNodeStore, type Db, type DbHandle, type NodeStore } from "@irori/db";
import { loadConfig, type Config } from "./config.js";
import { createRings } from "./rings.js";
import { createSseHub } from "./sse.js";
import { createEventFeed } from "./events-feed.js";
import { createAgentHub, type AgentHub } from "./hub.js";
import { createJobsService, type JobSettledEvent, type JobsService, type PushBlockedEvent } from "./jobs-service.js";
import { createDownloadQueueService, type DownloadQueueService } from "./download-queue-service.js";
import { createHfQuantsService } from "./hf-quants.js";
import { createHfTokenService, type HfTokenService } from "./hf-token.js";
import { createCadenceService, type CadenceService } from "./cadence.js";
import { createCostService, type CostService } from "./cost.js";
import { createModelctlPinService, type ModelctlPinService } from "./modelctl-pin.js";
import { CADENCE_MAX_MS, CADENCE_MIN_MS } from "@irori/core";
import { createRollupEngine, type RollupEngine } from "./rollups.js";
import { createLlmRollupEngine } from "./llm-rollups.js";
import { createLlmStore, type LlmStore } from "./llm-store.js";
import { runRetention, runLlmRetention, runUsageRetention } from "./retention.js";
import { createUsageStore, type UsageStore } from "./usage-store.js";
import { createUsageClients, type UsageClients } from "./usage-clients.js";
import { createUsageChats, type UsageChats } from "./usage-chats.js";
import { createUsageRollupEngine } from "./usage-rollups.js";
import { buildHistory } from "./history.js";
import { buildLlmHistory } from "./llm-history.js";
import { createApp, type HistoryBuilder, type LlmHistoryBuilder } from "./app.js";
import { createSetupsService, type SetupsService } from "./setups-service.js";
import { createBenchService, type BenchService } from "./bench-service.js";
import { createAnalyticsService, type AnalyticsService } from "./analytics.js";
import { createTokenMacroService, type TokenMacroService } from "./tokens-macro.js";
import { createCleanupService, weeklySafePassParams, type CleanupService } from "./cleanup-service.js";
import { createInventoryService, type InventoryService } from "./inventory-service.js";
import { createTokenLedgerEngine, pruneTokenLedger } from "./ledger.js";
import { type CleanupEntry } from "./cleanup-service.js";
import { createEnergyEngine } from "./energy.js";
import { JobBusyError, JobDispatchError } from "./jobs-service.js";
import { createPushRemediation } from "./push-remediation.js";
import { initOtel, shutdownOtel } from "./otel.js";
import { log } from "./logger.js";

const here = dirname(fileURLToPath(import.meta.url));
/** Monorepo default: apps/web/dist next to the server. Containers override via IRORI_STATIC_DIR. */
const WEB_DIST = process.env.IRORI_STATIC_DIR ?? resolve(here, "../../web/dist");

/**
 * IRI-011 (ADR-0007): agent artifacts served to nodes. Containers point
 * IRORI_AGENT_ARTIFACTS_DIR at a flat dir (Dockerfile ships it); the
 * monorepo resolves the apps/agent sources + built bundle directly.
 */
function resolveAgentArtifacts(): { installer: string; unit: string; bundle: string } | null {
  const dir = process.env.IRORI_AGENT_ARTIFACTS_DIR?.trim();
  if (dir !== undefined && dir.length > 0) {
    return { installer: join(dir, "install-agent.sh"), unit: join(dir, "irori-agent.service"), bundle: join(dir, "irori-agent.mjs") };
  }
  const agentPkg = resolve(here, "../../agent");
  const artifacts = {
    installer: join(agentPkg, "install-agent.sh"),
    unit: join(agentPkg, "irori-agent.service"),
    bundle: join(agentPkg, "dist", "irori-agent.mjs"),
  };
  return existsSync(artifacts.installer) ? artifacts : null;
}
const AGENT_ARTIFACTS = resolveAgentArtifacts();
const PRUNE_INTERVAL_MS = 5 * 60_000;
const ROLLUP_INTERVAL_MS = 60_000;
const BOOT_RETRY_MIN_MS = 2_000;
const BOOT_RETRY_MAX_MS = 30_000;
/** Health watcher + driver-truth poll cadence (M5). */
const SETUPS_TICK_MS = 5_000;
/** Stand-in for hub.online() before the hub exists (download queue drain). */
const NO_NODES_ONLINE: ReadonlySet<string> = new Set<string>();

// Shared wiring, filled in once the DB is reachable. Until then the app runs
// degraded: /healthz reports db:false and store-backed routes answer 503.
const state: {
  dbHealthy: () => Promise<boolean>;
  hub: AgentHub | null;
  store: NodeStore | null;
  /** IRI-019: global HF token service (null until the DB is wired). */
  hfToken: HfTokenService | null;
  /** IR-87: hub cadence setting service (null until the DB is wired). */
  cadence: CadenceService | null;
  /** IRI-025: energy/token cost settings (null until the DB is wired). */
  cost: CostService | null;
  llmStore: LlmStore | null;
  jobs: JobsService | null;
  downloads: DownloadQueueService | null;
  setups: SetupsService | null;
  bench: BenchService | null;
  analytics: AnalyticsService | null;
  /** IRI-040: token macro views (fleet / cluster / node / model). */
  tokenMacro: TokenMacroService | null;
  cleanup: CleanupService | null;
  /** IRI-028: cached per-node model inventory reads. */
  inventory: InventoryService | null;
  usage: UsageStore | null;
  usageClients: UsageClients | null;
  usageChats: UsageChats | null;
  history: HistoryBuilder | null;
  llmHistory: LlmHistoryBuilder | null;
  modelctlPin: ModelctlPinService | null;
} = {
  dbHealthy: async () => false,
  hub: null,
  store: null,
  hfToken: null,
  cadence: null,
  cost: null,
  modelctlPin: null,
  llmStore: null,
  jobs: null,
  downloads: null,
  setups: null,
  bench: null,
  analytics: null,
  tokenMacro: null,
  cleanup: null,
  inventory: null,
  usage: null,
  usageClients: null,
  usageChats: null,
  history: null,
  llmHistory: null,
};
let dbHandle: DbHandle | null = null;

const config = loadConfig();
/** The in-memory active cadence: settings row when present, else the env default. */
let activeCadenceMs = config.cadenceMs;
const version = readVersion();
/** Git tag baked into the image by CD/release; null for local builds. */
const gitTag = process.env.IRORI_GIT_TAG?.trim() || null;
// IRI-039/IR-116: env-gated OTLP export — no-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set.
initOtel({ serviceName: "irori-server", version, log: (m) => log.info(m) });
const rings = createRings();
// Recording feed (IRI-013): every non-snapshot/llm/heartbeat frame is kept for /events/recent.
const sse = createEventFeed(createSseHub());

const app = createApp({
  getStore: () => state.store,
  getLlmStore: () => state.llmStore,
  getJobs: () => state.jobs,
  getDownloads: () => state.downloads,
  getSetups: () => state.setups,
  getBench: () => state.bench,
  getAnalytics: () => state.analytics,
  getTokenMacro: () => state.tokenMacro,
  getCleanup: () => state.cleanup,
  getInventory: () => state.inventory,
  getUsage: () => state.usage,
  getUsageClients: () => state.usageClients,
  getUsageChats: () => state.usageChats,
  getHistory: () => state.history,
  getLlmHistory: () => state.llmHistory,
  dbHealthy: () => state.dbHealthy(),
  rings,
  sse,
  getHub: () => state.hub,
  getHfToken: () => state.hfToken,
  getCadence: () => state.cadence,
  getCost: () => state.cost,
  getModelctlPin: () => state.modelctlPin,
  getCadenceMs: () => activeCadenceMs,
  setCadenceMs: (ms) => {
    activeCadenceMs = ms;
  },
  hfQuants: createHfQuantsService(),
  version,
  tag: gitTag,
  staticDir: existsSync(WEB_DIST) ? WEB_DIST : null,
  agentArtifacts: AGENT_ARTIFACTS,
});

const server = createServer(app);
server.listen(config.port, () => {
  log.info(`${version}${gitTag === null ? "" : ` (${gitTag})`} listening on :${config.port}`);
});

void boot();

/** M8 (ADR-0008 §6): raw llm_requests kept 90 d, usage buckets 1 y. */
const USAGE_RAW_KEEP_DAYS = 90;
const USAGE_BUCKET_KEEP_DAYS = 365;

async function boot(): Promise<void> {
  if (config.databaseUrl === null) {
    log.info("no DATABASE_URL — running degraded (rings + SSE only)");
    return;
  }
  dbHandle = createDbHandle(config.databaseUrl);
  await migrateWithBackoff(dbHandle.migrate);
  log.info("database migrated");

  // loadConfig guarantees ENCRYPTION_KEY whenever DATABASE_URL is set.
  const store = createNodeStore(dbHandle.db, config.encryptionKey!);
  state.store = store;
  state.dbHealthy = dbHandle.isHealthy;

  const llmStore = createLlmStore(dbHandle.db);
  state.llmStore = llmStore;

  // M8 (ADR-0008): durable usage ingest + read models. The SSE fan-out and
  // ack ride the hub frame chain; inserts are deduplicated by client UUID.
  const usageStore = createUsageStore(dbHandle.db);
  state.usage = usageStore;
  // IR-55: client-identity registry (issued keys resolve at ingest).
  state.usageClients = createUsageClients(dbHandle.db);
  // IR-53: session chaining + reconstruction over stored bodies.
  state.usageChats = createUsageChats(dbHandle.db);
  // IRI-019: global HF token (settings row), pushed to agents via config-update.
  state.hfToken = createHfTokenService(dbHandle.db);
  // IR-87: hub cadence (settings row) — the stored value becomes the active
  // cadence for hello-ok/config-update until a PUT changes it.
  state.cadence = createCadenceService(dbHandle.db, CADENCE_MIN_MS, CADENCE_MAX_MS);
  const storedCadence = await state.cadence.get().catch(() => null);
  if (storedCadence !== null) activeCadenceMs = storedCadence;
  // IRI-025: energy/token cost settings (Overview cost previews).
  state.cost = createCostService(dbHandle.db);

  // IR-105: hub-pinned modelctl version (config-update + auto-provisioning).
  state.modelctlPin = createModelctlPinService(dbHandle.db);

  // IRI-014: download-queue batch settles reconcile the queue rows; the
  // mutable hook is filled in once the queue service exists (it needs jobs).
  let queueSettle: ((event: JobSettledEvent) => void) | null = null;
  // ADR-0014: the remediator needs the jobs service; fill the mutable hook
  // once the service exists (same pattern as queueSettle above).
  let pushRemediation: ((event: PushBlockedEvent) => void) | null = null;
  const jobsService = createJobsService(dbHandle.db, (nodeId, msg) => hub === null ? false : hub.sendToNode(nodeId, msg), (e) => {
    sse.send({ type: "job", serverTimeMs: Date.now(), nodeId: e.nodeId, jobId: e.jobId, kind: e.kind, status: e.status, exitCode: e.exitCode, durationMs: e.durationMs });
    queueSettle?.(e);
  }, (e) => {
    // IRI-028: a job starts from many places (download queue, setups, web
    // pages) — the Activity drawer must learn about all of them.
    sse.send({ type: "job", serverTimeMs: Date.now(), nodeId: e.nodeId, jobId: e.jobId, kind: e.kind, status: "running", exitCode: null, durationMs: null });
  }, () => (state.modelctlPin === null ? Promise.resolve(null) : state.modelctlPin.get()), (e) => pushRemediation?.(e));

  pushRemediation = createPushRemediation({
    jobs: jobsService,
    getNode: (id) => store.get(id),
    getNodes: () => store.list(),
    log: (message) => log.info(message),
  });

  const downloadQueue = createDownloadQueueService({
    db: dbHandle.db,
    jobs: jobsService,
    sendToAgent: (nodeId, msg) => (hub === null ? false : hub.sendToNode(nodeId, msg)),
    online: () => (hub === null ? NO_NODES_ONLINE : hub.online()),
  });
  queueSettle = (event) => void downloadQueue.onJobSettled(event);

  const benchService = createBenchService(
    dbHandle.db,
    (nodeId, msg) => (hub === null ? false : hub.sendToNode(nodeId, msg)),
    sse,
    (message) => log.info(message),
  );

  // M7: analytics + token ledger + energy archive + hygiene reads.
  state.analytics = createAnalyticsService(dbHandle.db);
  state.tokenMacro = createTokenMacroService(dbHandle.db);

  // M7: analytics + hygiene reads (token ledger + energy engines below).
  state.analytics = createAnalyticsService(dbHandle.db);
  const cleanup = createCleanupService(dbHandle.db);
  state.cleanup = cleanup;
  // IRI-028: per-node model inventory cache (written by jobs-service on a
  // models-inventory settle; invalidated by model-mutating settles).
  state.inventory = createInventoryService(dbHandle.db);

  const setupsService = createSetupsService({
    db: dbHandle.db,
    rings,
    sse,
    getNode: (id) => store.get(id),
    getNodes: () => store.list(),
    online: () => hub === null ? new Set<string>() : hub.online(),
    sendToNode: (nodeId, msg) => (hub === null ? false : hub.sendToNode(nodeId, msg)),
    refreshNodeConfig: async (nodeId) => (hub === null ? false : hub.refreshConfig(nodeId)),
    jobs: jobsService,
    log: (message) => log.info(message),
  });

  // IRI-028: at most one job-output SSE frame per second per job. The full
  // ring stays in job_output; this keeps the Activity drawer live without
  // flooding the stream (rsync/tqdm repaint far faster than 1/s).
  const progressSentAt = new Map<string, number>();

  // Job frames feed both the jobs subsystem (persistence + inventory) and the
  // staged-transfer engine (progress parsing + stage chaining).
  const jobEvents = {
    onOutput: async (nodeId: string, jobId: string, seq: number, line: string) => {
      await jobsService.onOutput(nodeId, jobId, seq, line);
      await setupsService.onJobOutput(nodeId, jobId, seq, line);
      // IRI-017: modelctl progress events → download_queue byte/speed columns.
      await downloadQueue.onJobOutput(jobId, line);
      const now = Date.now();
      if (now - (progressSentAt.get(jobId) ?? 0) >= 1000) {
        progressSentAt.set(jobId, now);
        sse.send({ type: "job-progress", serverTimeMs: now, nodeId, jobId, seq, line });
      }
    },
    onDone: async (nodeId: string, jobId: string, status: "succeeded" | "failed" | "canceled", exitCode: number | null) => {
      progressSentAt.delete(jobId);
      await jobsService.onDone(nodeId, jobId, status, exitCode);
      await setupsService.onJobDone(nodeId, jobId, status, exitCode);
    },
    onCatalog: jobsService.onCatalog,
    // IRI-012 (ADR-0007): the fresh hello's agentVersion settles update jobs.
    onHello: (nodeId: string, agentVersion: string) => jobsService.settleAgentUpdate(nodeId, agentVersion),
  };

  const hub = createAgentHub({ store, llmStore, rings, sse, getCadenceMs: () => activeCadenceMs, serverVersion: version, getHfToken: () => (state.hfToken === null ? Promise.resolve(undefined) : state.hfToken.get()), getModelctlPin: () => (state.modelctlPin === null ? Promise.resolve(null) : state.modelctlPin.get()), jobEvents, setupEvents: {
    onAck: (msg, senderNodeId) => setupsService.onDriverAck(msg, senderNodeId),
    onEvent: (msg, senderNodeId) => setupsService.onDriverEvent(msg, senderNodeId).catch(() => {}),
    onLog: (msg, senderNodeId) => setupsService.onDriverLog(msg, senderNodeId).catch(() => {}),
    onValidateResult: (msg, senderNodeId) => setupsService.onValidateResult(msg, senderNodeId),
  }, benchEvents: {
    onProgress: (nodeId, runId, progress) => benchService.onProgress(nodeId, runId, progress),
    onDone: (nodeId, runId, status, result, error) => benchService.onDone(nodeId, runId, status, result, error),
  }, usageEvents: {
    onBatch: async (nodeId, events) => {
      try {
        await usageStore.insertBatch(nodeId, events);
        return true;
      } catch {
        return false; // no ack — the agent's durable buffer redelivers
      }
    },
  } });
  hub.attach(server);
  state.hub = hub;
  state.jobs = jobsService;
  state.downloads = downloadQueue;
  state.setups = setupsService;
  state.bench = benchService;

  // Staged transfers that were running at restart resume from the first
  // pending stage; the health watcher polls driver truth + probes every 5 s.
  void setupsService.recover().catch((err) => {
    log.error(`setups recover failed (${err instanceof Error ? err.message : String(err)})`);
  });
  // IRI-014: settle download rows whose batch ended while the server was
  // down, then drain pending entries if the store node is idle.
  void downloadQueue.recover().catch((err) => {
    log.error(`download queue recover failed (${err instanceof Error ? err.message : String(err)})`);
  });
  const setupsTicker = setInterval(() => {
    if (dbHandle === null) return;
    // isHealthy is async; testing the promise directly would always be truthy.
    void dbHandle.isHealthy().then((healthy) => {
      if (!healthy) return;
      void setupsService.tick().catch((err) => {
        log.error(`setups tick failed (${err instanceof Error ? err.message : String(err)})`);
      });
    });
  }, SETUPS_TICK_MS);
  setupsTicker.unref();

  state.history = (nodeId, range) => buildHistory(dbHandle!.db, nodeId, range);
  state.llmHistory = (nodeId, range) => buildLlmHistory(dbHandle!.db, nodeId, range);

  // Roll up BEFORE the first prune pass so raw data is never deleted
  // un-aggregated, then keep buckets fresh every 60s. Hardware and llm
  // pipelines share the schedule but advance their watermarks separately.
  const engine = createRollupEngine(dbHandle.db);
  const llmEngine = createLlmRollupEngine(dbHandle.db);
  const usageEngine = createUsageRollupEngine(dbHandle.db);
  for (const [name, rollupEngine] of [
    ["rollup", engine],
    ["llm rollup", llmEngine],
    ["usage rollup", usageEngine],
  ] as const) {
    try {
      await rollupEngine.runOnce();
      log.info(`initial ${name} pass complete`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`initial ${name} failed (${message}) — retrying every ${ROLLUP_INTERVAL_MS / 1000}s`);
    }
  }
  const ledgerEngine = createTokenLedgerEngine(dbHandle.db);
  const energyEngine = createEnergyEngine(dbHandle.db);
  startRollupLoop([engine, llmEngine, ledgerEngine, energyEngine, usageEngine], dbHandle.isHealthy);

  // Ledger retention mirrors the bucket knobs; hourly is plenty.
  const ledgerPrune = setInterval(() => {
    void dbHandle?.isHealthy().then(async (healthy) => {
      if (!healthy) return;
      try {
        await pruneTokenLedger(dbHandle!.db, config.minuteKeepDays, config.hourKeepDays, config.dayKeepDays);
      } catch (err) {
        log.error(`token ledger prune failed (${err instanceof Error ? err.message : String(err)})`);
      }
    });
  }, 3_600_000);
  ledgerPrune.unref();

  // Weekly always-safe pass (SPEC §11.6): nodes with prevention enabled get a
  // hygiene-clean of the safe categories when their last clean is > 7 d old.
  const HYGIENE_WEEK_MS = 7 * 86_400_000;
  const hygieneScheduler = setInterval(() => {
    void dbHandle?.isHealthy().then(async (healthy) => {
      if (!healthy || state.jobs === null || state.cleanup === null) return;
      const cleanup = state.cleanup;
      try {
        for (const nodeId of await cleanup.weeklySafePassNodes()) {
          const history: CleanupEntry[] = await cleanup.history(nodeId, 20);
          const lastClean = history.find((h) => h.kind === "clean");
          if (lastClean !== undefined && Date.now() - Date.parse(lastClean.createdAt) < HYGIENE_WEEK_MS) continue;
          if (!hub?.online().has(nodeId)) continue; // offline nodes catch up next tick
          try {
            await jobsService.create(nodeId, "hygiene-clean", weeklySafePassParams());
            log.info(`weekly safe-pass hygiene-clean dispatched to ${nodeId}`);
          } catch (err) {
            if (err instanceof JobBusyError) continue; // busy: retried next tick
            if (err instanceof JobDispatchError) continue;
            throw err;
          }
        }
      } catch (err) {
        log.error(`hygiene scheduler failed (${err instanceof Error ? err.message : String(err)})`);
      }
    });
  }, 3_600_000);
  hygieneScheduler.unref();

  // Jobs die with their agent: any running job whose node is offline is
  // failed immediately (container-agent model — the process dies with it).
  const jobReaper = setInterval(() => {
    if (dbHandle === null) return;
    void dbHandle.isHealthy().then((healthy) => {
      if (!healthy) return;
      void jobsService.reapOffline(hub.online()).catch((err) => {
        log.error(`job reaper failed (${err instanceof Error ? err.message : String(err)})`);
      });
      // Benches die with their agent too: a running bench whose node vanished
      // cannot deliver a terminal frame.
      void benchService.reapOffline(hub.online()).catch((err) => {
        log.error(`bench reaper failed (${err instanceof Error ? err.message : String(err)})`);
      });
      // IRI-014: pending downloads drain whenever the store node is idle —
      // this tick also covers a store node coming online with no other event.
      void downloadQueue.dispatchIfIdle().catch((err) => {
        log.error(`download queue drain failed (${err instanceof Error ? err.message : String(err)})`);
      });
    });
  }, 60_000);
  jobReaper.unref();

  startPruneLoop(store, llmStore, dbHandle.db, config, benchService, usageStore);
  log.info(`agent hub ready on /agent-ws (cadence ${config.cadenceMs} ms)`);
}

async function migrateWithBackoff(migrate: () => Promise<void>): Promise<void> {
  let delay = BOOT_RETRY_MIN_MS;
  for (;;) {
    try {
      await migrate();
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`migrate failed (${message}) — retrying in ${Math.round(delay / 1000)}s`);
      const { promise: retry, resolve: retryDone } = Promise.withResolvers<void>();
      setTimeout(retryDone, delay);
      await retry;
      delay = Math.min(delay * 2, BOOT_RETRY_MAX_MS);
    }
  }
}

function startPruneLoop(store: NodeStore, llmStore: LlmStore, db: Db, config: Config, bench: BenchService, usage: UsageStore | null): void {
  const prune = async (): Promise<void> => {
    try {
      const result = await runRetention(store, db, {
        rawHours: config.snapshotRetentionHours,
        minuteKeepDays: config.minuteKeepDays,
        hourKeepDays: config.hourKeepDays,
        dayKeepDays: config.dayKeepDays,
      });
      const llm = await runLlmRetention(llmStore, {
        rawHours: config.snapshotRetentionHours,
        minuteKeepDays: config.minuteKeepDays,
        hourKeepDays: config.hourKeepDays,
        dayKeepDays: config.dayKeepDays,
      });
      let usageResult: { raw: number; hour: number; day: number } | null = null;
      if (usage !== null) {
        // ADR-0008 §6: 90 d raw / 1 y buckets (owner decision, research §6.2).
        usageResult = await runUsageRetention(usage, USAGE_RAW_KEEP_DAYS, USAGE_BUCKET_KEEP_DAYS);
      }
      if (result.raw > 0) {
        log.info(`pruned ${result.raw} snapshots (retention ${config.snapshotRetentionHours} h)`);
      }
      if (llm.raw > 0) {
        log.info(`pruned ${llm.raw} llm snapshots (retention ${config.snapshotRetentionHours} h)`);
      }
      if (result.minute + result.hour + result.day > 0) {
        log.info(
          `[irori-server] pruned buckets: ${result.minute} minute / ${result.hour} hour / ${result.day} day`,
        );
      }
      if (llm.minute + llm.hour + llm.day > 0) {
        log.info(
          `[irori-server] pruned llm buckets: ${llm.minute} minute / ${llm.hour} hour / ${llm.day} day`,
        );
      }
      if (usageResult !== null && usageResult.raw + usageResult.hour + usageResult.day > 0) {
        log.info(
          `[irori-server] pruned usage: ${usageResult.raw} raw requests / ${usageResult.hour} hour + ${usageResult.day} day buckets`,
        );
      }
      const pruned = await bench.prune();
      if (pruned > 0) log.info(`pruned ${pruned} bench runs (last 30 per type kept)`);
    } catch {
      // DB loss is handled by the hub buffer; prune just tries again next tick.
    }
  };
  void prune();
  const timer = setInterval(() => void prune(), PRUNE_INTERVAL_MS);
  timer.unref();
}

function startRollupLoop(engines: RollupEngine[], isHealthy: () => Promise<boolean>): void {
  const tick = async (): Promise<void> => {
    if (!(await isHealthy())) return;
    for (const engine of engines) {
      try {
        await engine.runOnce();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`rollup pass failed (${message})`);
      }
    }
  };
  const timer = setInterval(() => void tick(), ROLLUP_INTERVAL_MS);
  timer.unref();
}

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} received — shutting down`);
  state.hub?.stop();
  sse.stop();
  server.close();
  void dbHandle?.close();
  // IRI-039/IR-116: flush the last batching window before exit.
  void shutdownOtel();
  setTimeout(() => process.exit(0), 3_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(here, "../package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
