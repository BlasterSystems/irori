import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDbHandle, createNodeStore, type DbHandle, type NodeStore } from "@irori/db";
import { loadConfig } from "./config.js";
import { createRings } from "./rings.js";
import { createSseHub } from "./sse.js";
import { createAgentHub, type AgentHub } from "./hub.js";
import { createApp } from "./app.js";

const here = dirname(fileURLToPath(import.meta.url));
const WEB_DIST = resolve(here, "../../web/dist");
const PRUNE_INTERVAL_MS = 5 * 60_000;
const BOOT_RETRY_MIN_MS = 2_000;
const BOOT_RETRY_MAX_MS = 30_000;

// Shared wiring, filled in once the DB is reachable. Until then the app runs
// degraded: /healthz reports db:false and store-backed routes answer 503.
const state: { dbHealthy: () => Promise<boolean>; hub: AgentHub | null; store: NodeStore | null } = {
  dbHealthy: async () => false,
  hub: null,
  store: null,
};
let dbHandle: DbHandle | null = null;

const config = loadConfig();
const version = readVersion();
const rings = createRings();
const sse = createSseHub();

const app = createApp({
  getStore: () => state.store,
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

  const hub = createAgentHub({ store, rings, sse, cadenceMs: config.cadenceMs, serverVersion: version });
  hub.attach(server);
  state.hub = hub;

  startPruneLoop(store, config.snapshotRetentionHours);
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

function startPruneLoop(store: { pruneSnapshots(olderThan: Date): Promise<number> }, retentionHours: number): void {
  const prune = async (): Promise<void> => {
    try {
      const removed = await store.pruneSnapshots(new Date(Date.now() - retentionHours * 3_600_000));
      if (removed > 0) console.log(`[irori-server] pruned ${removed} snapshots (retention ${retentionHours} h)`);
    } catch {
      // DB loss is handled by the hub buffer; prune just tries again next tick.
    }
  };
  void prune();
  const timer = setInterval(() => void prune(), PRUNE_INTERVAL_MS);
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
