<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { fetchAnalytics, fetchTokenMacro } from "../api";
import { fmtCount } from "../analytics";
import { TOKENS_RANGE_TABS, clusterRows, fmtHitPct, modelRows, nodeRows, trendValues } from "../tokens-data";
import Sparkline from "./Sparkline.vue";
import type { TokenMacroResponse } from "@irori/core";

/**
 * Token macro views (IRI-040 / IR-118): fleet, per node/cluster, per model —
 * counter-based (M7 token ledger), never the capture proxy. Owner-specified
 * metrics: total, generated, input, cache, cache hit %.
 */
const range = ref<(typeof TOKENS_RANGE_TABS)[number]["value"]>("24h");
const groupBy = ref<"cluster" | "node">("cluster");
const macro = ref<TokenMacroResponse | null>(null);
const trend = ref<Array<number | null>>([]);
const loading = ref(false);
const error = ref<string | null>(null);
let loadSeq = 0;

async function load(): Promise<void> {
  const seq = ++loadSeq;
  loading.value = true;
  error.value = null;
  try {
    const [m, lens] = await Promise.all([
      fetchTokenMacro(range.value),
      fetchAnalytics("tokens", range.value, groupBy.value),
    ]);
    if (seq !== loadSeq) return;
    macro.value = m;
    trend.value = trendValues(lens.series);
  } catch (err) {
    if (seq !== loadSeq) return;
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    if (seq === loadSeq) loading.value = false;
  }
}

onMounted(() => void load());
watch([range, groupBy], () => void load());

const tiles = computed(() => {
  const f = macro.value?.fleet;
  return [
    { label: "Total tokens", value: f ? fmtCount(f.total) : "—" },
    { label: "Generated", value: f ? fmtCount(f.generated) : "—" },
    { label: "Input (prompt)", value: f ? fmtCount(f.input) : "—" },
    { label: "Cache", value: f ? fmtCount(f.cached) : "—" },
    { label: "Cache hit", value: f ? fmtHitPct(f.cacheHitPct) : "—" },
  ];
});

const groupedRows = computed(() => (macro.value === null ? [] : groupBy.value === "cluster" ? clusterRows(macro.value) : nodeRows(macro.value)));
const models = computed(() => (macro.value === null ? [] : modelRows(macro.value)));

const trendHeadline = computed(() => {
  const vals = trend.value.filter((v): v is number => v !== null);
  if (vals.length === 0) return "no data in range";
  const total = vals.reduce((s, v) => s + v, 0);
  const peak = Math.max(...vals);
  return `peak ${fmtCount(peak)} · sum ${fmtCount(total)}`;
});

const rangeLabel = computed(() => TOKENS_RANGE_TABS.find((t) => t.value === range.value)?.label ?? range.value);
</script>

<template>
  <div class="pagehead">
    <div>
      <h1>Tokens</h1>
      <p><span class="mono faint">from the token ledger — engine counters, no proxy · total = generated + input · hit = cache / input</span></p>
    </div>
    <div class="seg" role="group" aria-label="Range">
      <button v-for="t in TOKENS_RANGE_TABS" :key="t.value" :class="{ 'is-active': range === t.value }" @click="range = t.value">{{ t.label }}</button>
    </div>
  </div>

  <p v-if="error" class="banner banner--warn">{{ error }}</p>
  <p v-else-if="loading && macro === null" class="muted">loading…</p>

  <template v-if="macro !== null">
    <section class="card" style="margin-bottom: 12px">
      <div class="card__body">
        <div class="statgrid statgrid--6">
          <div v-for="t in tiles" :key="t.label" class="stat">
            <span class="stat__label">{{ t.label }}</span>
            <span class="stat__value">{{ t.value }}</span>
          </div>
        </div>
        <p class="stat__sub">{{ rangeLabel }} · fleet</p>
      </div>
    </section>

    <section class="card" style="margin-bottom: 12px">
      <div class="card__head"><h3>Total tokens over {{ rangeLabel }}</h3><span class="mono faint">{{ trendHeadline }}</span></div>
      <div class="card__body">
        <Sparkline v-if="trend.length > 0" :points="trend" :height="56" color="var(--accent)" :format="(v: number) => fmtCount(v)" aria-label="fleet total tokens over the selected range" />
        <p v-else class="muted">no data in range</p>
      </div>
    </section>

    <section class="card" style="margin-bottom: 12px">
      <div class="card__head">
        <div class="row">
          <h3>{{ groupBy === "cluster" ? "By cluster" : "By node" }}</h3>
          <span class="mono faint">{{ groupedRows.length }} row{{ groupedRows.length === 1 ? "" : "s" }}</span>
        </div>
        <div class="seg" role="group" aria-label="Group by">
          <button :class="{ 'is-active': groupBy === 'cluster' }" @click="groupBy = 'cluster'">cluster</button>
          <button :class="{ 'is-active': groupBy === 'node' }" @click="groupBy = 'node'">node</button>
        </div>
      </div>
      <div class="card__body">
        <table v-if="groupedRows.length > 0" class="tbl">
          <thead>
            <tr><th>{{ groupBy }}</th><th>total</th><th>generated</th><th>input</th><th>cache</th><th>cache hit</th></tr>
          </thead>
          <tbody>
            <tr v-for="r in groupedRows" :key="r.key">
              <td class="mono">{{ r.label }}<span v-if="r.sub !== null" class="mono faint"> · {{ r.sub }}</span></td>
              <td class="mono">{{ fmtCount(r.total) }}</td>
              <td class="mono">{{ fmtCount(r.generated) }}</td>
              <td class="mono">{{ fmtCount(r.input) }}</td>
              <td class="mono">{{ fmtCount(r.cached) }}</td>
              <td class="mono">{{ fmtHitPct(r.cacheHitPct) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="muted">no token counters in range — engines publish them per backend (vLLM, llama.cpp, q27, ds4)</p>
      </div>
    </section>

    <section class="card" style="margin-bottom: 12px">
      <div class="card__head"><h3>By model</h3><span class="mono faint">{{ models.length }} model{{ models.length === 1 ? "" : "s" }}</span></div>
      <div class="card__body">
        <table v-if="models.length > 0" class="tbl">
          <thead>
            <tr><th>model</th><th>total</th><th>generated</th><th>input</th><th>cache</th><th>cache hit</th></tr>
          </thead>
          <tbody>
            <tr v-for="r in models" :key="r.key">
              <td class="mono">{{ r.label }}</td>
              <td class="mono">{{ fmtCount(r.total) }}</td>
              <td class="mono">{{ fmtCount(r.generated) }}</td>
              <td class="mono">{{ fmtCount(r.input) }}</td>
              <td class="mono">{{ fmtCount(r.cached) }}</td>
              <td class="mono">{{ fmtHitPct(r.cacheHitPct) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="muted">no models in range</p>
      </div>
    </section>
  </template>
</template>
