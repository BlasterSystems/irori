<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import type { HardwareSnapshot, NodeInfo, SetupInfo } from "@irori/core";
import { CURRENCY_SYMBOL, GB10_SYSTEM_ENVELOPE_W, type AnalyticsSeries, type Currency } from "@irori/core";
import { live } from "../live";
import { tier } from "../tiers";
import HealthBanner from "./HealthBanner.vue";
import NodeCard from "./NodeCard.vue";
import NodeModal from "./NodeModal.vue";
import Tip from "./Tip.vue";
import LensChartVue from "./LensChart.vue";
import { fetchAnalytics, fetchLlmHistory, fetchUpdates, setFleetClockCap, type FleetClockCapNode, type LlmHistoryPoint, type UpdatesResponse } from "../api";
import { capOptions, CPU_CLOCK_CAP_PRESETS, GPU_CLOCK_CAP_PRESETS } from "../detail-data";
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
  fleetTemps,
  fmtEnergy,
  granularityMs,
  heroDataForPort,
  heroSpark,
  OVERVIEW_RANGES,
  peakDecode,
  powerBarSlot,
  relativeTime,
  TEMP_CRIT_C,
  TEMP_WARN_C,
  tokenTotals,
  type FleetPowerPoint,
  type HeroData,
  type OverviewRange,
} from "../overview";
import { fmtBytes, fmtBucket, fmtTps, fmtWatts, type LensChart } from "../analytics";
import { thresholds } from "../thresholds";
import { clampTipX } from "../sparkline";

const { sortedNodes } = live;
const totalCount = computed(() => sortedNodes.value.length);
const onlineCount = computed(() => sortedNodes.value.filter((n) => n.online).length);
/** Every spark node - heads included (they serve too); the NAS keeps its own card. */
const sparkNodes = computed(() => sortedNodes.value.filter((n) => n.kind !== "nas"));
const sparkIds = computed(() => new Set(sparkNodes.value.map((n) => n.id)));

// ─── fleet temperatures (IR-129): one always-on thermal surface; spark nodes
// only (the NAS has no thermal telemetry), hottest first, offline last.
const fleetTempData = computed(() =>
  fleetTemps(
    sparkNodes.value.map((n) => ({ id: n.id, name: n.name, online: n.online, snapshot: live.snapshots.get(n.id) })),
  ),
);

// ─── IR-189: fleet-wide clock caps — one action, per-node results ────────────
const fleetGpuCap = ref<string>("");
const fleetCpuCap = ref<string>("");
const fleetPersist = ref(false);
const fleetBusy = ref(false);
const fleetMsg = ref<string | null>(null);
const fleetError = ref<string | null>(null);
const fleetResults = ref<FleetClockCapNode[] | null>(null);
const fleetGpuOptions = capOptions(GPU_CLOCK_CAP_PRESETS, null);
const fleetCpuOptions = capOptions(CPU_CLOCK_CAP_PRESETS, null);

async function applyFleetCaps(clear: boolean): Promise<void> {
  fleetBusy.value = true;
  fleetError.value = null;
  fleetMsg.value = null;
  try {
    const gpu = clear ? null : fleetGpuCap.value === "" ? undefined : Number.parseInt(fleetGpuCap.value, 10);
    const cpu = clear ? null : fleetCpuCap.value === "" ? undefined : Number.parseInt(fleetCpuCap.value, 10);
    if (!clear && gpu === undefined && cpu === undefined) throw new Error("pick a GPU or CPU cap first");
    const out = await setFleetClockCap({ capMHz: gpu, cpuCapMHz: cpu, persistent: fleetPersist.value });
    fleetResults.value = out.results;
    fleetMsg.value = `${clear ? "cleared" : "applied"} on ${out.applied}/${out.results.length} nodes${out.failed > 0 ? ` · ${out.failed} failed` : ""}`;
    void live.refreshNodes();
  } catch (err: unknown) {
    fleetError.value = err instanceof Error ? err.message : String(err);
  } finally {
    fleetBusy.value = false;
  }
}

