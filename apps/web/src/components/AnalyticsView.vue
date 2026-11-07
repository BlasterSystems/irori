<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import {
  fetchAnalytics,
  type AnalyticsLensName,
  type AnalyticsRangeName,
} from "../api";
import {
  GROUP_TABS,
  TOKEN_GROUP_TABS,
  LENS_TABS,
  RANGE_TABS,
  fmtBucket,
  fmtBytes,
  fmtCount,
  fmtTemp,
  fmtTps,
  fmtWatts,
  lensChart,
  type AnalyticsPoint,
  type LensChartOptions,
} from "../analytics";
import { analyticsRangeMs, GB10_SYSTEM_ENVELOPE_W } from "@irori/core";
import type { AnalyticsResponse, TokenTotals } from "@irori/core";
import { fleetTiles, fmtHitPct, modelsCsv, seriesTotals, tokenInsight } from "../tokens-data";

const CURRENCY_SYMBOLS: Record<string, string> = { EUR: "€", USD: "$", GBP: "£" };
import { thresholds } from "../thresholds";
import { usageChart } from "../usage";
import { fetchTokenReconciliation, fetchEfficiency } from "../api";
import type { TokenReconciliation, EfficiencyRow } from "@irori/core";
import LensChart from "./LensChart.vue";

const lens = ref<AnalyticsLensName>("decode");
const range = ref<AnalyticsRangeName>("24h");
const groupBy = ref<"cluster" | "node" | "setup">("cluster");
const data = ref<AnalyticsResponse | null>(null);
const tempsStrip = ref<AnalyticsResponse | null>(null);
/** IRI-071: ledger vs capture reconciliation (tokens lens only). */
const recon = ref<TokenReconciliation | null>(null);
/** IRI-073: Wh-per-token efficiency (node statgrid + per-model column). */
const efficiencyNodes = ref<EfficiencyRow[]>([]);
const efficiencyModels = ref<Map<string, EfficiencyRow>>(new Map());
/** IRI-075: delta-vs-previous-period (same window shifted back one range). */
const prevFleet = ref<TokenTotals | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
let loadSeq = 0;

async function load(): Promise<void> {
  const seq = ++loadSeq;
  loading.value = true;
  error.value = null;
  try {
    const [main, strip, reconRows, effNodes, effModels, prevTokens] = await Promise.all([
      fetchAnalytics(lens.value, range.value, groupBy.value),
      lens.value === "temps" ? fetchAnalytics("temps", range.value, "node") : Promise.resolve(null),
      lens.value === "tokens" ? fetchTokenReconciliation(range.value) : Promise.resolve(null),
      lens.value === "tokens" ? fetchEfficiency(range.value, "node") : Promise.resolve(null),
      lens.value === "tokens" ? fetchEfficiency(range.value, "model") : Promise.resolve(null),
      // IRI-075: delta-vs-previous-period (same window shifted back one range).
      lens.value === "tokens" ? fetchAnalytics(lens.value, range.value, groupBy.value, { offsetMs: analyticsRangeMs(range.value) }) : Promise.resolve(null),
    ]);
    if (seq !== loadSeq) return;
    data.value = main;
    tempsStrip.value = strip;
    recon.value = reconRows;
    efficiencyNodes.value = effNodes?.rows ?? [];
    efficiencyModels.value = new Map((effModels?.rows ?? []).map((r) => [r.label.split(" · ").slice(1).join(" · "), r]));
    prevFleet.value = prevTokens?.fleet ?? null;
  } catch (err) {
    if (seq !== loadSeq) return;
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    if (seq === loadSeq) loading.value = false;
  }
}

onMounted(() => void load());
watch([lens, range, groupBy], () => void load());
watch(lens, (l) => {
  // Setup grouping exists only on the tokens lens.
  if (l !== "tokens" && groupBy.value === "setup") groupBy.value = "cluster";
});

const W = 720;

/** IRI-071 reconciliation cell formatters. */
const shortNodeId = (id: string): string => id.slice(0, 8);
const fmtDelta = (delta: number): string => (delta > 0 ? `+${fmtCount(delta)}` : delta < 0 ? `−${fmtCount(-delta)}` : "0");
const H = 160;

