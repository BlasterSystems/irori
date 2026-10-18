import os from "node:os";
import { SCHEMA_VERSION } from "@irori/core";
import { collect } from "./collector.js";
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
    llm: {
      llmPorts: config.llmTargets.map((t) => ({ port: t.port, host: t.host })),
      llmCadenceMs: config.llmTargets.length > 0 ? DEFAULT_LLM_CADENCE_MS : 0,
      llmDetectOnly: config.llmDetectOnly,
    },
    log,
  });
  ensureProbes(config.llmTargets);
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
