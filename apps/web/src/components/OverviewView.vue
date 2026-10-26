<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type { HardwareSnapshot, NodeInfo, SetupInfo } from "@irori/core";
import { CURRENCY_SYMBOL, GB10_SYSTEM_ENVELOPE_W, type AnalyticsSeries } from "@irori/core";
import { live } from "../live";
import NodeCard from "./NodeCard.vue";
import NodeModal from "./NodeModal.vue";
import Tip from "./Tip.vue";
import LensChartVue from "./LensChart.vue";
import { fetchAnalytics, fetchLlmHistory, type LlmHistoryPoint } from "../api";
import { downloadBytesLine, downloadEntryEta, downloadProgressPct, downloadSpeedView, fetchDownloadQueue, fetchModelsPage, formatEta, type DownloadQueueEntry } from "../models";
import { fetchSetups } from "../serve";
import { fmtTokens } from "../usage";
import { energyCost, tokenCost } from "../cost-settings";
import {
  binFleetPower,
  computeNasData,
  computePower,
  feedLines,
  fleetEnergyKwh,
  fleetPowerSeries,
  fmtEnergy,
  granularityMs,
  heroDataForPort,
  heroSpark,
  OVERVIEW_RANGES,
  peakDecode,
  powerBarSlot,
  relativeTime,
  tokenCostOf,
  tokenTotals,
  type FleetPowerPoint,
  type HeroData,
  type OverviewRange,
} from "../overview";
import { DISK_WARN_PCT, fmtBytes, fmtBucket, fmtTps, fmtWatts, type LensChart } from "../analytics";
import { clampTipX } from "../sparkline";

const { sortedNodes } = live;
const totalCount = computed(() => sortedNodes.value.length);
const onlineCount = computed(() => sortedNodes.value.filter((n) => n.online).length);
/** Every spark node - heads included (they serve too); the NAS keeps its own card. */
const sparkNodes = computed(() => sortedNodes.value.filter((n) => n.kind !== "nas"));
const sparkIds = computed(() => new Set(sparkNodes.value.map((n) => n.id)));

// ─── range filter (IRI-025): drives the hero charts and the power/token cards
const range = ref<OverviewRange>("30m");
const rangeLabel = computed(() => OVERVIEW_RANGES.find((r) => r.value === range.value)?.label ?? range.value);
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
  const next = new Map(charts.value); // failed nodes keep their last chart
  for (const [nodeId, ports] of perNode) {
    let series: Array<{ port: number; points: LlmHistoryPoint[] }> = [];
    try {
      series = (await fetchLlmHistory(nodeId, range.value)).series;
    } catch {
      continue; // history unavailable — this node's chart stays as-is
    }
    if (seq !== chartSeq) return;
    for (const port of ports) {
      const points = series.find((s) => s.port === port)?.points;
      if (points === undefined) continue;
      const process = heroProcesses.value.find((p) => p.nodeId === nodeId && p.hero.port === port);
      if (process === undefined) continue;
      next.set(process.key, { chart: heroSpark(points, rangeLabel.value), peak: peakDecode(points) });
    }
  }
  if (seq === chartSeq) charts.value = next;
}

// ─── power + NAS store + token cards ────────────────────────────────────────

const rawPower = ref<AnalyticsSeries[]>([]);
const rawTokens = ref<AnalyticsSeries[]>([]);
const powerGranularity = ref<"minute" | "hour" | "day">("hour");
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