function lensConfig(name: AnalyticsLensName): { valueKey: keyof AnalyticsPoint; opts: LensChartOptions } {
  switch (name) {
    case "memory":
      return { valueKey: "usedBytes", opts: { floorZero: true } };
    case "decode":
      return { valueKey: "decodeTps", opts: { floorZero: true } };
    case "power":
      return { valueKey: "watts", opts: { floorZero: true, ceiling: GB10_SYSTEM_ENVELOPE_W } };
    case "temps":
      return { valueKey: "gpuMax", opts: { floor: 30, guides: [thresholds.tempWarnC, thresholds.tempCriticalC], markers: { key: "gpuMax", warn: thresholds.tempWarnC, critical: thresholds.tempCriticalC } } };
    case "tokens":
      return { valueKey: "generated", opts: { floorZero: true } };
  }
}

const chart = computed(() => {
  if (data.value === null) return null;
  const cfg = lensConfig(lens.value);
  return lensChart(data.value.series, cfg.valueKey, W, H, cfg.opts);
});

/** Second chart for prefill rates (decode lens). */
const prefillChart = computed(() => {
  if (data.value === null || data.value.lens !== "decode") return null;
  return lensChart(data.value.series, "prefillTps", W, H, { floorZero: true });
});

const stripRows = computed(() => {
  const strip = tempsStrip.value;
  if (strip === null) return [];
  return strip.series
    .map((s) => {
      const last = [...s.points].reverse().find((p) => p.gpuMax !== null || p.cpuMax !== null) ?? null;
      const peak = s.points.reduce((m, p) => Math.max(m, p.gpuMax ?? -Infinity), -Infinity);
      return {
        key: s.key,
        label: s.label,
        gpu: last?.gpuMax ?? null,
        cpu: last?.cpuMax ?? null,
        peak24: Number.isFinite(peak) ? peak : null,
        tier: peak >= 90 ? "critical" : peak >= thresholds.tempWarnC ? "warn" : "ok",
      };
    })
    .sort((a, b) => (b.peak24 ?? -1) - (a.peak24 ?? -1));
});

const unit = computed(() => {
  switch (lens.value) {
    case "decode":
      return "tok/s";
    case "power":
      return "W";
    case "temps":
      return "°C";
    default:
      return "";
  }
});

function fmtPoint(v: number | null | undefined): string {
  switch (lens.value) {
    case "memory":
      return fmtBytes(v);
    case "decode":
      return fmtTps(v);
    case "power":
      return fmtWatts(v);
    case "temps":
      return fmtTemp(v);
    default:
      return fmtCount(v);
  }
}

/** Hover tooltip bucket labels, per the response's granularity. */
const bucketFmt = computed(() => {
  const g = data.value?.granularity ?? "hour";
  return (t: number): string => fmtBucket(t, g);
});

const headline = computed(() => {
  const c = chart.value;
  if (c === null || data.value === null) return "";
  const cfg = lensConfig(lens.value);
  const all = data.value.series.flatMap((s) => s.points);
  const vals = all.map((p) => p[cfg.valueKey]).filter((v): v is number => typeof v === "number");
  if (vals.length === 0) return "no data in range";
  const peak = Math.max(...vals);
  const last = vals[vals.length - 1]!;
  return `latest ${fmtPoint(last)} · peak ${fmtPoint(peak)}`;
});

/** IRI-040: the five fleet macro tiles (tokens lens only). */
const tokenTiles = computed(() => {
  if (data.value?.lens !== "tokens") return [];
  const cur = data.value.fleet?.total ?? null;
  const prev = prevFleet.value?.total ?? null;
  const deltaPct = cur !== null && prev !== null && prev > 0 ? ((cur - prev) / prev) * 100 : null;
  return fleetTiles(data.value.fleet, data.value.costMinor ?? 0, data.value.costCurrency ?? null, deltaPct);
});
/** IRI-075: plain-English insight, derived only from the response data. */
const tokenInsightLine = computed(() =>
  data.value?.lens === "tokens" ? tokenInsight(data.value.fleet, data.value.models) : null,
);
/** IRI-075: client-side CSV of the current per-model table. */
const csvHref = computed(() => `data:text/csv;charset=utf-8,${encodeURIComponent(modelsCsv(data.value?.models ?? []))}`);

