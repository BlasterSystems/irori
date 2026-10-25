<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type { HardwareSnapshot, NodeInfo, SetupInfo } from "@irori/core";
import { GB10_SYSTEM_ENVELOPE_W } from "@irori/core";
import { live } from "../live";
import NodeCard from "./NodeCard.vue";
import NodeModal from "./NodeModal.vue";
import LensChartVue from "./LensChart.vue";
import { fetchAnalytics, fetchLlmHistory, type LlmHistoryPoint } from "../api";
import { fetchModelsPage } from "../models";
import { fetchSetups } from "../serve";
import {
  computeNasData,
  computePower,
  feedLines,
  heroDataForPort,
  heroSpark,
  peakDecode,
  relativeTime,
  type HeroData,
  type PowerData,
} from "../overview";
import { DISK_WARN_PCT, fmtBytes, fmtBucket, fmtTps, fmtWatts, type LensChart } from "../analytics";

const { sortedNodes } = live;
const totalCount = computed(() => sortedNodes.value.length);
const onlineCount = computed(() => sortedNodes.value.filter((n) => n.online).length);
/** Every spark node — heads included (they serve too); the NAS keeps its own card. */
const sparkNodes = computed(() => sortedNodes.value.filter((n) => n.kind !== "nas"));
const nasNode = computed<NodeInfo | null>(() => sortedNodes.value.find((n) => n.kind === "nas") ?? null);

// ─── serving processes: one hero card per running setup, detected engines last ──

interface HeroProcess {
  key: string;
  title: string;
  kind: "single" | "cluster" | "engine";
  nodeId: string;
  nodeName: string;
  hero: HeroData;
}

const setups = ref<SetupInfo[]>([]);

async function refreshSetups(): Promise<void> {
  try {
    setups.value = await fetchSetups();
  } catch {
    /* registry unavailable — heroes keep the last known state */
  }
}

const EMPTY_HERO: HeroData = {
  port: 0,
  backend: "unknown",
  model: null,
  decodeTps: null,
  prefillTps: null,
  queueRunning: null,
  queueWaiting: null,
  kvCachePct: null,
  ttftP95Ms: null,
  e2eP95Ms: null,
  itlP95Ms: null,
  cacheHitPct: null,
};

const heroProcesses = computed<HeroProcess[]>(() => {
  const processes: HeroProcess[] = [];
  const covered = new Set<string>();
  for (const s of setups.value) {
    if (s.status !== "running") continue;
    covered.add(`${s.headNodeId}:${s.port}`);
    const snap = live.getLlm(s.headNodeId)?.ports?.find((p) => p.port === s.port) ?? null;
    processes.push({
      key: s.id,
      title: s.name,
      kind: s.kind,
      nodeId: s.headNodeId,
      nodeName: live.nodes.get(s.headNodeId)?.name ?? "node",
      hero: snap === null ? { ...EMPTY_HERO, port: s.port, model: s.model } : heroDataForPort(snap),
    });
  }
  // Engines probed on some node but managed by no setup still serve traffic —
  // a minimal card keeps them visible instead of only the node's inline line.
  for (const node of sortedNodes.value) {
    for (const p of live.getLlm(node.id)?.ports ?? []) {
      const key = `${node.id}:${p.port}`;
      if (covered.has(key) || p.detected !== true) continue;
      covered.add(key);
      processes.push({
        key: `engine-${key}`,
        title: p.model ?? `port ${p.port}`,
        kind: "engine",
        nodeId: node.id,
        nodeName: node.name,
        hero: heroDataForPort(p),
      });
    }
  }
  return processes;
});

// ─── per-process 30m charts (one history fetch per distinct serving node) ────

const charts = ref<Map<string, { chart: LensChart; peak: number | null }>>(new Map());
let chartSeq = 0;

async function refreshCharts(): Promise<void> {
  const seq = ++chartSeq;
  const perNode = new Map<string, Set<number>>();
  for (const p of heroProcesses.value) {
    const ports = perNode.get(p.nodeId) ?? new Set<number>();
    ports.add(p.hero.port);
    perNode.set(p.nodeId, ports);
  }
  const next = new Map<string, { chart: LensChart; peak: number | null }>();
  for (const [nodeId, ports] of perNode) {
    let series: Array<{ port: number; points: LlmHistoryPoint[] }> = [];
    try {
      series = (await fetchLlmHistory(nodeId, "30m")).series;
    } catch {
      continue; // history unavailable — charts keep their last data
    }
    if (seq !== chartSeq) return;
    for (const port of ports) {
      const points = series.find((s) => s.port === port)?.points;
      if (points === undefined) continue;
      const process = heroProcesses.value.find((p) => p.nodeId === nodeId && p.hero.port === port);
      if (process === undefined) continue;
      next.set(process.key, { chart: heroSpark(points), peak: peakDecode(points) });
    }
  }
  if (seq === chartSeq) charts.value = next;
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

let processTimer: ReturnType<typeof setInterval> | null = null;
let cardsTimer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  void refreshCards();
  void refreshSetups().then(() => void refreshCharts());
  void refreshCharts();
  processTimer = setInterval(() => void refreshSetups(), 5_000);
  cardsTimer = setInterval(() => {
    void refreshCards();
    void refreshCharts();
  }, 60_000);
});
onUnmounted(() => {
  if (processTimer !== null) clearInterval(processTimer);
  if (cardsTimer !== null) clearInterval(cardsTimer);
});
// New or removed processes appear as soon as the registry poll lands.
watch(
  () => heroProcesses.value.map((p) => p.key).join("|"),
  () => void refreshCharts(),
);

