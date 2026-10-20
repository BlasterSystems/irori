<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import {
  fetchUsageErrors,
  fetchUsageModels,
  fetchUsageOverview,
  fetchUsageRequest,
  fetchUsageRequests,
  type UsageRangeName,
} from "../api";
import { live } from "../live";
import { parseUsageHash, usageHashFor, type UsageTab, USAGE_TABS } from "../usage";
import {
  activityCharts,
  errorGroupRows,
  fmtBucketShort,
  fmtCount,
  fmtDurationMs,
  fmtPct,
  fmtTimeIso,
  fmtTokens,
  fmtTps,
  mergeLiveRequest,
  modelSeries,
  requestTier,
  statusText,
  tierChipClass,
  tokenMix,
  topModels,
  usageChart,
} from "../usage";
import type {
  UsageErrorsResponse,
  UsageModelsResponse,
  UsageOverviewResponse,
  UsageRequestRow,
  UsageRequestsResponse,
} from "@irori/core";
import LensChart from "./LensChart.vue";

/** Tab + range live in the hash (#/usage?tab=&range=) — shareable links. */
const tab = ref<UsageTab>("overview");
const range = ref<UsageRangeName>("24h");
const loading = ref(false);
const error = ref<string | null>(null);
let loadSeq = 0;

/** External hash edits (back/forward, shared links) re-sync tab+range. */
function onHashChange(): void {
  const parsed = parseUsageHash(typeof location === "undefined" ? "" : location.hash);
  if (parsed.tab !== tab.value || parsed.range !== range.value) {
    tab.value = parsed.tab;
    range.value = parsed.range as UsageRangeName;
  }
}

/** Per-tab payloads. */
const overview = ref<UsageOverviewResponse | null>(null);
const requests = ref<UsageRequestsResponse | null>(null);
const errors = ref<UsageErrorsResponse | null>(null);
const models = ref<UsageModelsResponse | null>(null);

/** Requests filters (page resets on change). */
const errorOnly = ref(false);
const statusFilter = ref<string>("");
const sigFilter = ref<string | null>(null);
const page = ref(1);
const PAGE_SIZE = 50;
const totalPages = computed(() => (requests.value === null ? 1 : Math.max(1, Math.ceil(requests.value.total / PAGE_SIZE))));

/** Models tab: which model's series is charted. */
const selectedModel = ref<string | null>(null);

const drawer = ref<{ row: UsageRequestRow; detail: UsageRequestRow | null } | null>(null);

function syncHash(): void {
  const next = usageHashFor(tab.value, range.value);
  if (location.hash !== next) history.replaceState(null, "", next);
}

async function load(): Promise<void> {
  const seq = ++loadSeq;
  loading.value = true;
  error.value = null;
  try {
    if (tab.value === "overview") {
      const data = await fetchUsageOverview(range.value);
      if (seq !== loadSeq) return;
      overview.value = data;
    } else if (tab.value === "requests") {
      const status = statusFilter.value.trim().length > 0 ? Number.parseInt(statusFilter.value, 10) : undefined;
      const data = await fetchUsageRequests(range.value, {
        errorOnly: errorOnly.value || undefined,
        sig: sigFilter.value ?? undefined,
        status: status !== undefined && Number.isFinite(status) ? status : undefined,
        page: page.value,
        limit: PAGE_SIZE,
      });
      if (seq !== loadSeq) return;
      requests.value = data;
    } else if (tab.value === "errors") {
      const data = await fetchUsageErrors(range.value);
      if (seq !== loadSeq) return;
      errors.value = data;
    } else {
      const data = await fetchUsageModels(range.value);
      if (seq !== loadSeq) return;
      models.value = data;
      const tops = topModels(data.models, 6);
      if (selectedModel.value === null || !tops.includes(selectedModel.value)) {
        selectedModel.value = tops[0] ?? null;
      }
    }
  } catch (err) {
    if (seq !== loadSeq) return;
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    if (seq === loadSeq) loading.value = false;
  }
}

onMounted(() => {
  const parsed = parseUsageHash(typeof location === "undefined" ? "" : location.hash);
  tab.value = parsed.tab;
  range.value = parsed.range as UsageRangeName;
  window.addEventListener("hashchange", onHashChange);
  void load();
});

onUnmounted(() => {
  window.removeEventListener("hashchange", onHashChange);
});

