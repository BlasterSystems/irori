import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDbHandle, createNodeStore, type Db, type DbHandle, type NodeStore } from "@irori/db";
import { loadConfig, type Config } from "./config.js";
import { createRings } from "./rings.js";
import { createSseHub } from "./sse.js";
import { createAgentHub, type AgentHub } from "./hub.js";
import { createJobsService, type JobsService } from "./jobs-service.js";
import { createRollupEngine, type RollupEngine } from "./rollups.js";
import { createLlmRollupEngine } from "./llm-rollups.js";
import { createLlmStore, type LlmStore } from "./llm-store.js";
import { runRetention, runLlmRetention } from "./retention.js";
import { buildHistory } from "./history.js";
import { buildLlmHistory } from "./llm-history.js";
import { createApp, type HistoryBuilder, type LlmHistoryBuilder } from "./app.js";
import { createSetupsService, type SetupsService } from "./setups-service.js";
import { createBenchService, type BenchService } from "./bench-service.js";
import { createAnalyticsService, type AnalyticsService } from "./analytics.js";
import { createCleanupService, weeklySafePassParams, type CleanupService } from "./cleanup-service.js";
import { createTokenLedgerEngine, pruneTokenLedger } from "./ledger.js";
import { type CleanupEntry } from "./cleanup-service.js";
import { createEnergyEngine } from "./energy.js";
import { JobBusyError, JobDispatchError } from "./jobs-service.js";

const here = dirname(fileURLToPath(import.meta.url));
/** Monorepo default: apps/web/dist next to the server. Containers override via IRORI_STATIC_DIR. */
const WEB_DIST = process.env.IRORI_STATIC_DIR ?? resolve(here, "../../web/dist");
const PRUNE_INTERVAL_MS = 5 * 60_000;
const ROLLUP_INTERVAL_MS = 60_000;
const BOOT_RETRY_MIN_MS = 2_000;
const BOOT_RETRY_MAX_MS = 30_000;
/** Health watcher + driver-truth poll cadence (M5). */
const SETUPS_TICK_MS = 5_000;

// Shared wiring, filled in once the DB is reachable. Until then the app runs
// degraded: /healthz reports db:false and store-backed routes answer 503.
const state: {
  dbHealthy: () => Promise<boolean>;
  hub: AgentHub | null;
  store: NodeStore | null;
  llmStore: LlmStore | null;
  jobs: JobsService | null;
  setups: SetupsService | null;
  bench: BenchService | null;
  analytics: AnalyticsService | null;
  cleanup: CleanupService | null;
  history: HistoryBuilder | null;
  llmHistory: LlmHistoryBuilder | null;
} = {
  dbHealthy: async () => false,
  hub: null,
  store: null,
  llmStore: null,
  jobs: null,
  setups: null,
  bench: null,
  analytics: null,
  cleanup: null,
  history: null,
  llmHistory: null,
};
let dbHandle: DbHandle | null = null;

const config = loadConfig();
const version = readVersion();
const rings = createRings();
const sse = createSseHub();

const app = createApp({
  getStore: () => state.store,
  getLlmStore: () => state.llmStore,
  getJobs: () => state.jobs,
  getSetups: () => state.setups,
  getBench: () => state.bench,
  getAnalytics: () => state.analytics,
  getCleanup: () => state.cleanup,
  getHistory: () => state.history,
  getLlmHistory: () => state.llmHistory,
  dbHealthy: () => state.dbHealthy(),
  rings,
  sse,
  getHub: () => state.hub,
  version,
  staticDir: existsSync(WEB_DIST) ? WEB_DIST : null,
});

const server = createServer(app);
server.listen(config.port, () => {
  console.log(`[irori-server] ${version} listening on :${config.port}`);
});

void boot();

