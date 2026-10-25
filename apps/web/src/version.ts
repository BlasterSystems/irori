import { ref } from "vue";

/**
 * The hub's own version (GET /api/v1/version). Null while unknown — an older
 * server has no route, and the drift badges simply stay hidden.
 */
export const serverVersion = ref<string | null>(null);
/** Git tag the hub image was built from (IRORI_GIT_TAG); null on local builds. */
export const serverTag = ref<string | null>(null);
/** Active snapshot cadence (IR-87); null on older hubs — the footer hides it. */
export const serverCadenceMs = ref<number | null>(null);

/** Tolerant: best-effort load at app boot; failure leaves the badges hidden. */
export async function loadServerVersion(): Promise<void> {
  try {
    const res = await fetch("/api/v1/version", { headers: { accept: "application/json" } });
    if (!res.ok) return;
    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null) return;
    if ("version" in body && typeof body.version === "string") {
      serverVersion.value = body.version;
    }
    if ("tag" in body && typeof body.tag === "string") {
      serverTag.value = body.tag;
    }
    if ("cadenceMs" in body && typeof body.cadenceMs === "number") {
      serverCadenceMs.value = body.cadenceMs;
    }
  } catch {
    // Drift UI is cosmetic; a failed load just hides it.
  }
}

/** Pure: whether the node's reported agent version differs from the hub's. */
export function agentDrifts(agentVersion: string | null | undefined): boolean {
  return serverVersion.value !== null && agentVersion != null && agentVersion.length > 0 && agentVersion !== serverVersion.value;
}
