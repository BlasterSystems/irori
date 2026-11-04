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
  events: ref([]),
  usageLatest: ref([]),
  lastEventAgeMs: ref(null),
  connected: ref(false),
  sortedNodes: computed(() => [] as Array<{ id: string; name: string; online: boolean }>),
  getLlm: () => undefined,
  refreshNodes: async () => {},
  on: () => () => {},
  off: () => {},
  send: () => {},
};
