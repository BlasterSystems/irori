<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { live } from "../live";
import {
  fetchHistory,
  HISTORY_RANGES,
  type HistoryRange,
  type HistoryResponse,
} from "../api";
import { computeCardData } from "../card-data";
import { computeDetailData } from "../detail-data";
import Sparkline from "./Sparkline.vue";

const props = defineProps<{ nodeId: string }>();

const node = computed(() => live.nodes.get(props.nodeId) ?? null);
const snapshot = computed(() => live.snapshots.get(props.nodeId) ?? null);
const card = computed(() =>
  node.value ? computeCardData(node.value, snapshot.value) : null,
);
/** Registry loaded but the id is unknown → real "not found", not "loading". */
const notFound = computed(() => node.value === null && live.nodes.size > 0);

const range = ref<HistoryRange>("24h");
const history = ref<HistoryResponse | null>(null);
const loadState = ref<"loading" | "ready" | "error">("loading");
const errorMessage = ref<string | null>(null);
let controller: AbortController | null = null;

async function load(): Promise<void> {
  controller?.abort();
  controller = new AbortController();
  const { signal } = controller;
  loadState.value = "loading";
  errorMessage.value = null;
  try {
    const res = await fetchHistory(props.nodeId, range.value, signal);
    if (signal.aborted) return;
    history.value = res;
    loadState.value = "ready";
  } catch (err) {
    if (signal.aborted) return;
    history.value = null;
    loadState.value = "error";
    errorMessage.value = err instanceof Error ? err.message : String(err);
  }
}

watch(
  () => props.nodeId,
  () => {
    void load();
  },
);
watch(range, () => {
  void load();
});
onMounted(() => {
  void load();
});
onUnmounted(() => controller?.abort());

const detail = computed(() =>
  computeDetailData(snapshot.value, history.value, range.value),
);

const historyMeta = computed(() => {
  if (loadState.value === "loading") return "loading…";
  if (loadState.value === "error") return "unavailable";
  return `${detail.value.granularity} buckets · ${detail.value.pointCount} pts`;
});

const statusChipClass = computed(() =>
  node.value?.online ? "chip--ok" : "chip--muted",
);
</script>

