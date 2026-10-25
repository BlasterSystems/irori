<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { fetchNodes } from "../api";
import { fetchSetups } from "../serve";
import { DOWNLOAD_BATCH_MAX_ENTRIES, pickStoreNode, type NodeInfo } from "@irori/core";
import {
  cancelJob,
  createJob,
  downloadBatchTotals,
  downloadBytesLine,
  downloadJobSummary,
  downloadProgressPct,
  downloadRowActions,
  downloadSpeedLabel,
  downloadSpeedView,
  downloadStatusChip,
  enqueueDownload,
  enqueueDownloadsBatch,
  fetchDownloadQueue,
  fetchHfQuants,
  fetchJob,
  fetchModelsPage,
  fetchPlacement,
  formatEta,
  formatGiB,
  jobStatusChip,
  placementChip,
  removeDownload,
  retryDownload,
  setupServingModel,
  type DownloadQueueEntry,
  type HfQuantsResult,
  type JobDetail,
  type JobView,
  type ModelsPage,
  type PlacementResponse,
} from "../models";

const search = ref("");
const page = ref(1);
const sort = ref<"recent" | "name">("recent");
const modelsPage = ref<ModelsPage | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

/** Selected model name → placement view. */
const selected = ref<string | null>(null);
const placement = ref<PlacementResponse | null>(null);
const placementLoading = ref(false);
const placementError = ref<string | null>(null);
/** IRI-018: serving-setup advisory for the NAS delete flow — scoped to the model name it was fetched for (warnings never block). */
const deleteSetupWarn = ref<{ name: string; setup: string } | null>(null);
let deleteSetupSeq = 0;

/** Download-from-HF modal state (paste + rows, IRI-015). */
const downloadOpen = ref(false);
const downloadJobs = ref(4);
const downloadBusy = ref(false);
const downloadError = ref<string | null>(null);

/** Active job drawer. */
const job = ref<JobDetail | null>(null);
const jobError = ref<string | null>(null);
let jobPoll: ReturnType<typeof setInterval> | undefined;
let loadSeq = 0;

async function load(): Promise<void> {
  const seq = ++loadSeq;
  loading.value = true;
  error.value = null;
  try {
    const result = await fetchModelsPage(page.value, search.value, sort.value);
    if (seq !== loadSeq) return;
    modelsPage.value = result;
  } catch (err) {
    if (seq !== loadSeq) return;
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    if (seq === loadSeq) loading.value = false;
  }
}

function onSortToggle(): void {
  sort.value = sort.value === "recent" ? "name" : "recent";
  page.value = 1;
  void load();
}

/** Store node for hygiene verbs and the modal banner (NAS-preferred, IRI-014). */
const nodes = ref<NodeInfo[]>([]);
const storeNode = computed(() => pickStoreNode(nodes.value)?.id ?? null);

onMounted(() => {
  document.addEventListener("click", onDocClick); // IRI-020: row-menu click-away
  void fetchNodes()
    .then((rows) => {
      nodes.value = rows;
    })
    .catch(() => {
      /* registry unavailable: download modal surfaces "no model-ops node" */
    });
  void load();
  void refreshQueue();
});

/** Maintenance verbs for the hygiene popover: kind → label; destructive ones ghosted. */
const HYGIENE_VERBS: Array<{ kind: string; label: string; destructive: boolean; perModel: boolean }> = [
  { kind: "doctor", label: "Doctor", destructive: false, perModel: false },
  { kind: "staging-audit", label: "Staging audit", destructive: false, perModel: false },
  { kind: "objects-audit", label: "Objects audit", destructive: false, perModel: false },
  { kind: "catalog-refresh", label: "Refresh catalog", destructive: false, perModel: false },
  { kind: "sync-cards", label: "Sync cards", destructive: false, perModel: false },
  { kind: "repair-active", label: "Repair check", destructive: false, perModel: true },
  { kind: "repair-active-apply", label: "Repair (APPLY)", destructive: true, perModel: true },
];

function runHygiene(kind: string, perModel: boolean): void {
  const nodeId = storeNode.value;
  if (nodeId === null) return;
  void runJob(nodeId, kind, perModel ? { name: selected.value ?? undefined } : {});
}

/**
 * IRI-015 paste+rows modal: a textarea takes one `owner/model` per line and
 * parses into editable rows (source + optional store name). IRI-016 adds the
 * per-row GGUF `quantization`/`mtp` passthrough and an "Expand" flow that
 * lists a repo's quantizations (hub HF-API listing) and replaces the row.
 * Submit sends ONE batch (`POST /downloads {downloads, jobs}`; a single row
 * uses the single-entry shape) — the server always queues and drains them as
 * one `download-queue` batch on the store node when it is idle.
 */
const downloadPaste = ref("");
let rowIdCounter = 0;
interface DownloadRow {
  id: number;
  source: string;
  name: string;
  /** modelctl --quantization substring; "" = single/auto. */
  quantization: string;
  /** Explicit MTP/draft companion; "" = modelctl auto-selects. */
  mtp: string;
  /** IRI-017: replace an existing manifest with different settings (modelctl force). */
  force: boolean;
}
const downloadRows = ref<DownloadRow[]>([]);

/** Rows are unique per (source, quantization) — same repo, several quants. */
function rowKey(r: { source: string; quantization: string }): string {
  return `${r.source.trim().toLowerCase()}|${r.quantization.trim().toLowerCase()}`;
}

function parsePaste(): void {
  const seen = new Set(downloadRows.value.map(rowKey));
  for (const raw of downloadPaste.value.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const key = `${line.toLowerCase()}|`;
    if (seen.has(key)) continue;
    seen.add(key);
    rowIdCounter += 1;
    downloadRows.value.push({ id: rowIdCounter, source: line, name: "", quantization: "", mtp: "", force: false });
  }
  downloadPaste.value = "";
}

