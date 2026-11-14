<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch, watchEffect } from "vue";
import { live } from "./live";
import NodeDetail from "./components/NodeDetail.vue";
import ModelsView from "./components/ModelsView.vue";
import ServeView from "./components/ServeView.vue";
import CommunityView from "./components/CommunityView.vue";
import BenchmarksView from "./components/BenchmarksView.vue";
import AnalyticsView from "./components/AnalyticsView.vue";
import OverviewView from "./components/OverviewView.vue";
import UsageView from "./components/UsageView.vue";
import ChatsView from "./components/ChatsView.vue";
import AuditView from "./components/AuditView.vue";
import LogsView from "./components/LogsView.vue";
import HubSettingsModal from "./components/HubSettingsModal.vue";
import TelemetryDrawer from "./components/TelemetryDrawer.vue";
import TransfersDock from "./components/TransfersDock.vue";
import BsIcon from "./components/BsIcon.vue";
import NodeModal from "./components/NodeModal.vue";
import { parseHash, chatsHash, usageHash, type Route } from "./router";
import { tier } from "./tiers";
import { loadServerVersion, serverCadenceMs, serverTag, serverVersion } from "./version";
import { loadCostSettings } from "./cost-settings";
import { fetchModelsPage } from "./models";
import { fetchSetups } from "./serve";
import { fmtTps, fmtWatts } from "./analytics";
import { OVERVIEW_RANGES, pickPrimaryPort, snapshotNodeWatts } from "./overview";
import { overviewRange, setOverviewRange } from "./range";

const { connected } = live;

/** Fleet power now: per reporting node gpu + cpu package + base overhead,
 *  clamped to the GB10 envelope — the same math as the server power analytics
 *  (shared snapshotNodeWatts; IR-224 S6 uses it for the Overview now-surfaces). */
const fleetWatts = computed<number | null>(() => {
  let total: number | null = null;
  for (const snap of live.snapshots.values()) {
    const w = snapshotNodeWatts(snap);
    if (w === null) continue; // nothing readable on this node
    total = (total ?? 0) + w;
  }
  return total;
});
const wattsText = computed(() => (fleetWatts.value === null ? null : fmtWatts(fleetWatts.value)));

/** Sidebar-foot / mobile-menu status line: connection plus the hub cadence. */
const liveStatusText = computed(() => {
  if (!connected.value) return "Offline";
  return serverCadenceMs.value === null ? "Live" : `Live · ${Math.round(serverCadenceMs.value / 1000)} s`;
});

const route = ref<Route>(
  parseHash(typeof location === "undefined" ? "" : location.hash),
);

function onHashChange(): void {
  route.value = parseHash(location.hash);
}

// Nav counts are totals only (IR-214 shell contract): nodes from the live
// registry; models and serve setups fetched from the hub. Re-fetched on
// navigation and reconnect so page totals and nav counts cannot drift.
const modelsTotal = ref<number | null>(null);
const setupsTotal = ref<number | null>(null);
async function refreshNavCounts(): Promise<void> {
  try {
    modelsTotal.value = (await fetchModelsPage(1, "", "recent")).total;
  } catch {
    /* nav counts are cosmetic — never block the shell */
  }
  try {
    setupsTotal.value = (await fetchSetups()).length;
  } catch {
    /* same */
  }
}

// IR-128: below the sidebar breakpoint the nav collapses into a hamburger
// disclosure. Escape returns focus to the toggle (APG); outside clicks
// close; link activation closes — SPA navigation does not unmount the
// header, so a same-route link would otherwise strand it open.
const navOpen = ref(false);
const navToggleBtn = ref<HTMLButtonElement | null>(null);
const navMenuEl = ref<HTMLElement | null>(null);
function closeNav(): void {
  navOpen.value = false;
}
function onDocPointerDown(e: Event): void {
  const target = e.target as Node;
  if (navOpen.value && !navMenuEl.value?.contains(target) && !navToggleBtn.value?.contains(target)) closeNav();
  if (railRangeOpen.value && !railRangeSeg.value?.contains(target) && !railRangeBtn.value?.contains(target)) railRangeOpen.value = false;
}
function onDocKeydown(e: KeyboardEvent): void {
  if (e.key !== "Escape" || !navOpen.value) return;
  closeNav();
  navToggleBtn.value?.focus();
}
watch(
  () => route.value.view,
  () => {
    closeNav();
    railRangeOpen.value = false;
    void refreshNavCounts();
  },
);
watch(connected, () => {
  void refreshNavCounts();
});
watch(tier, () => closeNav());

