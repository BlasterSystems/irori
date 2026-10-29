import { computed, reactive, ref } from "vue";
import type { ComputedRef, Ref } from "vue";
import {
  llmEventSchema,
  sseEventSchema,
  type HardwareSnapshot,
  type LlmPortSnapshot,
  type NodeInfo,
  type SseEvent,
  type UsageEvent,
} from "@irori/core";
import { fetchEventsRecent, fetchNodes } from "./api";
import { fetchRecentJobs, jobLiveFromSummary, type JobLive } from "./jobs";

/** Cap on the newest-first captured-request ring (M8). */
const USAGE_LATEST_CAP = 50;

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
  fetchEventsRecentFn?: typeof fetchEventsRecent;
  fetchRecentJobsFn?: typeof fetchRecentJobs;
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
  /** Live job view (id → job), seeded from GET /api/v1/jobs and updated by
   *  the `job` / `job-progress` SSE frames (IRI-028). Progress output lines
   *  stream into the Telemetry feed (IR-102); the seed keeps node/kind
   *  context for feedLines there. */
  jobs: Map<string, JobLive>;
  /** Bounded feed ring (newest last): node status, setups, benches, jobs,
   *  thermal — never the 2 s snapshot/llm floods (IRI-013). Seeded from
   *  /api/v1/events/recent on init. */
  events: Ref<SseEvent[]>;
  /** Latest captured usage requests (newest first, M8). */
  usageLatest: Ref<UsageEvent[]>;
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
  /** Re-fetch the recent-job list (Telemetry feed job context seed). */
  refreshJobs(): Promise<void>;
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
  const jobs = reactive(new Map<string, JobLive>());
  const events = ref<SseEvent[]>([]);
  const usageLatest = ref<UsageEvent[]>([]);
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
        pushEvent(event);
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
        pushEvent(event);
        break;
      case "job": {
        const existing = jobs.get(event.jobId);
        const at = new Date(event.serverTimeMs).toISOString();
        jobs.set(event.jobId, {
          id: event.jobId,
          nodeId: event.nodeId,
          kind: event.kind,
          status: event.status,
          // IR-121: the frame carries params on new hubs — prefer it; keep the
          // seed's params when the frame omits them (older hub / empty).
          params: event.params && Object.keys(event.params).length > 0 ? event.params : (existing?.params ?? {}),
          progress: existing?.progress ?? null,
          cancelRequestedAt: existing?.cancelRequestedAt ?? null,
          exitCode: event.exitCode,
          durationMs: event.durationMs,
          createdAt: existing?.createdAt ?? at,
          startedAt: event.status === "running" ? at : (existing?.startedAt ?? null),
          finishedAt: event.status === "running" ? null : at,
          lastLine: existing?.lastLine ?? null,
        });
        pushEvent(event);
        break;
      }
      case "job-progress": {
        // ≤1/s per job. IR-102: changed output lines stream into the feed
        // ring (deduped — rsync repaints identical lines); lifecycle `job`
        // frames were already in the ring. The server's recent-events ring
        // excludes progress frames, so the output tail is live-only.
        const job = jobs.get(event.jobId);
        const changed = job !== undefined && job.lastLine !== event.line;
        if (job !== undefined) {
          job.lastLine = event.line;
          // IR-131: parsed transfer progress rides the frame when the hub
          // could parse the line — a real bar without polling.
          if (event.progress !== undefined) job.progress = event.progress;
          if (job.status === "queued") job.status = "running";
        }
        if (changed && event.line.trim() !== "") pushEvent(event);
        break;
      }
      case "thermal":
      case "setup-state":
      case "setup-transfer":
        pushEvent(event);
        break;
      case "usage": {
        // Newest-first ring; also rides the feed (bounded by pushEvent).
        usageLatest.value.unshift(event);
        if (usageLatest.value.length > USAGE_LATEST_CAP) {
          usageLatest.value.length = USAGE_LATEST_CAP;
        }
        pushEvent(event);
        break;
      }
    }
  }

  /** Feed ring cap: generous for a session, small enough to stay cheap. */
  const EVENT_RING_CAP = 300;
  function pushEvent(event: SseEvent): void {
    events.value.push(event);
    if (events.value.length > EVENT_RING_CAP) events.value.splice(0, events.value.length - EVENT_RING_CAP);
  }

  async function refreshNodes(): Promise<void> {
    const fetched = await fetchNodesFn();
    if (stopped) return;
    nodes.clear();
    for (const node of fetched) nodes.set(node.id, node);
  }

  /** Seeds/refreshes the job map (node/kind context for the Telemetry feed). */
  async function refreshJobs(): Promise<void> {
    try {
      const fetched = await (options.fetchRecentJobsFn ?? fetchRecentJobs)(20);
      if (stopped) return;
      for (const summary of fetched) {
        const current = jobs.get(summary.id);
        const next = jobLiveFromSummary(summary);
        jobs.set(summary.id, { ...next, lastLine: current?.lastLine ?? summary.lastLine });
      }
      // Bound the map: drop the oldest settled entries beyond the last 50.
      if (jobs.size > 50) {
        const settled = [...jobs.values()]
          .filter((job) => !(job.status === "queued" || job.status === "running"))
          .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
        for (const job of settled.slice(0, jobs.size - 50)) jobs.delete(job.id);
      }
    } catch {
      // Older hub without the endpoint — SSE still fills the map.
    }
  }

  async function init(): Promise<void> {
    try {
      const recent = await (options.fetchEventsRecentFn ?? fetchEventsRecent)(200);
      if (!stopped) events.value = recent.slice(-EVENT_RING_CAP);
    } catch {
      // Feed history unavailable (older hub) — SSE still populates the ring.
    }
    try {
      await refreshNodes();
    } catch {
      // Registry unavailable at boot: still open the SSE stream — its onopen
      // re-fetches, and a hard failure here used to leave the store dead
      // (no SSE, no retry) rendering a misleading "no nodes" banner.
    }
    void refreshJobs();
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
    jobs,
    events,
    usageLatest,
    getLlm,
    lastEventAgeMs,
    connected,
    sortedNodes,
    init,
    stop,
    ingest,
    refreshNodes,
    refreshJobs,
  };
}

/** App-wide singleton (tests build their own via createLiveStore). */
export const live = createLiveStore();
