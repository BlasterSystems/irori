import { ref } from "vue";

/**
 * The hub's own version (GET /api/v1/version). Null while unknown — an older
 * server has no route, and the drift badges simply stay hidden.
 */
export const serverVersion = ref<string | null>(null);

/** Tolerant: best-effort load at app boot; failure leaves the badges hidden. */
export async function loadServerVersion(): Promise<void> {
  try {
    const res = await fetch("/api/v1/version", { headers: { accept: "application/json" } });
    if (!res.ok) return;
    const body: unknown = await res.json();
    if (typeof body === "object" && body !== null && typeof (body as { version?: unknown }).version === "string") {
      serverVersion.value = (body as { version: string }).version;
    }
  } catch {
    // Drift UI is cosmetic; a failed load just hides it.
  }
}

/** Pure: whether the node's reported agent version differs from the hub's. */
export function agentDrifts(agentVersion: string | null | undefined): boolean {
  return serverVersion.value !== null && agentVersion != null && agentVersion.length > 0 && agentVersion !== serverVersion.value;
}
