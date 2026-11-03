<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { fetchLogSummary, fetchLogs, type LogFilters } from "../api";
import { live } from "../live";
import type { LogPage, LogRow, LogSummary } from "@irori/core";
import {
  DEFAULT_LOG_FILTERS,
  LOG_LEVEL_TABS,
  LOG_RANGE_TABS,
  LOG_SCOPE_TABS,
  LOG_SOURCE_TABS,
  fmtLogTime,
  levelChipClass,
  logsHashFor,
  parseLogsHash,
  rowSummary,
  serverLogFilters,
  type LogFilterState,
} from "../logs-data";

/**
 * IRI-078 Logs: the durable record behind the rings (setup engine output,
 * job output, agent/proxy lifecycle). Level chips count via the summary
 * endpoint; `after`-cursor tail rides the hub's log-update pulse so a fresh
 * batch renders without polling the whole page.
 */

const filters = ref<LogFilterState>(parseLogsHash(typeof location === "undefined" ? "" : location.hash));
const qDraft = ref(filters.value.q);
const page = ref<LogPage | null>(null);
const summary = ref<LogSummary | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const liveOn = ref(false);
const loadingMore = ref(false);

let loadSeq = 0;
let moreSeq = 0;
let tailSeq = 0;

function serverFilters(): LogFilters {
  return { range: filters.value.range, ...serverLogFilters(filters.value) };
}

async function load(): Promise<void> {
  const seq = ++loadSeq;
  loading.value = true;
  error.value = null;
  try {
    const [data, counts] = await Promise.all([
      fetchLogs(serverFilters()),
      fetchLogSummary({ range: filters.value.range, ...summaryFilters() }),
    ]);
    if (seq !== loadSeq) return;
    page.value = data;
    summary.value = counts;
  } catch (err) {
    if (seq !== loadSeq) return;
    error.value = err instanceof Error ? err.message : String(err);
    page.value = null;
    summary.value = null;
  } finally {
    if (seq === loadSeq) loading.value = false;
  }
}

/** Chip counts ignore the level filter itself (every chip shows its own total). */
function summaryFilters(): Omit<LogFilters, "range" | "cursor" | "after" | "level"> & { level?: undefined } {
  const { level: _level, ...rest } = serverLogFilters(filters.value);
  return rest;
}

async function loadMore(): Promise<void> {
  const cursor = page.value?.nextCursor;
  if (cursor === null || cursor === undefined || loadingMore.value) return;
  const seq = ++moreSeq;
  loadingMore.value = true;
  try {
    const data = await fetchLogs({ ...serverFilters(), cursor });
    if (seq !== moreSeq) return;
    page.value = { ...data, rows: [...(page.value?.rows ?? []), ...data.rows] };
  } catch {
    // keep what we have; the button stays available to retry
  } finally {
    if (seq === moreSeq) loadingMore.value = false;
  }
}

/** Live tail: ascending delta after the newest id we hold, merged newest-first. */
async function tail(): Promise<void> {
  const after = page.value?.latestId;
  if (!liveOn.value || after === null || after === undefined) return;
  const seq = ++tailSeq;
  try {
    const data = await fetchLogs({ ...serverFilters(), after });
    if (seq !== tailSeq) return;
    if (data.rows.length === 0) return;
    const merged = [...data.rows.slice().reverse(), ...(page.value?.rows ?? [])].slice(0, 1000);
    page.value = { rows: merged, nextCursor: page.value?.nextCursor ?? null, latestId: data.latestId, truncated: page.value?.truncated ?? false };
  } catch {
    // the next pulse/poll retries; the page keeps what it has
  }
}

const pulseTimer = ref<ReturnType<typeof setInterval> | null>(null);
const { sortedNodes } = live;
onMounted(() => {
  void load();
  pulseTimer.value = setInterval(() => void tail(), 5_000); // pulse-agnostic fallback
});
onUnmounted(() => {
  if (pulseTimer.value !== null) clearInterval(pulseTimer.value);
});

// Hub pulse → immediate tail (cheap: one delta request per batch).
watch(live.logPulse, () => void tail());

watch(
  filters,
  () => {
    if (location.hash !== logsHash()) history.replaceState(null, "", logsHash());
    void load();
  },
  { deep: true },
);

function logsHash(): string {
  return logsHashFor(filters.value);
}

function setFilter(patch: Partial<LogFilterState>): void {
  filters.value = { ...filters.value, ...patch };
}

const rows = computed(() => page.value?.rows ?? []);
const hasMore = computed(() => (page.value?.nextCursor ?? null) !== null);
const { nodes } = live;
const nodeName = (id: string): string => nodes.get(id)?.name ?? id.slice(0, 8);
const rowCount = computed(() => rows.value.length);
</script>