function removeRow(index: number): void {
  if (expandRowId.value === downloadRows.value[index]?.id) closeExpand();
  downloadRows.value.splice(index, 1);
}

/** IRI-016 expand-quants state: one row at a time shows its repo's quantizations. */
const expandRowId = ref<number | null>(null);
const expandLoading = ref(false);
const expandError = ref<string | null>(null);
const expandListing = ref<HfQuantsResult | null>(null);
const expandSelected = ref<Set<string>>(new Set());
const expandMtp = ref("");

async function openExpand(row: DownloadRow): Promise<void> {
  expandRowId.value = row.id;
  expandLoading.value = true;
  expandError.value = null;
  expandListing.value = null;
  expandSelected.value = new Set();
  expandMtp.value = "";
  try {
    expandListing.value = await fetchHfQuants(row.source.trim());
    // Preselect modelctl's auto-companions only when it can auto-select.
    const mtp = expandListing.value.companions.mtp;
    expandMtp.value = mtp.default ?? "";
  } catch (err) {
    expandError.value = err instanceof Error ? err.message : String(err);
  } finally {
    expandLoading.value = false;
  }
}

function closeExpand(): void {
  expandRowId.value = null;
  expandListing.value = null;
  expandError.value = null;
  expandSelected.value = new Set();
}

/** Selected, non-ambiguous rows the expansion would add. */
const expandAddable = computed(() => {
  if (expandListing.value === null) return 0;
  return expandListing.value.quants.filter((q) => !q.ambiguous && expandSelected.value.has(q.tag)).length;
});

function toggleExpandTag(tag: string): void {
  const next = new Set(expandSelected.value);
  if (next.has(tag)) next.delete(tag);
  else next.add(tag);
  expandSelected.value = next;
}

/** Replaces the expanded row with one row per selected quantization (cap-aware). */
function applyExpand(): void {
  const index = downloadRows.value.findIndex((r) => r.id === expandRowId.value);
  const listing = expandListing.value;
  if (index === -1 || listing === null) return closeExpand();
  const row = downloadRows.value[index]!;
  const base = row.name.trim() || row.source.split("/").pop() || row.source;
  const existing = new Set(downloadRows.value.filter((_, i) => i !== index).map(rowKey));
  const additions: DownloadRow[] = [];
  for (const q of listing.quants) {
    if (q.ambiguous || !expandSelected.value.has(q.tag)) continue;
    if (existing.has(`${row.source.trim().toLowerCase()}|${q.tag.toLowerCase()}`)) continue;
    if (downloadRows.value.length - 1 + additions.length >= DOWNLOAD_BATCH_MAX_ENTRIES) {
      expandError.value = `batch cap is ${DOWNLOAD_BATCH_MAX_ENTRIES} entries — the rest were not added`;
      break;
    }
    rowIdCounter += 1;
    additions.push({ id: rowIdCounter, source: row.source, name: `${base}-${q.tag}`, quantization: q.tag, mtp: expandMtp.value, force: false });
  }
  downloadRows.value.splice(index, 1, ...additions);
  closeExpand();
}

async function submitDownload(): Promise<void> {
  const rows = downloadRows.value
    .map((r) => ({ source: r.source.trim(), name: r.name.trim(), quantization: r.quantization.trim(), mtp: r.mtp.trim(), force: r.force }))
    .filter((r) => r.source.length > 0);
  if (rows.length === 0) return;
  downloadBusy.value = true;
  downloadError.value = null;
  let entries: DownloadQueueEntry[];
  try {
    if (rows.length === 1) {
      const r = rows[0]!;
      entries = [
        await enqueueDownload({
          source: r.source,
          name: r.name || undefined,
          quantization: r.quantization || undefined,
          mtp: r.mtp || undefined,
          force: r.force || undefined,
          jobs: downloadJobs.value,
        }),
      ];
    } else {
      entries = await enqueueDownloadsBatch({
        downloads: rows.map((r) => ({
          source: r.source,
          name: r.name || undefined,
          quantization: r.quantization || undefined,
          mtp: r.mtp || undefined,
          force: r.force || undefined,
        })),
        jobs: downloadJobs.value,
      });
    }
    downloadOpen.value = false;
    downloadRows.value = [];
    downloadPaste.value = "";
    void refreshQueue();
    const running = entries.find((e) => e.status === "running" && e.jobId !== null);
    if (running?.jobId !== undefined && running.jobId !== null) await openJob(running.jobId);
  } catch (err) {
    downloadError.value = err instanceof Error ? err.message : String(err);
  } finally {
    downloadBusy.value = false;
  }
}

/** Download queue panel state (IRI-014). */
const downloadQueueEntries = ref<DownloadQueueEntry[]>([]);
const queueError = ref<string | null>(null);
const queueSeq = { n: 0 }; // stale-response guard (object: survives interval closures)
let queuePoll: ReturnType<typeof setInterval> | undefined;

function queueHasActive(entries: DownloadQueueEntry[]): boolean {
  return entries.some((e) => e.status === "pending" || e.status === "running");
}

async function refreshQueue(): Promise<void> {
  const seq = ++queueSeq.n;
  try {
    const entries = await fetchDownloadQueue();
    if (seq !== queueSeq.n) return; // a newer refresh won
    downloadQueueEntries.value = entries;
    queueError.value = null;
    // Poll only while something is queued/running; terminal states are static.
    if (queueHasActive(entries) && queuePoll === undefined) {
      queuePoll = setInterval(() => {
        if (!queueHasActive(downloadQueueEntries.value)) {
          clearInterval(queuePoll);
          queuePoll = undefined;
          return;
        }
        void refreshQueue();
      }, 2000);
    }
  } catch (err) {
    if (seq !== queueSeq.n) return; // a newer refresh won
    queueError.value = err instanceof Error ? err.message : String(err);
  }
}