// ─── formatting helpers ─────────────────────────────────────────────────────

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
  return decodeTps !== null ? "serving" : "starting";
}
</script>

<template>
  <div class="pagehead">
    <div>
      <h1>Overview</h1>
      <p>
        <span class="mono faint">{{ totalCount }} nodes · {{ onlineCount }} online · {{ heroProcesses.length }} serving</span>
      </p>
    </div>
    <div class="row">
      <button class="btn btn--primary" @click="addOpen = true">Add node…</button>
    </div>
  </div>

  <!-- Serving processes: one card per running setup, then detected engines -->
  <section v-if="heroProcesses.length > 0" class="hero-grid" style="margin-bottom: 12px;">
    <article v-for="p in heroProcesses" :key="p.key" class="card">
      <div class="card__head">
        <div class="row">
          <h3>{{ p.title }}</h3>
          <span class="chip chip--accent">{{ p.kind }}</span>
          <span class="chip chip--ok">{{ p.hero.backend }} :{{ p.hero.port }}</span>
        </div>
        <span class="mono faint">{{ p.nodeName }}</span>
      </div>
      <div class="card__body">
        <div class="row row--between" style="margin-bottom: 10px;">
          <span class="mono" style="font-size: 15px; font-weight: 500;">{{ p.hero.model ?? "model unknown" }}</span>
          <span class="mono faint">{{ servingState(p.hero.decodeTps) }}</span>
        </div>
        <div class="statgrid statgrid--6">
          <div class="stat"><span class="stat__label">Decode</span><span class="stat__value">{{ fmtTps(p.hero.decodeTps) }}</span><span v-if="charts.get(p.key)?.peak != null" class="stat__sub">peak {{ Math.round(charts.get(p.key)!.peak!) }}</span></div>
          <div class="stat"><span class="stat__label">Prefill</span><span class="stat__value">{{ fmtTps(p.hero.prefillTps) }}</span><span v-if="p.hero.cacheHitPct !== null" class="stat__sub">cache hit {{ Math.round(p.hero.cacheHitPct) }}%</span></div>
          <div class="stat"><span class="stat__label">Queue</span><span class="stat__value">{{ num(p.hero.queueRunning) }} · {{ num(p.hero.queueWaiting) }}</span><span class="stat__sub">running · waiting</span></div>
          <div class="stat"><span class="stat__label">KV cache</span><span class="stat__value">{{ num(p.hero.kvCachePct === null ? null : Math.round(p.hero.kvCachePct)) }}<template v-if="p.hero.kvCachePct !== null">%</template></span><div v-if="p.hero.kvCachePct !== null" class="bar" style="margin-top: 6px;"><div class="bar__fill" :style="{ width: p.hero.kvCachePct + '%' }"></div></div></div>
          <div class="stat"><span class="stat__label">TTFT p95</span><span class="stat__value">{{ ms(p.hero.ttftP95Ms) }}</span><span v-if="p.hero.e2eP95Ms !== null" class="stat__sub">E2E {{ Math.round(p.hero.e2eP95Ms) }} ms</span></div>
          <div class="stat"><span class="stat__label">ITL p95</span><span class="stat__value">{{ ms(p.hero.itlP95Ms) }}</span></div>
        </div>
        <LensChartVue v-if="charts.get(p.key) !== undefined" :chart="charts.get(p.key)!.chart" unit="tok/s" :format="fmtTps" style="margin-top: 12px;" aria-label="decode and prefill, 30m" />
      </div>
    </article>
  </section>
  <div v-else class="ghost-grid" style="min-height: 120px; margin-bottom: 12px; flex-direction: column; gap: 8px;">
    <span>nothing serving</span>
    <span style="letter-spacing: 0; text-transform: none;">start a setup on the Serve page — it appears here while it runs</span>
  </div>

  <!-- Fleet power + NAS store -->
  <section class="hero-grid" style="margin-bottom: 12px;">
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
          <span class="val" :class="{ 'metric--hot': nas.storePct !== null && nas.storePct >= DISK_WARN_PCT }">{{ storeText }}</span>
        </div>
        <p v-if="newestText !== null" class="stat__sub" style="margin-top: 10px;">newest added {{ newestText }}</p>
      </div>
    </article>
  </section>

  <h2 style="margin: 20px 0 10px;">Nodes</h2>
  <section v-if="sparkNodes.length > 0" class="cols cols-3">
    <NodeCard v-for="node in sparkNodes" :key="node.id" :node="node" :snapshot="live.snapshots.get(node.id) ?? null" :llm="live.getLlm(node.id)" />
  </section>
  <div v-else class="ghost-grid" style="min-height: 120px; flex-direction: column; gap: 8px;">
    <span>{{ totalCount === 0 ? "no nodes yet" : "no spark nodes" }}</span>
    <span v-if="totalCount === 0" style="letter-spacing: 0; text-transform: none;">add your first node → register the nas → download a model → serve</span>
  </div>

  <!-- All event classes in one feed (owner decision) -->
  <section class="card" style="margin-top: 20px; margin-bottom: 12px;">
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

<style scoped>
/* Two-column hero grid (owner decision); collapses under 900px. */
.hero-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
}
@media (max-width: 900px) {
  .hero-grid {
    grid-template-columns: 1fr;
  }
}
</style>
