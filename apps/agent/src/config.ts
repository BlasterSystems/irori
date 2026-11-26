import { homedir } from "node:os";
import { join } from "node:path";

/** One LLM engine port to probe. */
export interface LlmTarget {
  host: string;
  port: number;
}

/** Agent runtime configuration, sourced from the environment. */
export interface AgentConfig {
  /** WebSocket server URL including path (ws:// or wss://). */
  serverUrl: string;
  /** Shared node token presented in the hello frame. */
  token: string;
  /** Initial snapshot cadence in ms; the server may override via config-update. */
  cadenceMs: number;
  /** IRORI_LLM_TARGETS — probe targets that extend/override the server-assigned ports. */
  llmTargets: LlmTarget[];
  /** IRORI_LLM_DETECT_ONLY — force detection-only probes (backend/model, no rates). */
  llmDetectOnly: boolean;
  /** IRORI_MODELCTL_PIN — minimum modelctl version for the install job. */
  modelctlPin: string;
  /** IRORI_MODELCTL_PATH — explicit modelctl binary (uv's ~/.local/bin is off PATH). */
  modelctlPath: string;
  /** IRORI_STATE_DIR — persistent agent state (setup drivers, run logs). */
  stateDir: string;
  /** IRORI_USAGE_FLUSH_MS — usage buffer upload interval (ADR-0008: 30–60 s). */
  usageFlushMs: number;
  /** IRORI_USAGE_MAX_ROWS — hard cap on buffered usage rows (drop-oldest). */
  usageMaxRows: number;
  /** IRORI_LOG_FLUSH_MS — durable log buffer ship interval (IRI-078). */
  logFlushMs: number;
  /** IRORI_LOG_QUEUE_MAX — in-memory log queue cap before drop-oldest (IRI-078). */
  logQueueMax: number;
  /** IRORI_HF_TOKEN — optional HF token handed to modelctl as HF_TOKEN (gated/private repos). Bootstrap fallback: a hub-set global token (IRI-019, config-update) wins over this env. */
  hfToken: string;
  /** IRORI_MIN_STORE_FREE_BYTES — download floor on the store's free space (IR-213); 0 disables. */
  minStoreFreeBytes: number;
}

export const DEFAULT_SERVER_URL = "ws://127.0.0.1:3947/agent-ws";
export const DEFAULT_CADENCE_MS = 2000;
/** LLM probe cadence when ports are configured but the server sent none. */
export const DEFAULT_LLM_CADENCE_MS = 2000;

/** Load and validate agent configuration from `env` (defaults to process.env). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const serverUrlRaw = env.IRORI_SERVER_URL?.trim();
  let serverUrl = DEFAULT_SERVER_URL;
  if (serverUrlRaw !== undefined && serverUrlRaw.length > 0) {
    if (!serverUrlRaw.startsWith("ws://") && !serverUrlRaw.startsWith("wss://")) {
      throw new Error(
        `IRORI_SERVER_URL must start with ws:// or wss:// (got "${serverUrlRaw}")`,
      );
    }
    serverUrl = serverUrlRaw;
  }

  const token = env.IRORI_NODE_TOKEN?.trim();
  if (token === undefined || token.length === 0) {
    throw new Error("IRORI_NODE_TOKEN is required (refusing to start without a node token)");
  }

  const cadenceRaw = env.IRORI_CADENCE_MS?.trim();
  let cadenceMs = DEFAULT_CADENCE_MS;
  if (cadenceRaw !== undefined && cadenceRaw.length > 0) {
    const parsed = Number(cadenceRaw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(
        `IRORI_CADENCE_MS must be a positive integer number of milliseconds (got "${cadenceRaw}")`,
      );
    }
    cadenceMs = parsed;
  }

  const llmTargetsRaw = env.IRORI_LLM_TARGETS?.trim() ?? "";
  const llmTargets = parseLlmTargets(llmTargetsRaw);

  const llmDetectOnly = parseDetectOnly(env.IRORI_LLM_DETECT_ONLY?.trim() ?? "");

  const modelctlPin = env.IRORI_MODELCTL_PIN?.trim() || "0.24.0";
  const modelctlPath = env.IRORI_MODELCTL_PATH?.trim() || "/root/.local/bin/modelctl";

  const stateDir =
    env.IRORI_STATE_DIR?.trim() ||
    join(env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state"), "irori-agent");

  const usageFlushMsRaw = Number.parseInt(env.IRORI_USAGE_FLUSH_MS?.trim() ?? "", 10);
  const usageFlushMs = Number.isFinite(usageFlushMsRaw) && usageFlushMsRaw >= 1000 ? usageFlushMsRaw : 30_000;
  const usageMaxRowsRaw = Number.parseInt(env.IRORI_USAGE_MAX_ROWS?.trim() ?? "", 10);
  const usageMaxRows = Number.isFinite(usageMaxRowsRaw) && usageMaxRowsRaw > 0 ? usageMaxRowsRaw : 200_000;

  // IRI-078: logs ship faster than usage (an operator tails them live), but
  // still batched — a flooded engine is drained in bounded ticks.
  const logFlushMsRaw = Number.parseInt(env.IRORI_LOG_FLUSH_MS?.trim() ?? "", 10);
  const logFlushMs = Number.isFinite(logFlushMsRaw) && logFlushMsRaw >= 200 ? logFlushMsRaw : 2_000;
  const logQueueMaxRaw = Number.parseInt(env.IRORI_LOG_QUEUE_MAX?.trim() ?? "", 10);
  const logQueueMax = Number.isFinite(logQueueMaxRaw) && logQueueMaxRaw > 0 ? logQueueMaxRaw : 10_000;

  const hfToken = env.IRORI_HF_TOKEN?.trim() ?? "";

  // IR-213: downloads must fail fast when the destination pool is low. The
  // floor is checked against the agent's own telemetry at job start; 0 opts out.
  const minStoreFreeBytesRaw = Number.parseInt(env.IRORI_MIN_STORE_FREE_BYTES?.trim() ?? "", 10);
  const minStoreFreeBytes = Number.isFinite(minStoreFreeBytesRaw) && minStoreFreeBytesRaw >= 0 ? minStoreFreeBytesRaw : 1_649_267_441_664; // 1.5 TiB

  return { serverUrl, token, cadenceMs, llmTargets, llmDetectOnly, modelctlPin, modelctlPath, stateDir, usageFlushMs, usageMaxRows, logFlushMs, logQueueMax, hfToken, minStoreFreeBytes };
}

/** Parse "host:port,host:port" (a bare "port" probes 127.0.0.1). */
function parseLlmTargets(raw: string): LlmTarget[] {
  if (raw.length === 0) return [];
  const targets: LlmTarget[] = [];
  for (const token of raw.split(",")) {
    const entry = token.trim();
    if (entry.length === 0) continue;
    const sep = entry.lastIndexOf(":");
    const host = sep > 0 ? entry.slice(0, sep) : "127.0.0.1";
    const port = Number(sep > 0 ? entry.slice(sep + 1) : entry);
    if (host.length === 0 || !Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(
        `IRORI_LLM_TARGETS has an invalid target "${entry}" (expected host:port or port)`,
      );
    }
    targets.push({ host, port });
  }
  return targets;
}

function parseDetectOnly(raw: string): boolean {
  return raw === "1" || raw.toLowerCase() === "true";
}