/** Fleet aggregation over spark nodes only (the NAS has no power/telemetry). */
const power = computed(() => computePower(rawPower.value.filter((s) => sparkIds.value.has(s.key))));
const fleetPoints = computed(() => fleetPowerSeries(rawPower.value, sparkIds.value));
const powerBars = computed(() => binFleetPower(fleetPoints.value, granularityMs(powerGranularity.value)));
const energyKwh = computed(() => fleetEnergyKwh(fleetPoints.value, granularityMs(powerGranularity.value)));
const tokenSum = computed(() => tokenTotals(rawTokens.value, sparkIds.value));
const tokenCostValue = computed(() => (tokenCost.value === null ? null : tokenCostOf(tokenSum.value, tokenCost.value)));
const currencySymbol = computed(() => {
  if (energyCost.value !== null) return CURRENCY_SYMBOL[energyCost.value.currency];
  if (tokenCost.value !== null) return CURRENCY_SYMBOL[tokenCost.value.currency];
  return null;
});
const fleetNowText = computed(() => (power.value.fleetNow !== null ? fmtWatts(power.value.fleetNow) : "—"));
const energyKwhText = computed(() => {
  if (energyKwh.value === null) return null;
  const kwh = energyKwh.value;
  return kwh >= 100 ? kwh.toFixed(0) : kwh >= 10 ? kwh.toFixed(1) : kwh.toFixed(2);
});
const costText = computed(() => {
  if (energyKwh.value === null || energyCost.value === null) return null;
  return `≈ ${CURRENCY_SYMBOL[energyCost.value.currency]}${(energyKwh.value * energyCost.value.pricePerKwh).toFixed(2)}`;
});
const tokenCostText = computed(() =>
  tokenCostValue.value === null || currencySymbol.value === null ? null : `≈ ${currencySymbol.value}${tokenCostValue.value.toFixed(2)}`,
);
const tokenPriceTip = computed(() => {
  if (tokenCost.value === null) return "";
  const s = CURRENCY_SYMBOL[tokenCost.value.currency];
  return `same period as the power chart · prices: input ${s}${tokenCost.value.input} · cached ${s}${tokenCost.value.cached} · output ${s}${tokenCost.value.output} per Mtok`;
});
const tokenCostTip = computed(() => {
  if (tokenCost.value === null) return "";
  const s = CURRENCY_SYMBOL[tokenCost.value.currency];
  return `(input − cached) × ${s}${tokenCost.value.input} + cached × ${s}${tokenCost.value.cached} + output × ${s}${tokenCost.value.output} · per Mtok`;
});

// Download queue: every download runs on the NAS store node — 10s poll.
const downloads = ref<DownloadQueueEntry[] | null>(null);
const activeDownload = computed(() => downloads.value?.find((e) => e.status === "running") ?? null);
const downloadEtaText = computed(() => {
  const e = activeDownload.value;
  if (e === null) return null;
  const eta = downloadEntryEta(e);
  return eta !== null ? `eta ${formatEta(eta)}` : null;
});
const downloadLineText = computed(() => {
  const e = activeDownload.value;
  if (e === null) return null;
  const pct = downloadProgressPct(e);
  const segs = [pct !== null ? `${pct}%` : "", downloadBytesLine(e) ?? "", downloadSpeedView(e)?.label ?? ""];
  return segs.filter((s) => s !== "").join(" · ") || null;
});

async function refreshDownloads(): Promise<void> {
  try {
    downloads.value = await fetchDownloadQueue();
  } catch {
    /* store unavailable — keep the last known queue */
  }
}

async function refreshCards(): Promise<void> {
  try {
    const res = await fetchAnalytics("power", range.value, "node");
    rawPower.value = res.series;
    powerGranularity.value = res.granularity;
  } catch {
    // Analytics unavailable (degraded DB) — card stays empty.
  }
  try {
    const res = await fetchAnalytics("tokens", range.value, "node");
    rawTokens.value = res.series;
  } catch {
    // Ledger unavailable — the token stats stay empty.
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

const feed = computed(() => feedLines(live.events.value, (id) => live.nodes.get(id)?.name ?? "node", 120, (jobId) => live.jobs.get(jobId)));

// ─── add node + lifecycle ───────────────────────────────────────────────────

const addOpen = ref(false);

let processTimer: ReturnType<typeof setInterval> | null = null;
let cardsTimer: ReturnType<typeof setInterval> | null = null;
let downloadTimer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  void refreshCards();
  void refreshSetups().then(() => void refreshCharts());
  void refreshCharts();
  void refreshDownloads();
  processTimer = setInterval(() => void refreshSetups(), 5_000);
  downloadTimer = setInterval(() => void refreshDownloads(), 10_000);
  cardsTimer = setInterval(() => {
    void refreshCards();
    void refreshCharts();
  }, 60_000);
});
onUnmounted(() => {
  if (processTimer !== null) clearInterval(processTimer);
  if (cardsTimer !== null) clearInterval(cardsTimer);
  if (downloadTimer !== null) clearInterval(downloadTimer);
});
// New or removed processes appear as soon as the registry poll lands.
watch(
  () => heroProcesses.value.map((p) => p.key).join("|"),
  () => void refreshCharts(),
);
// The range filter re-fetches every card and chart.
watch(range, () => {
  void refreshCards();
  void refreshCharts();
});

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