const detailNodeId = computed(() =>
  route.value.view === "node" ? route.value.id : null,
);

/** IRI-019: the gear opens hub-wide settings (global HF token). */
const hubSettingsOpen = ref(false);

/** IRI-043: always-available live telemetry drawer. */
const telemetryOpen = ref(false);

/** IR-131 shape B: the cross-page transfers dock. */
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

// ─── IR-224 S4: collapsible sidebar, menu Add node, collapsed-rail popover ──
const navCollapsed = ref(
  (() => {
    try {
      return localStorage.getItem("irori.sidebar.collapsed") === "1";
    } catch {
      return false;
    }
  })(),
);
watchEffect(() => {
  // The mockup contract keys the collapsed rail off html[data-nav]; the pick
  // persists (try/catch like irori-theme) and survives reloads.
  if (navCollapsed.value) document.documentElement.dataset.nav = "collapsed";
  else delete document.documentElement.dataset.nav;
  try {
    localStorage.setItem("irori.sidebar.collapsed", navCollapsed.value ? "1" : "0");
  } catch {
    /* storage unavailable — the pick still applies for this visit */
  }
});
function toggleCollapse(): void {
  navCollapsed.value = !navCollapsed.value;
}

/** Add node is reachable from any route via the menu (ghost/secondary chip). */
const addNodeOpen = ref(false);

/** Collapsed-rail range popover: position:fixed anchored to the toggle's
 *  rect — it must escape the rail's overflow-x clip (mockup-verified). */
const railRangeOpen = ref(false);
const railRangeBtn = ref<HTMLButtonElement | null>(null);
const railRangeSeg = ref<HTMLElement | null>(null);
function toggleRailRange(): void {
  railRangeOpen.value = !railRangeOpen.value;
  if (!railRangeOpen.value) return;
  void nextTick(() => {
    const btn = railRangeBtn.value;
    const seg = railRangeSeg.value;
    if (btn === null || seg === null) return;
    const r = btn.getBoundingClientRect();
    seg.style.left = `${Math.round(r.right + 8)}px`;
    seg.style.top = `${Math.max(8, Math.round(r.top))}px`;
  });
}

/** IR-224 S4: the topbar perf chip — the busiest serving port (probe truth)
 *  plus fleet watts; hidden on the Overview, whose heroes carry the data. */
const perfChip = computed(() => {
  if (!connected.value) return null;
  for (const node of live.sortedNodes.value) {
    const port = pickPrimaryPort(live.getLlm(node.id)?.ports ?? null);
    if (port !== null && port.model !== null && port.decodeTps !== null) {
      return { model: port.model, decode: fmtTps(port.decodeTps) };
    }
  }
  return null;
});

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
  void refreshNavCounts();
});
onUnmounted(() => {
  window.removeEventListener("hashchange", onHashChange);
  document.removeEventListener("pointerdown", onDocPointerDown);
  document.removeEventListener("keydown", onDocKeydown);
  live.stop();
});
</script>

