import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeInfo } from "@irori/core";
import { createLiveStore } from "../src/live";

function nodeFixture(overrides: Partial<NodeInfo> = {}): NodeInfo {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    name: "spark2",
    kind: "spark",
    role: "worker",
    host: "10.0.30.21",
    enabled: true,
    agentVersion: "0.1.0",
    online: false,
    lastSeenAt: null,
    sortOrder: 1,
    createdAt: "2026-10-16T09:00:00.000Z",
    updatedAt: "2026-10-17T12:00:00.000Z",
    ...overrides,
  };
}

const SNAPSHOT_FIXTURE = {
  schemaVersion: 1,
  agentVersion: "0.1.0",
  hostname: "spark2",
  transport: "ws",
  timestampMs: 1_760_000_000_000,
  cpu: { model: "GB10", cores: 20, usagePct: 18, tempC: 62, packagePowerW: 41 },
  memory: { totalBytes: 127 * 2 ** 30, usedBytes: 96 * 2 ** 30 },
  gpus: [
    {
      index: 0,
      name: "NVIDIA GB10",
      uuid: null,
      usagePct: 34,
      tempC: 61,
      memUsedBytes: 42 * 2 ** 30,
      memTotalBytes: 127 * 2 ** 30,
      powerW: 74,
      powerLimitW: null,
      smClockMHz: null,
      smClockMaxMHz: null,
      throttleReasons: [],
      processes: [],
    },
  ],
};

/** Minimal EventSource double: captures handlers, emits on demand. */
class MockEventSource {
  static instances: MockEventSource[] = [];
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readyState: number = 1;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    MockEventSource.instances.push(this);
  }
  open(): void {
    this.onopen?.();
  }
  emit(data: string): void {
    this.onmessage?.({ data });
  }
  error(): void {
    this.onerror?.();
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
}

async function startedStore(nodes: NodeInfo[]) {
  const fetchNodesFn = vi.fn(async () => nodes);
  const store = createLiveStore({
    fetchNodesFn,
    EventSourceCtor: MockEventSource as unknown as typeof EventSource,
  });
  await store.init();
  const es = MockEventSource.instances.at(-1)!;
  return { store, fetchNodesFn, es };
}

