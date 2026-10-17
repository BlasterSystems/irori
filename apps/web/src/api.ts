import { nodeInfoSchema, type NodeInfo } from "@irori/core";

/**
 * Fetch the node registry. Tolerates extra fields: nodeInfoSchema strips
 * unknown keys (zod default), so newer servers stay compatible.
 */
export async function fetchNodes(signal?: AbortSignal): Promise<NodeInfo[]> {
  const res = await fetch("/api/v1/nodes", {
    headers: { accept: "application/json" },
    signal,
  });
  if (!res.ok) {
    throw new Error(`GET /api/v1/nodes failed: HTTP ${res.status}`);
  }
  const body: unknown = await res.json();
  if (!Array.isArray(body)) {
    throw new Error("GET /api/v1/nodes: expected a JSON array of nodes");
  }
  return body.map((item) => nodeInfoSchema.parse(item));
}