async function removeEntry(id: string): Promise<void> {
  try {
    await removeDownload(id);
    await refreshQueue();
  } catch (err) {
    queueError.value = err instanceof Error ? err.message : String(err);
  }
}

async function retryEntry(id: string, force = false): Promise<void> {
  try {
    const entry = await retryDownload(id, force);
    await refreshQueue();
    if (entry.status === "running" && entry.jobId !== null) await openJob(entry.jobId);
  } catch (err) {
    queueError.value = err instanceof Error ? err.message : String(err);
  }
}

/** IRI-020: per-row ⋯ menu (catalog + queue) and the shared confirm modal. */
interface RowMenu {
  kind: "catalog" | "queue";
  id: string;
  name: string;
  x: number;
  y: number;
}
const rowMenu = ref<RowMenu | null>(null);
const rowMenuEntry = computed(() =>
  rowMenu.value?.kind === "queue" ? downloadQueueEntries.value.find((e) => e.id === rowMenu.value?.id) ?? null : null,
);
const rowMenuItems = computed(() => {
  const m = rowMenu.value;
  if (m === null) return [];
  if (m.kind === "catalog") {
    return [
      { act: "details", label: "Details…" },
      { act: "delete", label: "Delete from NAS…" },
    ];
  }
  const e = rowMenuEntry.value;
  if (e === null) return [];
  return downloadRowActions(e.status, e.jobId !== null);
});

function openRowMenu(kind: "catalog" | "queue", id: string, name: string, ev: MouseEvent): void {
  const rect = (ev.currentTarget as HTMLElement | null)?.getBoundingClientRect();
  rowMenu.value = { kind, id, name, x: Math.max(8, (rect?.right ?? 0) - 210), y: (rect?.bottom ?? 0) + 6 };
}

function onDocClick(ev: MouseEvent): void {
  const t = ev.target as HTMLElement | null;
  if (rowMenu.value !== null && t !== null && !t.closest(".rowpop") && !t.closest(".rowopts")) rowMenu.value = null;
}

interface ConfirmAction {
  title: string;
  body: string;
  danger: string;
  run: () => Promise<void> | void;
}
const confirmState = ref<ConfirmAction | null>(null);
const confirmBusy = ref(false);

function confirmAction(a: ConfirmAction): void {
  confirmState.value = a;
}

async function runConfirm(): Promise<void> {
  const a = confirmState.value;
  if (a === null || confirmBusy.value) return;
  confirmBusy.value = true;
  try {
    await a.run();
  } finally {
    confirmBusy.value = false;
    // Only clear the dialog this run belongs to — a newer confirm opened
    // meanwhile must survive, and dismissing mid-run must not re-close it.
    if (confirmState.value === a) confirmState.value = null;
  }
}

function dismissConfirm(): void {
  confirmBusy.value = false;
  confirmState.value = null;
}

function runRowMenu(act: string): void {
  const m = rowMenu.value;
  rowMenu.value = null;
  if (m === null) return;
  if (m.kind === "catalog") {
    if (act === "details") void openModel(m.name);
    else if (act === "delete") {
      confirmAction({
        title: `Delete ${m.name} from the NAS?`,
        body: "Removes the model's objects, references and staging from the NAS store via modelctl. NAS is never written outside modelctl.",
        danger: "Delete from NAS",
        run: () => runNasDelete(m.name),
      });
    }
    return;
  }
  const e = downloadQueueEntries.value.find((x) => x.id === m.id);
  if (e === undefined) return;
  if (act === "job") {
    if (e.jobId !== null) void openJob(e.jobId);
  } else if (act === "retry") {
    void retryEntry(e.id);
  } else if (act === "retry-force") {
    confirmAction({
      title: `Retry ${e.name} with force?`,
      body: "Replaces an existing manifest with the current settings (modelctl force). Already-published objects stay referenced.",
      danger: "Retry with force",
      run: async () => {
        await retryEntry(e.id, true);
      },
    });
  } else if (act === "remove") {
    confirmAction({
      title: `Remove ${e.name} from the queue?`,
      body: "The entry leaves the download queue. A running download is not interrupted; published objects stay on the NAS.",
      danger: "Remove",
      run: async () => {
        await removeEntry(e.id);
      },
    });
  } else if (act === "cancel-job" && e.jobId !== null) {
    const jobId = e.jobId;
    // Canceling the batch job settles EVERY entry sharing it (server
    // settleBatch) — state the real blast radius, not the single row.
    const batch = downloadQueueEntries.value.filter((x) => x.jobId === jobId).length;
    confirmAction({
      title: "Cancel this download batch?",
      body: `Stops the running modelctl batch — all ${batch} entr${batch === 1 ? "y" : "ies"} sharing this job are marked canceled (resumable staging is kept).`,
      danger: "Cancel batch",
      run: async () => {
        try {
          await cancelJob(jobId);
        } catch (err) {
          queueError.value = err instanceof Error ? err.message : String(err);
        }
        await refreshQueue();
      },
    });
  }
}

/** The detail drawer's per-placement delete routes through the same confirm. */
function confirmDrawerDelete(nodeId: string): void {
  if (selected.value === null) return;
  const name = selected.value;
  confirmAction({
    title: `Delete ${name} from the NAS?`,
    body: "Removes the model's objects, references and staging from the NAS store via modelctl. NAS is never written outside modelctl.",
    danger: "Delete from NAS",
    run: () => runJob(nodeId, "nas-delete-apply", { name }),
  });
}