// ─── hero visibility (IRI-025): hide what has no data, never leave dead space

function showTtft(h: HeroData): boolean {
  return h.ttftP95Ms !== null || h.e2eP95Ms !== null;
}
function showItl(h: HeroData): boolean {
  return h.itlP95Ms !== null;
}
function heroGridClass(h: HeroData): string {
  return showTtft(h) || showItl(h) ? "statgrid statgrid--6" : "statgrid";
}
function hasQueue(h: HeroData): boolean {
  return h.queueRunning !== null || h.queueWaiting !== null;
}
/** "3 · 12" with null sides omitted (mirrors llm-data formatQueue). */
function queueValue(h: HeroData): string {
  if (!hasQueue(h)) return "—";
  const parts: string[] = [];
  if (h.queueRunning !== null) parts.push(num(h.queueRunning));
  if (h.queueWaiting !== null) parts.push(num(h.queueWaiting));
  return parts.join(" · ");
}
function queueSub(h: HeroData): string {
  if (!hasQueue(h)) return "queue";
  const parts: string[] = [];
  if (h.queueRunning !== null) parts.push("running");
  if (h.queueWaiting !== null) parts.push("waiting");
  return parts.join(" · ");
}

// ─── power bar chart geometry (600×90 viewBox, 240 W envelope at the top) ───

const BAR_VIEW_W = 600;
const BAR_TOP = 8;
const BAR_BOTTOM = 84;
const barStep = computed(() => BAR_VIEW_W / Math.max(1, powerBars.value.bars.length));
const barW = computed(() => Math.max(4, barStep.value * 0.57));
function barX(i: number): number {
  return i * barStep.value + (barStep.value - barW.value) / 2;
}
function barH(pct: number): number {
  return ((BAR_BOTTOM - BAR_TOP) * pct) / 100;
}
function barY(pct: number): number {
  return BAR_BOTTOM - barH(pct);
}