/** IRI-075: hourly cost + token trend from the response costSeries/series. */
const costTrend = computed(() => {
  if (data.value?.lens !== "tokens" || data.value.costSeries.length === 0) return null;
  const sym = data.value.costCurrency === null || CURRENCY_SYMBOLS[data.value.costCurrency] === undefined ? "" : CURRENCY_SYMBOLS[data.value.costCurrency];
  return {
    cost: usageChart(data.value.costSeries.map((p) => ({ t: new Date(p.t).toISOString(), value: p.costMinor / 100 })), W, H),
    fmt: (v: number): string => `${sym}${v.toFixed(2)}`,
    tokens: usageChart(
      data.value.series.flatMap((s) => s.points.map((p) => ({ t: new Date(p.t).toISOString(), value: (p.generated ?? 0) + (p.prompt ?? 0) }))).sort((a, b) => a.t.localeCompare(b.t)),
      W,
      H,
    ),
  };
});

/** IRI-040: By-cluster/node macro totals, folded from the lens series. */
const tokenGroupTotals = computed(() => (data.value?.lens === "tokens" ? seriesTotals(data.value.series) : []));
</script>

<template>
  <div class="pagehead">
    <div>
      <h1>Analytics</h1>
      <p><span class="mono faint">from rollups — memory, decode, power, temps, tokens · temps minute buckets · 7d</span></p>
    </div>
    <div class="row">
      <div class="seg" role="group" aria-label="Group by">
        <button v-for="g in lens === 'tokens' ? TOKEN_GROUP_TABS : GROUP_TABS" :key="g.key" :class="{ 'is-active': groupBy === g.key }" @click="groupBy = g.key as typeof groupBy">{{ g.label }}</button>
      </div>
      <div class="seg" role="group" aria-label="Range">
        <button v-for="r in RANGE_TABS" :key="r" :class="{ 'is-active': range === r }" @click="range = r">{{ r }}</button>
      </div>
    </div>
  </div>

  <div class="tabs" style="margin-bottom: 12px" role="tablist" aria-label="Lens">
    <button v-for="t in LENS_TABS" :key="t.lens" role="tab" :aria-selected="lens === t.lens" :class="{ 'is-active': lens === t.lens }" @click="lens = t.lens">
      {{ t.label }}
    </button>
  </div>

  <p v-if="error" class="banner banner--warn">{{ error }}</p>
  <p v-else-if="loading && data === null" class="muted">loading…</p>

  <template v-if="data !== null">
    <!-- IRI-040/075: fleet macro tiles (tokens lens) — computed/cached split,
         cost tile, insight line, CSV export. -->
    <section v-if="lens === 'tokens'" class="card" style="margin-bottom: 12px">
      <div class="card__body">
        <div class="statgrid statgrid--6">
          <div v-for="t in tokenTiles" :key="t.label" class="stat">
            <span class="stat__label">{{ t.label }}</span>
            <span class="stat__value">{{ t.value }}</span>
          </div>
        </div>
        <p class="stat__sub">{{ range }} · total = generated + input · input = computed + cached · cache hit = cached / input</p>
        <p v-if="tokenInsightLine !== null" class="stat__sub" style="margin-top: 4px"><strong>Insight:</strong> {{ tokenInsightLine }}</p>
        <div v-if="(data.models.length ?? 0) > 0" class="row" style="margin-top: 8px">
          <a class="btn btn--ghost btn--sm" download="token-models.csv" :href="csvHref" aria-label="Export per-model token table as CSV">Export CSV</a>
        </div>
      </div>
    </section>

    <!-- Temps fleet strip: latest per node, hottest first (SPEC §9). -->
    <section v-if="lens === 'temps' && stripRows.length > 0" class="card" style="margin-bottom: 12px">
      <div class="card__head"><h3>Fleet temperatures</h3><span class="mono faint">latest snapshot · hottest first</span></div>
      <div class="card__body">
        <div class="cols cols-4">
          <div v-for="row in stripRows" :key="row.key" class="subcard" style="padding: 10px 12px">
            <div class="row row--between">
              <span class="mono">{{ row.label }}</span>
              <span class="stat__sub">peak {{ range }} {{ fmtTemp(row.peak24) }}</span>
            </div>
            <div class="row row--wrap" style="margin-top: 6px">
              <span class="chip" :class="{ 'chip--warn': row.tier !== 'ok' }">GPU {{ fmtTemp(row.gpu) }}</span>
              <span class="chip">CPU {{ fmtTemp(row.cpu) }}</span>
              <span v-if="row.tier !== 'ok'" class="stat__sub">{{ row.tier === "critical" ? "▫ ≥90°" : "◇ ≥85°" }}</span>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="card" style="margin-bottom: 12px">
      <div class="card__head">
        <div class="row">
          <h3 class="capitalize">{{ lens }}{{ lens === "decode" ? " throughput" : lens === "tokens" ? " ledger" : lens === "power" ? " (estimated)" : "" }}</h3>
          <span v-if="unit !== ''" class="chip">{{ unit }}</span>
        </div>
        <div class="row row--wrap">
          <span v-for="s in data.series" :key="s.key" class="chip">{{ s.label }}</span>
        </div>
      </div>
      <div class="card__body">
        <template v-if="chart !== null && chart.paths.length > 0">
          <LensChart :chart="chart" :unit="unit" :aria-label="`${lens} over ${range}`" :format="fmtPoint" :time-format="bucketFmt" />
          <p class="stat__sub">{{ headline }}</p>
          <p v-if="lens === 'power'" class="stat__sub">estimated, not wall-metered — GPU board + CPU package + base overhead, clamped to the GB10 envelope (240 W)</p>
          <p v-if="lens === 'temps'" class="stat__sub">◇ warn ≥{{ thresholds.tempWarnC }}°C · ▫ critical ≥{{ thresholds.tempCriticalC }}°C — markers are bucket crossings, no rules engine</p>
        </template>
        <p v-else class="muted">no data in range</p>
      </div>
    </section>

    <section v-if="lens === 'decode' && prefillChart !== null && prefillChart.paths.length > 0" class="card" style="margin-bottom: 12px">
      <div class="card__head"><div class="row"><h3>Prefill throughput</h3><span class="chip">tok/s</span></div></div>
      <div class="card__body">
        <LensChart :chart="prefillChart" unit="tok/s" :aria-label="`prefill over ${range}`" :format="fmtTps" :time-format="bucketFmt" />
        <p class="stat__sub">prefill excludes cached tokens</p>
      </div>
    </section>

    <!-- IRI-040: By-cluster/node macro totals, folded from the series. -->
    <section v-if="lens === 'tokens' && tokenGroupTotals.length > 0" class="card" style="margin-bottom: 12px">
      <div class="card__head"><h3>Token totals — by {{ groupBy }}</h3><span class="mono faint">{{ tokenGroupTotals.length }} row{{ tokenGroupTotals.length === 1 ? "" : "s" }}</span></div>
      <div class="card__body card__body--flush">
        <table class="table">
          <thead>
            <tr><th>{{ groupBy }}</th><th>total</th><th>generated</th><th>input computed</th><th>cached</th><th>cache hit</th></tr>
          </thead>
          <tbody>
            <tr v-for="r in tokenGroupTotals" :key="r.key">
              <td class="mono">{{ r.label }}</td>
              <td class="mono">{{ fmtCount(r.total) }}</td>
              <td class="mono">{{ fmtCount(r.generated) }}</td>
              <td class="mono">{{ fmtCount(r.computed) }}</td>
              <td class="mono">{{ fmtCount(r.cached) }}</td>
              <td class="mono">{{ fmtHitPct(r.cacheHitPct) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section v-if="lens === 'tokens'" class="card" style="margin-bottom: 12px">
      <div class="card__head"><h3>Token ledger — per model</h3><span class="mono faint">{{ range }} · total / generated / input / cache / hit</span></div>
      <div v-if="data.models.length > 0" class="card__body card__body--flush">
        <table class="table">
          <thead>
            <tr><th>model</th><th>total</th><th>generated</th><th>input (prompt)</th><th>cache</th><th>cache hit</th><th title="Wh per 1,000 tokens — energy join, NAS excluded">Wh/ktok</th></tr>
          </thead>
          <tbody>
            <tr v-for="m in data.models" :key="m.model">
              <td class="mono">{{ m.model }}</td>
              <td class="mono">{{ fmtCount(m.total) }}</td>
              <td class="mono">{{ fmtCount(m.generated) }}</td>
              <td class="mono">{{ fmtCount(m.prompt) }}</td>
              <td class="mono">{{ fmtCount(m.cached) }}</td>
              <td class="mono">{{ fmtHitPct(m.cacheHitPct) }}</td>
              <td class="mono" :title="efficiencyModels.get(m.model)?.reason ?? ''">
                <template v-if="efficiencyModels.get(m.model)?.whPerKToken !== null && efficiencyModels.get(m.model)?.whPerKToken !== undefined">{{ efficiencyModels.get(m.model)!.whPerKToken }}</template>
                <template v-else>—</template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="muted" style="padding: 0 var(--space-4) var(--space-4)">no token counters yet — engines publish them per backend (vLLM, llama.cpp, q27, ds4, sglang)</p>
    </section>

      <!-- IRI-075: hourly cost + token trend next to the lens charts. -->
      <div v-if="lens === 'tokens' && costTrend !== null" class="cols cols-2" style="margin-top: var(--space-4)">
        <section class="card">
          <div class="card__head"><h3>Cost trend</h3><span class="mono faint">per {{ data.granularity }} · estimated</span></div>
          <div class="card__body"><LensChart :chart="costTrend.cost" unit="cost" aria-label="Cost per bucket" :format="costTrend.fmt" :time-format="bucketFmt" /></div>
        </section>
        <section class="card">
          <div class="card__head"><h3>Token trend</h3><span class="mono faint">per {{ data.granularity }}</span></div>
          <div class="card__body"><LensChart :chart="costTrend.tokens" unit="tok" aria-label="Tokens per bucket" :format="(v: number) => fmtCount(v)" :time-format="bucketFmt" /></div>
        </section>
      </div>

    <!-- IRI-073: Wh-per-1k-tokens statgrid; the NAS is excluded from fleet
         power so efficiency never divides by idle box watts. -->
    <section v-if="lens === 'tokens' && efficiencyNodes.length > 0" class="card" style="margin-bottom: 12px">
      <div class="card__head"><h3>Efficiency — Wh per 1,000 tokens</h3><span class="stat__sub">estimated, not wall-metered · NAS excluded from energy</span></div>
      <div class="card__body">
        <div class="statgrid">
          <div v-for="e in efficiencyNodes" :key="e.key" class="stat" :title="e.reason ?? `coverage ${e.energyCoverage === null ? '—' : Math.round(e.energyCoverage * 100) + '%'}`">
            <p class="stat__label">{{ e.label }}</p>
            <p class="stat__value stat__value--sm" :class="{ 'metric--hot': e.reason !== null }">
              {{ e.whPerKToken === null ? "—" : `${e.whPerKToken} Wh/ktok` }}
            </p>
            <p class="stat__sub">{{ e.reason ?? `${e.tokens.toLocaleString("en-US")} tok` }}</p>
          </div>
        </div>
      </div>
    </section>

    <!-- IRI-071: ledger (engine counters) vs capture (requests) — never a
         silent preference: both sides labeled, costs price the capture rows. -->
    <section v-if="lens === 'tokens' && recon !== null && recon.rows.length > 0" class="card" style="margin-bottom: 12px">
      <div class="card__head">
        <h3>Token reconciliation — engine counters vs captured requests</h3>
        <span class="chip chip--warn" v-if="recon.rows.some((r) => r.warn)">◇ divergence &gt; 20%</span>
      </div>
      <div class="card__body card__body--flush">
        <table class="table">
          <thead>
            <tr><th>node</th><th>port</th><th>model</th><th>engine counters</th><th>captured</th><th>Δ</th><th>divergence</th></tr>
          </thead>
          <tbody>
            <tr v-for="r in recon.rows" :key="`${r.nodeId}:${r.port}:${r.model}`">
              <td class="mono">{{ shortNodeId(r.nodeId) }}</td>
              <td class="mono">{{ r.port }}</td>
              <td class="mono">{{ r.model }}</td>
              <td class="mono">{{ fmtCount(r.ledgerTokens) }}</td>
              <td class="mono">{{ fmtCount(r.captureTokens) }}</td>
              <td class="mono" :class="{ 'metric--hot': r.warn }">{{ fmtDelta(r.delta) }}</td>
              <td class="mono">{{ r.divergencePct === null ? "—" : `${r.divergencePct}%` }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="stat__sub" style="padding: 8px 12px 0">costs are priced from the captured requests (llm_requests); engine counters come from the probes</p>
    </section>
  </template>
</template>

<style scoped>
.capitalize { text-transform: capitalize; }
</style>
