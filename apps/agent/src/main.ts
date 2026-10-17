import os from "node:os";
import { SCHEMA_VERSION } from "@irori/core";
import { collect } from "./collector.js";
import { loadConfig } from "./config.js";
import { AgentTransport } from "./transport.js";
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
  log(
    `irori agent ${AGENT_VERSION} (schema v${SCHEMA_VERSION}) starting — ` +
      `server ${config.serverUrl}, cadence ${config.cadenceMs} ms`,
  );

  const transport = new AgentTransport({
    token: config.token,
    hostname: os.hostname(),
    agentVersion: AGENT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    cadenceMs: config.cadenceMs,
    collect,
    log,
  });
  transport.connect(config.serverUrl);

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log(`${signal} received, stopping`);
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
