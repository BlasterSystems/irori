import type { HardwareSnapshot, LlmPortSnapshot } from "@irori/core";

/** In-memory ring capacity per node (ADR-0006). */
export const RING_CAPACITY = 900;

/** One LLM probe fan-in: receive time plus the ports probed in that pass. */
export interface LlmRingEntry {
  serverTimeMs: number;
  ports: LlmPortSnapshot[];
}

/** Fixed-capacity per-node ring (ADR-0006). */
class CapacityRing<T> {
  private readonly rings = new Map<string, { buf: Array<T | undefined>; head: number; count: number }>();

  constructor(private readonly capacity: number) {}

  push(nodeId: string, value: T): void {
    const ring = this.ringFor(nodeId);
    ring.buf[ring.head] = value;
    ring.head = (ring.head + 1) % this.capacity;
    ring.count = Math.min(ring.count + 1, this.capacity);
  }

  latest(nodeId: string): T | undefined {
    const ring = this.rings.get(nodeId);
    if (!ring || ring.count === 0) return undefined;
    const idx = (ring.head - 1 + this.capacity) % this.capacity;
    return ring.buf[idx];
  }

  remove(nodeId: string): void {
    this.rings.delete(nodeId);
  }

  private ringFor(nodeId: string) {
    let ring = this.rings.get(nodeId);
    if (!ring) {
      ring = { buf: new Array<T | undefined>(this.capacity), head: 0, count: 0 };
      this.rings.set(nodeId, ring);
    }
    return ring;
  }
}

/**
 * Fixed-capacity per-node rings. The live view the REST API reads; the DB is
 * only history (ADR-0002: server survives DB loss). Hardware snapshots and
 * LLM probe passes each get their own ring at RING_CAPACITY.
 */
export interface Rings {
  push(nodeId: string, snapshot: HardwareSnapshot): void;
  latest(nodeId: string): HardwareSnapshot | undefined;
  pushLlm(nodeId: string, entry: LlmRingEntry): void;
  latestLlm(nodeId: string): LlmRingEntry | undefined;
  remove(nodeId: string): void;
}

export function createRings(capacity: number = RING_CAPACITY): Rings {
  const snapshots = new CapacityRing<HardwareSnapshot>(capacity);
  const llm = new CapacityRing<LlmRingEntry>(capacity);

  return {
    push(nodeId, snapshot) {
      snapshots.push(nodeId, snapshot);
    },
    latest(nodeId) {
      return snapshots.latest(nodeId);
    },
    pushLlm(nodeId, entry) {
      llm.push(nodeId, entry);
    },
    latestLlm(nodeId) {
      return llm.latest(nodeId);
    },
    remove(nodeId) {
      snapshots.remove(nodeId);
      llm.remove(nodeId);
    },
  };
}
