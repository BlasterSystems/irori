<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type { HardwareSnapshot, NodeInfo } from "@irori/core";
import { GB10_SYSTEM_ENVELOPE_W } from "@irori/core";
import { live } from "../live";
import NodeCard from "./NodeCard.vue";
import NodeModal from "./NodeModal.vue";
import LensChartVue from "./LensChart.vue";
import { fetchAnalytics, fetchLlmHistory } from "../api";
import { fetchModelsPage } from "../models";
import {
  computeHeroData,
  computeNasData,
  computePower,
  feedLines,
  heroSpark,
  peakDecode,
  pickPrimaryPort,
  relativeTime,
  type PowerData,
} from "../overview";
import { groupNodes } from "../llm-data";
import { fmtBytes, fmtBucket, fmtTps, fmtWatts, type LensChart } from "../analytics";

/** Lens segment (mockup round 5, owner decision: default Cluster). The
 *  mockup's "nas" button is simply the NAS node's per-node lens. */
type Lens = "cluster" | "all" | `node:${string}`;
const lens = ref<Lens>("cluster");

const { sortedNodes } = live;
const totalCount = computed(() => sortedNodes.value.length);
const onlineCount = computed(() => sortedNodes.value.filter((n) => n.online).length);

/** Primary head anchors the cluster lens; null while the fleet is empty. */
const headNode = computed<NodeInfo | null>(() => groupNodes(sortedNodes.value).heads[0] ?? null);
const nasNode = computed<NodeInfo | null>(() => sortedNodes.value.find((n) => n.kind === "nas") ?? null);

const hero = computed(() => computeHeroData(live.getLlm(headNode.value?.id ?? "")?.ports ?? null));

const lensOptions = computed(() => [
  { key: "cluster" as Lens, label: hero.value?.model !== null && hero.value?.model !== undefined ? `Cluster · ${hero.value.model}` : "Cluster" },
  { key: "all" as Lens, label: "All fleet" },
  ...sortedNodes.value.map((n) => ({ key: `node:${n.id}` as Lens, label: n.name })),
]);

/** Cluster lens: hero replaces the head card; workers follow. */
const lensNodes = computed<NodeInfo[]>(() => {
  if (lens.value === "all") return sortedNodes.value;
  if (lens.value.startsWith("node:")) {
    const id = lens.value.slice("node:".length);
    const node = sortedNodes.value.find((n) => n.id === id);
    return node === undefined ? [] : [node];
  }
  const groups = groupNodes(sortedNodes.value);
  const rest = [...groups.workers, ...groups.standalone];
  return hero.value === null ? [...groups.heads, ...rest] : rest;
});

const sectionTitle = computed(() => {
  if (lens.value === "cluster") return "Workers";
  if (lens.value.startsWith("node:")) {
    const id = lens.value.slice("node:".length);
    return sortedNodes.value.find((n) => n.id === id)?.kind === "nas" ? "NAS" : "Nodes";
  }
  return "Nodes";
});

// ─── hero 24h spark ─────────────────────────────────────────────────────────

const sparkChart = ref<LensChart | null>(null);
const sparkPeak = ref<number | null>(null);

async function refreshSpark(): Promise<void> {
  const head = headNode.value;
  if (head === null) return;
  try {
    const hist = await fetchLlmHistory(head.id, "24h");
    const ports = live.getLlm(head.id)?.ports ?? null;
    const primary = pickPrimaryPort(ports);
    const series = hist.series.find((s) => s.port === primary?.port) ?? hist.series[0];
    if (series === undefined) return;
    sparkChart.value = heroSpark(series.points);
    sparkPeak.value = peakDecode(series.points);
  } catch {
    // History unavailable — the hero renders current stats without the spark.
  }
}

// ─── power + NAS store cards ────────────────────────────────────────────────

const power = ref<PowerData | null>(null);
const nasModelCount = ref<number | null>(null);
const nasNewestAddedAt = ref<string | null>(null);

const nas = computed(() =>
  computeNasData(nasModelCount.value, nasNewestAddedAt.value, nasNode.value === null ? null : (live.snapshots.get(nasNode.value.id) ?? null)),
);
const storeText = computed(() =>
  nas.value.storeUsedBytes !== null && nas.value.storeTotalBytes !== null
    ? `${fmtBytes(nas.value.storeUsedBytes)} / ${fmtBytes(nas.value.storeTotalBytes)}`
    : null,
);
const newestText = computed(() => relativeTime(nas.value.newestAddedAt, Date.now()));

