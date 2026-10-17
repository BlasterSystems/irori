import type { HardwareSnapshot } from "@irori/core";

/** In-memory ring capacity per node (ADR-0006). */
export const RING_CAPACITY = 900;

/**
 * Fixed-capacity per-node snapshot rings. The live view the REST API reads;
 * the DB is only history (ADR-0002: server survives DB loss).
 */
export interface Rings {
  push(nodeId: string, snapshot: HardwareSnapshot): void;
  latest(nodeId: string): HardwareSnapshot | undefined;
  remove(nodeId: string): void;
}

export function createRings(capacity: number = RING_CAPACITY): Rings {
  interface Ring {
    buf: Array<HardwareSnapshot | undefined>;
    head: number;
    count: number;
  }
  const rings = new Map<string, Ring>();

  const ringFor = (nodeId: string): Ring => {
    let ring = rings.get(nodeId);
    if (!ring) {
      ring = { buf: new Array<HardwareSnapshot | undefined>(capacity), head: 0, count: 0 };
      rings.set(nodeId, ring);
    }
    return ring;
  };

  return {
    push(nodeId, snapshot) {
      const ring = ringFor(nodeId);
      ring.buf[ring.head] = snapshot;
      ring.head = (ring.head + 1) % capacity;
      ring.count = Math.min(ring.count + 1, capacity);
    },
    latest(nodeId) {
      const ring = rings.get(nodeId);
      if (!ring || ring.count === 0) return undefined;
      const idx = (ring.head - 1 + capacity) % capacity;
      return ring.buf[idx];
    },
    remove(nodeId) {
      rings.delete(nodeId);
    },
  };
}