<template>
  <div>
    <div class="pagehead">
      <div>
        <h1 style="font-size: 20px">Logs</h1>
        <p>Durable record across the fleet — setups (driver/engine/proxy), jobs, agent and hub lines — with levels and search.</p>
      </div>
      <div class="row">
        <nav class="seg" aria-label="Scope">
          <button v-for="t in LOG_SCOPE_TABS" :key="t.value" :class="{ 'is-active': filters.scope === t.value }" @click="setFilter({ scope: t.value })">{{ t.label }}</button>
        </nav>
        <nav class="seg" aria-label="Range">
          <button v-for="r in LOG_RANGE_TABS" :key="r.value" :class="{ 'is-active': filters.range === r.value }" @click="setFilter({ range: r.value })">{{ r.label }}</button>
        </nav>
        <button class="btn btn--ghost" :class="{ 'is-active': liveOn }" :aria-pressed="liveOn" @click="liveOn = !liveOn">{{ liveOn ? "● Live" : "Live" }}</button>
      </div>
    </div>

    <div class="row" style="margin-top: var(--space-3); gap: var(--space-2); flex-wrap: wrap">
      <nav class="seg" aria-label="Source">
        <button v-for="t in LOG_SOURCE_TABS" :key="t.value" :class="{ 'is-active': filters.source === t.value }" @click="setFilter({ source: t.value })">{{ t.label }}</button>
      </nav>
      <select class="input" style="max-width: 160px" aria-label="Node filter" :value="filters.nodeId" @change="setFilter({ nodeId: ($event.target as HTMLSelectElement).value })">
        <option value="">All nodes</option>
        <option v-for="n in sortedNodes" :key="n.id" :value="n.id">{{ n.name }}</option>
      </select>
      <input v-model="qDraft" class="input" style="max-width: 260px" placeholder="search lines (substring)" aria-label="Log search" @keyup.enter="setFilter({ q: qDraft })" @blur="setFilter({ q: qDraft })" />
      <span v-if="filters.setupId" class="chip chip--accent">
        setup {{ filters.setupId.slice(0, 8) }}<template v-if="filters.runId"> · run {{ filters.runId.slice(0, 8) }}</template>
        <button class="iconbtn" style="min-height: 0; padding: 0 4px" aria-label="Clear setup filter" @click="setFilter({ setupId: '', runId: '' })">✕</button>
      </span>
      <span v-if="summary?.truncated" class="chip chip--warn" title="A node's queue dropped lines in this window — the record is truncated.">truncated</span>
    </div>

    <div class="row" style="margin-top: var(--space-2); gap: var(--space-2); flex-wrap: wrap" aria-label="Level">
      <button v-for="t in LOG_LEVEL_TABS" :key="t.value" class="btn btn--ghost btn--sm" :class="{ 'is-active': filters.level === t.value }" @click="setFilter({ level: t.value })">
        {{ t.label }}<template v-if="summary"> · {{ t.value === 'all' ? summary.total : (summary.counts[t.value] ?? 0) }}</template>
      </button>
    </div>

    <p v-if="error" class="faint" style="margin-top: 10px" role="alert">{{ error }}</p>

    <section class="card" style="margin-top: var(--space-4)">
      <div class="card__head">
        <h3 style="font-size: 15px">Lines</h3>
        <span class="mono faint">{{ rowCount }} shown · newest first{{ liveOn ? " · live tail on" : "" }}</span>
      </div>
      <div class="card__body card__body--flush">
        <div v-if="loading && page === null" class="faint" style="padding: 12px">Loading…</div>
        <template v-else>
          <div v-for="row in rows" :key="row.id" class="log-row" :class="`log-row--${row.level}`">
            <span class="mono faint log-row__ts" :title="row.ts">{{ fmtLogTime(row.ts) }}</span>
            <span class="chip" :class="levelChipClass(row.level)">{{ row.level }}</span>
            <span class="faint mono log-row__meta">{{ row.scope }}/{{ row.source }}</span>
            <span class="faint mono log-row__node" :title="row.nodeId">{{ nodeName(row.nodeId) }}</span>
            <span v-if="row.seq !== null" class="faint mono log-row__seq">#{{ row.seq }}</span>
            <span class="log-row__line mono" :title="rowSummary(row)">{{ row.line }}</span>
          </div>
          <div v-if="rowCount === 0" class="faint" style="padding: 12px">No lines in this range{{ filters.setupId ? " for this setup" : "" }}{{ filters.q ? ` matching “${filters.q}”` : "" }}.</div>
          <div v-else-if="hasMore" style="padding: 10px 12px">
            <button class="btn btn--ghost" :disabled="loadingMore" @click="loadMore">{{ loadingMore ? "Loading…" : "Load older" }}</button>
          </div>
        </template>
      </div>
    </section>
  </div>
</template>

<style scoped>
.log-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 3px 12px;
  border-bottom: 1px solid var(--border);
  font-size: 12.5px;
  min-width: 0;
}
.log-row:last-child {
  border-bottom: 0;
}
.log-row:hover {
  background: var(--surface-2, rgba(127, 127, 127, 0.08));
}
.log-row--error {
  background: color-mix(in srgb, var(--error, #c0392b) 8%, transparent);
}
.log-row--warn {
  background: color-mix(in srgb, var(--warning, #d9a300) 8%, transparent);
}
.log-row__ts {
  font-size: 11px;
  white-space: nowrap;
}
.log-row__meta {
  font-size: 11px;
  white-space: nowrap;
}
.log-row__node {
  font-size: 11px;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.log-row__seq {
  font-size: 11px;
  white-space: nowrap;
}
.log-row__line {
  flex: 1;
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
}
</style>
