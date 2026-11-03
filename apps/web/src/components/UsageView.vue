<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import {
  createUsageClient,
  deleteUsageClient,
  fetchUsageAgents,
  fetchUsageClients,
  fetchUsageErrors,
  fetchUsageModels,
  fetchUsageOverview,
  fetchUsageRequest,
  fetchUsageRequests,
  fetchUsageRetries,
  fetchUsageTools,
  fetchRequestTrace,
  type UsageRangeName,
  type UsageRetriesResponse,
} from "../api";
import type { UsageTrace } from "@irori/core";
import { live } from "../live";
import { vScrimClose } from "../scrim";
import { costText } from "../cost-format";
import { parseUsageHash, usageHashFor, agentGroupKey, agentGroupLabel, agentGroupSource, clientLabel, retryText, toolRowKey, type UsageTab, USAGE_TABS } from "../usage";
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
  ClientIdentityCreated,
  ClientIdentityInfo,
  UsageAgentsResponse,
  UsageErrorsResponse,
  UsageModelsResponse,
  UsageOverviewResponse,
  UsageRequestRow,
  UsageRequestsResponse,
  UsageToolsResponse,
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
const agents = ref<UsageAgentsResponse | null>(null);
const tools = ref<UsageToolsResponse | null>(null);

/** IR-55 client filters (requests tab) + identity manager drawer state. */
const projectFilter = ref("");
const agentTypeFilter = ref("");
const clientsOpen = ref(false);
const clients = ref<ClientIdentityInfo[]>([]);
const newIdentityName = ref("");
const newIdentityProject = ref("");
const newIdentityAgentType = ref<"" | "main" | "subagent">("");
const issuedKey = ref<{ name: string; key: string } | null>(null);
const clientsBusy = ref(false);
const clientsError = ref<string | null>(null);

async function loadClients(): Promise<void> {
  try {
    clients.value = (await fetchUsageClients()).clients;
    clientsError.value = null;
  } catch (err) {
    clientsError.value = err instanceof Error ? err.message : String(err);
  }
}

async function submitIdentity(): Promise<void> {
  if (newIdentityName.value.trim().length === 0 || clientsBusy.value) return;
  clientsBusy.value = true;
  clientsError.value = null;
  try {
    const created: ClientIdentityCreated = await createUsageClient({
      name: newIdentityName.value.trim(),
      project: newIdentityProject.value.trim().length > 0 ? newIdentityProject.value.trim() : undefined,
      agentType: newIdentityAgentType.value === "" ? undefined : newIdentityAgentType.value,
    });
    issuedKey.value = { name: created.name, key: created.key };
    newIdentityName.value = "";
    newIdentityProject.value = "";
    newIdentityAgentType.value = "";
    await loadClients();
  } catch (err) {
    clientsError.value = err instanceof Error ? err.message : String(err);
  } finally {
    clientsBusy.value = false;
  }
}

async function removeIdentity(id: string): Promise<void> {
  clientsBusy.value = true;
  try {
    await deleteUsageClient(id);
    await loadClients();
  } catch (err) {
    clientsError.value = err instanceof Error ? err.message : String(err);
  } finally {
    clientsBusy.value = false;
  }
}

function openClients(): void {
  clientsOpen.value = true;
  issuedKey.value = null;
  void loadClients();
}