async function refreshCards(): Promise<void> {
  try {
    power.value = computePower((await fetchAnalytics("power", "1h", "node")).series);
  } catch {
    // Analytics unavailable (degraded DB) — card stays empty.
  }
  try {
    const page = await fetchModelsPage(1, "", "recent");
    nasModelCount.value = page.total;
    nasNewestAddedAt.value = page.models[0]?.firstSeenAt ?? null;
  } catch {
    // Store unavailable — card stays empty.
  }
}

// ─── feed ───────────────────────────────────────────────────────────────────

const feed = computed(() => feedLines(live.events.value, (id) => live.nodes.get(id)?.name ?? "node", 30));

// ─── add node + lifecycle ───────────────────────────────────────────────────

const addOpen = ref(false);

let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  void refreshCards();
  void refreshSpark();
  timer = setInterval(() => {
    void refreshCards();
    void refreshSpark();
  }, 60_000);
});
// OverviewView mounts before App's live.init() seeds the registry — the head
// (and with it the spark source) can appear only after the first fetch.
watch(
  () => headNode.value?.id,
  (id, prev) => {
    if (id !== undefined && id !== prev) void refreshSpark();
  },
);
onUnmounted(() => {
  if (timer !== null) clearInterval(timer);
});

// ─── formatting helpers ─────────────────────────────────────────────────────

function uptimeText(node: NodeInfo | null, snapshot: HardwareSnapshot | null | undefined): string {
  const s = snapshot?.uptimeS;
  if (typeof s !== "number" || !Number.isFinite(s)) return node?.online === true ? "online" : "offline";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return d > 0 ? `uptime ${d}d ${h}h` : `uptime ${h}h`;
}

function num(v: number | null | undefined): string {
  return typeof v === "number" ? String(Math.round(v)) : "—";
}

function ms(v: number | null | undefined): string {
  return typeof v === "number" ? `${Math.round(v)} ms` : "—";
}

function powerBarPct(watts: number | null): number {
  return watts === null ? 0 : Math.min(100, (watts / GB10_SYSTEM_ENVELOPE_W) * 100);
}

function servingState(decodeTps: number | null): string {
  return decodeTps !== null ? "serving" : "detected";
}
</script>