<template>
  <div>
    <div class="pagehead">
      <div>
        <p class="label" style="margin: 0 0 4px;">Nodes / {{ node?.name ?? "…" }}</p>
        <div class="row">
          <h1>{{ node?.name ?? nodeId }}</h1>
          <template v-if="card">
            <span v-if="card.role !== 'standalone'" class="chip chip--accent">{{ card.role }}</span>
            <span class="chip">{{ card.kind }}</span>
            <span class="chip" :class="statusChipClass">
              <span class="dot" :class="card.dotClass" aria-hidden="true"></span>{{ card.statusText }}
            </span>
            <span class="chip">{{ node?.host }}</span>
            <span v-if="card.agentVersion" class="chip">Agent {{ card.agentVersion }}</span>
          </template>
          <a class="chip detail-back" href="#/">← Overview</a>
        </div>
        <p v-if="notFound" class="muted" style="margin-top: 8px;">
          Node not found in the registry — it may have been removed.
        </p>
      </div>
    </div>

    <h2 style="margin-bottom: 10px;">Live</h2>
    <section class="cols cols-2" style="margin-bottom: 12px;">
      <article class="card">
        <div class="card__head">
          <h3>Sensors</h3>
          <span v-if="card" class="mono faint">{{ card.online ? "streaming" : "offline" }}</span>
        </div>
        <div class="card__body" style="padding-top: 12px;">
          <template v-if="card?.hasSnapshot">
            <div class="barrow"><span>CPU</span><div class="bar"><div class="bar__fill" :style="{ width: (card.cpuBarPct ?? 0) + '%' }"></div></div><span class="val">{{ card.cpuLine }}</span></div>
            <div class="barrow"><span>MEM</span><div class="bar"><div class="bar__fill" :style="{ width: (card.memBarPct ?? 0) + '%' }"></div></div><span class="val">{{ card.memLine }}</span></div>
            <div v-for="gpu in card.gpus" :key="gpu.index" class="barrow">
              <span>GPU{{ gpu.index }}</span>
              <div class="bar"><div class="bar__fill" :style="{ width: (gpu.barPct ?? 0) + '%' }"></div></div>
              <span class="val">{{ gpu.name }} · {{ gpu.line }}</span>
            </div>
          </template>
          <p v-else class="muted">waiting for first snapshot</p>
        </div>
      </article>
    </section>

    <h2 style="margin-bottom: 10px;">History</h2>
    <div class="row row--between detail-range" style="margin-bottom: 12px;">
      <div class="seg" role="group" aria-label="History range">
        <button
          v-for="r in HISTORY_RANGES"
          :key="r"
          type="button"
          :class="{ 'is-active': r === range }"
          @click="range = r"
        >{{ r }}</button>
      </div>
      <span class="mono faint">{{ historyMeta }}</span>
    </div>

    <div
      v-if="loadState === 'error'"
      class="banner banner--warn"
      role="alert"
      style="margin-bottom: 12px; flex-wrap: wrap; row-gap: 8px;"
    >
      <span class="grow">history unavailable — {{ errorMessage }}</span>
      <button class="btn btn--sm btn--secondary" type="button" @click="load">Retry</button>
    </div>

    <section v-if="loadState === 'ready'" class="cols cols-2">
      <article class="card">
        <div class="card__head"><h3>CPU</h3><span class="mono faint">{{ detail.cpu.current }}</span></div>
        <div class="card__body" style="padding-top: 12px;">
          <template v-if="detail.cpu.current">
            <Sparkline :points="detail.cpu.series" :domain="{ min: 0, max: 100 }" :aria-label="`CPU usage, ${range}`" />
            <p v-if="detail.cpu.sub" class="stat__sub" style="margin-top: 8px;">{{ detail.cpu.sub }}</p>
          </template>
          <p v-else class="muted">no data yet</p>
        </div>
      </article>

      <article class="card">
        <div class="card__head"><h3>Memory</h3><span class="mono faint">{{ detail.memory.current }}</span></div>
        <div class="card__body" style="padding-top: 12px;">
          <template v-if="detail.memory.current">
            <Sparkline :points="detail.memory.series" :aria-label="`Memory used, ${range}`" />
            <p v-if="detail.memory.sub" class="stat__sub" style="margin-top: 8px;">{{ detail.memory.sub }}</p>
            <p v-for="note in detail.memory.notes" :key="note" class="stat__sub">{{ note }}</p>
          </template>
          <p v-else class="muted">no data yet</p>
        </div>
      </article>

      <article class="card">
        <div class="card__head"><h3>GPU</h3><span class="mono faint">{{ detail.gpu.current }}</span></div>
        <div class="card__body" style="padding-top: 12px;">
          <template v-if="detail.gpu.current">
            <Sparkline :points="detail.gpu.series" :domain="{ min: 0, max: 100 }" :aria-label="`GPU usage, ${range}`" />
            <p v-if="detail.gpu.sub" class="stat__sub" style="margin-top: 8px;">{{ detail.gpu.sub }}</p>
            <p v-for="note in detail.gpu.notes" :key="note" class="stat__sub">{{ note }}</p>
          </template>
          <p v-else class="muted">no data yet</p>
        </div>
      </article>

      <article class="card">
        <div class="card__head"><h3>Network</h3><span class="mono faint">{{ detail.network.current }}</span></div>
        <div class="card__body" style="padding-top: 12px;">
          <template v-if="detail.network.current">
            <div class="barrow">
              <span>RX</span>
              <Sparkline :points="detail.network.series" :height="36" :aria-label="`Network receive, ${range}`" />
              <span class="val">{{ detail.network.current }}</span>
            </div>
            <div v-if="detail.network.series2" class="barrow">
              <span>TX</span>
              <Sparkline :points="detail.network.series2" :height="36" :aria-label="`Network transmit, ${range}`" />
              <span class="val">{{ detail.network.sub }}</span>
            </div>
          </template>
          <p v-else class="muted">no data yet</p>
        </div>
      </article>
    </section>
  </div>
</template>

<style scoped>
.detail-back {
  display: inline-flex;
  align-items: center;
  min-height: 34px;
}

/* The h1 falls back to the raw node id until the registry loads; keep the
   36-char UUID from forcing horizontal overflow on 390px phones. */
h1 {
  overflow-wrap: anywhere;
}

@media (max-width: 720px) {
  .detail-back {
    min-height: 44px;
  }
  .detail-range {
    width: 100%;
  }
  .detail-range .seg button {
    min-height: 44px;
  }
}
</style>