async function boot(): Promise<void> {
  if (config.databaseUrl === null) {
    console.log("[irori-server] no DATABASE_URL — running degraded (rings + SSE only)");
    return;
  }
  dbHandle = createDbHandle(config.databaseUrl);
  await migrateWithBackoff(dbHandle.migrate);
  console.log("[irori-server] database migrated");

  // loadConfig guarantees ENCRYPTION_KEY whenever DATABASE_URL is set.
  const store = createNodeStore(dbHandle.db, config.encryptionKey!);
  state.store = store;
  state.dbHealthy = dbHandle.isHealthy;

  const llmStore = createLlmStore(dbHandle.db);
  state.llmStore = llmStore;

  const jobsService = createJobsService(dbHandle.db, (nodeId, msg) => hub === null ? false : hub.sendToNode(nodeId, msg));

  const benchService = createBenchService(
    dbHandle.db,
    (nodeId, msg) => (hub === null ? false : hub.sendToNode(nodeId, msg)),
    sse,
    (message) => console.log(`[irori-server] ${message}`),
  );

  // M7: analytics + token ledger + energy archive + hygiene reads.
  state.analytics = createAnalyticsService(dbHandle.db);

  // M7: analytics + hygiene reads (token ledger + energy engines below).
  state.analytics = createAnalyticsService(dbHandle.db);
  const cleanup = createCleanupService(dbHandle.db);
  state.cleanup = cleanup;

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
    log: (message) => console.log(`[irori-server] ${message}`),
  });

  // Job frames feed both the jobs subsystem (persistence + inventory) and the
  // staged-transfer engine (progress parsing + stage chaining).
  const jobEvents = {
    onOutput: async (nodeId: string, jobId: string, seq: number, line: string) => {
      await jobsService.onOutput(nodeId, jobId, seq, line);
      await setupsService.onJobOutput(nodeId, jobId, seq, line);
    },
    onDone: async (nodeId: string, jobId: string, status: "succeeded" | "failed" | "canceled", exitCode: number | null) => {
      await jobsService.onDone(nodeId, jobId, status, exitCode);
      await setupsService.onJobDone(nodeId, jobId, status, exitCode);
    },
    onCatalog: jobsService.onCatalog,
  };

  const hub = createAgentHub({ store, llmStore, rings, sse, cadenceMs: config.cadenceMs, serverVersion: version, jobEvents, setupEvents: {
    onAck: (msg, senderNodeId) => setupsService.onDriverAck(msg, senderNodeId),
    onEvent: (msg, senderNodeId) => setupsService.onDriverEvent(msg, senderNodeId).catch(() => {}),
    onLog: (msg, senderNodeId) => setupsService.onDriverLog(msg, senderNodeId).catch(() => {}),
    onValidateResult: (msg, senderNodeId) => setupsService.onValidateResult(msg, senderNodeId),
  }, benchEvents: {
    onProgress: (nodeId, runId, progress) => benchService.onProgress(nodeId, runId, progress),
    onDone: (nodeId, runId, status, result, error) => benchService.onDone(nodeId, runId, status, result, error),
  } });
  hub.attach(server);
  state.hub = hub;
  state.jobs = jobsService;
  state.setups = setupsService;
  state.bench = benchService;

  // Staged transfers that were running at restart resume from the first
  // pending stage; the health watcher polls driver truth + probes every 5 s.
  void setupsService.recover().catch((err) => {
    console.error(`[irori-server] setups recover failed (${err instanceof Error ? err.message : String(err)})`);
  });
  const setupsTicker = setInterval(() => {
    if (dbHandle === null) return;
    // isHealthy is async; testing the promise directly would always be truthy.
    void dbHandle.isHealthy().then((healthy) => {
      if (!healthy) return;
      void setupsService.tick().catch((err) => {
        console.error(`[irori-server] setups tick failed (${err instanceof Error ? err.message : String(err)})`);
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
  for (const [name, rollupEngine] of [
    ["rollup", engine],
    ["llm rollup", llmEngine],
  ] as const) {
    try {
      await rollupEngine.runOnce();
      console.log(`[irori-server] initial ${name} pass complete`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[irori-server] initial ${name} failed (${message}) — retrying every ${ROLLUP_INTERVAL_MS / 1000}s`);
    }
  }
  const ledgerEngine = createTokenLedgerEngine(dbHandle.db);
  const energyEngine = createEnergyEngine(dbHandle.db);
  startRollupLoop([engine, llmEngine, ledgerEngine, energyEngine], dbHandle.isHealthy);

  // Ledger retention mirrors the bucket knobs; hourly is plenty.
  const ledgerPrune = setInterval(() => {
    void dbHandle?.isHealthy().then(async (healthy) => {
      if (!healthy) return;
      try {
        await pruneTokenLedger(dbHandle!.db, config.hourKeepDays, config.dayKeepDays);
      } catch (err) {
        console.error(`[irori-server] token ledger prune failed (${err instanceof Error ? err.message : String(err)})`);
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
            console.log(`[irori-server] weekly safe-pass hygiene-clean dispatched to ${nodeId}`);
          } catch (err) {
            if (err instanceof JobBusyError) continue; // busy: retried next tick
            if (err instanceof JobDispatchError) continue;
            throw err;
          }
        }
      } catch (err) {
        console.error(`[irori-server] hygiene scheduler failed (${err instanceof Error ? err.message : String(err)})`);
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
        console.error(`[irori-server] job reaper failed (${err instanceof Error ? err.message : String(err)})`);
      });
      // Benches die with their agent too: a running bench whose node vanished
      // cannot deliver a terminal frame.
      void benchService.reapOffline(hub.online()).catch((err) => {
        console.error(`[irori-server] bench reaper failed (${err instanceof Error ? err.message : String(err)})`);
      });
    });
  }, 60_000);
  jobReaper.unref();

  startPruneLoop(store, llmStore, dbHandle.db, config, benchService);
  console.log(`[irori-server] agent hub ready on /agent-ws (cadence ${config.cadenceMs} ms)`);
}

async function migrateWithBackoff(migrate: () => Promise<void>): Promise<void> {
  let delay = BOOT_RETRY_MIN_MS;
  for (;;) {
    try {
      await migrate();
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[irori-server] migrate failed (${message}) — retrying in ${Math.round(delay / 1000)}s`);
      const { promise: retry, resolve: retryDone } = Promise.withResolvers<void>();
      setTimeout(retryDone, delay);
      await retry;
      delay = Math.min(delay * 2, BOOT_RETRY_MAX_MS);
    }
  }
}

function startPruneLoop(store: NodeStore, llmStore: LlmStore, db: Db, config: Config, bench: BenchService): void {
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
      if (result.raw > 0) {
        console.log(`[irori-server] pruned ${result.raw} snapshots (retention ${config.snapshotRetentionHours} h)`);
      }
      if (llm.raw > 0) {
        console.log(`[irori-server] pruned ${llm.raw} llm snapshots (retention ${config.snapshotRetentionHours} h)`);
      }
      if (result.minute + result.hour + result.day > 0) {
        console.log(
          `[irori-server] pruned buckets: ${result.minute} minute / ${result.hour} hour / ${result.day} day`,
        );
      }
      if (llm.minute + llm.hour + llm.day > 0) {
        console.log(
          `[irori-server] pruned llm buckets: ${llm.minute} minute / ${llm.hour} hour / ${llm.day} day`,
        );
      }
      const pruned = await bench.prune();
      if (pruned > 0) console.log(`[irori-server] pruned ${pruned} bench runs (last 30 per type kept)`);
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
        console.error(`[irori-server] rollup pass failed (${message})`);
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
  console.log(`[irori-server] ${signal} received — shutting down`);
  state.hub?.stop();
  sse.stop();
  server.close();
  void dbHandle?.close();
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