watch([tab, range, errorOnly, statusFilter], () => {
  page.value = 1;
  sigFilter.value = tab.value === "requests" ? sigFilter.value : null;
  drawer.value = null;
  syncHash();
  void load();
});
watch(page, () => void load());

/** Live: merge SSE-captured requests into the visible page (newest first). */
const REQUESTS_MERGE_CAP = 200;
const mergedRows = computed<UsageRequestRow[]>(() => {
  const base = requests.value?.rows ?? [];
  if (tab.value !== "requests") return base;
  let rows = base;
  for (const event of live.usageLatest.value) {
    if (rows.some((r) => r.id === event.request.id)) continue;
    rows = mergeLiveRequest(rows, event, REQUESTS_MERGE_CAP);
  }
  return rows;
});

async function openDrawer(row: UsageRequestRow): Promise<void> {
  drawer.value = { row, detail: null };
  try {
    const detail = await fetchUsageRequest(row.id);
    if (drawer.value?.row.id === row.id) drawer.value = { row, detail: detail ?? row };
  } catch {
    if (drawer.value?.row.id === row.id) drawer.value = { row, detail: row };
  }
}

function showErrorsFor(sig: string): void {
  sigFilter.value = sig;
  tab.value = "requests";
  page.value = 1;
  syncHash();
  void load();
}

const W = 680;
const H = 140;

const activity = computed(() => {
  if (overview.value === null) return null;
  return activityCharts(overview.value.series, W, H);
});

const tokenMixRows = computed(() => (overview.value === null ? [] : tokenMix(overview.value.tokenMix)));

const modelOptions = computed(() => topModels(models.value?.models ?? [], 6));
const modelCharts = computed(() => {
  const data = models.value;
  if (data === null || selectedModel.value === null) return null;
  const points = modelSeries(data.series, selectedModel.value);
  return {
    ttft: usageChart(points.map((p) => ({ t: p.t, value: p.ttftP50Ms })), W, H),
    tps: usageChart(points.map((p) => ({ t: p.t, value: p.decodeTps })), W, H),
  };
});

const kpis = computed(() => overview.value?.kpis ?? null);
const errorRate = computed(() => {
  if (kpis.value === null || kpis.value.requests === 0) return null;
  return kpis.value.errors / kpis.value.requests;
});
const cachedShare = computed(() => {
  if (kpis.value === null || kpis.value.promptTokens === 0) return null;
  return kpis.value.cachedTokens / kpis.value.promptTokens;
});

const detailJson = computed(() => {
  const detail = drawer.value?.detail;
  if (detail === null || detail === undefined) return null;
  const meta = detail.engineMeta;
  return meta === null || meta === undefined ? null : JSON.stringify(meta, null, 2);
});

const liveAgeText = computed(() => {
  const v = live.lastEventAgeMs.value;
  return v === null ? null : `${Math.round(v / 1000)}s`;
});
</script>

