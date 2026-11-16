import type { ClocksGetResultMsg } from "@irori/core";

/**
 * IR-189: the desired clock state is stored on the node row, but nothing
 * re-applied it after boot. A DGX OS component rewrites `scaling_max_freq`
 * after boot and the governor every ~2 minutes, so a cap could be silently
 * reverted while the registry still claimed it (SPEC §10 promised re-apply on
 * every node online transition; only the boot-time oneshots existed).
 *
 * This service owns the three things that promise needs:
 *
 *  - `reassert()` — on node online, read the agent's live clocks and re-apply
 *    any stored cap that drifted. Persistence is NOT touched: the registry
 *    already holds the desired state and the boot oneshot is already installed
 *    (or not) per `*ClockCapPersistent`.
 *  - `driftStreak()` — the health rule's metric: how many consecutive sweeps
 *    observed a mismatch (0 = matching, null = not measurable).
 *  - `drift()` — the pure comparison, exported for tests.
 */

export type ClockSide = "gpu" | "cpu";

export interface ClockDrift {
  side: ClockSide;
  /** The cap stored on the node row. */
  stored: number;
  /** What the agent reports as the live ceiling; null = no cap applied. */
  observed: number | null;
}

export interface ClockCapStore {
  get(id: string): Promise<{ gpuClockCapMHz: number | null; cpuClockCapMHz: number | null } | null>;
}

export interface ClockCapHub {
  clocks(nodeId: string): Promise<ClocksGetResultMsg | null>;
  setClocks(
    nodeId: string,
    caps: { smMaxMHz?: number | null; cpuMaxMHz?: number | null },
    persist?: boolean,
  ): Promise<{ ok: boolean; error: string | null } | null>;
}

export interface ClockCapService {
  /** Re-applies drifted caps after a node comes online. Never throws. */
  reassert(nodeId: string): Promise<{ checked: boolean; applied: ClockSide[] }>;
  /** Consecutive sweeps with a mismatch; null when not measurable. */
  driftStreak(nodeId: string): Promise<number | null>;
  /** Drops the in-memory streak (node removed / caps cleared). */
  forget(nodeId: string): void;
}

/**
 * Compares a live clocks reading against the stored caps. A side is only
 * compared when a cap is stored AND the reading can express that side: an
 * agent that predates IRI-124 omits `cpu`, and an empty `gpus` array means the
 * collector could not read anything — neither is evidence of drift.
 */
export function clockDrift(
  stored: { gpu: number | null; cpu: number | null },
  reading: ClocksGetResultMsg,
): ClockDrift[] {
  const drift: ClockDrift[] = [];
  if (stored.gpu !== null && reading.gpus.length > 0) {
    // Every GPU must carry the cap; one reverted card is drift.
    const observed = reading.gpus.map((g) => g.smCapMHz);
    // IR-259: an all-null read-back means the driver cannot express
    // application clocks at all (GB10 rejects clocks.applications.sm) — that
    // is unmeasurable (the same contract as the CPU guard below), not drift.
    // The comparison stays on when at least one card reports a real ceiling.
    if (observed.some((cap) => cap !== null) && observed.some((cap) => cap !== stored.gpu)) {
      drift.push({ side: "gpu", stored: stored.gpu, observed: observed[0] ?? null });
    }
  }
  if (stored.cpu !== null && reading.cpu !== undefined && reading.cpu !== null) {
    // `capMHz` is null when the policies are not uniformly capped — that is
    // exactly the "the governor rewrote one cluster" case.
    if (reading.cpu.capMHz !== stored.cpu) {
      drift.push({ side: "cpu", stored: stored.cpu, observed: reading.cpu.capMHz });
    }
  }
  return drift;
}

export function createClockCapService(deps: {
  store: ClockCapStore;
  hub: () => ClockCapHub | null;
  log?: (message: string) => void;
}): ClockCapService {
  const log = deps.log ?? (() => {});
  const streaks = new Map<string, number>();

  async function read(nodeId: string): Promise<{
    stored: { gpu: number | null; cpu: number | null };
    reading: ClocksGetResultMsg;
  } | null> {
    const node = await deps.store.get(nodeId).catch(() => null);
    if (node === null) return null;
    const stored = { gpu: node.gpuClockCapMHz, cpu: node.cpuClockCapMHz };
    if (stored.gpu === null && stored.cpu === null) return null;
    const hub = deps.hub();
    if (hub === null) return null;
    const reading = await hub.clocks(nodeId).catch(() => null);
    if (reading === null || !reading.ok) return null;
    return { stored, reading };
  }

  return {
    async reassert(nodeId) {
      try {
        const state = await read(nodeId);
        if (state === null) return { checked: false, applied: [] };
        const drift = clockDrift(state.stored, state.reading);
        const applied: ClockSide[] = [];
        for (const d of drift) {
          const reply =
            d.side === "gpu"
              ? await deps.hub()?.setClocks(nodeId, { smMaxMHz: d.stored }, false)
              : await deps.hub()?.setClocks(nodeId, { cpuMaxMHz: d.stored }, false);
          if (reply?.ok === true) {
            applied.push(d.side);
            log(
              `clock cap re-applied on ${nodeId}: ${d.side} ${d.observed ?? "default"} → ${d.stored} MHz`,
            );
          } else {
            log(
              `clock cap re-apply failed on ${nodeId}: ${d.side} ${d.stored} MHz (${reply?.error ?? "no reply"})`,
            );
          }
        }
        return { checked: true, applied };
      } catch (err: unknown) {
        log(`clock cap re-assert failed on ${nodeId}: ${err instanceof Error ? err.message : String(err)}`);
        return { checked: false, applied: [] };
      }
    },

    async driftStreak(nodeId) {
      const state = await read(nodeId).catch(() => null);
      if (state === null) {
        // No cap stored, node gone, or the agent cannot answer: not measurable.
        streaks.delete(nodeId);
        return null;
      }
      if (clockDrift(state.stored, state.reading).length === 0) {
        streaks.delete(nodeId);
        return 0;
      }
      const next = (streaks.get(nodeId) ?? 0) + 1;
      streaks.set(nodeId, next);
      return next;
    },

    forget(nodeId) {
      streaks.delete(nodeId);
    },
  };
}
