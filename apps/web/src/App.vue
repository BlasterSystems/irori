<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { live } from "./live";
import NodeDetail from "./components/NodeDetail.vue";
import ModelsView from "./components/ModelsView.vue";
import ServeView from "./components/ServeView.vue";
import BenchmarksView from "./components/BenchmarksView.vue";
import AnalyticsView from "./components/AnalyticsView.vue";
import OverviewView from "./components/OverviewView.vue";
import UsageView from "./components/UsageView.vue";
import ChatsView from "./components/ChatsView.vue";
import AuditView from "./components/AuditView.vue";
import HubSettingsModal from "./components/HubSettingsModal.vue";
import TelemetryDrawer from "./components/TelemetryDrawer.vue";
import TransfersDock from "./components/TransfersDock.vue";
import { parseHash, chatsHash, usageHash, type Route } from "./router";
import { tier } from "./tiers";
import { loadServerVersion, serverCadenceMs, serverTag, serverVersion } from "./version";
import { loadCostSettings } from "./cost-settings";
import { DEFAULT_BASE_OVERHEAD_W, GB10_SYSTEM_ENVELOPE_W } from "@irori/core";
import { fmtWatts } from "./analytics";

const { connected } = live;

/** Fleet power now: per reporting node gpu + cpu package + base overhead,
 *  clamped to the GB10 envelope — the same math as the server power analytics. */
const fleetWatts = computed<number | null>(() => {
  let total: number | null = null;
  for (const snap of live.snapshots.values()) {
    const gpu = (snap.gpus ?? []).reduce((a, g) => a + (g.powerW ?? 0), 0);
    const cpu = snap.cpu?.packagePowerW ?? 0;
    if (gpu === 0 && cpu === 0) continue; // nothing readable on this node
    total = (total ?? 0) + Math.min(gpu + cpu + DEFAULT_BASE_OVERHEAD_W, GB10_SYSTEM_ENVELOPE_W);
  }
  return total;
});
const wattsText = computed(() => (fleetWatts.value === null ? null : fmtWatts(fleetWatts.value)));
const intervalText = computed(() =>
  serverCadenceMs.value === null ? null : `updates every ${Math.round(serverCadenceMs.value / 1000)} s`,
);

const route = ref<Route>(
  parseHash(typeof location === "undefined" ? "" : location.hash),
);

function onHashChange(): void {
  route.value = parseHash(location.hash);
}

// IR-128: below full width the nav collapses into a hamburger disclosure
// (mockups/overview-v4.html). Escape returns focus to the toggle (APG);
// outside clicks close; link activation closes — SPA navigation does not
// unmount the topbar, so a same-route link would otherwise strand it open.
const navOpen = ref(false);
const navToggleBtn = ref<HTMLButtonElement | null>(null);
const navMenuEl = ref<HTMLElement | null>(null);
function closeNav(): void {
  navOpen.value = false;
}
function onDocPointerDown(e: Event): void {
  const target = e.target as Node;
  if (navOpen.value && !navMenuEl.value?.contains(target) && !navToggleBtn.value?.contains(target)) closeNav();
}
function onDocKeydown(e: KeyboardEvent): void {
  if (e.key !== "Escape" || !navOpen.value) return;
  closeNav();
  navToggleBtn.value?.focus();
}
watch(
  () => route.value.view,
  () => closeNav(),
);
watch(tier, () => closeNav());

const detailNodeId = computed(() =>
  route.value.view === "node" ? route.value.id : null,
);

/** IRI-019: footer gear → hub-wide settings (global HF token). */
const hubSettingsOpen = ref(false);

/** IRI-043: footer CTA → always-available live telemetry drawer. */
const telemetryOpen = ref(false);