const knownProjects = computed(() => [...new Set(clients.value.map((c) => c.project).filter((p): p is string => p !== null))]);

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
/** IRI-074: pricing currency of the last requests fetch (drawer cost row). */
const requestsCurrency = ref<string | null>(null);

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
        project: projectFilter.value.length > 0 ? projectFilter.value : undefined,
        agentType: agentTypeFilter.value.length > 0 ? (agentTypeFilter.value as "main" | "subagent") : undefined,
        page: page.value,
        limit: PAGE_SIZE,
      });
      if (seq !== loadSeq) return;
      requests.value = data;
      requestsCurrency.value = data.costCurrency;
    } else if (tab.value === "errors") {
      const data = await fetchUsageErrors(range.value);
      if (seq !== loadSeq) return;
      errors.value = data;
    } else if (tab.value === "retries") {
      const data = await fetchUsageRetries(range.value);
      if (seq !== loadSeq) return;
      retries.value = data;
    } else if (tab.value === "agents") {
      const data = await fetchUsageAgents(range.value);
      if (seq !== loadSeq) return;
      agents.value = data;
    } else if (tab.value === "tools") {
      const data = await fetchUsageTools(range.value);
      if (seq !== loadSeq) return;
      tools.value = data;
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
  void loadClients(); // project filter options (IR-55)
  void load();
});

onUnmounted(() => {
  window.removeEventListener("hashchange", onHashChange);
});

