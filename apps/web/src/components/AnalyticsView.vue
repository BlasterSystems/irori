<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import {
  fetchAnalytics,
  type AnalyticsLensName,
  type AnalyticsRangeName,
} from "../api";
import {
  GROUP_TABS,
  LENS_TABS,
  RANGE_TABS,
  fmtBucket,
  fmtBytes,
  fmtCount,
  fmtTemp,
  fmtTps,
  fmtWatts,
  lensChart,
  TEMPS_WARN_C,
  TEMPS_CRITICAL_C,
  type AnalyticsPoint,
  type LensChartOptions,
} from "../analytics";
import { GB10_SYSTEM_ENVELOPE_W } from "@irori/core";
import type { AnalyticsResponse } from "@irori/core";
import LensChart from "./LensChart.vue";

const lens = ref<AnalyticsLensName>("decode");
const range = ref<AnalyticsRangeName>("24h");
const groupBy = ref<"cluster" | "node">("cluster");
const data = ref<AnalyticsResponse | null>(null);
const tempsStrip = ref<AnalyticsResponse | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
let loadSeq = 0;

async function load(): Promise<void> {
  const seq = ++loadSeq;
  loading.value = true;
  error.value = null;
  try {
    const [main, strip] = await Promise.all([
      fetchAnalytics(lens.value, range.value, groupBy.value),
      lens.value === "temps" ? fetchAnalytics("temps", range.value, "node") : Promise.resolve(null),
    ]);
    if (seq !== loadSeq) return;
    data.value = main;
    tempsStrip.value = strip;
  } catch (err) {
    if (seq !== loadSeq) return;
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    if (seq === loadSeq) loading.value = false;
  }
}

onMounted(() => void load());
watch([lens, range, groupBy], () => void load());

const W = 720;
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
      return { valueKey: "gpuMax", opts: { floor: 30, guides: [TEMPS_WARN_C, TEMPS_CRITICAL_C], markers: { key: "gpuMax", warn: TEMPS_WARN_C, critical: TEMPS_CRITICAL_C } } };
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
        tier: peak >= 90 ? "critical" : peak >= TEMPS_WARN_C ? "warn" : "ok",
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
</script>

<template>
  <div class="pagehead">
    <div>
      <h1>Analytics</h1>
      <p><span class="mono faint">from rollups — memory, decode, power, temps, tokens · temps minute buckets · 7d</span></p>
    </div>
    <div class="row">
      <div class="seg" role="group" aria-label="Group by">
        <button v-for="g in GROUP_TABS" :key="g.key" :class="{ 'is-active': groupBy === g.key }" @click="groupBy = g.key">{{ g.label }}</button>
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
          <p v-if="lens === 'temps'" class="stat__sub">◇ warn ≥{{ TEMPS_WARN_C }}°C · ▫ critical ≥90°C — markers are bucket crossings, no rules engine</p>
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

    <section v-if="lens === 'tokens'" class="card" style="margin-bottom: 12px">
      <div class="card__head"><h3>Token ledger — per model</h3><span class="mono faint">{{ range }} · generated / prompt / cached</span></div>
      <div class="card__body">
        <table v-if="data.models.length > 0" class="tbl">
          <thead>
            <tr><th>model</th><th>generated</th><th>prompt (prefill)</th><th>cached</th></tr>
          </thead>
          <tbody>
            <tr v-for="m in data.models" :key="m.model">
              <td class="mono">{{ m.model }}</td>
              <td class="mono">{{ fmtCount(m.generated) }}</td>
              <td class="mono">{{ fmtCount(m.prompt) }}</td>
              <td class="mono">{{ fmtCount(m.cached) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="muted">no token counters yet — engines publish them per backend (vLLM, llama.cpp, q27, ds4)</p>
      </div>
    </section>
  </template>
</template>

<style scoped>
.capitalize { text-transform: capitalize; }
</style>