/** IR-131 shape B: footer CTA → the cross-page transfers dock. */
const transfersOpen = ref(false);
const activeTransfers = computed(() => {
  let n = 0;
  for (const job of live.jobs.values()) {
    if (job.status === "queued" || job.status === "running") n++;
  }
  return n;
});

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
  document.addEventListener("pointerdown", onDocPointerDown);
  document.addEventListener("keydown", onDocKeydown);
  void live.init().catch(() => {});
  void loadServerVersion().catch(() => {});
  void loadCostSettings().catch(() => {});
});
onUnmounted(() => {
  window.removeEventListener("hashchange", onHashChange);
  document.removeEventListener("pointerdown", onDocPointerDown);
  document.removeEventListener("keydown", onDocKeydown);
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
      <nav v-if="tier === 'full'" class="nav" aria-label="Primary">
        <a href="#/" :class="{ 'is-active': route.view === 'overview' }" :aria-current="route.view === 'overview' ? 'page' : undefined">Overview</a>
        <a href="#/models" :class="{ 'is-active': route.view === 'models' }" :aria-current="route.view === 'models' ? 'page' : undefined">Models</a>
        <a href="#/serve" :class="{ 'is-active': route.view === 'serve' }" :aria-current="route.view === 'serve' ? 'page' : undefined">Serve</a>
        <a href="#/analytics" :class="{ 'is-active': route.view === 'analytics' }" :aria-current="route.view === 'analytics' ? 'page' : undefined">Analytics</a>
        <a :href="usageHash()" :class="{ 'is-active': route.view === 'usage' }" :aria-current="route.view === 'usage' ? 'page' : undefined">Usage</a>
        <a :href="chatsHash()" :class="{ 'is-active': route.view === 'chats' }" :aria-current="route.view === 'chats' ? 'page' : undefined">Chats</a>
        <a href="#/benchmarks" :class="{ 'is-active': route.view === 'benchmarks' }" :aria-current="route.view === 'benchmarks' ? 'page' : undefined">Benchmarks</a>
        <a href="#/audit" :class="{ 'is-active': route.view === 'audit' }" :aria-current="route.view === 'audit' ? 'page' : undefined">Audit</a>
      </nav>
      <span v-if="!connected" class="chip chip--warn"><span class="dot dot--warn" aria-hidden="true"></span> Offline</span>
      <button class="iconbtn" aria-label="Toggle theme" @click="toggleTheme">
        <svg v-if="isDark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
        <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>
      </button>
      <button class="iconbtn" aria-label="Hub settings" title="Hub settings" @click="hubSettingsOpen = true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33 1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82 1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>
      </button>
      <button v-if="tier !== 'full'" ref="navToggleBtn" class="iconbtn navtoggle" aria-label="Menu" aria-controls="navMenu" :aria-expanded="navOpen ? 'true' : 'false'" @click.stop="navOpen = !navOpen">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
      </button>
      <div v-if="tier !== 'full'" ref="navMenuEl" id="navMenu" class="navmenu" :class="{ 'is-open': navOpen }" role="navigation" aria-label="Primary menu">
        <a href="#/" :class="{ 'is-active': route.view === 'overview' }" :aria-current="route.view === 'overview' ? 'page' : undefined">Overview</a>
        <a href="#/models" :class="{ 'is-active': route.view === 'models' }" :aria-current="route.view === 'models' ? 'page' : undefined">Models</a>
        <a href="#/serve" :class="{ 'is-active': route.view === 'serve' }" :aria-current="route.view === 'serve' ? 'page' : undefined">Serve</a>
        <a href="#/analytics" :class="{ 'is-active': route.view === 'analytics' }" :aria-current="route.view === 'analytics' ? 'page' : undefined">Analytics</a>
        <a :href="usageHash()" :class="{ 'is-active': route.view === 'usage' }" :aria-current="route.view === 'usage' ? 'page' : undefined">Usage</a>
        <a :href="chatsHash()" :class="{ 'is-active': route.view === 'chats' }" :aria-current="route.view === 'chats' ? 'page' : undefined">Chats</a>
        <a href="#/benchmarks" :class="{ 'is-active': route.view === 'benchmarks' }" :aria-current="route.view === 'benchmarks' ? 'page' : undefined">Benchmarks</a>
        <a href="#/audit" :class="{ 'is-active': route.view === 'audit' }" :aria-current="route.view === 'audit' ? 'page' : undefined">Audit</a>
      </div>
    </div>
  </header>

  <main class="container page">
    <ModelsView v-if="route.view === 'models'" />
    <ServeView v-else-if="route.view === 'serve'" />
    <BenchmarksView v-else-if="route.view === 'benchmarks'" />
    <AnalyticsView v-else-if="route.view === 'analytics'" />
    <UsageView v-else-if="route.view === 'usage'" />
    <ChatsView v-else-if="route.view === 'chats'" />
    <AuditView v-else-if="route.view === 'audit'" />
    <NodeDetail v-else-if="detailNodeId !== null" :node-id="detailNodeId" />
    <OverviewView v-else />
  </main>

  <footer class="foot">
    <div class="container foot__in" style="justify-content: space-between">
      <span class="mono faint">Irori {{ serverVersion ?? "…" }}<template v-if="serverTag"> · {{ serverTag }}</template><template v-if="intervalText"> · {{ intervalText }}</template><template v-if="wattsText"> · {{ wattsText }}</template></span>
      <span class="row" style="gap: 8px;">
        <button class="btn btn--ghost btn--sm" aria-label="Open transfers" @click="transfersOpen = true">Transfers<span v-if="activeTransfers > 0" class="countbub">{{ activeTransfers }}</span></button>
        <button class="btn btn--ghost btn--sm" aria-label="Open live telemetry" @click="telemetryOpen = true">Telemetry</button>
      </span>
    </div>
  </footer>

  <HubSettingsModal v-if="hubSettingsOpen" @close="hubSettingsOpen = false" />
  <TelemetryDrawer v-if="telemetryOpen" @close="telemetryOpen = false" />
  <TransfersDock v-if="transfersOpen" @close="transfersOpen = false" />
</template>

<style scoped>
/* IR-128 tier chrome (App-owned): the shell tightens below full width and the
   hamburger keeps a real 44px hit target on both tiers under 1440 (the shared
   34px .iconbtn floor stops at ≤720 via iroiri.css mobile tiers). */
html[data-tier="small"] .topbar__in { padding: 0 12px; gap: var(--space-3); }
html[data-tier="small"] .brand-endorsement { display: none; }
html[data-tier="small"] .page { padding-top: var(--space-4); padding-bottom: var(--space-4); }
html[data-tier="small"] .foot { margin-top: var(--space-3); }
html[data-tier="small"] .foot__in { padding: 8px 12px; font-size: 10.5px; }
html[data-tier="medium"] .navtoggle,
html[data-tier="small"] .navtoggle { width: 44px; height: 44px; }
</style>