/** IRI-020: the job drawer's Cancel job gets the same guard as the queue menu. */
function confirmDrawerCancel(): void {
  const j = job.value?.job;
  if (j === undefined) return;
  const jobId = j.id;
  const isBatch = j.kind === "download-queue";
  confirmAction({
    title: isBatch ? "Cancel this download batch?" : `Cancel this ${j.kind} job?`,
    body: isBatch
      ? "Stops the running modelctl batch — every entry sharing this job is marked canceled (resumable staging is kept)."
      : "Stops the running job; anything it already wrote stays as-is.",
    danger: "Cancel job",
    run: async () => {
      try {
        await cancelJob(jobId);
      } catch (err) {
        jobError.value = err instanceof Error ? err.message : String(err);
      }
      await openJob(jobId); // refetch terminal state into the drawer
    },
  });
}

/** IRI-020: batch totals strip — hidden until any row carries size/speed data. */
const queueTotals = computed(() => downloadBatchTotals(downloadQueueEntries.value));
const showQueueTotals = computed(() => downloadQueueEntries.value.some((e) => e.bytesTotal != null || e.speedBps != null));
const queueTotalsText = computed(() => {
  const t = queueTotals.value;
  const parts: string[] = [];
  if (t.pct !== null) parts.push(`${t.pct}%`);
  if (t.bytesTotal > 0) parts.push(`${formatGiB(t.bytesDone)} / ${formatGiB(t.bytesTotal)}`);
  if (t.speedBps !== null) parts.push(`${downloadSpeedLabel(t.speedBps).label} combined`);
  if (t.etaSeconds !== null) parts.push(`eta ${formatEta(t.etaSeconds)}`);
  return parts.join(" · ");
});
const queueTotalsBucket = computed(() => (queueTotals.value.speedBps !== null ? downloadSpeedLabel(queueTotals.value.speedBps).bucket : "ok"));

/** IRI-020: the open drawer's download-queue batch rows → collapsed summary. */
const jobBatchEntries = computed(() => {
  const j = job.value?.job;
  if (j === undefined || j.kind !== "download-queue") return [];
  return downloadQueueEntries.value.filter((e) => e.jobId === j.id);
});
const jobSummaryText = computed(() => (jobBatchEntries.value.length > 0 ? downloadJobSummary(jobBatchEntries.value) : ""));

/** Row-level delete entry point — applies immediately behind the confirm
 *  dialog (owner decision: no dry-run/arm dance); the modelctl write path is
 *  unchanged. */
async function runNasDelete(name: string): Promise<void> {
  const nodeId = storeNode.value;
  if (nodeId === null) return;
  deleteSetupWarn.value = null;
  // Advisory only — never delays the delete dispatch; sequenced so a late
  // response cannot attach to a different model's job.
  const seq = ++deleteSetupSeq;
  void fetchSetups()
    .then((rows) => {
      if (seq !== deleteSetupSeq) return;
      const setup = setupServingModel(rows, name);
      deleteSetupWarn.value = setup === null ? null : { name, setup };
    })
    .catch(() => {});
  await runJob(nodeId, "nas-delete-apply", { name });
}

/** The open drawer's nas-delete-apply job's target name — the advisory banner is scoped to it. */
const jobApplyName = computed(() => {
  const j = job.value?.job;
  if (j === undefined || j.kind !== "nas-delete-apply") return null;
  const name = j.params["name"];
  return typeof name === "string" && name.length > 0 ? name : null;
});

let debounce: ReturnType<typeof setTimeout> | undefined;
function onSearchInput(): void {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    page.value = 1;
    void load();
  }, 250);
}

const totalPages = computed(() => {
  const p = modelsPage.value;
  if (p === null || p.pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(p.total / p.pageSize));
});

function go(delta: number): void {
  const next = page.value + delta;
  if (next < 1 || next > totalPages.value) return;
  page.value = next;
  void load();
}

let placementSeq = 0;
async function openModel(name: string): Promise<void> {
  const seq = ++placementSeq;
  selected.value = name;
  placement.value = null;
  placementError.value = null;
  deleteSetupWarn.value = null;
  placementLoading.value = true;
  // IRI-018: advisory only — a serving setup that references this model.
  void fetchSetups()
    .then((rows) => {
      if (seq !== placementSeq) return;
      const setup = setupServingModel(rows, name);
      deleteSetupWarn.value = setup === null ? null : { name, setup };
    })
    .catch(() => {});
  try {
    const res = await fetchPlacement(name);
    if (seq !== placementSeq) return; // a newer drawer opened meanwhile
    placement.value = res;
  } catch (err) {
    if (seq !== placementSeq) return;
    placementError.value = err instanceof Error ? err.message : String(err);
  } finally {
    if (seq === placementSeq) placementLoading.value = false;
  }
}

function closeDetail(): void {
  placementSeq++; // an in-flight openModel must not repopulate the closed drawer
  selected.value = null;
  placement.value = null;
  placementError.value = null;
  deleteSetupWarn.value = null;
}

async function runJob(nodeId: string, kind: string, params: Record<string, unknown>): Promise<void> {
  jobError.value = null;
  try {
    const view: JobView = await createJob(nodeId, kind, params);
    await openJob(view.id);
  } catch (err) {
    jobError.value = err instanceof Error ? err.message : String(err);
  }
}

let jobSeq = 0;
/** IRI-018: delayed catalog refetch after a terminal delete job (cleared on unmount). */
let deleteReloadTimer: ReturnType<typeof setTimeout> | undefined;
async function openJob(id: string): Promise<void> {
  clearInterval(jobPoll);
  const seq = ++jobSeq;
  try {
    job.value = await fetchJob(id);
  } catch (err) {
    if (seq !== jobSeq) return;
    jobError.value = err instanceof Error ? err.message : String(err);
    return;
  }
  if (seq !== jobSeq) return; // a newer drawer opened while fetching
  jobPoll = setInterval(async () => {
    if (job.value === null) return;
    if (job.value.job.status === "succeeded" || job.value.job.status === "failed" || job.value.job.status === "canceled") {
      clearInterval(jobPoll);
      // A settled delete changes the store catalog — the hub's catalog-request
      // round-trip is async, so refetch now and once more after it lands.
      if (job.value.job.kind === "nas-delete" || job.value.job.kind === "nas-delete-apply") {
        void load();
        clearTimeout(deleteReloadTimer);
        deleteReloadTimer = setTimeout(() => void load(), 5000);
      }
      void refreshQueue(); // a settled download batch changes the queue rows
      return;
    }
    const pollSeq = jobSeq;
    if (job.value.job.kind === "download-queue") void refreshQueue(); // IRI-020: keep the drawer summary live
    try {
      const next = await fetchJob(job.value.job.id);
      if (pollSeq !== jobSeq) return;
      job.value = next;
    } catch {
      clearInterval(jobPoll);
    }
  }, 2000);
}

