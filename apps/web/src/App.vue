<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { live } from "./live";
import NodeCard from "./components/NodeCard.vue";
import NodeModal from "./components/NodeModal.vue";
import NodeDetail from "./components/NodeDetail.vue";
import ModelsView from "./components/ModelsView.vue";
import ServeView from "./components/ServeView.vue";
import BenchmarksView from "./components/BenchmarksView.vue";
import AnalyticsView from "./components/AnalyticsView.vue";
import { groupNodes } from "./llm-data";
import { parseHash, type Route } from "./router";
import { loadServerVersion } from "./version";

const { sortedNodes, connected, lastEventAgeMs } = live;

const route = ref<Route>(
  parseHash(typeof location === "undefined" ? "" : location.hash),
);

function onHashChange(): void {
  route.value = parseHash(location.hash);
}

const detailNodeId = computed(() =>
  route.value.view === "node" ? route.value.id : null,
);

/** Add-node modal on the Overview fleet page (IRI-010). */
const addOpen = ref(false);

const totalCount = computed(() => sortedNodes.value.length);
const onlineCount = computed(
  () => sortedNodes.value.filter((n) => n.online).length,
);

/** Cluster grouping (M3): heads anchor the view, then workers, then standalone. */
const orderedNodes = computed(() => {
  const groups = groupNodes(sortedNodes.value);
  return [...groups.heads, ...groups.workers, ...groups.standalone];
});
const ageText = computed(() =>
  lastEventAgeMs.value === null
    ? null
    : `${Math.round(lastEventAgeMs.value / 1000)}s`,
);

const isDark = ref(
  typeof document !== "undefined" &&
    document.documentElement.dataset.theme === "dark",
);

function toggleTheme(): void {
  const dark = !isDark.value;
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  try {
    localStorage.setItem("irori-theme", dark ? "dark" : "light");
  } catch {
    /* storage unavailable — theme still applies for this visit */
  }
  isDark.value = dark;
}

onMounted(() => {
  window.addEventListener("hashchange", onHashChange);
  void live.init().catch(() => {});
  void loadServerVersion().catch(() => {});
});
onUnmounted(() => {
  window.removeEventListener("hashchange", onHashChange);
  live.stop();
});
</script>

<template>
  <header class="topbar">
    <div class="topbar__in">
      <a class="brand" href="#/" aria-label="Irori home">
        <span class="brand-mark" aria-hidden="true"><span class="mark-node"></span><span class="mark-line"></span><span class="mark-square"></span></span>
        <span class="brand-text"><span class="brand-name">Irori</span><span class="brand-endorsement">A BlasterSystems product</span></span>
      </a>
      <nav class="nav" aria-label="Primary">
        <a href="#/" :class="{ 'is-active': route.view === 'overview' }" :aria-current="route.view === 'overview' ? 'page' : undefined">Overview</a>
        <a href="#/models" :class="{ 'is-active': route.view === 'models' }" :aria-current="route.view === 'models' ? 'page' : undefined">Models</a>
        <a href="#/serve" :class="{ 'is-active': route.view === 'serve' }" :aria-current="route.view === 'serve' ? 'page' : undefined">Serve</a>
        <a href="#/analytics" :class="{ 'is-active': route.view === 'analytics' }" :aria-current="route.view === 'analytics' ? 'page' : undefined">Analytics</a>
        <a href="#/benchmarks" :class="{ 'is-active': route.view === 'benchmarks' }" :aria-current="route.view === 'benchmarks' ? 'page' : undefined">Benchmarks</a>
      </nav>
      <span v-if="connected" class="chip chip--ok"><span class="pulse" aria-hidden="true"></span>Live<template v-if="ageText"> · {{ ageText }}</template></span>
      <span v-else class="chip chip--muted">Connecting…</span>
      <button class="iconbtn" aria-label="Toggle theme" @click="toggleTheme">
        <svg v-if="isDark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
        <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>
      </button>
    </div>
  </header>

  <main class="container page">
    <ModelsView v-if="route.view === 'models'" />
    <ServeView v-else-if="route.view === 'serve'" />
    <BenchmarksView v-else-if="route.view === 'benchmarks'" />
    <AnalyticsView v-else-if="route.view === 'analytics'" />
    <NodeDetail v-else-if="detailNodeId !== null" :node-id="detailNodeId" />
    <template v-else>
      <div class="pagehead">
        <div>
          <h1>Fleet</h1>
          <p><span class="mono faint">{{ totalCount }} nodes · {{ onlineCount }} online<template v-if="ageText"> · last event {{ ageText }} ago</template></span></p>
        </div>
        <div class="row">
          <button class="btn btn--primary" @click="addOpen = true">Add node…</button>
        </div>
      </div>

      <section v-if="totalCount > 0" class="cols cols-3">
        <NodeCard
          v-for="node in orderedNodes"
          :key="node.id"
          :node="node"
          :snapshot="live.snapshots.get(node.id) ?? null"
          :llm="live.getLlm(node.id)"
        />
      </section>
      <div v-else class="ghost-grid" style="min-height: 120px; flex-direction: column; gap: 8px;">
        <span>no nodes yet</span>
        <span style="letter-spacing: 0; text-transform: none;">add your first node → register the nas → download a model → serve</span>
      </div>

      <NodeModal v-if="addOpen" mode="create" @close="addOpen = false" />
    </template>
  </main>
</template>
