import { computed, reactive, ref } from "vue";

/**
 * IRI-084: complete live-store fake for view mounts — the shape mirrors
 * createLiveStore's public members (reactive maps + refs) so every view's
 * setup body runs without the SSE singleton.
 */
interface MockNode { id: string; name: string; online: boolean; role?: string; kind?: string }

export const liveMock: {
  nodes: Map<string, MockNode>;
  snapshots: Map<string, unknown>;
  jobs: Map<string, unknown>;
  llm: Map<string, unknown>;
  events: { value: unknown[] };
  usageLatest: { value: unknown[] };
  lastEventAgeMs: { value: number | null };
  connected: { value: boolean };
  sortedNodes: { value: MockNode[] };
  getLlm: (nodeId: string) => unknown;
  refreshNodes: () => Promise<void>;
  on: () => () => void;
  off: () => void;
  send: () => void;
} = {
  nodes: reactive(new Map()),
  snapshots: reactive(new Map()),
  jobs: reactive(new Map()),
  llm: reactive(new Map()),
  events: ref([]),
  usageLatest: ref([]),
  lastEventAgeMs: ref(null),
  connected: ref(false),
  sortedNodes: computed(() =>
    [...(liveMock.nodes as Map<string, MockNode>)]
      .map(([, n]) => n)
      .sort((a, b) => a.name.localeCompare(b.name)),
  ),
  getLlm: (nodeId: string) => liveMock.llm.get(nodeId),
  refreshNodes: async () => {},
  on: () => () => {},
  off: () => {},
  send: () => {},
};