<template>
  <div class="pagehead">
    <div>
      <h1>Overview</h1>
      <p>
        <span class="mono faint">Fleet lens — serving state first. {{ totalCount }} nodes · {{ onlineCount }} online<template v-if="totalCount > 0"> · {{ lensNodes.length }} in lens</template></span>
      </p>
    </div>
    <div class="row">
      <div class="seg" role="group" aria-label="Lens">
        <button v-for="l in lensOptions" :key="l.key" :class="{ 'is-active': lens === l.key }" @click="lens = l.key">{{ l.label }}</button>
      </div>
      <button class="btn btn--primary" @click="addOpen = true">Add node…</button>
    </div>
  </div>

  <!-- Head hero: serving state is the primary object (cluster lens only) -->
  <section v-if="lens === 'cluster' && hero !== null && headNode !== null" class="cols cols-side" style="margin-bottom: 12px;">
    <article class="card">
      <div class="card__head">
        <div class="row">
          <h3>{{ headNode.name }}</h3>
          <span class="chip chip--accent">head</span>
          <span class="chip">{{ headNode.kind }}</span>
          <span v-if="headNode.agentVersion" class="chip">Agent {{ headNode.agentVersion }}</span>
        </div>
        <span class="mono faint">{{ uptimeText(headNode, live.snapshots.get(headNode.id)) }}</span>
      </div>
      <div class="card__body">
        <div class="row row--between" style="margin-bottom: 10px;">
          <div class="row">
            <span class="mono" style="font-size: 17px; font-weight: 500;">{{ hero.model ?? "model unknown" }}</span>
            <span class="chip chip--ok">{{ hero.backend }} :{{ hero.port }}</span>
          </div>
          <span class="mono faint">{{ servingState(hero.decodeTps) }}</span>
        </div>
        <div class="statgrid statgrid--6">
          <div class="stat"><span class="stat__label">Decode</span><span class="stat__value">{{ fmtTps(hero.decodeTps) }}</span><span v-if="sparkPeak !== null" class="stat__sub">peak {{ Math.round(sparkPeak) }}</span></div>
          <div class="stat"><span class="stat__label">Prefill</span><span class="stat__value">{{ fmtTps(hero.prefillTps) }}</span><span v-if="hero.cacheHitPct !== null" class="stat__sub">cache hit {{ Math.round(hero.cacheHitPct) }}%</span></div>
          <div class="stat"><span class="stat__label">Queue</span><span class="stat__value">{{ num(hero.queueRunning) }} · {{ num(hero.queueWaiting) }}</span><span class="stat__sub">running · waiting</span></div>
          <div class="stat"><span class="stat__label">KV cache</span><span class="stat__value">{{ num(hero.kvCachePct === null ? null : Math.round(hero.kvCachePct)) }}<template v-if="hero.kvCachePct !== null">%</template></span><div v-if="hero.kvCachePct !== null" class="bar" style="margin-top: 6px;"><div class="bar__fill" :style="{ width: hero.kvCachePct + '%' }"></div></div></div>
          <div class="stat"><span class="stat__label">TTFT p95</span><span class="stat__value">{{ ms(hero.ttftP95Ms) }}</span><span v-if="hero.e2eP95Ms !== null" class="stat__sub">E2E {{ Math.round(hero.e2eP95Ms) }} ms</span></div>
          <div class="stat"><span class="stat__label">ITL p95</span><span class="stat__value">{{ ms(hero.itlP95Ms) }}</span><span class="stat__sub">60m window</span></div>
        </div>
        <LensChartVue v-if="sparkChart !== null" :chart="sparkChart" unit="tok/s" :format="fmtTps" style="margin-top: 12px;" aria-label="decode and prefill, 24h" />
      </div>
    </article>

    <div class="stack">
      <article class="card">
        <div class="card__head"><h3>Power</h3><span class="chip">estimated</span></div>
        <div class="card__body" style="padding-top: 12px;">
          <div class="stat"><span class="stat__label">Fleet now</span><span class="stat__value">{{ power?.fleetNow !== null && power?.fleetNow !== undefined ? fmtWatts(power.fleetNow) : "—" }}</span></div>
          <div style="margin-top: 10px;">
            <div v-for="n in power?.nodes ?? []" :key="n.key" class="barrow">
              <span>{{ n.label }}</span>
              <div class="bar"><div class="bar__fill" :style="{ width: powerBarPct(n.watts) + '%' }"></div></div>
              <span class="val">{{ fmtWatts(n.watts) }}</span>
            </div>
            <p v-if="power?.nodes.length === 0" class="stat__sub">no power data yet</p>
          </div>
        </div>
      </article>
      <article v-if="nasNode !== null" class="card">
        <div class="card__head"><h3>{{ nasNode.name }}</h3><span class="chip chip--accent">NAS store</span></div>
        <div class="card__body" style="padding-top: 12px;">
          <div class="stat"><span class="stat__label">Models</span><span class="stat__value">{{ nas.modelCount ?? "—" }}</span></div>
          <div v-if="storeText !== null" style="margin-top: 10px;" class="barrow">
            <span>store</span>
            <div class="bar"><div class="bar__fill" :style="{ width: (nas.storePct ?? 0) + '%' }"></div></div>
            <span class="val">{{ storeText }}</span>
          </div>
          <p v-if="newestText !== null" class="stat__sub" style="margin-top: 10px;">newest added {{ newestText }}</p>
        </div>
      </article>
    </div>
  </section>

  <h2 style="margin: 20px 0 10px;">{{ sectionTitle }}</h2>
  <section v-if="lensNodes.length > 0" class="cols cols-3">
    <NodeCard v-for="node in lensNodes" :key="node.id" :node="node" :snapshot="live.snapshots.get(node.id) ?? null" :llm="live.getLlm(node.id)" />
  </section>
  <div v-else class="ghost-grid" style="min-height: 120px; flex-direction: column; gap: 8px;">
    <span>{{ totalCount === 0 ? "no nodes yet" : "nothing in this lens" }}</span>
    <span v-if="totalCount === 0" style="letter-spacing: 0; text-transform: none;">add your first node → register the nas → download a model → serve</span>
  </div>

  <!-- All event classes in one feed (owner decision) -->
  <section class="card" style="margin-bottom: 12px;">
    <div class="card__head"><h3>Telemetry</h3><span class="chip">streaming</span></div>
    <div class="card__body card__body--flush">
      <div class="log" style="border: 0; border-radius: 0 0 var(--radius) var(--radius); min-height: 120px; max-height: 220px;">
        <div v-for="(line, i) in feed" :key="`${line.t}-${i}`"><span class="dim">{{ fmtBucket(line.t, "minute") }}</span> {{ line.text }}</div>
        <div v-if="feed.length === 0" class="dim">waiting for events…</div>
      </div>
    </div>
  </section>

  <NodeModal v-if="addOpen" mode="create" @close="addOpen = false" />
</template>
