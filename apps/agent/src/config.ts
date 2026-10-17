/** Agent runtime configuration, sourced from the environment. */
export interface AgentConfig {
  /** WebSocket server URL including path (ws:// or wss://). */
  serverUrl: string;
  /** Shared node token presented in the hello frame. */
  token: string;
  /** Initial snapshot cadence in ms; the server may override via config-update. */
  cadenceMs: number;
}

export const DEFAULT_SERVER_URL = "ws://127.0.0.1:3947/agent-ws";
export const DEFAULT_CADENCE_MS = 2000;

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

  return { serverUrl, token, cadenceMs };
}
