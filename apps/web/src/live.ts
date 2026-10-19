import { computed, reactive, ref } from "vue";
import type { ComputedRef, Ref } from "vue";
import {
  llmEventSchema,
  sseEventSchema,
  type HardwareSnapshot,
  type LlmPortSnapshot,
  type NodeInfo,
} from "@irori/core";
import { fetchNodes } from "./api";

/** Latest LLM probe per node (SSE llm events; REST seeds it on the detail page). */
export interface LlmEntry {
  ports: LlmPortSnapshot[];
  /** Server receive time of the probe, ISO. */
  updatedAt: string;
}

/** Latest bench frame per run id (SSE bench events; M6). */
export interface BenchLive {
  runId: string;
  bench: string;
  nodeId: string;
  status: "running" | "completed" | "failed" | "canceled";
  progress: { phase: string; index: number; total: number; label: string; liveTps: number | null } | null;
  serverTimeMs: number;
}

export interface LiveStoreOptions {
  /** Overridable for tests. */
  fetchNodesFn?: typeof fetchNodes;
  EventSourceCtor?: typeof EventSource | null;
  now?: () => number;
  /** Interval at which lastEventAgeMs is refreshed. */
  ageTickMs?: number;
}

export interface LiveStore {
  /** Node registry (id → NodeInfo), from GET /api/v1/nodes + status events. */
  nodes: Map<string, NodeInfo>;
  /** Latest hardware snapshot per node (id → snapshot), from SSE. */
  snapshots: Map<string, HardwareSnapshot>;
  /** Latest LLM probe per node (id → entry), from SSE llm events. */
  llm: Map<string, LlmEntry>;
  /** Latest bench frame per run id, from SSE bench events (M6). */
  benches: Map<string, BenchLive>;
  /** Latest LLM entry for a node, null when no probe has arrived yet. */
  getLlm(nodeId: string): LlmEntry | null;
  /** ms since the last SSE frame arrived (refreshed by a tick), null before the first event. */
  lastEventAgeMs: Ref<number | null>;
  /** True while the EventSource is in the OPEN state. */
  connected: Ref<boolean>;
  /** Registry sorted by sortOrder, then name. */
  sortedNodes: ComputedRef<NodeInfo[]>;
  init(): Promise<void>;
  stop(): void;
  /** Parse + apply one raw SSE frame. Exposed for tests and reuse. */
  ingest(raw: string): void;
  /** Re-fetch the node registry (used on init and on SSE (re)connect). */
  refreshNodes(): Promise<void>;
}

/**
 * Client-side live store: REST registry seed + SSE stream of snapshots and
 * node status. EventSource reconnects natively; every (re)open also re-fetches
 * the registry so edits made while disconnected are picked up.
 */
export function createLiveStore(options: LiveStoreOptions = {}): LiveStore {
  const fetchNodesFn = options.fetchNodesFn ?? fetchNodes;
  const EventSourceImpl =
    options.EventSourceCtor === undefined
      ? globalThis.EventSource
      : options.EventSourceCtor;
  const now = options.now ?? (() => Date.now());
  const ageTickMs = options.ageTickMs ?? 1000;

  const nodes = reactive(new Map<string, NodeInfo>());
  const snapshots = reactive(new Map<string, HardwareSnapshot>());
  const llm = reactive(new Map<string, LlmEntry>());
  const benches = reactive(new Map<string, BenchLive>());
  const lastEventAtMs = ref<number | null>(null);
  const lastEventAgeMs = ref<number | null>(null);
  const connected = ref(false);

  const sortedNodes = computed<NodeInfo[]>(() =>
    [...nodes.values()].sort(
      (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
    ),
  );

  let eventSource: EventSource | null = null;
  let ageTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  function ingest(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // ignore malformed frames
    }
    // LLM frames are validated against their dedicated schema first: older
    // cores ship the SSE union without them, and the frame still applies.
    const llmEvt = llmEventSchema.safeParse(parsed);
    if (llmEvt.success) {
      lastEventAtMs.value = now();
      lastEventAgeMs.value = 0;
      llm.set(llmEvt.data.nodeId, {
        ports: llmEvt.data.ports,
        updatedAt: new Date(llmEvt.data.serverTimeMs).toISOString(),
      });
      return;
    }
    const evt = sseEventSchema.safeParse(parsed);
    if (!evt.success) return; // ignore unknown event shapes
    lastEventAtMs.value = now();
    lastEventAgeMs.value = 0;

    const event = evt.data;
    switch (event.type) {
      case "snapshot": {
        const node = nodes.get(event.nodeId);
        if (node && event.snapshot.agentVersion && !node.agentVersion) {
          node.agentVersion = event.snapshot.agentVersion;
        }
        snapshots.set(event.nodeId, event.snapshot);
        break;
      }
      case "node-online":
      case "node-offline": {
        const node = nodes.get(event.nodeId);
        if (!node) break; // registry is authoritative; next refresh picks it up
        node.online = event.type === "node-online";
        if (event.agentVersion) node.agentVersion = event.agentVersion;
        break;
      }
      case "heartbeat":
        break;
      case "bench":
        benches.set(event.runId, {
          runId: event.runId,
          bench: event.bench,
          nodeId: event.nodeId,
          status: event.status,
          progress: event.progress,
          serverTimeMs: event.serverTimeMs,
        });
        break;
    }
  }

  async function refreshNodes(): Promise<void> {
    const fetched = await fetchNodesFn();
    if (stopped) return;
    nodes.clear();
    for (const node of fetched) nodes.set(node.id, node);
  }

  async function init(): Promise<void> {
    try {
      await refreshNodes();
    } catch {
      // Registry unavailable at boot: still open the SSE stream — its onopen
      // re-fetches, and a hard failure here used to leave the store dead
      // (no SSE, no retry) rendering a misleading "no nodes" banner.
    }
    if (stopped) return;

    if (EventSourceImpl) {
      const es = new EventSourceImpl("/api/v1/events");
      eventSource = es;
      es.onopen = () => {
        connected.value = true;
        void refreshNodes().catch(() => {});
      };
      es.onmessage = (msg) => ingest(msg.data);
      es.onerror = () => {
        connected.value = false;
      };
    }

    if (typeof window !== "undefined") {
      window.addEventListener("online", onWindowOnline);
    }

    ageTimer = setInterval(() => {
      if (lastEventAtMs.value !== null) {
        lastEventAgeMs.value = Math.max(0, now() - lastEventAtMs.value);
      }
    }, ageTickMs);
  }

  function onWindowOnline(): void {
    void refreshNodes().catch(() => {});
  }

  function getLlm(nodeId: string): LlmEntry | null {
    return llm.get(nodeId) ?? null;
  }

  function stop(): void {
    stopped = true;
    connected.value = false;
    eventSource?.close();
    eventSource = null;
    if (ageTimer !== null) {
      clearInterval(ageTimer);
      ageTimer = null;
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("online", onWindowOnline);
    }
  }

  return {
    nodes,
    snapshots,
    llm,
    benches,
    getLlm,
    lastEventAgeMs,
    connected,
    sortedNodes,
    init,
    stop,
    ingest,
    refreshNodes,
  };
}

/** App-wide singleton (tests build their own via createLiveStore). */
export const live = createLiveStore();
