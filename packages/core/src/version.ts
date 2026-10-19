/** Wire/schema version of the agent↔server contracts. Bump on breaking changes. */
export const SCHEMA_VERSION = 1;

/** Servers refuse hellos from agents older than this. */
export const MIN_AGENT_VERSION = "0.1.0";

/** First agent version that understands the `agent-update` job (IRI-012).
 *  Older agents cannot self-update — they get the install one-liner once. */
export const AGENT_UPDATE_MIN_VERSION = "0.3.0";

/** Compare two dotted numeric versions; negative if a < b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function isAgentSupported(agentVersion: string): boolean {
  return compareVersions(agentVersion, MIN_AGENT_VERSION) >= 0;
}