function closeJob(): void {
  clearInterval(jobPoll);
  jobSeq++; // an in-flight openJob must not repopulate the closed drawer
  job.value = null;
  jobError.value = null;
}

onBeforeUnmount(() => {
  document.removeEventListener("click", onDocClick);
  clearTimeout(debounce);
  clearTimeout(deleteReloadTimer);
  clearInterval(jobPoll);
  clearInterval(queuePoll);
});
</script>

<template>
  <div class="page">
    <header class="pagehead">
      <h1>Models</h1>
      <p class="mono faint">NAS store · catalog.json (schema 3) · no store writes outside modelctl</p>
    </header>

    <div class="row row--between row--wrap" style="margin-bottom: 12px">
      <input
        v-model="search"
        class="search"
        type="search"
        placeholder="Search name or repository…"
        aria-label="Search models"
        @input="onSearchInput"
      />
      <div class="row" style="gap: 8px">
        <span v-if="modelsPage" class="mono faint">{{ modelsPage.total }} models</span>
        <button class="btn btn--secondary btn--sm" @click="onSortToggle">
          {{ sort === "recent" ? "Recently added ↓" : "Name A–Z" }}
        </button>
        <button class="btn btn--primary btn--sm" @click="downloadOpen = true">Download from HF…</button>
      </div>
    </div>

    <p v-if="error" class="banner banner--warn">{{ error }}</p>
    <p v-else-if="loading && modelsPage === null" class="faint">loading…</p>
    <p v-else-if="modelsPage !== null && modelsPage.models.length === 0" class="faint">
      no models match — refresh the catalog from a model-ops node
    </p>

    <table v-else-if="modelsPage !== null" class="table">
      <thead>
        <tr>
          <th>Model</th><th class="num">Size</th><th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="m in modelsPage.models" :key="m.name" class="is-clickable" @click="openModel(m.name)">
          <td>
            <strong>{{ m.name }}</strong>
            <div class="mono faint">{{ m.repository }}</div>
          </td>
          <td class="num mono">{{ formatGiB(m.bytes) }}</td>
          <td @click.stop>
            <button
              v-if="storeNode !== null"
              class="btn btn--ghost btn--sm rowopts"
              :aria-label="`Actions for ${m.name}`"
              @click="openRowMenu('catalog', m.name, m.name, $event)"
            >⋯</button>
          </td>
        </tr>
      </tbody>
    </table>

    <div v-if="modelsPage !== null && totalPages > 1" class="row row--between" style="margin-top: 10px">
      <button class="btn btn--secondary btn--sm" :disabled="page <= 1" @click="go(-1)">← Prev</button>
      <span class="mono faint">page {{ modelsPage.page }} / {{ totalPages }}</span>
      <button class="btn btn--secondary btn--sm" :disabled="page >= totalPages" @click="go(1)">Next →</button>
    </div>

    <!-- IRI-014 download queue: adds always queue; the NAS drains when idle -->
    <section
      v-if="downloadQueueEntries.length > 0 || queueError !== null"
      class="card"
      style="margin-top: 14px; padding: 12px"
      aria-label="Download queue"
    >
      <div class="row row--between">
        <h3>Download queue</h3>
        <span class="stat__sub faint">queued adds dispatch to the NAS store node when idle</span>
      </div>
      <p v-if="queueError" class="banner banner--warn">{{ queueError }}</p>
      <div v-if="showQueueTotals" class="dlbar-row" style="margin: 8px 0 2px; max-width: none">
        <span class="stat__sub mono" style="flex: none">batch</span>
        <div class="dlbar dlbar--agg" role="progressbar" :aria-valuenow="queueTotals.pct ?? 0" aria-valuemin="0" aria-valuemax="100">
          <div class="dlbar__fill" :class="`dlbar__fill--${queueTotalsBucket}`" :style="{ width: `${queueTotals.pct ?? 0}%` }"></div>
        </div>
        <span class="stat__sub mono">{{ queueTotalsText }}</span>
      </div>
      <table v-if="downloadQueueEntries.length > 0" class="table">
        <thead>
          <tr><th>Model</th><th>Status</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="e in downloadQueueEntries" :key="e.id">
            <td>
              <strong>{{ e.name }}</strong>
              <div class="mono faint">{{ e.source }}</div>
              <div v-if="downloadProgressPct(e) !== null || downloadBytesLine(e) !== null" class="dlbar-row">
                <div v-if="downloadProgressPct(e) !== null" class="dlbar" role="progressbar" :aria-valuenow="downloadProgressPct(e) ?? 0" aria-valuemin="0" aria-valuemax="100">
                  <div class="dlbar__fill" :class="`dlbar__fill--${downloadSpeedView(e)?.bucket ?? 'slow'}`" :style="{ width: `${downloadProgressPct(e)}%` }"></div>
                </div>
                <span class="stat__sub mono">{{ downloadProgressPct(e) !== null ? `${downloadProgressPct(e)}% ·` : "" }} {{ downloadBytesLine(e) }}</span>
                <span v-if="downloadSpeedView(e)" class="dlbar__speed" :class="`dlbar__speed--${downloadSpeedView(e)!.bucket}`">{{ downloadSpeedView(e)!.label }}</span>
              </div>
            </td>
            <td>
              <span v-if="e.error !== null && e.error !== ''" class="tip" tabindex="0">
                <span class="chip" :class="downloadStatusChip(e.status).cls">{{ downloadStatusChip(e.status).label }}</span>
                <span class="tip__box" role="tooltip">{{ e.error }}</span>
              </span>
              <span v-else class="chip" :class="downloadStatusChip(e.status).cls">{{ downloadStatusChip(e.status).label }}</span>
            </td>
            <td class="num" style="width: 44px">
              <button class="btn btn--ghost btn--sm rowopts" :aria-label="`Actions for ${e.name}`" @click="openRowMenu('queue', e.id, e.name, $event)">⋯</button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- Model detail drawer: placement + job actions -->
    <div v-if="selected !== null" class="drawer-scrim" @click.self="closeDetail">
      <section class="card drawer" aria-label="Model detail">
        <div class="card__head">
          <h3 class="mono">{{ selected }}</h3>
          <button class="btn btn--secondary btn--sm" @click="closeDetail">Close</button>
        </div>
        <p v-if="placementLoading" class="faint">loading placement…</p>
        <p v-else-if="placementError" class="banner banner--warn">{{ placementError }}</p>
        <template v-else-if="placement !== null">
          <p class="stat__sub">
            {{ formatGiB(placement.model.bytes) }} · from
            <span class="mono">{{ placement.model.name }}</span>
          </p>
          <table class="table">
            <thead>
              <tr><th>Node</th><th>Role</th><th>Action</th><th></th></tr>
            </thead>
            <tbody>
              <tr v-for="row in placement.placements" :key="row.node.id">
                <td class="mono">{{ row.node.name }}</td>
                <td><span class="chip">{{ row.node.role }}</span></td>
                <td>
                  <span class="chip" :class="placementChip(row.action).cls">{{ placementChip(row.action).label }}</span>
                  <span v-if="row.action === 'unavailable' && row.reason" class="mono faint"> {{ row.reason }}</span>
                </td>
                <td>
                  <button
                    v-if="row.action === 'sync'"
                    class="btn btn--secondary btn--sm"
                    @click="runJob(row.node.id, 'sync-local', { name: selected, root: undefined })"
                  >Sync</button>
                  <!-- Warnings never block (SPEC): capacity/offline reasons are advisory. -->
                  <button
                    v-else-if="row.node.online && row.node.kind !== 'nas' && row.viaNodeIds.length > 0"
                    class="btn btn--secondary btn--sm"
                    @click="runJob(row.viaNodeIds[0]!, 'push', { name: selected, hosts: [row.node.host], jobs: 4 })"
                  >Push</button>
                  <button
                    v-else-if="row.node.kind === 'nas'"
                    class="btn btn--secondary btn--sm"
                    @click="confirmDrawerDelete(row.node.id)"
                  >Delete from NAS</button>
                </td>
              </tr>
            </tbody>
          </table>
          <p class="stat__sub faint">
            Sync/push jobs stream output below · deletes apply immediately after their confirmation
          </p>
          <details class="hygiene">
            <summary class="stat__sub">Store maintenance…</summary>
            <div class="row row--wrap" style="gap: 6px; margin-top: 8px">
              <template v-for="v in HYGIENE_VERBS" :key="v.kind">
                <button
                  v-if="storeNode !== null"
                  class="btn btn--sm"
                  :class="v.destructive ? 'btn--ghost' : 'btn--secondary'"
                  @click="runHygiene(v.kind, v.perModel)"
                >{{ v.label }}</button>
              </template>
              <span class="stat__sub faint">doctor and audits cover the whole store; repair targets this model</span>
            </div>
          </details>
        </template>
      </section>
    </div>

    <!-- Job output drawer -->
    <div v-if="job !== null" class="drawer-scrim" @click.self="closeJob">
      <section class="card drawer" aria-label="Job output">
        <div class="card__head">
          <h3>
            {{ job.job.kind }}
            <span class="chip" :class="jobStatusChip(job.job.status).cls">{{ jobStatusChip(job.job.status).label }}</span>
          </h3>
          <button class="btn btn--secondary btn--sm" @click="closeJob">Close</button>
        </div>
        <p v-if="jobError" class="banner banner--warn">{{ jobError }}</p>
        <p v-if="jobApplyName !== null && deleteSetupWarn?.name === jobApplyName" class="banner banner--warn">
          Setup "{{ deleteSetupWarn!.setup }}" serves this model — deleting breaks its next start (advisory, never blocks).
        </p>
        <template v-if="job.job.kind === 'download-queue' && jobSummaryText !== ''">
          <pre class="joblog mono">{{ jobSummaryText }}</pre>
          <details class="rawlog">
            <summary class="stat__sub">raw modelctl output — collapsed (one line per entry, refreshed in place)</summary>
            <pre class="joblog mono">{{ job.output.map((o) => o.line).join("\n") || "no output yet…" }}</pre>
          </details>
          <p class="stat__sub faint">summary from the download queue (IR 71 progress fields) · raw output stays in the job record</p>
        </template>
        <pre v-else class="joblog mono">{{ job.output.map((o) => o.line).join("\n") || "no output yet…" }}</pre>
        <div v-if="job.job.status === 'running' || job.job.status === 'queued'" class="row row--between">
          <span class="faint">streaming…</span>
          <button class="btn btn--danger btn--sm" @click="confirmDrawerCancel">Cancel job</button>
        </div>
      </section>
    </div>

    <!-- Download from HF modal: ALWAYS queues via POST /downloads; server picks the NAS-preferred store node.
         IRI-016: per-row quantization/mtp + expand-quants; dl-drawer fixes the DS spacing rhythm (F2/F3/F5). -->
    <div v-if="downloadOpen" class="drawer-scrim" @click.self="downloadOpen = false">
      <section class="card drawer dl-drawer" aria-label="Download from Hugging Face">
        <div class="card__head">
          <h3>Download from HF to NAS</h3>
          <button class="btn btn--secondary btn--sm" @click="downloadOpen = false">Close</button>
        </div>
        <p v-if="storeNode === null" class="banner banner--warn">
          No online model-ops node (node with the NAS root mounted) — adds queue until one is online.
        </p>
        <div class="field">
          <label class="stat__sub" for="dl-paste">Hugging Face repos — one owner/model per line (# comments ignored)</label>
          <textarea
            id="dl-paste"
            v-model="downloadPaste"
            class="input mono"
            rows="3"
            placeholder="unsloth/GLM-5.3-Flash-EXL3&#10;unsloth/flint-GGUF"
          ></textarea>
          <button class="btn btn--secondary btn--sm" :disabled="downloadPaste.trim().length === 0" @click="parsePaste">
            Parse rows
          </button>
        </div>
        <div class="field">
          <span class="stat__sub">Downloads to queue ({{ downloadRows.length }})</span>
          <p v-if="downloadRows.length === 0" class="stat__sub faint">
            Nothing parsed yet — paste repos above and parse, then tweak names before queueing.
          </p>
          <table v-else class="table">
            <thead>
              <tr><th>Hugging Face repo</th><th>Store name (optional)</th><th>Quantization (optional)</th><th title="Replace an existing manifest with different settings (modelctl force)">Force</th><th></th></tr>
            </thead>
            <tbody>
              <template v-for="(row, index) in downloadRows" :key="row.id">
                <tr>
                  <td><input v-model="row.source" class="input mono" type="text" :aria-label="`Repo ${index + 1}`" /></td>
                  <td><input v-model="row.name" class="input mono" type="text" :placeholder="row.source.split('/').pop() || ''" :aria-label="`Store name ${index + 1}`" /></td>
                  <td><input v-model="row.quantization" class="input mono" type="text" placeholder="e.g. UD-Q4_K_XL" :aria-label="`Quantization ${index + 1}`" /></td>
                  <td>
                    <input
                      v-model="row.force"
                      type="checkbox"
                      :aria-label="`Force ${index + 1}`"
                      title="Replace an existing manifest with different settings (modelctl force)"
                    />
                  </td>
                  <td class="row" style="justify-content: flex-end">
                    <button class="btn btn--secondary btn--sm" :disabled="expandRowId === row.id" @click="openExpand(row)">Expand</button>
                    <button class="btn btn--ghost btn--sm" :aria-label="`Remove ${row.source}`" @click="removeRow(index)">✕</button>
                  </td>
                </tr>
                <tr v-if="expandRowId === row.id">
                  <td colspan="5">
                    <p v-if="expandLoading" class="stat__sub faint">Listing quantizations…</p>
                    <template v-else>
                      <p v-if="expandError" class="banner banner--warn">{{ expandError }}</p>
                      <template v-if="expandListing !== null">
                        <div class="row row--wrap">
                          <button class="btn btn--ghost btn--sm" @click="expandSelected = new Set(expandListing.quants.filter((q) => !q.ambiguous).map((q) => q.tag))">All</button>
                          <button class="btn btn--ghost btn--sm" @click="expandSelected = new Set()">None</button>
                          <span v-if="expandListing.quants.length === 0" class="stat__sub faint">no GGUF model files found in this repo</span>
                        </div>
                        <div class="expand-grid">
                          <label
                            v-for="q in expandListing.quants"
                            :key="q.tag"
                            class="pick"
                            :class="{ 'is-on': expandSelected.has(q.tag) }"
                            :style="q.ambiguous ? 'opacity: .5' : ''"
                          >
                            <input
                              type="checkbox"
                              :checked="expandSelected.has(q.tag)"
                              :disabled="q.ambiguous"
                              @change="toggleExpandTag(q.tag)"
                            />
                            <span class="mono">{{ q.tag }}</span>
                            <span class="stat__sub">{{ q.bytes === null ? "size n/a" : formatGiB(q.bytes) }}{{ q.sharded ? ` · ${q.shards} shards` : "" }}</span>
                          </label>
                        </div>
                        <div class="field expand-companion">
                          <label class="stat__sub" for="dl-mtp">MTP draft (companion)</label>
                          <select id="dl-mtp" v-model="expandMtp" class="select">
                            <option value="">Auto (modelctl default)</option>
                            <option v-for="c in expandListing.companions.mtp.candidates" :key="c.path" :value="c.path">{{ c.path }}</option>
                          </select>
                          <span v-if="expandListing.companions.mtp.candidates.length > 1 && expandListing.companions.mtp.default === null" class="stat__sub faint">
                            multiple MTP files — modelctl requires an explicit choice
                          </span>
                          <span v-if="expandListing.companions.mmproj.candidates.length > 1 && expandListing.companions.mmproj.default === null" class="stat__sub faint">
                            multiple mmproj files without an f16 default — modelctl will refuse this entry
                          </span>
                        </div>
                        <div class="row">
                          <button class="btn btn--primary btn--sm" :disabled="expandAddable === 0" @click="applyExpand">
                            Add {{ expandAddable }} row{{ expandAddable === 1 ? "" : "s" }}
                          </button>
                          <button class="btn btn--ghost btn--sm" @click="closeExpand">Cancel</button>
                        </div>
                      </template>
                    </template>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
        <div class="field">
          <label class="stat__sub" for="dl-jobs">Parallel jobs</label>
          <input id="dl-jobs" v-model.number="downloadJobs" class="input" type="number" min="1" max="16" />
        </div>
        <p v-if="downloadError" class="banner banner--warn">{{ downloadError }}</p>
        <div class="row row--between">
          <span class="stat__sub faint">Always queued · dispatched to the NAS when idle · resumable · companion files included</span>
          <button class="btn btn--primary btn--sm" :disabled="downloadBusy || downloadRows.length === 0" @click="submitDownload">
            {{ downloadBusy ? "Queueing…" : downloadRows.length > 0 ? `Add ${downloadRows.length} to queue` : "Add to queue" }}
          </button>
        </div>
      </section>
    </div>

    <!-- IRI-020: per-row actions menu (catalog + queue); closes on any outside click -->
    <div v-if="rowMenu !== null" class="rowpop" role="menu" :aria-label="`Actions for ${rowMenu.name}`" :style="{ top: `${rowMenu.y}px`, left: `${rowMenu.x}px` }">
      <button v-for="it in rowMenuItems" :key="it.act" class="btn btn--ghost btn--sm menu-item" @click="runRowMenu(it.act)">{{ it.label }}</button>
    </div>

    <!-- IRI-020: shared confirmation for destructive actions (queue + catalog) -->
    <div v-if="confirmState !== null" class="drawer-scrim" @click.self="dismissConfirm">
      <section class="card confirm-card" role="alertdialog" aria-modal="true" :aria-label="confirmState.title">
        <div class="card__head">
          <h3>{{ confirmState.title }}</h3>
          <button class="btn btn--secondary btn--sm" @click="dismissConfirm">Close</button>
        </div>
        <p class="stat__sub" style="margin: 0">{{ confirmState.body }}</p>
        <div class="row row--between">
          <span class="stat__sub faint">nothing destructive runs until you confirm</span>
          <div class="row">
            <button class="btn btn--secondary btn--sm" @click="dismissConfirm">Cancel</button>
            <button class="btn btn--danger btn--sm" :disabled="confirmBusy" @click="runConfirm">{{ confirmBusy ? "Working…" : confirmState.danger }}</button>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.search {
  min-height: 44px;
  min-width: min(320px, 100%);
}
.is-clickable {
  cursor: pointer;
}
.drawer-scrim {
  position: fixed;
  inset: 0;
  background: color-mix(in srgb, var(--bg, #000) 55%, transparent);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  z-index: 10;
}
.drawer {
  width: min(760px, 100%);
  max-height: 86vh;
  overflow: auto;
  padding: 14px;
}
.joblog {
  max-height: 40vh;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--surface, transparent);
  padding: 10px;
  border-radius: 6px;
}
.num {
  text-align: right;
}
/* IRI-016 (brief §7): real DS rhythm between the modal's field groups, an
   unstretched secondary action, and a proportional numeric input. */
.dl-drawer {
  display: grid;
  gap: var(--space-3);
}
.dl-drawer .field > .btn {
  justify-self: start;
}
.dl-drawer input[type="number"] {
  max-width: 120px;
}
/* IRI-017: per-row download progress. Width/color transitions animate speed
   changes smoothly; disabled under prefers-reduced-motion (DS pulse rule). */
.dlbar-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}
.dlbar {
  flex: 1;
  max-width: 260px;
  height: 4px;
  border-radius: 999px;
  background: var(--border, #333);
  overflow: hidden;
}
.dlbar__fill {
  height: 100%;
  border-radius: 999px;
  background: var(--accent);
  transition: width 0.6s ease, background-color 0.6s ease;
}
.dlbar__fill--slow { background: var(--warning); }
.dlbar__fill--ok { background: var(--accent); }
.dlbar__fill--fast { background: var(--success); }
.dlbar__speed {
  font-family: var(--font-mono);
  font-size: 12px;
  transition: color 0.6s ease;
}
.dlbar__speed--slow { color: var(--warning); }
.dlbar__speed--ok { color: var(--accent); }
.dlbar__speed--fast { color: var(--success); }
@media (prefers-reduced-motion: reduce) {
  .dlbar__fill, .dlbar__speed { transition: none; }
}
/* Expand-quants panel: dense two-column checkbox list + companion select. */
.expand-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  margin: 8px 0;
}
.expand-companion {
  margin-top: 8px;
}
/* IRI-020: per-row actions menu, shared confirm modal, error tooltip, and the
   aggregate batch bar. Menu/tooltip sit below the drawer scrim z-index. */
.rowpop {
  position: fixed;
  z-index: 30;
  width: 210px;
  padding: 6px;
  display: grid;
  gap: 2px;
  background: var(--surface, #fff);
  border: 1px solid var(--border-strong, #666);
  border-radius: 4px;
}
.rowpop .menu-item {
  display: block;
  width: 100%;
  text-align: left;
  border: none;
}
.rowpop .menu-item:hover {
  background: var(--surface-2, rgba(127, 127, 127, 0.15));
}
.confirm-card {
  width: min(520px, 92vw);
  max-height: 86vh;
  overflow: auto;
  padding: 14px;
  display: grid;
  gap: 12px;
}
.tip {
  position: relative;
  display: inline-block;
}
.tip__box {
  position: absolute;
  left: 0;
  top: calc(100% + 6px);
  z-index: 30;
  display: none;
  width: 420px;
  max-width: 80vw;
  background: var(--surface, #111);
  border: 1px solid var(--border-strong, #666);
  border-radius: 4px;
  padding: 8px 10px;
  font-family: var(--font-mono, monospace);
  font-size: 11.5px;
  line-height: 1.5;
  white-space: normal;
  overflow-wrap: anywhere;
  text-align: left;
}
.tip:hover .tip__box,
.tip:focus-within .tip__box {
  display: block;
}
.dlbar--agg {
  max-width: none;
  height: 6px;
}
@media (min-width: 721px) {
  .drawer-scrim {
    align-items: center;
  }
}
</style>