/** IR-198: per-side outcome as visible row text (was title-only chips). IR-199: ok sides name the applied cap (mockup S7/S8); failures keep the API error text. */
function fleetOutcomeText(r: FleetClockCapNode): string {
  return r.results.map((x) => (x.ok ? `${x.side.toUpperCase()} ${x.appliedMHz ?? "cleared"}` : `${x.side.toUpperCase()} failed — ${x.error ?? "unknown"}`)).join(" · ");
}

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
  /** Cluster workers beyond the head (0 for single setups and engines). */
  workers: number;
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
      workers: s.nodes.length,
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
        workers: 0,
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
// IRI-072: server-priced; the web formats only.
const tokenCostMinor = ref<number | null>(null);
const tokenCostCurrency = ref<Currency | null>(null);
const tokenCostLabel = computed(() =>
  tokenCostMinor.value === null || tokenCostCurrency.value === null
    ? null
    : `≈ ${CURRENCY_SYMBOL[tokenCostCurrency.value]}${(tokenCostMinor.value / 100).toFixed(2)}`,
);
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
const tokenCostText = computed(() => tokenCostLabel.value);
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
    // IRI-072: cost is computed server-side (per-model pricing) — the web
    // only formats.
    tokenCostMinor.value = res.costMinor;
    tokenCostCurrency.value = res.costCurrency;
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

// IR-109: the feed is newest-last in a scrolling box — keep the latest line in
// view by scrolling to the bottom whenever a line is added (owner ask).
const feedLog = ref<HTMLElement | null>(null);
watch(feed, async () => {
  await nextTick();
  if (feedLog.value !== null) feedLog.value.scrollTop = feedLog.value.scrollHeight;
});

// ─── add node + lifecycle ───────────────────────────────────────────────────

const addOpen = ref(false);

