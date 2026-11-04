import { computed, reactive, ref } from "vue";

/**
 * IRI-084: complete live-store fake for view mounts — the shape mirrors
 * createLiveStore's public members (reactive maps + refs) so every view's
 * setup body runs without the SSE singleton.
 */
export const liveMock = {
  nodes: reactive(new Map()),
  snapshots: reactive(new Map()),
  jobs: reactive(new Map()),
  llm: reactive(new Map()),
  events: ref([]),
  usageLatest: ref([]),
  lastEventAgeMs: ref(null),
  connected: ref(false),
  sortedNodes: computed(() =>
    [...(liveMock.nodes as Map<string, { id: string; name: string; online: boolean; role?: string }>)]
      .map(([, n]) => n)
      .sort((a, b) => a.name.localeCompare(b.name)),
  ),
  getLlm: (nodeId: string) => (liveMock as unknown as { llm: Map<string, unknown> }).llm.get(nodeId),
  refreshNodes: async () => {},
  on: () => () => {},
  off: () => {},
  send: () => {},
};