<template>
  <div class="shell">
    <aside class="bs-sidebar">
      <div class="bs-sidebar__brand">
        <a class="bs-lockup" href="#/" aria-label="Irori home">
          <span class="bs-lockup__glyph" aria-hidden="true"><span class="mark-node"></span><span class="mark-line"></span><span class="mark-square"></span></span>
          <span class="bs-lockup__text">
            <span class="bs-lockup__name">Irori</span>
            <span class="bs-lockup__endorse">A BlasterSystems product</span>
          </span>
        </a>
        <button class="bs-sidebar__collapse" type="button" :aria-expanded="navCollapsed ? 'false' : 'true'" :aria-label="navCollapsed ? 'Expand menu' : 'Collapse menu'" @click="toggleCollapse">
          <BsIcon name="chevron-left" />
        </button>
      </div>
      <nav class="bs-nav" aria-label="Primary">
        <a class="bs-nav-item" href="#/" :aria-current="route.view === 'overview' ? 'page' : undefined"><BsIcon name="overview" /><span class="bs-nav-item__label">Overview</span><span v-if="live.nodes.size > 0" class="bs-nav-item__count">{{ live.nodes.size }}</span></a>
        <a class="bs-nav-item" href="#/models" :aria-current="route.view === 'models' ? 'page' : undefined"><BsIcon name="models" /><span class="bs-nav-item__label">Models</span><span v-if="modelsTotal !== null" class="bs-nav-item__count">{{ modelsTotal }}</span></a>
        <a class="bs-nav-item" href="#/serve" :aria-current="route.view === 'serve' ? 'page' : undefined"><BsIcon name="serve" /><span class="bs-nav-item__label">Serve</span><span v-if="setupsTotal !== null" class="bs-nav-item__count">{{ setupsTotal }}</span></a>
        <a class="bs-nav-item" href="#/analytics" :aria-current="route.view === 'analytics' ? 'page' : undefined"><BsIcon name="analytics" /><span class="bs-nav-item__label">Analytics</span></a>
        <a class="bs-nav-item" :href="usageHash()" :aria-current="route.view === 'usage' ? 'page' : undefined"><BsIcon name="usage" /><span class="bs-nav-item__label">Usage</span></a>
        <a class="bs-nav-item" :href="chatsHash()" :aria-current="route.view === 'chats' ? 'page' : undefined"><BsIcon name="chats" /><span class="bs-nav-item__label">Chats</span></a>
        <a class="bs-nav-item" href="#/benchmarks" :aria-current="route.view === 'benchmarks' ? 'page' : undefined"><BsIcon name="benchmarks" /><span class="bs-nav-item__label">Benchmarks</span></a>
        <a class="bs-nav-item" href="#/audit" :aria-current="route.view === 'audit' ? 'page' : undefined"><BsIcon name="audit" /><span class="bs-nav-item__label">Audit</span></a>
        <a class="bs-nav-item" href="#/logs" :aria-current="route.view === 'logs' ? 'page' : undefined"><BsIcon name="logs" /><span class="bs-nav-item__label">Logs</span></a>
        <a class="bs-nav-item" href="#/community" :aria-current="route.view === 'community' ? 'page' : undefined"><BsIcon name="community" /><span class="bs-nav-item__label">Community</span></a>
      </nav>
      <div class="bs-sidebar__tools">
        <span class="tools-label">Range</span>
        <div class="rangeseg" role="group" aria-label="History range">
          <button v-for="r in OVERVIEW_RANGES" :key="r.value" type="button" :class="{ 'is-active': overviewRange === r.value }" :aria-pressed="overviewRange === r.value ? 'true' : 'false'" @click="setOverviewRange(r.value)">{{ r.label }}</button>
        </div>
        <div class="rangeseg-pop" :class="{ 'is-open': railRangeOpen }">
          <button ref="railRangeBtn" class="iconbtn" type="button" aria-label="History range" :aria-expanded="railRangeOpen ? 'true' : 'false'" @click.stop="toggleRailRange">
            <BsIcon name="clock" />
          </button>
          <div ref="railRangeSeg" class="rangeseg" role="group" aria-label="History range">
            <button v-for="r in OVERVIEW_RANGES" :key="r.value" type="button" :class="{ 'is-active': overviewRange === r.value }" :aria-pressed="overviewRange === r.value ? 'true' : 'false'" @click="setOverviewRange(r.value)">{{ r.label }}</button>
          </div>
        </div>
        <button class="btn btn--secondary btn--sm" type="button" title="Register a node and install the agent" @click="addNodeOpen = true">
          <BsIcon name="plus" /><span class="tools-cta-label">Add node</span>
        </button>
      </div>
      <div class="bs-sidebar__foot">
        <span class="bs-sidebar__status">
          <span><span v-if="connected" class="pulse" aria-hidden="true"></span>&nbsp;{{ liveStatusText }}</span>
          <span>Irori {{ serverVersion ?? "…" }}<template v-if="serverTag"> · {{ serverTag }}</template></span>
          <span v-if="wattsText">{{ wattsText }}</span>
        </span>
      </div>
    </aside>

    <div class="main">
      <header class="bs-topbar">
        <div class="row grow" style="min-width: 0">
          <button ref="navToggleBtn" class="iconbtn bs-topbar__menubtn" aria-label="Menu" aria-controls="navMenu" :aria-expanded="navOpen ? 'true' : 'false'" @click.stop="navOpen = !navOpen">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
          </button>
          <a class="bs-topbar__brand" href="#/" aria-label="Irori home">
            <span class="bs-lockup__glyph" style="width: 22px; height: 8px" aria-hidden="true">
              <span class="mark-node" style="width: 8px; height: 8px; border-width: 1.5px"></span>
              <span class="mark-line" style="left: 8px; right: 8px; top: 3.25px; height: 1.5px"></span>
              <span class="mark-square" style="width: 8px; height: 8px"></span>
            </span>
            <span class="bs-lockup__name" style="font-size: 15px">Irori</span>
          </a>
          <span v-if="!connected" class="chip chip--warn"><span class="dot dot--warn" aria-hidden="true"></span> Offline</span>
        </div>
        <div class="row bs-topbar__group">
          <a v-if="perfChip !== null && route.view !== 'overview'" class="bs-perf" href="#/serve" title="Inference server · live — open Serve">
            <span class="pulse" aria-hidden="true"></span>
            <span class="bs-perf__model">{{ perfChip.model }}</span>
            <span class="bs-perf__sep bs-perf__sep--model">·</span>
            {{ perfChip.decode }}
            <span class="bs-perf__sep">·</span>
            {{ wattsText ?? "—" }}
          </a>
          <button class="btn btn--secondary btn--sm" aria-label="Open transfers" @click="transfersOpen = true">Transfers<span v-if="activeTransfers > 0" class="countbub">{{ activeTransfers }}</span></button>
          <button class="btn btn--secondary btn--sm" aria-label="Open live telemetry" @click="telemetryOpen = true">Telemetry</button>
          <button class="iconbtn" aria-label="Hub settings" title="Hub settings" @click="hubSettingsOpen = true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33 1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82 1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>
          </button>
          <button class="bs-theme" type="button" aria-label="Toggle theme" @click="toggleTheme"><span></span></button>
        </div>
        <nav ref="navMenuEl" id="navMenu" class="bs-topbar__menu" :class="{ 'is-open': navOpen }" aria-label="Primary menu">
          <a class="bs-nav-item" href="#/" :aria-current="route.view === 'overview' ? 'page' : undefined"><span class="bs-nav-item__label">Overview</span><span v-if="live.nodes.size > 0" class="bs-nav-item__count">{{ live.nodes.size }}</span></a>
          <a class="bs-nav-item" href="#/models" :aria-current="route.view === 'models' ? 'page' : undefined"><span class="bs-nav-item__label">Models</span><span v-if="modelsTotal !== null" class="bs-nav-item__count">{{ modelsTotal }}</span></a>
          <a class="bs-nav-item" href="#/serve" :aria-current="route.view === 'serve' ? 'page' : undefined"><span class="bs-nav-item__label">Serve</span><span v-if="setupsTotal !== null" class="bs-nav-item__count">{{ setupsTotal }}</span></a>
          <a class="bs-nav-item" href="#/analytics" :aria-current="route.view === 'analytics' ? 'page' : undefined"><span class="bs-nav-item__label">Analytics</span></a>
          <a class="bs-nav-item" :href="usageHash()" :aria-current="route.view === 'usage' ? 'page' : undefined"><span class="bs-nav-item__label">Usage</span></a>
          <a class="bs-nav-item" :href="chatsHash()" :aria-current="route.view === 'chats' ? 'page' : undefined"><span class="bs-nav-item__label">Chats</span></a>
          <a class="bs-nav-item" href="#/benchmarks" :aria-current="route.view === 'benchmarks' ? 'page' : undefined"><span class="bs-nav-item__label">Benchmarks</span></a>
          <a class="bs-nav-item" href="#/audit" :aria-current="route.view === 'audit' ? 'page' : undefined"><span class="bs-nav-item__label">Audit</span></a>
          <a class="bs-nav-item" href="#/logs" :aria-current="route.view === 'logs' ? 'page' : undefined"><span class="bs-nav-item__label">Logs</span></a>
          <a class="bs-nav-item" href="#/community" :aria-current="route.view === 'community' ? 'page' : undefined"><span class="bs-nav-item__label">Community</span></a>
          <div class="bs-sidebar__tools" style="padding-top: 8px">
            <span class="tools-label">Range</span>
            <div class="rangeseg" role="group" aria-label="History range">
              <button v-for="r in OVERVIEW_RANGES" :key="r.value" type="button" :class="{ 'is-active': overviewRange === r.value }" :aria-pressed="overviewRange === r.value ? 'true' : 'false'" @click="setOverviewRange(r.value)">{{ r.label }}</button>
            </div>
            <button class="btn btn--secondary btn--sm" type="button" @click="addNodeOpen = true"><span class="tools-cta-label">Add node</span></button>
          </div>
          <div class="bs-menu-foot">
            <span>deploy {{ serverTag ?? "unknown" }}</span>
            <span>{{ liveStatusText }}<template v-if="wattsText"> · {{ wattsText }}</template></span>
          </div>
        </nav>
      </header>

      <main class="content">
        <ModelsView v-if="route.view === 'models'" />
        <ServeView v-else-if="route.view === 'serve'" :route="route" />
        <CommunityView v-else-if="route.view === 'community'" />
        <BenchmarksView v-else-if="route.view === 'benchmarks'" />
        <AnalyticsView v-else-if="route.view === 'analytics'" />
        <UsageView v-else-if="route.view === 'usage'" />
        <ChatsView v-else-if="route.view === 'chats'" />
        <AuditView v-else-if="route.view === 'audit'" />
        <LogsView v-else-if="route.view === 'logs'" />
        <NodeDetail v-else-if="detailNodeId !== null" :node-id="detailNodeId" />
        <OverviewView v-else />
      </main>
    </div>
  </div>

  <HubSettingsModal v-if="hubSettingsOpen" @close="hubSettingsOpen = false" />
  <TelemetryDrawer v-if="telemetryOpen" @close="telemetryOpen = false" />
  <TransfersDock v-if="transfersOpen" @close="transfersOpen = false" />
  <NodeModal v-if="addNodeOpen" mode="create" @close="addNodeOpen = false" />
</template>

<style scoped>
/* IR-197 S1 carries over: every topbar control gets the 44px touch floor on
   tiers under full (≤720 is also covered by the shared .iconbtn rule). The
   v1.1 footer is superseded — version/watts live in the sidebar foot and the
   refresh-note; the deploy tag keeps its committed hamburger-menu home. */
html[data-tier="medium"] .bs-topbar .iconbtn,
html[data-tier="small"] .bs-topbar .iconbtn { width: 44px; height: 44px; }
html[data-tier="medium"] .bs-topbar .bs-theme,
html[data-tier="small"] .bs-topbar .bs-theme { width: 44px; height: 44px; }
html[data-tier="medium"] .bs-topbar .btn,
html[data-tier="small"] .bs-topbar .btn { min-height: 44px; }
html[data-tier="medium"] .bs-topbar .bs-perf,
html[data-tier="small"] .bs-topbar .bs-perf { min-height: 44px; }
</style>