beforeEach(() => {
  MockEventSource.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createLiveStore", () => {
  it("seeds the registry from REST and opens /api/v1/events", async () => {
    const { store, fetchNodesFn, es } = await startedStore([nodeFixture()]);
    expect(fetchNodesFn).toHaveBeenCalled();
    expect(store.sortedNodes.value.map((n) => n.name)).toEqual(["spark2"]);
    expect(es.url).toBe("/api/v1/events");
    store.stop();
  });

  it("applies snapshot events into the snapshots map", async () => {
    const { store, es } = await startedStore([nodeFixture()]);
    es.emit(JSON.stringify({ type: "snapshot", serverTimeMs: 1, nodeId: nodeFixture().id, snapshot: SNAPSHOT_FIXTURE }));
    expect(store.snapshots.get(nodeFixture().id)?.cpu.usagePct).toBe(18);
    expect(store.lastEventAgeMs.value).toBe(0);
    store.stop();
  });

  it("adopts the agent version from a snapshot when unknown", async () => {
    const { store, es } = await startedStore([nodeFixture({ agentVersion: null })]);
    es.emit(JSON.stringify({ type: "snapshot", serverTimeMs: 1, nodeId: nodeFixture().id, snapshot: SNAPSHOT_FIXTURE }));
    expect(store.nodes.get(nodeFixture().id)?.agentVersion).toBe("0.1.0");
    store.stop();
  });

  it("flips node.online from status events and ignores unknown node ids", async () => {
    const known = "00000000-0000-4000-8000-000000000001";
    const unknown = "00000000-0000-4000-8000-000000000099";
    const { store, es } = await startedStore([nodeFixture({ id: known })]);

    es.emit(JSON.stringify({ type: "node-online", serverTimeMs: 1, nodeId: unknown, agentVersion: null }));
    es.emit(JSON.stringify({ type: "node-online", serverTimeMs: 2, nodeId: known, agentVersion: "0.2.0" }));
    expect(store.nodes.get(known)?.online).toBe(true);
    expect(store.nodes.get(known)?.agentVersion).toBe("0.2.0");
    expect(store.nodes.size).toBe(1);

    es.emit(JSON.stringify({ type: "node-offline", serverTimeMs: 3, nodeId: known, agentVersion: null }));
    expect(store.nodes.get(known)?.online).toBe(false);
    store.stop();
  });

  it("tracks event age through the tick and ignores malformed frames", async () => {
    vi.useFakeTimers();
    const { store, es } = await startedStore([nodeFixture()]);

    es.emit("not json");
    es.emit(JSON.stringify({ type: "nope" }));
    expect(store.lastEventAgeMs.value).toBe(null);

    es.emit(JSON.stringify({ type: "heartbeat", serverTimeMs: 1 }));
    expect(store.lastEventAgeMs.value).toBe(0);

    vi.advanceTimersByTime(5000);
    expect(store.lastEventAgeMs.value).toBe(5000);
    store.stop();
  });

  it("sorts by sortOrder then name, and re-fetches on SSE open", async () => {
    const b = nodeFixture({ id: "00000000-0000-4000-8000-000000000002", name: "b", sortOrder: 1 });
    const a = nodeFixture({ id: "00000000-0000-4000-8000-000000000003", name: "a", sortOrder: 1 });
    const { store, es, fetchNodesFn } = await startedStore([b, a]);
    expect(store.sortedNodes.value.map((n) => n.name)).toEqual(["a", "b"]);

    const calls = fetchNodesFn.mock.calls.length;
    es.open();
    await vi.waitFor(() => expect(fetchNodesFn.mock.calls.length).toBe(calls + 1));
    expect(store.connected.value).toBe(true);

    es.error();
    expect(store.connected.value).toBe(false);
    store.stop();
  });

  it("ingests llm events into the llm store", async () => {
    const { store, es } = await startedStore([nodeFixture()]);
    es.emit(JSON.stringify({
      type: "llm",
      serverTimeMs: 1_760_000_000_000,
      nodeId: nodeFixture().id,
      ports: [
        {
          port: 8000,
          backend: "exl3",
          detected: true,
          model: "GLM-5.3-Flash-EXL3",
          decodeTps: 142.3,
          probedAtMs: 1_760_000_000_000,
        },
        { port: 8001, backend: "unknown", detected: false, probedAtMs: 1_760_000_000_000 },
      ],
    }));
    const entry = store.getLlm(nodeFixture().id);
    expect(entry).not.toBeNull();
    expect(entry?.ports).toHaveLength(2);
    expect(entry?.ports[0]).toMatchObject({ port: 8000, backend: "exl3", decodeTps: 142.3 });
    expect(entry?.updatedAt).toBe(new Date(1_760_000_000_000).toISOString());
    expect(store.lastEventAgeMs.value).toBe(0);
    store.stop();
  });

  it("keeps the previous llm entry when a frame is malformed", async () => {
    const { store, es } = await startedStore([nodeFixture()]);
    es.emit(JSON.stringify({
      type: "llm",
      serverTimeMs: 1,
      nodeId: nodeFixture().id,
      ports: [],
    }));
    expect(store.getLlm(nodeFixture().id)?.ports).toEqual([]);

    es.emit(JSON.stringify({
      type: "llm",
      serverTimeMs: 2,
      nodeId: nodeFixture().id,
      ports: [{ port: 8000, backend: "not-a-backend", detected: true }],
    }));
    expect(store.getLlm(nodeFixture().id)?.ports).toEqual([]);
    store.stop();
  });

  it("stores llm frames for nodes the registry does not know yet", async () => {
    const unknown = "00000000-0000-4000-8000-000000000099";
    const { store, es } = await startedStore([nodeFixture()]);
    es.emit(JSON.stringify({
      type: "llm",
      serverTimeMs: 3,
      nodeId: unknown,
      ports: [{ port: 8081, backend: "tensorfold", detected: true, probedAtMs: 3 }],
    }));
    expect(store.getLlm(unknown)?.ports[0]).toMatchObject({ port: 8081, backend: "tensorfold" });
    store.stop();
  });
});