<template>
  <div>
    <div class="pagehead">
      <div>
        <h1 style="font-size: 20px">Usage</h1>
        <p>Captured LLM traffic through proxy-flagged setups (ADR-0008).</p>
      </div>
      <div class="row">
        <span v-if="live.connected" class="chip chip--ok"><span class="pulse" aria-hidden="true"></span>Live<template v-if="liveAgeText"> · {{ liveAgeText }}</template></span>
        <span v-else class="chip chip--muted">Connecting…</span>
        <nav class="seg" aria-label="Range">
          <button v-for="r in [{ v: '1h', l: '1h' }, { v: '24h', l: '24h' }, { v: '7d', l: '7d' }, { v: '30d', l: '30d' }, { v: '90d', l: '90d' }]" :key="r.v" :class="{ 'is-active': range === r.v }" @click="range = r.v as UsageRangeName">{{ r.l }}</button>
        </nav>
      </div>
    </div>

    <nav class="tabs" aria-label="Usage sections">
      <button v-for="t in USAGE_TABS" :key="t" :class="{ 'is-active': tab === t }" @click="tab = t">{{ t[0]!.toUpperCase() + t.slice(1) }}</button>
    </nav>

    <p v-if="error" class="faint" style="margin-top: 10px" role="alert">{{ error }}</p>
    <p v-else-if="loading && overview === null && requests === null && errors === null && models === null" class="faint" style="margin-top: 10px">Loading…</p>

    <!-- Overview: KPIs + activity + token mix -->
    <template v-if="tab === 'overview'">
      <div v-if="kpis !== null" class="statgrid statgrid--6" style="margin-top: var(--space-4)">
        <div><span class="stat__label">Requests</span><span class="stat__value">{{ fmtCount(kpis.requests) }}</span></div>
        <div><span class="stat__label">Errors</span><span class="stat__value">{{ fmtCount(kpis.errors) }}<template v-if="errorRate !== null"> · {{ fmtPct(errorRate) }}</template></span></div>
        <div><span class="stat__label">Total tokens</span><span class="stat__value">{{ fmtTokens(kpis.totalTokens) }}</span></div>
        <div><span class="stat__label">Prompt / cached</span><span class="stat__value stat__value--sm">{{ fmtTokens(kpis.promptTokens) }}<template v-if="cachedShare !== null"> · {{ fmtPct(cachedShare) }}</template></span></div>
        <div><span class="stat__label">TTFT p95</span><span class="stat__value stat__value--sm">{{ fmtDurationMs(kpis.ttftP95Ms) }}</span></div>
        <div><span class="stat__label">Decode tok/s</span><span class="stat__value stat__value--sm">{{ fmtTps(kpis.decodeTps) }}</span></div>
      </div>

      <div v-if="activity !== null" class="cols cols-2" style="margin-top: var(--space-4)">
        <section class="card">
          <div class="card__head"><h3 style="font-size: 15px">Requests</h3><span class="mono faint">per {{ overview?.granularity ?? "hour" }}</span></div>
          <div class="card__body"><LensChart :chart="activity.requests" unit="req" aria-label="Requests per bucket" :format="(v: number) => fmtCount(v)" :time-format="fmtBucketShort" /></div>
        </section>
        <section class="card">
          <div class="card__head"><h3 style="font-size: 15px">Errors</h3><span class="mono faint">per {{ overview?.granularity ?? "hour" }}</span></div>
          <div class="card__body"><LensChart :chart="activity.errors" unit="err" aria-label="Errors per bucket" :format="(v: number) => fmtCount(v)" :time-format="fmtBucketShort" /></div>
        </section>
      </div>
      <section v-if="activity !== null" class="card" style="margin-top: var(--space-4)">
        <div class="card__head"><h3 style="font-size: 15px">Tokens</h3><span class="mono faint">total per {{ overview?.granularity ?? "hour" }}</span></div>
        <div class="card__body"><LensChart :chart="activity.tokens" unit="tok" aria-label="Tokens per bucket" :format="(v: number) => fmtTokens(v)" :time-format="fmtBucketShort" /></div>
      </section>

      <section class="card" style="margin-top: var(--space-4)">
        <div class="card__head"><h3 style="font-size: 15px">Token mix by model</h3><span class="mono faint">{{ range }}</span></div>
        <div class="card__body card__body--flush">
          <table class="table">
            <thead>
              <tr><th>Model</th><th>Requests</th><th>Errors</th><th>Prompt</th><th>Completion</th><th>Cached</th><th>Reasoning</th><th>Total</th><th>Share</th></tr>
            </thead>
            <tbody>
              <tr v-for="row in tokenMixRows" :key="row.model">
                <td class="mono">{{ row.model === "" ? "(unknown)" : row.model }}</td>
                <td class="mono">{{ fmtCount(row.requests) }}</td>
                <td class="mono">{{ fmtCount(row.errors) }}</td>
                <td class="mono">{{ fmtTokens(row.promptTokens) }}</td>
                <td class="mono">{{ fmtTokens(row.completionTokens) }}</td>
                <td class="mono">{{ fmtTokens(row.cachedTokens) }}</td>
                <td class="mono">{{ fmtTokens(row.reasoningTokens) }}</td>
                <td class="mono">{{ fmtTokens(row.totalTokens) }}</td>
                <td class="mono">{{ fmtPct(row.share) }}</td>
              </tr>
              <tr v-if="tokenMixRows.length === 0"><td colspan="9" class="faint">No captured traffic in this range.</td></tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>

    <!-- Requests: filters + table + drawer -->
    <template v-else-if="tab === 'requests'">
      <div class="toolbar row" style="margin-top: var(--space-4)">
        <label class="row" style="gap: 6px; font-size: 13px"><input v-model="errorOnly" type="checkbox" /> Errors only</label>
        <input v-model="statusFilter" class="input mono" style="max-width: 120px" placeholder="status e.g. 429" inputmode="numeric" aria-label="Filter by HTTP status" />
        <span v-if="sigFilter !== null" class="chip chip--accent">sig: {{ sigFilter.slice(0, 42) }}{{ sigFilter.length > 42 ? "…" : "" }} <button class="btn btn--ghost btn--sm" @click="sigFilter = null">clear</button></span>
        <span class="faint mono" style="font-size: 12px">{{ requests?.total ?? 0 }} requests</span>
      </div>
      <section class="card" style="margin-top: var(--space-3)">
        <div class="card__body card__body--flush">
          <table class="table">
            <thead>
              <tr><th>Received</th><th>Model</th><th>Endpoint</th><th>Status</th><th>Duration</th><th>TTFT</th><th>tok/s</th><th>Prompt</th><th>Completion</th><th></th></tr>
            </thead>
            <tbody>
              <tr v-for="row in mergedRows" :key="row.id">
                <td class="mono">{{ fmtTimeIso(row.receivedAtMs) }}</td>
                <td class="mono">{{ row.model ?? "(unknown)" }}</td>
                <td class="mono">{{ row.endpoint }}</td>
                <td><span :class="['chip', tierChipClass(requestTier(row))]">{{ statusText(row) }}</span></td>
                <td class="mono">{{ fmtDurationMs(row.durationMs) }}</td>
                <td class="mono">{{ fmtDurationMs(row.ttftMs) }}</td>
                <td class="mono">{{ fmtTps(row.decodeTps) }}</td>
                <td class="mono">{{ fmtTokens(row.promptTokens) }}</td>
                <td class="mono">{{ fmtTokens(row.completionTokens) }}</td>
                <td><button class="btn btn--ghost btn--sm" @click="openDrawer(row)">detail</button></td>
              </tr>
              <tr v-if="mergedRows.length === 0"><td colspan="10" class="faint">No requests match.</td></tr>
            </tbody>
          </table>
        </div>
      </section>
      <div v-if="(totalPages ?? 1) > 1" class="row" style="margin-top: var(--space-3)">
        <button class="btn btn--secondary btn--sm" :disabled="page <= 1" @click="page = page - 1">‹ Prev</button>
        <span class="mono faint">page {{ page }} / {{ totalPages }}</span>
        <button class="btn btn--secondary btn--sm" :disabled="page >= totalPages" @click="page = page + 1">Next ›</button>
      </div>
    </template>

    <!-- Errors: signature groups -->
    <template v-else-if="tab === 'errors'">
      <section class="card" style="margin-top: var(--space-4)">
        <div class="card__head"><h3 style="font-size: 15px">Error signatures</h3><span class="mono faint">{{ range }}</span></div>
        <div class="card__body card__body--flush">
          <table class="table">
            <thead>
              <tr><th>Count</th><th>Status</th><th>Signature</th><th>Models</th><th>Last seen</th><th></th></tr>
            </thead>
            <tbody>
              <tr v-for="g in errorGroupRows(errors?.groups ?? [])" :key="g.sig">
                <td class="mono">{{ fmtCount(g.count) }}</td>
                <td class="mono">{{ g.status ?? "—" }}</td>
                <td class="mono" style="max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap" :title="g.sample">{{ g.sig }}</td>
                <td class="mono">{{ g.models.length === 0 ? "—" : g.models.join(", ") }}</td>
                <td class="mono">{{ fmtTimeIso(g.lastSeenMs) }}</td>
                <td><button class="btn btn--ghost btn--sm" @click="showErrorsFor(g.sig)">requests</button></td>
              </tr>
              <tr v-if="(errors?.groups.length ?? 0) === 0"><td colspan="6" class="faint">No errors in this range.</td></tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>

    <!-- Models: aggregates + per-model series -->
    <template v-else>
      <section class="card" style="margin-top: var(--space-4)">
        <div class="card__head"><h3 style="font-size: 15px">Models</h3><span class="mono faint">{{ range }}</span></div>
        <div class="card__body card__body--flush">
          <table class="table">
            <thead>
              <tr><th>Model</th><th>Requests</th><th>Errors</th><th>Total tokens</th><th>TTFT p50</th><th>TTFT p95</th><th>tok/s</th></tr>
            </thead>
            <tbody>
              <tr v-for="m in models?.models ?? []" :key="m.model">
                <td class="mono">{{ m.model === "" ? "(unknown)" : m.model }}</td>
                <td class="mono">{{ fmtCount(m.requests) }}</td>
                <td class="mono">{{ fmtCount(m.errors) }}</td>
                <td class="mono">{{ fmtTokens(m.totalTokens) }}</td>
                <td class="mono">{{ fmtDurationMs(m.ttftP50Ms) }}</td>
                <td class="mono">{{ fmtDurationMs(m.ttftP95Ms) }}</td>
                <td class="mono">{{ fmtTps(m.decodeTps) }}</td>
              </tr>
              <tr v-if="(models?.models.length ?? 0) === 0"><td colspan="7" class="faint">No captured traffic in this range.</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <div v-if="modelCharts !== null" class="cols cols-2" style="margin-top: var(--space-4)">
        <section class="card">
          <div class="card__head">
            <h3 style="font-size: 15px">TTFT p50 — {{ selectedModel }}</h3>
            <select v-if="modelOptions.length > 0" class="select" style="max-width: 220px" aria-label="Model" @change="selectedModel = ($event.target as HTMLSelectElement).value">
              <option v-for="m in modelOptions" :key="m" :value="m" :selected="m === selectedModel">{{ m }}</option>
            </select>
          </div>
          <div class="card__body"><LensChart :chart="modelCharts.ttft" unit="ms" aria-label="TTFT p50 per bucket" :format="(v: number) => fmtDurationMs(v)" :time-format="fmtBucketShort" /></div>
        </section>
        <section class="card">
          <div class="card__head"><h3 style="font-size: 15px">Decode tok/s — {{ selectedModel }}</h3></div>
          <div class="card__body"><LensChart :chart="modelCharts.tps" unit="tok/s" aria-label="Decode tok/s per bucket" :format="fmtTps" :time-format="fmtBucketShort" /></div>
        </section>
      </div>
    </template>

    <!-- Request detail drawer -->
    <div v-if="drawer !== null" class="drawer-scrim" @click.self="drawer = null">
      <aside class="drawer" role="dialog" aria-label="Request details">
        <div class="row row--between" style="margin-bottom: 10px">
          <h3 style="font-size: 17px">Request {{ drawer.row.id.slice(0, 8) }}</h3>
          <button class="btn btn--ghost btn--sm" aria-label="Close details" @click="drawer = null">✕</button>
        </div>
        <table class="table">
          <tbody>
            <tr><td class="faint">Received</td><td class="mono">{{ fmtTimeIso(drawer.row.receivedAtMs) }}</td></tr>
            <tr><td class="faint">Model</td><td class="mono">{{ drawer.row.model ?? "(unknown)" }}</td></tr>
            <tr><td class="faint">Endpoint</td><td class="mono">{{ drawer.row.endpoint }}<template v-if="drawer.row.stream"> (stream)</template></td></tr>
            <tr><td class="faint">Status</td><td class="mono">{{ statusText(drawer.row) }}</td></tr>
            <tr v-if="drawer.row.error !== null"><td class="faint">Error</td><td class="mono">{{ drawer.row.error }}</td></tr>
            <tr><td class="faint">Duration / TTFT</td><td class="mono">{{ fmtDurationMs(drawer.row.durationMs) }} / {{ fmtDurationMs(drawer.row.ttftMs) }}</td></tr>
            <tr><td class="faint">Decode tok/s</td><td class="mono">{{ fmtTps(drawer.row.decodeTps) }}</td></tr>
            <tr><td class="faint">Tokens</td><td class="mono">prompt {{ fmtTokens(drawer.row.promptTokens) }} · completion {{ fmtTokens(drawer.row.completionTokens) }} · cached {{ fmtTokens(drawer.row.cachedTokens) }} · reasoning {{ fmtTokens(drawer.row.reasoningTokens) }} · total {{ fmtTokens(drawer.row.totalTokens) }}</td></tr>
            <tr><td class="faint">Payload sizes</td><td class="mono">req {{ fmtCount(drawer.row.reqBytes) }} B · res {{ fmtCount(drawer.row.resBytes) }} B</td></tr>
            <tr><td class="faint">Source</td><td class="mono">{{ drawer.row.sourceAddr ?? "—" }}</td></tr>
            <tr><td class="faint">Node</td><td class="mono">{{ drawer.row.nodeId }}</td></tr>
          </tbody>
        </table>
        <pre v-if="detailJson !== null" class="log" style="margin-top: 10px; padding: 10px; font-size: 12px; white-space: pre-wrap">{{ detailJson }}</pre>
      </aside>
    </div>
  </div>
</template>