let processTimer: ReturnType<typeof setInterval> | null = null;
let cardsTimer: ReturnType<typeof setInterval> | null = null;
let downloadTimer: ReturnType<typeof setInterval> | null = null;
/** IRI-081: fleet update posture vs upstream baseline (informational). */
const updateRows = ref<UpdatesResponse["nodes"]>([]);
const updateBaseline = ref<UpdatesResponse["baseline"]>(null);
const updatePostureChip = (p: string): string => (p === "up to date" ? "chip chip--ok" : p === "behind" || p === "pending reboot" ? "chip chip--warn" : "chip");
const refreshUpdates = (): void => {
  void fetchUpdates()
    .then((r) => {
      updateRows.value = r.nodes;
      updateBaseline.value = r.baseline;
    })
    .catch(() => {});
};
onMounted(() => {
  void refreshCards();
  void refreshSetups().then(() => void refreshCharts());
  void refreshCharts();
  void refreshDownloads();
  refreshUpdates();
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

// ─── hero head (IR-127): title + one mono meta line; chips only when degraded
// IR-103 rule: healthy is the absence of chrome — the only chips are a state
// chip (probe stale / weights loading) and never kind/backend/SERVING.

/** "tensorfold :8081 · DGX-1 +1 worker" (+ "· unmanaged" for probe-detected
 *  engines with no setup). An unprobed backend (weights still loading) is
 *  simply omitted — ":8081 · DGX-1". */
function heroMeta(p: HeroProcess): string {
  const backend = p.hero.backend === "unknown" ? "" : `${p.hero.backend} `;
  const workers = p.kind === "cluster" && p.workers > 0 ? ` +${p.workers} worker${p.workers === 1 ? "" : "s"}` : "";
  const unmanaged = p.kind === "engine" ? " · unmanaged" : "";
  return `${backend}:${p.hero.port} · ${p.nodeName}${workers}${unmanaged}`;
}

/** A process whose node stopped answering has history, not live data. */
function isProbeStale(p: HeroProcess): boolean {
  const node = live.nodes.get(p.nodeId);
  return node !== undefined && !node.online;
}

type HeroStateView = { cls: string; dot: string; label: string } | null;

/** The only chip a hero may render: OFFLINE when the probe went stale,
 *  "starting" while weights load (no probe data yet). Null while healthy. */
function heroStateView(p: HeroProcess): HeroStateView {
  if (isProbeStale(p)) return { cls: "chip--warn", dot: "dot--warn", label: "OFFLINE" };
  if (p.hero.decodeTps === null) return { cls: "", dot: "dot--run", label: "starting" };
  return null;
}
</script>

<template>
  <div class="pagehead">
    <div>
      <h1>Overview</h1>
      <p>
        <span class="mono faint">{{ totalCount }} nodes · {{ onlineCount }} online · {{ heroProcesses.length }} serving<template v-if="fleetTempData.hottest !== null"> · hottest <span :class="{ hot: fleetTempData.hottest.tempC >= TEMP_WARN_C }">{{ fleetTempData.hottest.tempC }}°C {{ fleetTempData.hottest.name }}</span></template></span>
      </p>
    </div>
    <div class="row">
      <!-- IR-128: one shared range state, two surfaces — seg at full, native
           select below full (mockups/overview-v4.html). -->
      <div v-if="tier === 'full'" class="seg" role="group" aria-label="History range">
        <button v-for="r in OVERVIEW_RANGES" :key="r.value" :class="{ 'is-active': range === r.value }" @click="range = r.value">{{ r.label }}</button>
      </div>
      <template v-else>
        <label class="visually-hidden" for="rangeSelect">History range</label>
        <select id="rangeSelect" v-model="range" class="select range-select">
          <option v-for="r in OVERVIEW_RANGES" :key="r.value" :value="r.value">{{ r.label }}</option>
        </select>
      </template>
      <button class="btn btn--primary" @click="addOpen = true">Add node…</button>
    </div>
  </div>

  <!-- IR-203: global infra banner — open fleet-scoped health findings
       (database unavailable, hub disk) above everything else. -->
  <HealthBanner :findings="live.findings.value" />

  <!-- ── Fleet temperatures (IR-129): small tier only, ordered above the
       heroes — on phones the node cards are below the fold. Spark nodes only;
       the NAS is excluded (no power or thermal telemetry). ── -->
  <section class="card tempscard section-gap" aria-label="Fleet temperatures">
    <div class="card__head">
      <div class="row"><h3>Fleet temperatures</h3><Tip text="latest snapshot per node · GPU / CPU package · warn ≥70 °C · critical ≥90 °C · the NAS is excluded (no power or thermal telemetry)" /></div>
      <span class="mono faint">hottest first</span>
    </div>
    <div class="card__body tempsbody">
      <div class="temps" role="list" aria-label="Fleet temperatures">
        <span v-for="item in fleetTempData.items" :key="item.id" class="tempitem" :class="{ 'tempitem--down': !item.online }" role="listitem">
          <span class="tempitem__name">{{ item.name }}</span>
          <template v-if="item.online">
            <span v-if="item.gpu === null" class="tempitem__v">— <em>gpu</em></span>
            <span v-else class="tempitem__v" :class="{ hot: item.gpu >= TEMP_WARN_C, crit: item.gpu >= TEMP_CRIT_C }">{{ item.gpu }}°C <em>gpu</em></span>
            <span v-if="item.cpu === null" class="tempitem__v">— <em>cpu</em></span>
            <span v-else class="tempitem__v" :class="{ hot: item.cpu >= TEMP_WARN_C, crit: item.cpu >= TEMP_CRIT_C }">{{ item.cpu }}°C <em>cpu</em></span>
          </template>
          <span v-else class="tempitem__v hot">— OFFLINE</span>
        </span>
      </div>
    </div>
  </section>

  <!-- Serving processes: one card per running setup, then detected engines -->
  <section v-if="heroProcesses.length > 0" class="hero-grid section-gap" :class="{ 'hero-grid--single': heroProcesses.length === 1 }">
    <article v-for="p in heroProcesses" :key="p.key" class="card" :class="{ 'card--stale': isProbeStale(p) }">
      <div class="card__head">
        <div class="row" style="min-width: 0;">
          <h3 class="hero__title" :title="p.title">{{ p.title }}</h3>
          <span class="hero__meta">{{ heroMeta(p) }}</span>
          <span v-if="heroStateView(p) !== null" class="chip hero__state" :class="heroStateView(p)!.cls"><span class="dot" :class="heroStateView(p)!.dot" aria-hidden="true"></span> {{ heroStateView(p)!.label }}</span>
        </div>
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
        <!-- IR-128: sparklines hidden ONLY on small — shown on medium and
             full (owner final call). -->
        <LensChartVue v-if="tier !== 'small' && charts.get(p.key) !== undefined" :chart="charts.get(p.key)!.chart" unit="tok/s" :format="fmtTps" style="margin-top: 12px;" :aria-label="`decode and prefill, ${rangeLabel}`" />
      </div>
    </article>
  </section>
  <div v-else class="ghost-grid" style="min-height: 120px; margin-bottom: 12px; flex-direction: column; gap: 8px;">
    <span>nothing serving</span>
    <span style="letter-spacing: 0; text-transform: none;">start a setup on the Serve page — it appears here while it runs</span>
  </div>

  <h2 class="h2-gap">Nodes</h2>
  <section v-if="sparkNodes.length > 0" class="cols cols-3">
    <NodeCard v-for="node in sparkNodes" :key="node.id" :node="node" :snapshot="live.snapshots.get(node.id) ?? null" :llm="live.getLlm(node.id)" />
  </section>
  <div v-else class="ghost-grid" style="min-height: 120px; flex-direction: column; gap: 8px;">
    <span>{{ totalCount === 0 ? "no nodes yet" : "no spark nodes" }}</span>
    <span v-if="totalCount === 0" style="letter-spacing: 0; text-transform: none;">add your first node → register the nas → download a model → serve</span>
  </div>

  <!-- Fleet power + NAS store -->
  <section class="hero-grid section-gap">
    <article class="card">
      <div class="card__head"><h3>Power</h3><span class="chip">estimated</span></div>
      <div class="card__body" style="padding-top: 12px;">
        <div class="statgrid statgrid--3">
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
          <svg class="powerchart" viewBox="0 0 600 90" preserveAspectRatio="none" aria-hidden="true" @pointermove="onBarMove" @pointerleave="barHover = null">
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
          <span class="val" :class="{ 'metric--hot': nas.storePct !== null && nas.storePct >= thresholds.diskWarnPct }">{{ storeText }}</span>
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
        <div class="statgrid" style="margin-top: 8px;">
          <div class="stat"><span class="stat__label">Input</span><span class="stat__value stat__value--sm">{{ fmtTokens(tokenSum.input) }}</span></div>
          <div class="stat"><span class="stat__label">Cached</span><span class="stat__value stat__value--sm">{{ fmtTokens(tokenSum.cached) }}</span></div>
          <div class="stat"><span class="stat__label">Output</span><span class="stat__value stat__value--sm">{{ fmtTokens(tokenSum.generated) }}</span></div>
          <div class="stat"><span class="stat__label">Cost<Tip v-if="tokenCost !== null" :text="tokenCostTip" /></span><span class="stat__value stat__value--sm">{{ tokenCostText ?? "—" }}</span></div>
        </div>
      </div>
    </article>
  </section>

  <!-- ── IR-189/IR-198: fleet-wide clock caps — one action fans out to every
       enabled spark node; per-node outcomes stay visible as touch-legible rows
       instead of collapsing into a single status. Demoted below Nodes/Power
       (IR-198 option A) and hidden entirely on a NAS-only fleet. ── -->
  <section v-if="sparkNodes.length > 0" class="card section-gap" aria-label="Fleet clock caps">
    <div class="card__head">
      <div class="row"><h3>Fleet clock caps</h3><Tip text="applies to every enabled spark node · a cap is a ceiling, not an operating point · 'keep after reboot' installs the boot-time oneshot on each node · a stored cap is re-applied whenever a node comes back online" /></div>
      <span class="mono faint">{{ sparkNodes.length }} spark nodes</span>
    </div>
    <div class="card__body">
      <div class="row" style="align-items: center; gap: 6px; flex-wrap: wrap;">
        <label class="visually-hidden" for="fleetGpuCap">GPU SM clock cap</label>
        <select id="fleetGpuCap" v-model="fleetGpuCap" class="select" style="max-width: 165px;">
          <option value="">GPU: leave alone</option>
          <option v-for="o in fleetGpuOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
        <label class="visually-hidden" for="fleetCpuCap">CPU clock cap</label>
        <select id="fleetCpuCap" v-model="fleetCpuCap" class="select" style="max-width: 165px;">
          <option value="">CPU: leave alone</option>
          <option v-for="o in fleetCpuOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
        <label class="stat__sub" style="display: flex; gap: 4px; align-items: center; cursor: pointer;">
          <input v-model="fleetPersist" type="checkbox" /> keep after reboot
        </label>
        <button class="btn btn--secondary btn--sm" :disabled="fleetBusy || (fleetGpuCap === '' && fleetCpuCap === '')" @click="applyFleetCaps(false)">Apply to fleet</button>
        <button class="btn btn--ghost btn--sm" :disabled="fleetBusy" @click="applyFleetCaps(true)">Clear fleet</button>
      </div>
      <p v-if="fleetMsg" class="stat__sub" role="status">{{ fleetMsg }}</p>
      <p v-if="fleetError" class="banner banner--warn">{{ fleetError }}</p>
      <div v-if="fleetResults !== null" class="fleet-orows" role="list" aria-label="Per-node apply outcomes" style="margin-top: 8px;">
        <div v-for="r in fleetResults" :key="r.nodeId" class="orow" role="listitem">
          <span class="dot" :class="r.status === 200 ? 'dot--ok' : 'dot--warn'" aria-hidden="true"></span>
          <span class="orow__n">{{ r.name }}</span>
          <span class="orow__d">{{ fleetOutcomeText(r) }}</span>
        </div>
      </div>
    </div>
  </section>

  <!-- IRI-081: fleet update posture vs upstream baseline (informational only) -->
  <section class="card section-gap">
    <div class="card__head">
      <h3>Updates</h3>
      <span class="chip">baseline {{ updateBaseline === null ? "unknown" : updateBaseline.source === "live" ? "fresh" : "cached" }}</span>
    </div>
    <div class="card__body card__body--flush">
      <table class="table">
        <thead><tr><th>Node</th><th>Posture</th><th>DGX OS / driver</th><th>Reboot</th></tr></thead>
        <tbody>
          <tr v-for="u in updateRows" :key="u.nodeId">
            <td><span class="dot" :class="u.online ? 'dot--ok' : 'dot--dim'" /> {{ u.name }}</td>
            <td><span class="chip" :class="updatePostureChip(u.posture)">{{ u.posture }}</span></td>
            <td class="mono">{{ u.updates?.dgxOsVersion ?? "—" }} / {{ u.updates?.nvidiaDriverVersion ?? "—" }}</td>
            <td>{{ u.updates?.pendingReboot === true ? "yes" : "no" }}</td>
          </tr>
          <tr v-if="updateRows.length === 0"><td colspan="4" class="dim">no update reports yet</td></tr>
        </tbody>
      </table>
    </div>
  </section>

  <!-- All event classes in one feed (owner decision) -->
  <section class="card section-gap">
    <div class="card__head"><h3>Telemetry</h3><span class="chip">streaming</span></div>
    <div class="card__body card__body--flush">
      <div ref="feedLog" class="log feedlog">
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
.hero__title {
  min-width: 0;
  flex: 0 1 auto;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* One mono meta line carries backend :port · node · workers (IR-127). */
.hero__meta {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  flex: 1 1 auto;
}
.hero__state {
  margin-left: auto;
  flex: none;
}
/* Stale engine (IR-127): the probe stopped answering — data is history.
   Dim the VALUES only; labels/units keep AA contrast. Thread border, distinct
   from the node-card IR-103 offline treatment (error border + strip). */
.card--stale {
  border-color: var(--thread);
}
.card--stale .stat__value,
.card--stale .bar__fill,
.card--stale .barrow .val {
  opacity: 0.75;
}
.rule {
  border: 0;
  border-top: 1px solid var(--border);
  margin: 14px 0;
}
/* ── Fleet temperatures (IR-129): small tier only ──────────────────────
   Medium and full drop the strip: every node card already shows GPU/CPU
   temperature with its bar, so the strip is duplicate information there. */
.hot { color: var(--thread-ink); }
.tempsbody { padding-top: 10px; padding-bottom: 10px; }
.temps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px var(--space-4); }
.tempitem { display: flex; align-items: baseline; gap: 10px; min-width: 0; font-family: var(--font-mono); font-size: 12.5px; }
.tempitem__name { color: var(--fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tempitem__v { color: var(--muted); white-space: nowrap; }
.tempitem__v em { font-style: normal; font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--faint); margin-left: 3px; }
.tempitem__v.crit { color: var(--thread-ink); font-weight: 600; }
.tempitem__v.crit::before { content: "▫ "; font-size: 8px; }
.tempitem--down .tempitem__name { color: var(--thread-ink); }
html[data-tier="medium"] .tempscard,
html[data-tier="full"] .tempscard { display: none; }
html[data-tier="small"] .temps { grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 6px 10px; }
html[data-tier="small"] .tempitem { gap: 6px; }
html[data-tier="small"] .tempitem__name { flex: none; }
/* Page rhythm classes (IR-128): CSS-reachable so the small tier can tighten
   them — inline margins could not be overridden. */
.section-gap { margin: 20px 0 12px; }
.h2-gap { margin: 20px 0 10px; }
.powerchart { width: 100%; height: 96px; display: block; margin-top: 6px; }
.feedlog { border: 0; border-radius: 0 0 var(--radius) var(--radius); min-height: 120px; max-height: 220px; }
/* ── IR-128: width tiers. The tier store (src/tiers.ts) mirrors small ≤900 /
   medium 901–1440 / full >1440 onto <html data-tier>; 900 matches the old
   .hero-grid media collapse. ── */
html[data-tier="small"] .hero-grid {
  grid-template-columns: 1fr;
}
/* Small tier: compact reflow. 12px page gutters live in iroiri.css; real
   44px tap targets are preserved (the 34px compromise applied only to the old
   seg buttons, never to the select or the CTA). */
html[data-tier="small"] .section-gap { margin: 12px 0; }
html[data-tier="small"] .h2-gap { margin: 12px 0 8px; }
html[data-tier="small"] .pagehead { flex-direction: row; align-items: baseline; flex-wrap: wrap; gap: 6px 10px; margin-bottom: var(--space-3); }
html[data-tier="small"] .pagehead h1 { font-size: 18px; }
html[data-tier="small"] .pagehead p { font-size: 11.5px; margin: 0; width: 100%; order: 3; }
html[data-tier="small"] .pagehead > .row { width: 100%; }
html[data-tier="small"] .btn { min-height: 44px; padding: 0 12px; font-size: 12px; }
html[data-tier="small"] .card__head { padding: 7px 10px; }
html[data-tier="small"] .card__body { padding: 9px 10px; }
html[data-tier="small"] h2 { font-size: 15px; }
html[data-tier="small"] h3 { font-size: 14px; }
/* The meta must not squeeze the title to nothing; the head row wraps instead. */
html[data-tier="small"] .hero__title { font-size: 15px; min-width: 8ch; }
html[data-tier="small"] .hero__meta { font-size: 10.5px; flex: none; }
html[data-tier="small"] .card__head .row { flex-wrap: wrap; }
html[data-tier="small"] .statgrid { gap: 7px 10px; }
html[data-tier="small"] .statgrid,
html[data-tier="small"] .statgrid--3,
html[data-tier="small"] .statgrid--6 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
html[data-tier="small"] .stat__label { font-size: 10px; letter-spacing: 0.07em; }
html[data-tier="small"] .stat__value { font-size: 15px; line-height: 1.15; }
html[data-tier="small"] .stat__sub { font-size: 10px; }
html[data-tier="small"] .statgrid .stat__sub { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
html[data-tier="small"] .bar { height: 5px; }
html[data-tier="small"] .powerchart { height: 64px; }
html[data-tier="small"] .barrow { font-size: 11px; grid-template-columns: 46px minmax(0, 1fr) auto; gap: 8px; }
html[data-tier="small"] .barrow + .barrow { margin-top: 6px; }
html[data-tier="small"] .log { font-size: 11px; line-height: 1.5; padding: 8px 10px; }
html[data-tier="small"] .feedlog { min-height: 96px; max-height: 118px; }
html[data-tier="small"] .range-select { min-height: 44px; }
/* IR-198: per-node fleet cap outcomes as touch-legible rows (was title-only chips). */
.orow { display: flex; align-items: baseline; gap: 8px; font-family: var(--font-mono); font-size: 12px; padding: 7px 0; border-bottom: 1px solid var(--border); }
.orow:last-child { border-bottom: 0; }
.orow__n { flex: none; }
.orow__d { color: var(--muted); min-width: 0; overflow-wrap: anywhere; }
</style>