/** IR-97: nearest-bar hover drives a fixed-position .charttip (LensChart pattern). */
const barHover = ref<{ index: number; x: number; y: number } | null>(null);
function onBarMove(e: PointerEvent): void {
  const bars = powerBars.value.bars;
  const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
  if (rect.width === 0 || bars.length === 0) {
    barHover.value = null;
    return;
  }
  const index = Math.max(0, Math.min(bars.length - 1, Math.floor(((e.clientX - rect.left) / rect.width) * bars.length)));
  barHover.value = { index, x: clampTipX(e.clientX), y: e.clientY };
}
const barTip = computed(() => {
  const h = barHover.value;
  if (h === null) return null;
  const b = powerBars.value.bars[h.index];
  if (b === undefined) return null;
  return { slot: powerBarSlot(b, powerGranularity.value), wh: b.wh, x: h.x, y: h.y };
});
const avgLineY = computed(() => {
  const avg = powerBars.value.avgW;
  if (avg === null) return null;
  return BAR_BOTTOM - ((BAR_BOTTOM - BAR_TOP) * Math.min(100, (avg / GB10_SYSTEM_ENVELOPE_W) * 100)) / 100;
});

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
      <div class="seg" role="group" aria-label="History range">
        <button v-for="r in OVERVIEW_RANGES" :key="r.value" :class="{ 'is-active': range === r.value }" @click="range = r.value">{{ r.label }}</button>
      </div>
      <button class="btn btn--primary" @click="addOpen = true">Add node…</button>
    </div>
  </div>

  <!-- Serving processes: one card per running setup, then detected engines -->
  <section v-if="heroProcesses.length > 0" class="hero-grid" :class="{ 'hero-grid--single': heroProcesses.length === 1 }" style="margin-bottom: 12px;">
    <article v-for="p in heroProcesses" :key="p.key" class="card">
      <div class="card__head">
        <div class="row hero-head">
          <h3 :title="p.title">{{ p.title }}</h3>
          <span class="chip chip--accent">{{ p.kind }}</span>
          <span class="chip chip--ok">{{ p.hero.backend }} :{{ p.hero.port }}</span>
          <span class="chip"><span class="dot dot--run" aria-hidden="true"></span> {{ servingState(p.hero.decodeTps) }}</span>
        </div>
        <span class="mono faint hero-node">{{ p.nodeName }}</span>
      </div>
      <div class="card__body">
        <div :class="heroGridClass(p.hero)">
          <div class="stat"><span class="stat__label">Decode</span><span class="stat__value">{{ fmtTps(p.hero.decodeTps) }}</span><span v-if="charts.get(p.key)?.peak != null" class="stat__sub">peak {{ Math.round(charts.get(p.key)!.peak!) }}</span></div>
          <div class="stat"><span class="stat__label">Prefill</span><span class="stat__value">{{ fmtTps(p.hero.prefillTps) }}</span><span v-if="p.hero.cacheHitPct !== null" class="stat__sub">cache hit {{ Math.round(p.hero.cacheHitPct) }}%</span></div>
          <div class="stat"><span class="stat__label">Queue</span><span class="stat__value">{{ queueValue(p.hero) }}</span><span class="stat__sub">{{ queueSub(p.hero) }}</span></div>
          <div class="stat"><span class="stat__label">KV cache</span><span class="stat__value">{{ num(p.hero.kvCachePct === null ? null : Math.round(p.hero.kvCachePct)) }}<template v-if="p.hero.kvCachePct !== null">%</template></span><div v-if="p.hero.kvCachePct !== null" class="bar" style="margin-top: 6px;"><div class="bar__fill" :style="{ width: p.hero.kvCachePct + '%' }"></div></div></div>
          <div v-if="showTtft(p.hero)" class="stat"><span class="stat__label">TTFT p95</span><span class="stat__value">{{ ms(p.hero.ttftP95Ms) }}</span><span v-if="p.hero.e2eP95Ms !== null" class="stat__sub">E2E {{ Math.round(p.hero.e2eP95Ms) }} ms</span></div>
          <div v-if="showItl(p.hero)" class="stat"><span class="stat__label">ITL p95</span><span class="stat__value">{{ ms(p.hero.itlP95Ms) }}</span></div>
        </div>
        <p v-if="!showTtft(p.hero) || !showItl(p.hero)" class="stat__sub" style="margin-top: 8px;">ttft · itl appear with the first requests</p>
        <LensChartVue v-if="charts.get(p.key) !== undefined" :chart="charts.get(p.key)!.chart" unit="tok/s" :format="fmtTps" style="margin-top: 12px;" :aria-label="`decode and prefill, ${rangeLabel}`" />
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
        <div class="statgrid" style="grid-template-columns: repeat(3, minmax(0, 1fr));">
          <div class="stat"><span class="stat__label">Fleet now<Tip text="fleet = sparks only · the NAS is excluded (no power telemetry)" /></span><span class="stat__value">{{ fleetNowText }}</span></div>
          <div class="stat"><span class="stat__label">Energy · {{ rangeLabel }}<Tip text="average draw across the window" /></span><span class="stat__value">{{ energyKwhText ?? "—" }}<template v-if="energyKwhText !== null"> <span class="stat__sub" style="display: inline;">kWh</span></template></span></div>
          <div class="stat"><span class="stat__label">Cost · {{ rangeLabel }}<Tip v-if="energyCost !== null" :text="`@ ${energyCost.pricePerKwh} ${CURRENCY_SYMBOL[energyCost.currency]}/kWh · hub setting`" /></span><span class="stat__value">{{ costText ?? "—" }}</span></div>
        </div>
        <div style="margin-top: 10px;">
          <div v-for="n in power?.nodes ?? []" :key="n.key" class="barrow">
            <span>{{ n.label }}</span>
            <div class="bar"><div class="bar__fill" :style="{ width: powerBarPct(n.watts) + '%' }"></div></div>
            <span class="val">{{ fmtWatts(n.watts) }}</span>
          </div>
          <p v-if="power?.nodes.length === 0" class="stat__sub">no power data yet</p>
        </div>
        <div style="margin-top: 14px;">
          <span class="label">fleet draw<Tip text="selected window · grey dashes = 240 W envelope (per-node clamp) · red dashes = window average · hover a bar for its slot and energy" /></span>
          <svg viewBox="0 0 600 90" preserveAspectRatio="none" style="width: 100%; height: 96px; display: block; margin-top: 6px;" aria-hidden="true" @pointermove="onBarMove" @pointerleave="barHover = null">
            <rect v-for="(b, i) in powerBars.bars" :key="b.t" :x="barX(i)" :y="barY(b.pct)" :width="barW" :height="barH(b.pct)" fill="var(--ink)" :opacity="barHover === null || barHover.index === i ? 1 : 0.45" />
            <line x1="0" :y1="BAR_TOP" :x2="600" :y2="BAR_TOP" stroke="var(--border-strong)" stroke-width="1.25" stroke-dasharray="4 3" />
            <line v-if="avgLineY !== null" x1="0" :y1="avgLineY" :x2="600" :y2="avgLineY" stroke="var(--thread)" stroke-width="1.25" stroke-dasharray="4 3" />
            <line x1="0" y1="84" x2="600" y2="84" stroke="var(--border)" />
          </svg>
          <div v-if="barTip !== null" class="charttip" :style="{ left: `${barTip.x}px`, top: `${barTip.y}px` }" aria-hidden="true">
            <div class="charttip__time">{{ barTip.slot }}</div>
            <div class="charttip__row">
              <span class="charttip__swatch" style="background: var(--ink)"></span>
              <span class="charttip__label">energy</span>
              <span class="charttip__value">{{ fmtEnergy(barTip.wh) }}</span>
            </div>
          </div>
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
        <div v-if="activeDownload !== null" style="margin-top: 12px;">
          <div class="row row--between">
            <span class="row"><span class="dot dot--run" aria-hidden="true"></span><span class="mono" style="font-size: 12px;">{{ activeDownload.name }}</span></span>
            <span v-if="downloadEtaText !== null" class="stat__sub">{{ downloadEtaText }}</span>
          </div>
          <div class="bar" style="margin-top: 6px;"><div class="bar__fill" :style="{ width: (downloadProgressPct(activeDownload) ?? 0) + '%' }"></div></div>
          <p v-if="downloadLineText !== null" class="stat__sub" style="margin-top: 4px;">{{ downloadLineText }}</p>
        </div>
        <hr class="rule" />
        <div class="row row--between">
          <span class="label">Tokens · {{ rangeLabel }}<Tip v-if="tokenCost !== null" :text="tokenPriceTip" /></span>
        </div>
        <div class="statgrid" style="grid-template-columns: repeat(4, minmax(0, 1fr)); margin-top: 8px;">
          <div class="stat"><span class="stat__label">Input</span><span class="stat__value stat__value--sm">{{ fmtTokens(tokenSum.input) }}</span></div>
          <div class="stat"><span class="stat__label">Cached</span><span class="stat__value stat__value--sm">{{ fmtTokens(tokenSum.cached) }}</span></div>
          <div class="stat"><span class="stat__label">Output</span><span class="stat__value stat__value--sm">{{ fmtTokens(tokenSum.generated) }}</span></div>
          <div class="stat"><span class="stat__label">Cost<Tip v-if="tokenCost !== null" :text="tokenCostTip" /></span><span class="stat__value stat__value--sm">{{ tokenCostText ?? "—" }}</span></div>
        </div>
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
/* A single serving process spans the full row — no dead column. */
.hero-grid--single {
  grid-template-columns: 1fr;
}
/* Hero heads: long model names truncate, the node label never breaks. */
.hero-head {
  min-width: 0;
}
.hero-head h3 {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.hero-node {
  white-space: nowrap;
  flex: none;
}
.rule {
  border: 0;
  border-top: 1px solid var(--border);
  margin: 14px 0;
}
@media (max-width: 900px) {
  .hero-grid {
    grid-template-columns: 1fr;
  }
}
</style>