watch([tab, range, errorOnly, statusFilter, projectFilter, agentTypeFilter], () => {
  page.value = 1;
  sigFilter.value = tab.value === "requests" ? sigFilter.value : null;
  drawer.value = null;
  clientsOpen.value = false; // a one-time key must never linger across tabs
  issuedKey.value = null;
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

function copyTraceId(): void {
  if (drawerTrace.value?.traceId !== null && drawerTrace.value?.traceId !== undefined) {
    void navigator.clipboard.writeText(drawerTrace.value.traceId);
  }
}

const traceSegmentSum = computed(() =>
  drawerTrace.value === null ? 0 : drawerTrace.value.spans.reduce((a: number, s) => a + (s.endMs - s.startMs), 0),
);

async function openDrawer(row: UsageRequestRow): Promise<void> {
  drawer.value = { row, detail: null };
  drawerTrace.value = null;
  try {
    const detail = await fetchUsageRequest(row.id);
    if (drawer.value?.row.id === row.id) drawer.value = { row, detail: detail ?? row };
  } catch {
    if (drawer.value?.row.id === row.id) drawer.value = { row, detail: row };
  }
  // IRI-079: waterfall data — a failure just hides the Trace tab.
  try {
    drawerTrace.value = await fetchRequestTrace(row.id);
  } catch {
    drawerTrace.value = null;
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

// IRI-074: cost surfaces — every value renders from API cost fields.
const costCurrency = computed(() => overview.value?.costCurrency ?? null);
const costChart = computed(() => {
  if (overview.value === null || overview.value.costCurrency === null) return null;
  return usageChart(overview.value.series.map((p) => ({ t: p.t, value: p.costMinor / 100 })), W, H);
});
const modelsCostTotal = computed(() => (models.value?.models ?? []).reduce((acc, m) => acc + (m.costMinor ?? 0), 0));
const agentsCostShown = computed(() => (agents.value?.costCurrency ?? null) !== null);
const toolsCostShown = computed(() => (tools.value?.costCurrency ?? null) !== null);
const errorsCostShown = computed(() => (errors.value?.costCurrency ?? null) !== null);
/** IRI-076: retry waste (superseded attempts per client key). */
const retries = ref<UsageRetriesResponse | null>(null);
/** IRI-079: drawer trace (waterfall) — fetched when the drawer opens. */
const drawerTrace = ref<UsageTrace | null>(null);
const retriesCostShown = computed(() => (retries.value?.costCurrency ?? null) !== null);

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
        <p>Captured LLM traffic through proxy-flagged setups.</p>
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
      <div v-if="kpis !== null" class="statgrid statgrid--7" style="margin-top: var(--space-4)">
        <div><span class="stat__label">Requests</span><span class="stat__value">{{ fmtCount(kpis.requests) }}</span></div>
        <div><span class="stat__label">Errors</span><span class="stat__value">{{ fmtCount(kpis.errors) }}<template v-if="errorRate !== null"> · {{ fmtPct(errorRate) }}</template></span></div>
        <div><span class="stat__label">Total tokens</span><span class="stat__value">{{ fmtTokens(kpis.totalTokens) }}</span></div>
        <div>
          <span class="stat__label">Cost</span>
          <span v-if="costCurrency !== null" class="stat__value">{{ costText(overview?.costMinor ?? 0, costCurrency) }}</span>
          <a v-else class="stat__value stat__value--sm" href="#/settings" title="Set token prices in Hub settings to see costs">Configure pricing</a>
        </div>
        <div><span class="stat__label">Prompt / cached</span><span class="stat__value stat__value--sm">{{ fmtTokens(kpis.promptTokens) }}<template v-if="cachedShare !== null"> · {{ fmtPct(cachedShare) }}</template></span></div>
        <div><span class="stat__label">TTFT p95</span><span class="stat__value stat__value--sm">{{ fmtDurationMs(kpis.ttftP95Ms) }}</span></div>
        <div><span class="stat__label">Decode tok/s</span><span class="stat__value stat__value--sm">{{ fmtTps(kpis.decodeTps) }}</span></div>
      </div>
      <!-- IRI-070: quarantined captures are visible, never silent loss. -->
      <p v-if="(overview?.rejected ?? 0) > 0" class="row" style="margin-top: var(--space-2)" role="alert">
        <span class="chip chip--warn" :title="'Schema-rejected captures quarantined in range — inspectable in rejected_usage, counted instead of dropped'">{{ fmtCount(overview?.rejected ?? 0) }} rejected capture{{ (overview?.rejected ?? 0) === 1 ? "" : "s" }} quarantined</span>
      </p>

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

      <!-- IRI-074: range-scoped cost per bucket (errors costed too — a failed
           300k-token request is real money). Hidden while pricing is unset. -->
      <section v-if="costChart !== null" class="card" style="margin-top: var(--space-4)">
        <div class="card__head"><h3 style="font-size: 15px">Cost</h3><span class="mono faint">per {{ overview?.granularity ?? "hour" }} · {{ costCurrency }}</span></div>
        <div class="card__body"><LensChart :chart="costChart" unit="cost" aria-label="Cost per bucket" :format="(v: number) => costText(Math.round(v * 100), costCurrency)" :time-format="fmtBucketShort" /></div>
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
        <select v-model="projectFilter" class="select" style="max-width: 180px" aria-label="Filter by project">
          <option value="">all projects</option>
          <option v-for="p in knownProjects" :key="p" :value="p">{{ p }}</option>
        </select>
        <select v-model="agentTypeFilter" class="select" style="max-width: 150px" aria-label="Filter by agent type">
          <option value="">all agents</option>
          <option value="main">main</option>
          <option value="subagent">subagent</option>
        </select>
        <button class="btn btn--secondary btn--sm" @click="openClients">Client keys</button>
        <span v-if="sigFilter !== null" class="chip chip--accent">sig: {{ sigFilter.slice(0, 42) }}{{ sigFilter.length > 42 ? "…" : "" }} <button class="btn btn--ghost btn--sm" @click="sigFilter = null">clear</button></span>
        <span class="faint mono" style="font-size: 12px">{{ requests?.total ?? 0 }} requests</span>
      </div>
      <section class="card" style="margin-top: var(--space-3)">
        <div class="card__body card__body--flush">
          <table class="table">
            <thead>
              <tr><th>Received</th><th>Client</th><th>Model</th><th>Endpoint</th><th>Status</th><th>Duration</th><th>TTFT</th><th>tok/s</th><th>Prompt</th><th>Completion</th><th></th></tr>
            </thead>
            <tbody>
              <tr v-for="row in mergedRows" :key="row.id">
                <td class="mono">{{ fmtTimeIso(row.receivedAtMs) }}</td>
                <td class="mono">{{ clientLabel(row) }}<template v-if="row.clientAgentType !== null"> · {{ row.clientAgentType }}</template></td>
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
              <tr v-if="mergedRows.length === 0"><td colspan="11" class="faint">No requests match.</td></tr>
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

    <!-- Agents: client identity groups (IR-55) -->
    <template v-else-if="tab === 'agents'">
      <section class="card" style="margin-top: var(--space-4)">
        <div class="card__head">
          <h3 style="font-size: 15px">Agents &amp; clients</h3>
          <span class="row" style="gap: 8px">
            <span class="mono faint">{{ range }}</span>
            <button class="btn btn--secondary btn--sm" @click="openClients">Client keys</button>
          </span>
        </div>
        <div class="card__body card__body--flush">
          <table class="table">
            <thead>
              <tr><th>Client</th><th>Agent type</th><th>Project</th><th>Requests</th><th>Errors</th><th>Prompt</th><th>Completion</th><th>Total</th><th>Cost</th><th>Last seen</th></tr>
            </thead>
            <tbody>
              <tr v-for="g in agents?.groups ?? []" :key="agentGroupKey(g)">
                <td class="mono">{{ agentGroupLabel(g) }}<div class="faint" style="font-size: 11px">{{ agentGroupSource(g) }}</div></td>
                <td><span v-if="g.agentType !== null" :class="['chip', g.agentType === 'main' ? 'chip--accent' : 'chip--muted']">{{ g.agentType }}</span><span v-else class="faint">—</span></td>
                <td class="mono">{{ g.project ?? "—" }}</td>
                <td class="mono">{{ fmtCount(g.requests) }}</td>
                <td class="mono">{{ fmtCount(g.errors) }}</td>
                <td class="mono">{{ fmtTokens(g.promptTokens) }}</td>
                <td class="mono">{{ fmtTokens(g.completionTokens) }}</td>
                <td class="mono">{{ fmtTokens(g.totalTokens) }}</td>
                <td class="mono">{{ agentsCostShown ? costText(g.costMinor, agents?.costCurrency ?? null) : "—" }}</td>
                <td class="mono">{{ fmtTimeIso(g.lastSeenMs) }}</td>
              </tr>
              <tr v-if="(agents?.groups.length ?? 0) === 0"><td colspan="10" class="faint">No captured traffic in this range. Unidentified clients appear here by source IP.</td></tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>

    <!-- Errors: signature groups -->
    <template v-else-if="tab === 'errors'">
      <section class="card" style="margin-top: var(--space-4)">
        <div class="card__head"><h3 style="font-size: 15px">Error signatures</h3><span class="mono faint">{{ range }}</span></div>
        <div class="card__body card__body--flush">
          <table class="table">
            <thead>
              <tr><th>Count</th><th>Status</th><th>Signature</th><th>Models</th><th>Cost</th><th>Last seen</th><th></th></tr>
            </thead>
            <tbody>
              <tr v-for="g in errorGroupRows(errors?.groups ?? [])" :key="g.sig">
                <td class="mono">{{ fmtCount(g.count) }}</td>
                <td class="mono">{{ g.status ?? "—" }}</td>
                <td class="mono" style="max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap" :title="g.sample">{{ g.sig }}</td>
                <td class="mono">{{ g.models.length === 0 ? "—" : g.models.join(", ") }}</td>
                <td class="mono">{{ errorsCostShown ? costText(g.costMinor, errors?.costCurrency ?? null) : "—" }}</td>
                <td class="mono">{{ fmtTimeIso(g.lastSeenMs) }}</td>
                <td><button class="btn btn--ghost btn--sm" @click="showErrorsFor(g.sig)">requests</button></td>
              </tr>
              <tr v-if="(errors?.groups.length ?? 0) === 0"><td colspan="7" class="faint">No errors in this range.</td></tr>
            </tbody>
          </table>
        </div>
      </section>
      <!-- IRI-076: cost of errors for the range, split by signature above. -->
      <p v-if="errorsCostShown && (errors?.errorsCostMinor ?? 0) > 0" class="row" style="margin-top: var(--space-3)">
        <span class="chip chip--warn">Cost of errors: {{ costText(errors?.errorsCostMinor ?? 0, errors?.costCurrency ?? null) }}</span>
      </p>
    </template>

    <!-- Tools: attribution from wire payloads (IR-54) -->
    <template v-else-if="tab === 'tools'">
      <section class="card" style="margin-top: var(--space-4)">
        <div class="card__head"><h3 style="font-size: 15px">Tool attribution</h3><span class="mono faint">{{ range }} · token shares sum to the attributed requests' totals</span></div>
        <div class="card__body card__body--flush">
          <table class="table">
            <thead>
              <tr><th>Tool</th><th>Model</th><th>Calls</th><th>Errors</th><th>Args chars</th><th>Result chars</th><th>Prompt share</th><th>Completion share</th><th>Cost</th><th>Last seen</th></tr>
            </thead>
            <tbody>
              <tr v-for="t in tools?.tools ?? []" :key="toolRowKey(t)">
                <td class="mono">{{ t.tool === "unknown" ? "(unresolved)" : t.tool }}</td>
                <td class="mono">{{ t.model ?? "(unknown)" }}</td>
                <td class="mono">{{ fmtCount(t.calls) }}</td>
                <td class="mono">{{ fmtCount(t.errors) }}</td>
                <td class="mono">{{ fmtCount(t.argsChars) }}</td>
                <td class="mono">{{ fmtCount(t.resultChars) }}</td>
                <td class="mono">{{ fmtTokens(t.promptTokens) }}</td>
                <td class="mono">{{ fmtTokens(t.completionTokens) }}</td>
                <td class="mono">{{ toolsCostShown ? costText(t.costMinor, tools?.costCurrency ?? null) : "—" }}</td>
                <td class="mono">{{ fmtTimeIso(t.lastSeenMs) }}</td>
              </tr>
              <tr v-if="(tools?.tools.length ?? 0) === 0"><td colspan="10" class="faint">No tool usage captured in this range.</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <div v-if="(tools?.series.length ?? 0) > 0" class="cols cols-2" style="margin-top: var(--space-4)">
        <section v-for="s in tools!.series" :key="s.tool" class="card">
          <div class="card__head"><h3 style="font-size: 15px">Tokens — {{ s.tool }}</h3><span class="mono faint">prompt + completion share</span></div>
          <div class="card__body">
            <LensChart :chart="usageChart(s.points.map((p) => ({ t: p.t, value: p.tokens })), 680, 140)" unit="tok" aria-label="Attributed tokens per bucket" :format="(v: number) => fmtTokens(v)" :time-format="fmtBucketShort" />
          </div>
        </section>
      </div>
    </template>

    <!-- Models: aggregates + per-model series -->
    <template v-else>
      <section class="card" style="margin-top: var(--space-4)">
        <div class="card__head"><h3 style="font-size: 15px">Models</h3><span class="mono faint">{{ range }}</span></div>
        <div class="card__body card__body--flush">
          <table class="table">
            <thead>
              <tr><th>Model</th><th>Requests</th><th>Errors</th><th>Total tokens</th><th>TTFT p50</th><th>TTFT p95</th><th>tok/s</th><th>Cost</th></tr>
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
                <!-- IRI-074: cost share of the range; unset pricing collapses all cells to one CTA. -->
                <td class="mono">
                  <template v-if="(models?.costCurrency ?? null) !== null">{{ costText(m.costMinor ?? 0, models?.costCurrency ?? null) }}<template v-if="modelsCostTotal > 0"> · {{ fmtPct((m.costMinor ?? 0) / modelsCostTotal) }}</template></template>
                  <a v-else href="#/settings" title="Set token prices in Hub settings to see costs">Configure pricing</a>
                </td>
              </tr>
              <tr v-if="(models?.models.length ?? 0) === 0"><td colspan="8" class="faint">No captured traffic in this range.</td></tr>
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

    <!-- IRI-076: retry waste — superseded attempts per client key, costed. -->
    <template v-else-if="tab === 'retries'">
      <section class="card" style="margin-top: var(--space-4)">
        <div class="card__head">
          <h3 style="font-size: 15px">Retry waste</h3>
          <span class="row" style="gap: 8px">
            <span v-if="retriesCostShown && (retries?.retriesCostMinor ?? 0) > 0" class="chip chip--warn">Wasted: {{ costText(retries?.retriesCostMinor ?? 0, retries?.costCurrency ?? null) }}</span>
            <span class="mono faint">{{ range }}</span>
          </span>
        </div>
        <div class="card__body card__body--flush">
          <table class="table">
            <thead>
              <tr><th>Client</th><th>Agent type</th><th>Project</th><th>Superseded attempts</th><th>Wasted cost</th><th>Last seen</th></tr>
            </thead>
            <tbody>
              <tr v-for="(g, i) in retries?.groups ?? []" :key="i">
                <td class="mono">{{ g.clientName ?? g.sourceAddr ?? "—" }}</td>
                <td><span v-if="g.clientAgentType !== null" :class="['chip', g.clientAgentType === 'main' ? 'chip--accent' : 'chip--muted']">{{ g.clientAgentType }}</span><span v-else class="faint">—</span></td>
                <td class="mono">{{ g.clientProject ?? "—" }}</td>
                <td class="mono">{{ fmtCount(g.attempts) }}</td>
                <td class="mono">{{ retriesCostShown ? costText(g.costMinor, retries?.costCurrency ?? null) : "—" }}</td>
                <td class="mono">{{ fmtTimeIso(g.lastSeenMs) }}</td>
              </tr>
              <tr v-if="(retries?.groups.length ?? 0) === 0"><td colspan="6" class="faint">No superseded retry attempts in this range.</td></tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>

    <!-- Request detail drawer -->
    <div v-if="drawer !== null" class="drawer-scrim" v-scrim-close="() => (drawer = null)">
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
            <tr v-if="requestsCurrency !== null"><td class="faint">Cost</td><td class="mono">{{ costText(drawer.row.costMinor, requestsCurrency) }}</td></tr>
            <tr><td class="faint">Payload sizes</td><td class="mono">req {{ fmtCount(drawer.row.reqBytes) }} B · res {{ fmtCount(drawer.row.resBytes) }} B</td></tr>
            <tr><td class="faint">Source</td><td class="mono">{{ drawer.row.sourceAddr ?? "—" }}</td></tr>
            <tr><td class="faint">Client</td><td class="mono">{{ clientLabel(drawer.row) }}<template v-if="drawer.row.clientProject !== null"> · {{ drawer.row.clientProject }}</template><template v-if="drawer.row.clientAgentType !== null"> · {{ drawer.row.clientAgentType }}</template></td></tr>
            <tr v-if="retryText(drawer.row) !== null"><td class="faint">Retry</td><td class="mono">{{ retryText(drawer.row) }}</td></tr>
            <tr><td class="faint">Node</td><td class="mono">{{ drawer.row.nodeId }}</td></tr>
          </tbody>
        </table>
        <pre v-if="detailJson !== null" class="log" style="margin-top: 10px; padding: 10px; font-size: 12px; white-space: pre-wrap">{{ detailJson }}</pre>

        <!-- IRI-079: trace waterfall — segments sum to durationMs; speculative
             acceptance rides the decode span; trace id copies and links out
             when an OTLP endpoint is configured. -->
        <template v-if="drawerTrace !== null">
          <h4 class="stat__label" style="margin: 12px 0 6px">Trace</h4>
          <div class="row" style="gap: 8px; align-items: center; margin-bottom: 8px">
            <span class="mono faint">{{ drawerTrace.traceId ?? "no trace id" }}</span>
            <button v-if="drawerTrace.traceId !== null" class="btn btn--ghost btn--sm" @click="copyTraceId">Copy trace id</button>
          </div>
          <div v-for="s in drawerTrace.spans" :key="s.name" style="margin-bottom: 6px">
            <div class="row row--between" style="font-size: 11px">
              <span class="mono">{{ s.name }}</span>
              <span class="mono faint">{{ s.endMs - s.startMs }} ms</span>
            </div>
            <div style="position: relative; height: 14px; background: var(--surface); border-radius: 3px; overflow: hidden">
              <div
                style="position: absolute; top: 0; bottom: 0; background: var(--accent); opacity: 0.75; border-radius: 3px"
                :style="{ left: `${(s.startMs / Math.max(1, drawerTrace.durationMs)) * 100}%`, width: `${((s.endMs - s.startMs) / Math.max(1, drawerTrace.durationMs)) * 100}%` }"
              ></div>
            </div>
            <div v-if="Object.keys(s.attrs).length > 0" class="stat__sub" style="font-size: 11px">
              <template v-for="(v, k) in s.attrs" :key="k">{{ k }} {{ v }} · </template>
            </div>
          </div>
          <p class="stat__sub">segments sum to {{ traceSegmentSum }} ms of {{ drawerTrace.durationMs }} ms</p>
        </template>
      </aside>
    </div>

    <!-- Client keys drawer (IR-55): issue identification keys for clients -->
    <div v-if="clientsOpen" class="drawer-scrim" v-scrim-close="() => (clientsOpen = false)">
      <aside class="drawer" role="dialog" aria-label="Client keys">
        <div class="row row--between" style="margin-bottom: 10px">
          <h3 style="font-size: 17px">Client keys</h3>
          <button class="btn btn--ghost btn--sm" aria-label="Close client keys" @click="clientsOpen = false">✕</button>
        </div>
        <p class="faint" style="font-size: 12px">
          Identification, not auth: a client presents its key as the bearer token (or sends <span class="mono">X-Irori-*</span> headers) and its
          requests are attributed to the mapped project and agent type. Unidentified clients stay visible by source IP.
        </p>

        <div v-if="issuedKey !== null" class="card" style="margin-top: 10px; padding: 10px">
          <p style="font-size: 13px; margin: 0 0 6px"><strong>{{ issuedKey.name }}</strong> — copy the key now; it is shown once:</p>
          <code class="mono" style="font-size: 12px; word-break: break-all">{{ issuedKey.key }}</code>
          <div style="margin-top: 6px"><button class="btn btn--secondary btn--sm" @click="issuedKey = null">done</button></div>
        </div>

        <div class="row" style="margin-top: 12px; gap: 6px; flex-wrap: wrap">
          <input v-model="newIdentityName" class="input" style="max-width: 160px" placeholder="client name" aria-label="Client name" />
          <input v-model="newIdentityProject" class="input" style="max-width: 160px" placeholder="project (optional)" aria-label="Project" />
          <select v-model="newIdentityAgentType" class="select" style="max-width: 140px" aria-label="Agent type">
            <option value="">agent type…</option>
            <option value="main">main</option>
            <option value="subagent">subagent</option>
          </select>
          <button class="btn btn--primary btn--sm" :disabled="clientsBusy || newIdentityName.trim().length === 0" @click="submitIdentity">Issue key</button>
        </div>
        <p v-if="clientsError !== null" class="faint" style="font-size: 12px" role="alert">{{ clientsError }}</p>

        <table class="table" style="margin-top: 10px">
          <thead>
            <tr><th>Name</th><th>Project</th><th>Type</th><th>Key</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="c in clients" :key="c.id">
              <td class="mono">{{ c.name }}</td>
              <td class="mono">{{ c.project ?? "—" }}</td>
              <td class="mono">{{ c.agentType ?? "—" }}</td>
              <td class="mono faint" style="font-size: 11px">{{ c.keyHash === null ? "header-only" : `…${c.keyHash.slice(-8)}` }}</td>
              <td><button class="btn btn--ghost btn--sm" :disabled="clientsBusy" @click="removeIdentity(c.id)">revoke</button></td>
            </tr>
            <tr v-if="clients.length === 0"><td colspan="5" class="faint">No identities issued yet.</td></tr>
          </tbody>
        </table>
      </aside>
    </div>
  </div>
</template>
