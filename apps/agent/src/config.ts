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

  const modelctlPin = env.IRORI_MODELCTL_PIN?.trim() || "0.20.1";
  const modelctlPath = env.IRORI_MODELCTL_PATH?.trim() || "/root/.local/bin/modelctl";

  const stateDir =
    env.IRORI_STATE_DIR?.trim() ||
    join(env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state"), "irori-agent");

  return { serverUrl, token, cadenceMs, llmTargets, llmDetectOnly, modelctlPin, modelctlPath, stateDir };
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
