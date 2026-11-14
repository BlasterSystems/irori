<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { fetchNodes, fetchRecipes, installRecipe, fetchRecipeDraft, type RecipeRow } from "../api";
import { RECIPE_CAVEATS } from "@irori/core";
import { live } from "../live";
import { activeJobsByNode, blockingJobLabel, jobLabel, jobStreams, type JobLive } from "../jobs";
import { fetchSetups } from "../serve";
import { fmtBytes } from "../analytics";
import { computeNasData } from "../overview";
import { thresholds } from "../thresholds";
import CleanupDrawer from "./CleanupDrawer.vue";
import { DOWNLOAD_BATCH_MAX_ENTRIES, compareVersions, pickStoreNode, type NodeInfo, type PlacementRow } from "@irori/core";
import {
  bulkDeleteTotalBytes,
  cancelJob,
  createJob,
  DOWNLOAD_CLEAR_GRACE_MS,
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
  setupServingNames,
  staleSucceededIds,
  transferSummaryLine,
  type DownloadQueueEntry,
  type HfQuantsResult,
  type JobDetail,
  type JobView,
  type ModelEntry,
  type ModelsPage,
  type PlacementResponse,
} from "../models";

const search = ref("");
const page = ref(1);
// IRI-051: the toggle choice persists — the owner flips to Name A-Z once and
// it sticks. Default stays "recently added" (new downloads belong on top).
// Storage access is guarded: browsers throw when site data is blocked.
const sort = ref<"recent" | "name">((() => {
  try {
    return localStorage.getItem("irori.models.sort") === "name" ? "name" : "recent";
  } catch {
    return "recent";
  }
})());
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

/** IR-210: bulk store-delete selection (catalog names, survives pagination) + totals. */
const bulkSelected = ref<Set<string>>(new Set());
function toggleBulk(name: string): void {
  const next = new Set(bulkSelected.value);
  if (!next.delete(name)) next.add(name);
  bulkSelected.value = next;
}
function clearBulk(): void {
  bulkSelected.value = new Set();
}
const bulkAllSelected = computed(() => {
  const models = modelsPage.value?.models ?? [];
  return models.length > 0 && models.every((m) => bulkSelected.value.has(m.name));
});
function toggleBulkAll(): void {
  const models = modelsPage.value?.models ?? [];
  const next = new Set(bulkSelected.value);
  if (bulkAllSelected.value) models.forEach((m) => next.delete(m.name));
  else models.forEach((m) => next.add(m.name));
  bulkSelected.value = next;
}
const bulkBytes = computed(() => bulkDeleteTotalBytes(modelsPage.value?.models ?? [], bulkSelected.value));

/** IR-207: the store node must run an agent that knows nas-delete-batch
 *  (0.7.0+); an older agent fails the job with "unknown job kind", so the
 *  action is hidden instead of dispatching into a guaranteed failure. */
const bulkSupported = computed(() => {
  const node = pickStoreNode(nodes.value);
  if (node === null) return false;
  return compareVersions(node.agentVersion ?? "0", "0.7.0") >= 0;
});

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
    let result: ModelsPage;
    if (runtimeFiltering.value) {
      // The chips cannot be answered server-side (/api/v1/models filters by q
      // only) — merge every page in the chosen order, filter by runtime and
      // paginate at the hub's 25/page (IR-222: counts stay hub-derived).
      const all: ModelEntry[] = [];
      for (let p = 1; ; p++) {
        const res = await fetchModelsPage(p, search.value, sort.value);
        all.push(...res.models);
        if (all.length >= res.total || res.models.length === 0) break;
      }
      const filtered = all.filter((m) => runtimeSel.value.includes(m.runtime));
      result = {
        page: page.value,
        pageSize: MODELS_PAGE_SIZE,
        total: filtered.length,
        models: filtered.slice((page.value - 1) * MODELS_PAGE_SIZE, page.value * MODELS_PAGE_SIZE),
      };
    } else {
      result = await fetchModelsPage(page.value, search.value, sort.value);
    }
    if (seq !== loadSeq) return;
    modelsPage.value = result;
  } catch (err) {
    if (seq !== loadSeq) return;
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    if (seq === loadSeq) loading.value = false;
  }
}

/** IR-222 runtime filter chips (aria-pressed): all pressed = the server-paged
 *  catalog as before; a subset switches to the merged+filtered page. */
const RUNTIMES = ["vllm", "llama.cpp"] as const;
/** Mirrors the hub's MODELS_PAGE_SIZE — the merged+filtered page slices at it. */
const MODELS_PAGE_SIZE = 25;
const runtimeSel = ref<string[]>([]);
const runtimeFiltering = computed(() => runtimeSel.value.length > 0 && runtimeSel.value.length < RUNTIMES.length);
function toggleRuntime(rt: string): void {
  runtimeSel.value = runtimeSel.value.includes(rt) ? runtimeSel.value.filter((r) => r !== rt) : [...runtimeSel.value, rt];
  page.value = 1;
  void load();
}

function onSortChange(ev: Event): void {
  const v = (ev.target as HTMLSelectElement).value;
  sort.value = v === "name" ? "name" : "recent";
  try {
    localStorage.setItem("irori.models.sort", sort.value);
  } catch {
    /* storage blocked — the choice stays session-only */
  }
  page.value = 1;
  void load();
}

/** Store node for hygiene verbs and the modal banner (NAS-preferred, IRI-014). */
const nodes = ref<NodeInfo[]>([]);
const storeNodeInfo = computed(() => pickStoreNode(nodes.value));
const storeNode = computed(() => storeNodeInfo.value?.id ?? null);

/** IR-222 store strip: disk from the store node's live snapshot, catalog
 *  counts from the same fetch as the page — never a hardcoded total. */
const storeSnapshot = computed(() => (storeNodeInfo.value === null ? null : live.snapshots.get(storeNodeInfo.value.id) ?? null));
const storeNas = computed(() => computeNasData(null, null, storeSnapshot.value));
const storeVal = computed(() =>
  storeNas.value.storeUsedBytes !== null && storeNas.value.storeTotalBytes !== null
    ? `${fmtBytes(storeNas.value.storeUsedBytes)} / ${fmtBytes(storeNas.value.storeTotalBytes)}`
    : null,
);
const storeHot = computed(() => storeNas.value.storePct !== null && storeNas.value.storePct >= thresholds.diskWarnPct);

/** Store-wide hygiene verbs for the strip popover (per-model repair stays in
 *  the drawer); labels follow the modelctl verbs they dispatch. */
const STORE_VERBS: Array<{ kind: string; label: string }> = [
  { kind: "doctor", label: "doctor --json" },
  { kind: "staging-audit", label: "staging audit" },
  { kind: "objects-audit", label: "objects audit" },
  { kind: "catalog-refresh", label: "refresh catalog" },
  { kind: "sync-cards", label: "sync cards" },
  { kind: "gc-objects", label: "gc-objects (dry-run)" },
];
const hygOpen = ref(false);
/** IR-222: "clean up disk — run audit" opens the shared per-node cleanup drawer. */
const cleanupNode = ref<{ id: string; name: string } | null>(null);
function openCleanup(nodeId: string): void {
  const n = nodes.value.find((x) => x.id === nodeId);
  if (n !== undefined) cleanupNode.value = { id: n.id, name: n.name };
}

/** IRI-082: curated recipe catalog (SparkRun + MiaAI). */
const recipes = ref<RecipeRow[]>([]);
const recipeBusy = ref<string | null>(null);
const recipeDraft = ref<{ slug: string; text: string } | null>(null);
async function installRecipeCard(r: RecipeRow): Promise<void> {
  recipeBusy.value = r.slug;
  try {
    const nodes = await fetchNodes();
    const head = nodes.find((n) => n.online) ?? nodes[0];
    if (head === undefined) throw new Error("no node available");
    const jobId = await installRecipe(r.id, head.id);
    for (let i = 0; i < 20; i++) {
      await new Promise((res) => setTimeout(res, 1500));
      try {
        const draft = await fetchRecipeDraft(jobId);
        recipeDraft.value = { slug: r.slug, text: draft.name + " on " + head.name + " :" + draft.port + " — scripts " + draft.scriptStart + "/" + draft.scriptStop };
        location.hash = "#/serve?recipeJob=" + encodeURIComponent(jobId);
        return;
      } catch {
        /* not settled yet */
      }
    }
    recipeDraft.value = { slug: r.slug, text: "staging still running — check Activity, then Serve" };
  } catch (err) {
    recipeDraft.value = { slug: r.slug, text: err instanceof Error ? err.message : "install failed" };
  } finally {
    recipeBusy.value = null;
  }
}
void fetchRecipes().then((r) => { recipes.value = r.recipes; }).catch(() => {});

onMounted(() => {
  document.addEventListener("click", onDocClick); // IRI-020: row-menu click-away
  document.addEventListener("keydown", onDocKeydown); // IR-222: Escape closes the popover/menu
  void fetchNodes()
    .then((rows) => {
      nodes.value = rows;
    })
    .catch(() => {
      /* registry unavailable: download modal surfaces "no model-ops node" */
    });
  void live.refreshJobs(); // IR-222: re-seed the jobs rows from the hub
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
let clearTimer: ReturnType<typeof setTimeout> | undefined;

function queueHasActive(entries: DownloadQueueEntry[]): boolean {
  return entries.some((e) => e.status === "pending" || e.status === "running");
}

/** IR-96: delete the given settled rows; tolerates 404/409 races (another tab
 *  removed them first) — the follow-up refresh is the source of truth. */
function pruneSucceeded(ids: string[]): void {
  if (ids.length === 0) return;
  void (async () => {
    await Promise.allSettled(ids.map((id) => removeDownload(id)));
    await refreshQueue();
  })();
}

/** IR-96: rows settled before the grace window (previous session) never render. */
function pruneStaleSucceeded(entries: DownloadQueueEntry[]): void {
  pruneSucceeded(staleSucceededIds(entries, Date.now()));
}

/** IR-96: succeeded rows leave once they cross the grace window
 *  (updatedAt + grace), active batch or not — the timer targets the next
 *  crossing so polling while a batch runs cannot starve it; failed/canceled
 *  rows stay until removed or retried. */
function scheduleSucceededClear(entries: DownloadQueueEntry[]): void {
  if (clearTimer !== undefined) {
    clearTimeout(clearTimer);
    clearTimer = undefined;
  }
  const now = Date.now();
  const next = entries
    .filter((e) => e.status === "succeeded")
    .map((e) => Date.parse(e.updatedAt) + DOWNLOAD_CLEAR_GRACE_MS - now)
    .filter((ms) => ms > 0)
    .sort((a, b) => a - b)[0];
  if (next === undefined) return;
  clearTimer = setTimeout(() => {
    clearTimer = undefined;
    pruneSucceeded(staleSucceededIds(downloadQueueEntries.value, Date.now()));
  }, next);
}

async function refreshQueue(): Promise<void> {
  const seq = ++queueSeq.n;
  try {
    const entries = await fetchDownloadQueue();
    if (seq !== queueSeq.n) return; // a newer refresh won
    downloadQueueEntries.value = entries;
    queueError.value = null;
    pruneStaleSucceeded(entries); // IR-96: a stale batch from a previous session never renders
    scheduleSucceededClear(entries); // IR-96: finished rows leave at updatedAt + grace
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

/** IR-222: destructive menu entries read as thread-ink text (never a fill). */
function isRowMenuDanger(act: string): boolean {
  if (rowMenu.value?.kind === "catalog") return act === "delete";
  return act === "cancel-job" || act === "retry-force" || act === "remove";
}

function onDocClick(ev: MouseEvent): void {
  const t = ev.target as HTMLElement | null;
  if (rowMenu.value !== null && t !== null && !t.closest(".rowpop") && !t.closest(".rowopts")) rowMenu.value = null;
  // IR-222 store-health popover: closes on any outside press, like the rowpop.
  if (hygOpen.value && t !== null && !t.closest(".hygpop") && !t.closest(".hygopen")) hygOpen.value = false;
}

function onDocKeydown(ev: KeyboardEvent): void {
  if (ev.key !== "Escape") return;
  hygOpen.value = false;
  rowMenu.value = null;
}

interface ConfirmAction {
  title: string;
  body: string;
  danger: string;
  run: () => Promise<void> | void;
  /** IR-210: scrollable item list (bulk-delete model names); page-level confirm only. */
  list?: string[];
  /** IRI-043: "job" renders the confirm INSIDE the sheet (no stacked modal);
   *  absent = page-level confirm-card. */
  host?: "job";
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

/** IRI-043 (option C): the primary drawer and the job sheet share one scrim —
 *  the top-most layer closes first on a backdrop press. */
const primaryOpen = computed(() => selected.value !== null || downloadOpen.value);
function closeTopMost(): void {
  if (job.value !== null && primaryOpen.value) {
    closeJob();
    return;
  }
  if (selected.value !== null) closeDetail();
  if (downloadOpen.value) downloadOpen.value = false;
}

function runRowMenu(act: string): void {
  const m = rowMenu.value;
  rowMenu.value = null;
  if (m === null) return;
  if (m.kind === "catalog") {
    if (act === "details") void openModel(m.name);
    else if (act === "delete" && storeNode.value !== null) startNasDelete(storeNode.value, m.name);
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

/** IR-222 armed delete (SPEC §6): the plan is a dry-run `nas-delete` job —
 *  the job sheet shows it, then arms the typed `nas-delete-apply` once the
 *  plan settles. The serving-setup advisory rides along (never blocks). */
function startNasDelete(nodeId: string, name: string): void {
  deleteSetupWarn.value = null;
  const seq = ++deleteSetupSeq;
  void fetchSetups()
    .then((rows) => {
      if (seq !== deleteSetupSeq) return;
      const setup = setupServingModel(rows, name);
      deleteSetupWarn.value = setup === null ? null : { name, setup };
    })
    .catch(() => {});
  armName.value = "";
  void runJob(nodeId, "nas-delete", { name });
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
    host: "job", // IRI-043: confirms inside the sheet, never a stacked modal
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

/** IRI-020: batch totals strip; IR-96: shown only while the queue has active rows. */
const queueTotals = computed(() => downloadBatchTotals(downloadQueueEntries.value));
// IR-96: the strip is progress toward done — hidden once nothing is pending/running.
const showQueueTotals = computed(() => queueHasActive(downloadQueueEntries.value) && downloadQueueEntries.value.some((e) => e.bytesTotal != null || e.speedBps != null));
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

/**
 * IR-210: bulk delete confirm. The setup advisory is computed BEFORE the modal
 * opens (a wrong 76-model dispatch is expensive to unwind) and the drawer
 * banner repeats it post-dispatch, per the single-delete convention.
 */
async function confirmBulkDelete(): Promise<void> {
  const nodeId = storeNode.value;
  const names = [...bulkSelected.value];
  if (nodeId === null || names.length === 0) return;
  const serving = await fetchSetups()
    .then((rows) => setupServingNames(rows, names))
    .catch(() => [] as string[]);
  const total = bulkBytes.value;
  confirmAction({
    title: `Delete ${names.length} models from the NAS?`,
    body:
      `Removes every listed model's objects, references and staging from the NAS store via modelctl — ` +
      `${formatGiB(total)} total. NAS is never written outside modelctl.` +
      (serving.length > 0
        ? ` Setup${serving.length === 1 ? "" : "s"} ${serving.join(", ")} serve${serving.length === 1 ? "s" : ""} selected models — deleting breaks their next start.`
        : ""),
    list: names,
    danger: `Delete ${names.length} models`,
    run: async () => {
      deleteSetupWarn.value = null;
      // Advisory only — never delays the dispatch; sequenced so a late
      // response cannot attach to a different job.
      const seq = ++deleteSetupSeq;
      void fetchSetups()
        .then((rows) => {
          if (seq !== deleteSetupSeq) return;
          const serving = setupServingNames(rows, names);
          deleteSetupWarn.value = serving.length === 0 ? null : { name: "bulk", setup: serving.join(", ") };
        })
        .catch(() => {});
      await runJob(nodeId, "nas-delete-batch", { names });
      clearBulk();
    },
  });
}

/** The open drawer's batch delete — the advisory banner is scoped to it. */
const jobBulkDelete = computed(() => job.value?.job.kind === "nas-delete-batch" && deleteSetupWarn.value?.name === "bulk");

/** The open sheet's nas-delete/apply target name — the advisory banner is
 *  scoped to it (the plan and the armed apply share it). */
const jobApplyName = computed(() => {
  const j = job.value?.job;
  if (j === undefined || (j.kind !== "nas-delete-apply" && j.kind !== "nas-delete")) return null;
  const name = j.params["name"];
  return typeof name === "string" && name.length > 0 ? name : null;
});

/** IR-222 armed delete (SPEC §6): once the dry-run plan job has settled, the
 *  sheet offers the typed arm — the apply only runs when the typed name
 *  matches the planned model. */
const armName = ref("");
const armBusy = ref(false);
const armJob = computed(() => {
  const j = job.value;
  if (j === null || j.job.kind !== "nas-delete" || j.job.status !== "succeeded") return null;
  const name = j.job.params["name"];
  return typeof name === "string" && name.length > 0 ? { name } : null;
});
async function runArmDelete(): Promise<void> {
  const a = armJob.value;
  if (a === null || armBusy.value || armName.value !== a.name) return;
  armBusy.value = true;
  try {
    await runJob(job.value!.job.nodeId, "nas-delete-apply", { name: a.name });
  } finally {
    armBusy.value = false;
    armName.value = "";
  }
}

/** IRI-051: what the open job sheet is FOR — target node plus model, so the
 *  sheet stops reading as an anonymous "sync-local RUNNING" modal. */
const jobContext = computed(() => {
  const j = job.value?.job;
  if (j === undefined) return null;
  const parts: string[] = [];
  const node = nodes.value.find((n) => n.id === j.nodeId)?.name ?? null;
  if (node !== null) parts.push(`on ${node}`);
  const name = j.params["name"];
  if (typeof name === "string" && name.length > 0) parts.push(name);
  return parts.length > 0 ? parts.join(" · ") : null;
});

/** IR-222 refresh-note: live status, catalog size, jobs stream (Overview precedent). */
const refreshNoteText = computed(() => {
  if (!live.connected.value) return "Offline — showing the last known state";
  return `Live · catalog ${modelsPage.value?.total ?? 0} models · jobs stream`;
});

/** IR-222 jobs rows: active transfer jobs from the live store (seeded from
 *  GET /api/v1/jobs, kept current by SSE) — hub data, never a hardcoded list. */
const TRANSFER_KINDS = ["sync-local", "push", "download-queue"];
const activeTransfers = computed(() => {
  const out: JobLive[] = [];
  for (const j of live.jobs.values()) {
    if (!TRANSFER_KINDS.includes(j.kind) || (j.status !== "queued" && j.status !== "running")) continue;
    out.push(j);
  }
  return out.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
});
const doneTodayCount = computed(() => {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  let n = 0;
  for (const j of live.jobs.values()) {
    if (TRANSFER_KINDS.includes(j.kind) && j.finishedAt !== null && Date.parse(j.finishedAt) >= dayStart.getTime()) n++;
  }
  return n;
});
const jobsMeta = computed(() => `${activeTransfers.value.length} running · ${doneTodayCount.value} done today`);

function jobRowName(j: JobLive): string {
  return `${j.kind}${jobLabel(j.params)}`;
}
function jobRowTarget(j: JobLive): string {
  const node = nodes.value.find((n) => n.id === j.nodeId)?.name ?? "node";
  if (j.kind === "push") {
    const hosts = j.params["hosts"];
    const dest = Array.isArray(hosts) ? hosts.filter((h): h is string => typeof h === "string").join(", ") : "";
    return dest.length > 0 ? `${node} → ${dest}` : node;
  }
  if (j.kind === "sync-local") return `${node} ← nas`;
  return `${node} · nas store`;
}
function jobRowPct(j: JobLive): number | null {
  const p = j.progress?.percent;
  return typeof p === "number" ? Math.max(0, Math.min(100, p)) : null;
}
function jobRowBytes(j: JobLive): string | null {
  const b = j.progress?.bytes;
  return typeof b === "number" && b > 0 ? fmtBytes(b) : null;
}
function jobRowRate(j: JobLive): string | null {
  const p = j.progress;
  if (p === null || p === undefined) return null;
  const parts: string[] = [];
  if (typeof p.rateBytesPerSec === "number" && p.rateBytesPerSec > 0) parts.push(downloadSpeedLabel(p.rateBytesPerSec).label);
  if (typeof p.etaSeconds === "number" && p.etaSeconds > 0) parts.push(`~${formatEta(p.etaSeconds)} left`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Catalog-row lookups for the drawer's kv (repo/added/runtime come from the
 *  same fetch as the page; the placement response carries name+bytes only). */
function catalogEntry(name: string): ModelEntry | null {
  return modelsPage.value?.models.find((m) => m.name === name) ?? null;
}
const drawerRuntime = computed(() => (selected.value === null ? null : catalogEntry(selected.value)?.runtime ?? null));
const drawerRepo = computed(() => (selected.value === null ? null : catalogEntry(selected.value)?.repository ?? null));
const drawerAdded = computed(() => {
  if (selected.value === null) return null;
  const iso = catalogEntry(selected.value)?.firstSeenAt ?? "";
  const t = Date.parse(iso);
  return Number.isFinite(t) && iso !== "" ? new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : null;
});
/** "Oct 12" from a catalog firstSeenAt (mockup Added column). */
function addedLabel(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) && iso !== "" ? new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—";
}

/** IR-222 pagination: page buttons with aria-current; 0 marks an ellipsis gap. */
const pageList = computed<Array<number | 0>>(() => {
  const n = totalPages.value;
  const cur = page.value;
  if (n <= 9) return Array.from({ length: n }, (_, i) => i + 1);
  const out: Array<number | 0> = [1];
  const lo = Math.max(2, cur - 1);
  const hi = Math.min(n - 1, cur + 1);
  if (lo > 2) out.push(0);
  for (let p = lo; p <= hi; p++) out.push(p);
  if (hi < n - 1) out.push(0);
  out.push(n);
  return out;
});
function goTo(p: number): void {
  if (p === page.value) return;
  page.value = p;
  void load();
}

/** IRI-051: aggregate line for the sheet — download-queue keeps its batch
 *  summary; transfer kinds get the hub-parsed progress (IR-131) via
 *  transferSummaryLine (single-stream only; push stays raw). */
const sheetSummary = computed(() => {
  const j = job.value;
  if (j === null) return null;
  if (j.job.kind === "download-queue") return jobSummaryText.value === "" ? null : jobSummaryText.value;
  const modelBytes = placement.value?.model.bytes ?? null;
  return transferSummaryLine(j.job.kind, j.job.params, j.job.progress, j.output, modelBytes);
});

/** IRI-051: running sync-local jobs keyed by target node, for the live
 *  "syncing" chip in the placement table. Fed by broadcast SSE (job and
 *  job-progress frames) — independent of the open sheet and its poll.
 *  Value = parsed percent, null while nothing parseable has arrived. */
const syncingPct = computed(() => {
  const out = new Map<string, number | null>();
  for (const j of live.jobs.values()) {
    if (j.kind !== "sync-local" || j.status !== "running") continue;
    if (j.params["name"] !== selected.value) continue;
    out.set(j.nodeId, j.progress !== null && j.progress !== undefined && typeof j.progress.percent === "number" ? Math.round(j.progress.percent) : null);
  }
  return out;
});

/** IR-134: the job holding each node's one-active slot, so a push row whose
 *  RELAY (viaNodeIds[0]) is busy shows the blocker instead of throwing an
 *  invisible 409 at the user. Kept current by the same SSE frames as
 *  syncingPct. */
const relayBusy = computed(() => activeJobsByNode(live.jobs.values()));

/** IR-134: the job blocking a row's dispatch — a push runs on the RELAY
 *  (viaNodeIds[0]), sync/delete on the node itself. Null when idle. */
function dispatchBlocker(row: PlacementRow): JobLive | null {
  const targetId = row.action === "push" ? row.viaNodeIds[0] : row.node.id;
  if (targetId === undefined) return null;
  return relayBusy.value.get(targetId) ?? null;
}

function dispatchBlockerLabel(row: PlacementRow): string {
  const blocker = dispatchBlocker(row);
  if (blocker === null) return "";
  const name = placement.value?.placements.find((p) => p.node.id === blocker.nodeId)?.node.name ?? "node";
  return `${name} busy — ${blockingJobLabel(blocker)}`;
}

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

/** IR-222 review: under an active search/runtime filter the page total is
 *  the FILTERED count, not the catalog total — label it honestly (the nav
 *  count carries the unfiltered total). */
const stripCountLabel = computed(() => {
  const filtered = search.value.trim() !== "" || runtimeFiltering.value;
  const n = modelsPage.value?.total ?? "—";
  return filtered ? `${n} matching (catalog total in the nav)` : `catalog ${n} objects`;
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

/** IR-100: name of the node the push job will run on (viaNodeIds[0]) — the
 * CX7 holder; null when the source node is not in the placement response. */
function pushViaName(viaNodeIds: string[]): string | null {
  const id = viaNodeIds[0];
  if (id === undefined || placement.value === null) return null;
  return placement.value.placements.find((p) => p.node.id === id)?.node.name ?? null;
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
/** IR-131 IRI-044 parity: the last transfer opened here stays reachable after
 *  the sheet closes. The bar reads the SSE-updated live store, so it survives
 *  closeJob() and every drawer; the global dock covers cross-page reach. */
const lastTransferId = ref<string | null>(null);
const opDismissedFor = ref<string | null>(null);
const opBarJob = computed(() => {
  const id = lastTransferId.value;
  if (id === null) return null;
  const j = live.jobs.get(id);
  if (j === undefined || (j.status !== "queued" && j.status !== "running")) return null;
  if (job.value?.job.id === id) return null; // the sheet is showing it
  if (opDismissedFor.value === id) return null;
  return j;
});
/** IR-222: shared guarded-cancel for the op bar and the jobs rows — the same
 *  blast-radius copy, the shared page confirm. */
function confirmTransferCancel(j: JobLive): void {
  const isBatch = j.kind === "download-queue";
  confirmAction({
    title: isBatch ? "Cancel this download batch?" : `Cancel this ${j.kind} transfer?`,
    body: isBatch
      ? "Stops the running modelctl batch — every entry sharing this job is marked canceled (resumable staging is kept)."
      : "Stops the running transfer; whatever it already wrote stays as resumable staging.",
    danger: "Cancel transfer",
    run: async () => {
      try {
        await cancelJob(j.id);
      } catch (err) {
        jobError.value = err instanceof Error ? err.message : String(err);
      }
      await refreshQueue();
    },
  });
}

function confirmOpBarCancel(): void {
  const j = opBarJob.value;
  if (j !== null) confirmTransferCancel(j);
}
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
  // Track the transfer for the persistent op bar (IR-131).
  if (["sync-local", "push", "download-queue"].includes(job.value.job.kind)) {
    lastTransferId.value = job.value.job.id;
    opDismissedFor.value = null;
  }
  jobPoll = setInterval(async () => {
    if (job.value === null) return;
    if (job.value.job.status === "succeeded" || job.value.job.status === "failed" || job.value.job.status === "canceled") {
      clearInterval(jobPoll);
      // A settled delete changes the store catalog — the hub's catalog-request
      // round-trip is async, so refetch now and once more after it lands.
      if (job.value.job.kind === "nas-delete" || job.value.job.kind === "nas-delete-apply" || job.value.job.kind === "nas-delete-batch") {
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
  document.removeEventListener("keydown", onDocKeydown);
  clearTimeout(debounce);
  clearTimeout(deleteReloadTimer);
  clearTimeout(clearTimer); // IR-96: no prune after unmount
  clearInterval(jobPoll);
  clearInterval(queuePoll);
});
</script>

<template>
  <div class="page">
    <header class="pagehead">
      <h1>Models</h1>
      <p><span class="mono">nas → {{ storeNodeInfo?.nasRoot ?? "NAS store" }}</span> · no store writes outside modelctl</p>
    </header>

    <!-- IR-131 IRI-044 parity: the last transfer opened here stays reachable
         after every drawer/sheet close — guarded cancel, live status line. -->
    <div v-if="opBarJob !== null" class="card" style="margin-bottom: 12px;" aria-label="Active transfer">
      <div class="card__body" style="padding: 10px 12px;">
        <div class="row row--between" style="flex-wrap: wrap; gap: 8px;">
          <span class="row" style="gap: 8px; min-width: 0;">
            <strong class="stat__sub">Transfer</strong>
            <span class="chip" :class="opBarJob.cancelRequestedAt !== null ? 'chip--warn' : ''"><span class="dot dot--run" aria-hidden="true"></span> {{ opBarJob.cancelRequestedAt !== null ? "canceling" : opBarJob.kind }}</span>
            <span class="stat__sub faint" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{{ jobLabel(opBarJob.params).slice(1) || opBarJob.kind }} · {{ opBarJob.lastLine ?? "waiting for output…" }}</span>
          </span>
          <span class="row" style="gap: 12px;">
            <button class="bs-link" @click="openJob(opBarJob.id)">Output</button>
            <button v-if="opBarJob.cancelRequestedAt === null" class="bs-link bs-link--thread" @click="confirmOpBarCancel">Cancel…</button>
            <button class="bs-link" @click="opDismissedFor = opBarJob!.id">Dismiss</button>
          </span>
        </div>
      </div>
    </div>

    <!-- IR-222 store strip: NAS disk from the live snapshot, catalog counts
         from the same fetch as the page; the popover carries the store-wide
         hygiene verbs. -->
    <section class="card strip" aria-label="Store health">
      <div class="card__body strip__body">
        <div class="row row--between row--wrap" style="gap: 16px;">
          <div class="row row--wrap" style="gap: 16px; min-width: 0;">
            <div v-if="storeVal !== null" class="barrow storebarrow">
              <span>store</span>
              <div class="bar"><div class="bar__fill" :style="{ width: `${storeNas.storePct ?? 0}%` }"></div></div>
              <span class="val" :class="{ 'metric--hot': storeHot }">{{ storeVal }}</span>
            </div>
            <span class="stat__sub">{{ stripCountLabel }} · page {{ modelsPage?.page ?? page }} / {{ totalPages }} @ {{ modelsPage?.pageSize ?? MODELS_PAGE_SIZE }}/page</span>
            <span class="stat__sub">
              {{ storeNodeInfo?.name ?? "no store node" }}<template v-if="storeNodeInfo?.agentVersion !== null && storeNodeInfo?.agentVersion !== undefined"> · agent {{ storeNodeInfo.agentVersion }}</template> · {{ live.connected.value ? "live" : "offline" }}
            </span>
          </div>
          <div class="row" style="position: relative;">
            <button class="btn btn--secondary btn--sm hygopen" :aria-expanded="hygOpen ? 'true' : 'false'" aria-controls="hygPop" @click.stop="hygOpen = !hygOpen">Store health</button>
            <div v-if="hygOpen" id="hygPop" class="popover hygpop" role="dialog" aria-label="Store health">
              <dl class="kv">
                <dt>objects</dt><dd>{{ modelsPage?.total ?? 0 }} active</dd>
                <dt>store root</dt><dd>{{ storeNodeInfo?.nasRoot ?? "—" }}</dd>
                <dt>agent</dt><dd>{{ storeNodeInfo?.agentVersion ?? "—" }}</dd>
              </dl>
              <div class="row row--wrap" style="margin-top: 12px; gap: 8px;">
                <button
                  v-for="v in STORE_VERBS"
                  :key="v.kind"
                  class="btn btn--secondary btn--sm"
                  :disabled="storeNode === null"
                  @click="runHygiene(v.kind, false)"
                >{{ v.label }}</button>
              </div>
              <p class="stat__sub faint" style="margin: 10px 0 0;">All mutations dry-run first, then armed. NAS never written outside modelctl.</p>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- IR-222 jobs rows: active transfer jobs from the live store, with
         guarded Output/Cancel — the mockup's jobs panel on hub data. -->
    <section v-if="activeTransfers.length > 0 || doneTodayCount > 0" class="card section-gap" aria-label="Jobs">
      <div class="card__head">
        <h3>Jobs</h3>
        <span class="stat__sub faint">{{ jobsMeta }}</span>
      </div>
      <div class="jobrows">
        <div v-for="j in activeTransfers" :key="j.id" class="jobrow">
          <span class="dot" :class="j.cancelRequestedAt !== null ? 'dot--warn' : 'dot--run'" aria-hidden="true"></span>
          <div class="jobrow__main">
            <span class="jobrow__name mono">{{ jobRowName(j) }}</span>
            <span class="jobrow__target">{{ jobRowTarget(j) }}</span>
          </div>
          <div class="jobrow__bar">
            <div v-if="jobRowPct(j) !== null" class="bar bar--lg"><div class="bar__fill" :style="{ width: `${jobRowPct(j)}%` }"></div></div>
            <span v-else class="stat__sub">no progress{{ jobStreams(j.kind, j.params) > 1 ? ` · ${jobStreams(j.kind, j.params)} streams` : "" }}</span>
            <span v-if="jobRowBytes(j) !== null" class="stat__sub">{{ jobRowBytes(j) }}</span>
          </div>
          <span class="jobrow__rate">{{ jobRowRate(j) ?? "—" }}</span>
          <span class="chip jobrow__chip" :class="j.cancelRequestedAt !== null ? 'chip--warn' : ''"><span class="dot dot--run" aria-hidden="true"></span>{{ j.cancelRequestedAt !== null ? "canceling" : j.status }}</span>
          <span class="row jobrow__actions" style="gap: 12px;">
            <button class="bs-link" @click="openJob(j.id)">Output</button>
            <button v-if="j.cancelRequestedAt === null" class="bs-link bs-link--thread" @click="confirmTransferCancel(j)">Cancel…</button>
          </span>
        </div>
      </div>
    </section>

    <p v-if="error" class="banner banner--warn">{{ error }}</p>
    <p v-else-if="loading && modelsPage === null" class="faint">loading…</p>

    <!-- Catalog: toolbar (bordered hybrid search + pressed filter chips + sort),
         IR-210 bulk selection, the hairline table and aria-current pagination. -->
    <section v-if="error === null && modelsPage !== null" class="card section-gap" aria-label="Catalog">
      <div class="card__body catalog-toolbar">
        <input
          v-model="search"
          class="input search"
          type="search"
          placeholder="Search name or repository…"
          aria-label="Search models"
          @input="onSearchInput"
        />
        <div class="row row--wrap" role="group" aria-label="Runtime filters" style="padding-bottom: 8px;">
          <button v-for="rt in RUNTIMES" :key="rt" class="bs-filter" :aria-pressed="runtimeSel.includes(rt)" @click="toggleRuntime(rt)">{{ rt }}</button>
        </div>
        <span class="grow"></span>
        <label class="visually-hidden" for="sort">Sort</label>
        <select id="sort" class="select sortsel" :value="sort" @change="onSortChange">
          <option value="recent">Recently added</option>
          <option value="name">Name A–Z</option>
        </select>
        <button class="btn btn--primary btn--sm" @click="downloadOpen = true">Download from HF…</button>
      </div>

      <!-- IR-210: bulk store-delete selection bar (catalog names, catalog-sourced bytes) -->
      <div v-if="bulkSelected.size > 0" class="row row--between bulkbar" role="status">
        <span class="stat__sub mono">{{ bulkSelected.size }} selected · {{ formatGiB(bulkBytes) }}</span>
        <span class="row" style="gap: 12px;">
          <button class="bs-link" @click="clearBulk">Clear</button>
          <button
            class="bs-link bs-link--thread"
            :disabled="storeNode === null || !bulkSupported"
            :title="bulkSupported ? undefined : 'the store node agent predates the batch kind (0.7.0) — update the agent first'"
            @click="confirmBulkDelete"
          >Delete selected…</button>
        </span>
      </div>
      <p v-if="bulkSelected.size > 0 && !bulkSupported && storeNode !== null" class="stat__sub faint bulkwarn">
        the store node agent predates the batch-delete kind — run an agent update on that node first.
      </p>

      <p v-if="modelsPage.models.length === 0" class="stat__sub faint catalog-empty">
        no models match — refresh the catalog from a model-ops node
      </p>
      <div v-else style="overflow-x: auto;">
        <table class="table">
          <thead>
            <tr>
              <th class="bulk-col">
                <input
                  type="checkbox"
                  class="bulk-check"
                  :checked="bulkAllSelected"
                  :aria-label="bulkAllSelected ? 'Deselect all models on this page' : 'Select all models on this page'"
                  @change="toggleBulkAll"
                />
              </th>
              <th>Model</th><th>Runtime</th><th class="num">Size</th><th>Added</th><th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in modelsPage.models" :key="m.name" class="is-clickable" @click="openModel(m.name)">
              <td class="bulk-col" @click.stop>
                <input
                  type="checkbox"
                  class="bulk-check"
                  :checked="bulkSelected.has(m.name)"
                  :aria-label="`Select ${m.name} for bulk delete`"
                  @change="toggleBulk(m.name)"
                />
              </td>
              <td>
                <strong>{{ m.name }}</strong>
                <div class="mono faint">{{ m.repository }}</div>
              </td>
              <td class="mono">{{ m.runtime }}</td>
              <td class="num mono">{{ formatGiB(m.bytes) }}</td>
              <td class="mono">{{ addedLabel(m.firstSeenAt) }}</td>
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
      </div>

      <div v-if="totalPages > 1" class="pagerow">
        <span class="stat__sub">{{ modelsPage.models.length }} of {{ modelsPage.total }} models · page {{ modelsPage.page }} / {{ totalPages }}</span>
        <div class="row" role="group" aria-label="Pagination">
          <button class="bs-filter" aria-label="Previous page" :disabled="page <= 1" @click="go(-1)">‹</button>
          <template v-for="(p, pi) in pageList" :key="`${pi}-${p}`">
            <span v-if="p === 0" class="stat__sub pagerow-gap" aria-hidden="true">…</span>
            <button v-else class="bs-filter" :aria-current="p === page ? 'page' : undefined" @click="goTo(p)">{{ p }}</button>
          </template>
          <button class="bs-filter" aria-label="Next page" :disabled="page >= totalPages" @click="go(1)">›</button>
        </div>
      </div>
    </section>

    <!-- IRI-014 download queue: adds always queue; the NAS drains when idle -->
    <section
      v-if="downloadQueueEntries.length > 0 || queueError !== null"
      class="card section-gap"
      aria-label="Download queue"
    >
      <div class="card__head">
        <h3>Download queue</h3>
        <span class="stat__sub faint">queued adds dispatch to the NAS store node when idle</span>
      </div>
      <div class="card__body">
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
      </div>
    </section>

    <!-- IRI-043 (option C): the primary drawer and the job sheet share ONE
         scrim — the sheet docks beside the drawer, nothing stacks. -->
    <div v-if="primaryOpen || job !== null" class="drawer-scrim" @click.self="closeTopMost">
      <div class="overlay-row">
        <section v-if="selected !== null" class="card drawer" aria-label="Model detail">
        <div class="card__head">
          <div class="row" style="min-width: 0;">
            <h3>{{ selected }}</h3>
            <span v-if="drawerRuntime !== null" class="chip">{{ drawerRuntime }}</span>
          </div>
          <button class="iconbtn" aria-label="Close details" @click="closeDetail">✕</button>
        </div>
        <p v-if="placementLoading" class="faint">loading placement…</p>
        <p v-else-if="placementError" class="banner banner--warn">{{ placementError }}</p>
        <template v-else-if="placement !== null">
          <dl class="kv">
            <dt>repo</dt><dd>{{ drawerRepo ?? "—" }}</dd>
            <dt>size</dt><dd>{{ formatGiB(placement.model.bytes) }}</dd>
            <dt v-if="drawerAdded !== null">added</dt><dd v-if="drawerAdded !== null">{{ drawerAdded }}</dd>
          </dl>
          <table class="table">
            <thead>
              <tr><th>Node</th><th>State</th><th></th></tr>
            </thead>
            <tbody>
              <tr v-for="row in placement.placements" :key="row.node.id">
                <td class="mono">{{ row.node.name }}<div class="stat__sub">{{ row.node.role }}</div></td>
                <td>
                  <span v-if="syncingPct.has(row.node.id)" class="chip chip--accent">syncing {{ syncingPct.get(row.node.id) !== null ? `${syncingPct.get(row.node.id)}%` : "…" }}</span>
                  <span v-else class="chip" :class="placementChip(row.action).cls">{{ placementChip(row.action).label }}</span>
                  <span v-if="row.action === 'push' && pushViaName(row.viaNodeIds)" class="mono faint"> via {{ pushViaName(row.viaNodeIds) }}</span>
                  <!-- IR-134: a push runs on the RELAY (viaNodeIds[0]), a
                       sync/delete on the node itself — the one-active-slot
                       holder for the DISPATCHING node is the real blocker,
                       so name it instead of letting the click 409. -->
                  <span v-if="dispatchBlocker(row)" class="mono faint" style="display: block;">{{ dispatchBlockerLabel(row) }}</span>
                  <span v-if="row.action === 'unavailable' && row.reason" class="stat__sub capacityline">
                    {{ row.reason }} ·
                    <button class="bs-link" @click="openCleanup(row.node.id)">clean up disk — run audit</button>
                  </span>
                </td>
                <td>
                  <button
                    v-if="row.action === 'sync'"
                    class="btn btn--secondary btn--sm"
                    :disabled="dispatchBlocker(row) !== null"
                    :title="dispatchBlocker(row) !== null ? dispatchBlockerLabel(row) : undefined"
                    @click="runJob(row.node.id, 'sync-local', { name: selected, root: undefined })"
                  >{{ dispatchBlocker(row) !== null ? "Busy" : "Sync" }}</button>
                  <!-- Warnings never block (SPEC): capacity/offline reasons are advisory. -->
                  <button
                    v-else-if="row.node.online && row.node.kind !== 'nas' && row.viaNodeIds.length > 0"
                    class="btn btn--secondary btn--sm"
                    :disabled="dispatchBlocker(row) !== null"
                    :title="dispatchBlocker(row) !== null ? dispatchBlockerLabel(row) : undefined"
                    @click="runJob(row.viaNodeIds[0]!, 'push', { name: selected, hosts: [row.node.cacheUser ? `${row.node.cacheUser}@${row.node.host}` : row.node.host], jobs: 4 })"
                  >{{ dispatchBlocker(row) !== null ? "Busy" : "Push" }}</button>
                  <button
                    v-else-if="row.node.kind === 'nas'"
                    class="bs-link bs-link--thread"
                    :disabled="dispatchBlocker(row) !== null"
                    :title="dispatchBlocker(row) !== null ? dispatchBlockerLabel(row) : undefined"
                    @click="selected !== null && startNasDelete(row.node.id, selected)"
                  >Delete from NAS…</button>
                </td>
              </tr>
            </tbody>
          </table>
          <p class="stat__sub faint">
            Sync/push jobs stream in the side sheet · deletes arm from the job sheet — dry-run plan first, then a typed apply
          </p>
          <details class="hygiene">
            <summary class="stat__sub">Store maintenance…</summary>
            <div class="row row--wrap" style="gap: 6px; margin-top: 8px">
              <template v-for="v in HYGIENE_VERBS" :key="v.kind">
                <button
                  v-if="storeNode !== null && v.destructive"
                  class="bs-link bs-link--thread"
                  @click="runHygiene(v.kind, v.perModel)"
                >{{ v.label }}</button>
                <button
                  v-else-if="storeNode !== null"
                  class="btn btn--secondary btn--sm"
                  @click="runHygiene(v.kind, v.perModel)"
                >{{ v.label }}</button>
              </template>
              <span class="stat__sub faint">doctor and audits cover the whole store; repair targets this model</span>
            </div>
          </details>
        </template>
      </section>

      <!-- Job output: docks as a sheet beside an open drawer (IRI-043 option C);
           standalone centered drawer when no primary is open. -->
      <aside v-if="job !== null" class="card" :class="primaryOpen ? 'sheet' : 'drawer'" aria-label="Job output">
        <div class="card__head">
          <h3>
            {{ job.job.kind }}
            <span class="chip" :class="jobStatusChip(job.job.status).cls">{{ jobStatusChip(job.job.status).label }}</span>
          </h3>
          <button class="iconbtn" aria-label="Close job output" @click="closeJob">✕</button>
        </div>
        <p v-if="jobContext !== null" class="stat__sub mono" style="margin: -8px 0 0;">{{ jobContext }}</p>
        <p v-if="jobError" class="banner banner--warn">{{ jobError }}</p>
        <p v-if="jobApplyName !== null && deleteSetupWarn?.name === jobApplyName" class="banner banner--warn">
          Setup "{{ deleteSetupWarn!.setup }}" serves this model — deleting breaks its next start (advisory, never blocks).
        </p>
        <p v-else-if="jobBulkDelete && deleteSetupWarn !== null" class="banner banner--warn">
          Serving setups reference selected models — deleting breaks their next start (advisory, never blocks): {{ deleteSetupWarn.setup }}.
        </p>
        <template v-if="sheetSummary !== null">
          <pre class="log joblog mono">{{ sheetSummary }}</pre>
          <details class="rawlog">
            <summary class="stat__sub">raw output — collapsed</summary>
            <pre class="log joblog mono">{{ job.output.map((o) => o.line).join("\n") || "no output yet…" }}</pre>
          </details>
          <p v-if="job.job.kind === 'download-queue'" class="stat__sub faint">summary from the download queue (IR 71 progress fields) · raw output stays in the job record</p>
          <p v-else class="stat__sub faint">hub-parsed transfer progress (IR-131) · raw output stays in the job record</p>
        </template>
        <pre v-else class="log joblog mono">{{ job.output.map((o) => o.line).join("\n") || "no output yet…" }}</pre>
        <div v-if="confirmState !== null && confirmState.host === 'job'" class="inline-confirm" role="alertdialog" :aria-label="confirmState.title">
          <p class="stat__sub" style="margin: 0 0 4px"><strong>{{ confirmState.title }}</strong></p>
          <p class="stat__sub" style="margin: 0 0 8px">{{ confirmState.body }}</p>
          <div class="row row--between">
            <span class="stat__sub faint">nothing destructive runs until you confirm</span>
            <span class="row" style="gap: 12px;">
              <button class="bs-link" @click="dismissConfirm">Cancel</button>
              <button class="bs-link bs-link--thread" :disabled="confirmBusy" @click="runConfirm">{{ confirmBusy ? "Working…" : confirmState.danger }}</button>
            </span>
          </div>
        </div>
        <!-- IR-222 armed delete: the dry-run plan settled — arm with a typed confirm. -->
        <div v-if="armJob !== null" class="inline-confirm" role="alertdialog" :aria-label="`Arm delete of ${armJob.name}`">
          <p class="stat__sub" style="margin: 0 0 4px"><strong>Plan settled — arm the delete?</strong></p>
          <p class="stat__sub" style="margin: 0 0 8px">The dry-run plan finished. Arming runs modelctl delete --apply --yes for {{ armJob.name }} — objects, references and staging leave the NAS store.</p>
          <div class="row" style="gap: 8px;">
            <input
              v-model="armName"
              class="input mono arm-input"
              type="text"
              :placeholder="`type ${armJob.name} to arm`"
              :aria-label="`Type ${armJob.name} to arm the delete`"
            />
            <button class="bs-link bs-link--thread" :disabled="armBusy || armName !== armJob.name" @click="runArmDelete">
              {{ armBusy ? "Deleting…" : "Delete from NAS (--apply --yes)" }}
            </button>
          </div>
        </div>
        <div v-if="job.job.status === 'running' || job.job.status === 'queued'" class="row row--between sheet__foot">
          <span class="faint">streaming…</span>
          <button class="bs-link bs-link--thread" @click="confirmDrawerCancel">Cancel job…</button>
        </div>
      </aside>

    <!-- Download from HF modal: ALWAYS queues via POST /downloads; server picks the NAS-preferred store node.
         IRI-016: per-row quantization/mtp + expand-quants. IRI-043: lives on the shared scrim; job output docks beside it. -->
    <section v-if="downloadOpen" class="card drawer dl-drawer" aria-label="Download from Hugging Face">
        <div class="card__head">
          <h3>Download from HF to NAS</h3>
          <button class="iconbtn" aria-label="Close download modal" @click="downloadOpen = false">✕</button>
        </div>
        <p v-if="storeNode === null" class="banner banner--warn">
          No online model-ops node (node with the NAS root mounted) — adds queue until one is online.
        </p>
        <div class="field">
          <label for="dl-paste">Hugging Face repos — one owner/model per line (# comments ignored)</label>
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
          <span class="label">Downloads to queue ({{ downloadRows.length }})</span>
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
                        <div class="row row--wrap" style="gap: 12px;">
                          <button class="bs-link" @click="expandSelected = new Set(expandListing.quants.filter((q) => !q.ambiguous).map((q) => q.tag))">All</button>
                          <button class="bs-link" @click="expandSelected = new Set()">None</button>
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
                          <label for="dl-mtp">MTP draft (companion)</label>
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
                        <div class="row" style="gap: 12px;">
                          <button class="btn btn--secondary btn--sm" :disabled="expandAddable === 0" @click="applyExpand">
                            Add {{ expandAddable }} row{{ expandAddable === 1 ? "" : "s" }}
                          </button>
                          <button class="bs-link" @click="closeExpand">Cancel</button>
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
          <label for="dl-jobs">Parallel jobs</label>
          <input id="dl-jobs" v-model.number="downloadJobs" class="input" type="number" min="1" max="16" />
        </div>
        <p v-if="downloadError" class="banner banner--warn">{{ downloadError }}</p>
        <p v-if="downloadRows.length > 0" class="banner dl-preflight">
          <span class="stat__sub">
            preflight: {{ downloadRows.length }} entr{{ downloadRows.length === 1 ? "y" : "ies" }} · ONE download-queue batch ·
            dispatched to {{ storeNodeInfo?.name ?? "the store node" }} when idle · resumable staging · companion files included
          </span>
        </p>
        <div class="row row--between">
          <span class="stat__sub faint">Always queued · dispatched to the NAS when idle · resumable · companion files included</span>
          <button class="btn btn--primary btn--sm" :disabled="downloadBusy || downloadRows.length === 0" @click="submitDownload">
            {{ downloadBusy ? "Queueing…" : downloadRows.length > 0 ? `Add ${downloadRows.length} to queue` : "Add to queue" }}
          </button>
        </div>
      </section>
      </div>
    </div>

    <!-- IRI-020: per-row actions menu (catalog + queue); closes on any outside click -->
    <div v-if="rowMenu !== null" class="rowpop" role="menu" :aria-label="`Actions for ${rowMenu.name}`" :style="{ top: `${rowMenu.y}px`, left: `${rowMenu.x}px` }">
      <button v-for="it in rowMenuItems" :key="it.act" class="menu-item" :class="{ 'menu-item--thread': isRowMenuDanger(it.act) }" @click="runRowMenu(it.act)">{{ it.label }}</button>
    </div>

    <!-- IRI-020: shared confirmation for destructive actions with no drawer
         open (queue + catalog rows); drawer-hosted confirms render inline. -->
    <div v-if="confirmState !== null && confirmState.host === undefined" class="drawer-scrim" @click.self="dismissConfirm">
      <section class="card confirm-card" role="alertdialog" aria-modal="true" :aria-label="confirmState.title">
        <div class="card__head">
          <h3>{{ confirmState.title }}</h3>
          <button class="iconbtn" aria-label="Close confirm" @click="dismissConfirm">✕</button>
        </div>
        <p class="stat__sub" style="margin: 0">{{ confirmState.body }}</p>
        <ul v-if="confirmState.list !== undefined" class="confirm-list">
          <li v-for="n in confirmState.list" :key="n" class="mono">{{ n }}</li>
        </ul>
        <div class="row row--between">
          <span class="stat__sub faint">nothing destructive runs until you confirm</span>
          <div class="row" style="gap: 12px;">
            <button class="btn btn--secondary btn--sm" @click="dismissConfirm">Cancel</button>
            <button class="bs-link bs-link--thread" :disabled="confirmBusy" @click="runConfirm">{{ confirmBusy ? "Working…" : confirmState.danger }}</button>
          </div>
        </div>
      </section>
    </div>
  </div>

  <!-- IRI-082: curated recipes (SparkRun + MiaAI) — install drafts a setup, never auto-starts -->
  <section class="card section-gap">
    <div class="card__head"><h3>Recipes</h3><span class="chip">curated</span></div>
    <div class="card__body">
      <div v-for="r in recipes" :key="r.slug" class="row" style="align-items: flex-start; gap: 10px; padding: 6px 0;">
        <div style="min-width: 0; flex: 1;">
          <strong>{{ r.name }}</strong>
          <span class="chip" style="margin-left: 8px;">{{ r.engine }}</span>
          <span class="chip" :class="r.copyleft ? 'chip--warn' : ''" style="margin-left: 4px;">{{ r.license }}</span>
          <span v-if="r.kind === 'sparkrun-transpiled'" class="chip" style="margin-left: 4px;">transpiled</span>
          <div class="muted">{{ r.summary }}</div>
          <div class="mono faint">{{ r.upstreamUrl }} @ {{ r.commitSha.slice(0, 8) }}</div>
          <div v-if="r.nodeCountMax > 1" class="faint">cluster: {{ r.nodeCountMin }}–{{ r.nodeCountMax }} nodes</div>
        </div>
        <button class="btn btn--secondary btn--sm" :disabled="recipeBusy === r.slug" @click="installRecipeCard(r)">{{ recipeBusy === r.slug ? "staging…" : "Install" }}</button>
      </div>
      <p v-if="recipes.length === 0" class="muted">catalog empty (unpinned entries stay hidden until the pin pass lands)</p>
      <p v-if="recipeDraft !== null" class="banner banner--ok">{{ recipeDraft.text }}</p>
      <details class="muted" style="margin-top: 8px;">
        <summary>Recipe caveats (apply to every card)</summary>
        <ul style="margin: 6px 0 0 16px;">
          <li v-for="c in RECIPE_CAVEATS" :key="c.id">{{ c.text }}</li>
        </ul>
      </details>
    </div>
  </section>

  <!-- IR-222: "clean up disk — run audit" opens the shared per-node drawer
       (typed confirms live inside it, never dispatched from the link). -->
  <CleanupDrawer v-if="cleanupNode !== null" :node-id="cleanupNode.id" :node-name="cleanupNode.name" @close="cleanupNode = null" />

  <!-- IR-222: v1.1 refresh-note — live status, catalog size, jobs stream. -->
  <footer class="refresh-note" aria-label="Refresh status">
    <span class="dot dot--run" aria-hidden="true"></span>
    <span>{{ refreshNoteText }}</span>
  </footer>
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
  background: var(--overlay);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  z-index: 40;
}
.drawer {
  width: min(760px, 100%);
  max-height: 86vh;
  overflow: auto;
  padding: 14px;
}
/* Surface/typography come from the shared .log (force-dark console); this
   only caps the height and wraps long lines. */
.joblog {
  max-height: 40vh;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
.num {
  text-align: right;
}

/* ── IR-222 v1.1 page surfaces ─────────────────────────────────────── */
/* Store strip: compact card body, mockup storebarrow (narrow middle column
 * so 320px never overflows — PLAN.md gotcha). */
.strip__body {
  padding: 12px 18px;
}
.storebarrow {
  grid-template-columns: 52px minmax(0, 140px) auto;
}
/* Store-health popover (v1.1 paper-2 surface, explicit width — never
 * shrink-to-fit); opens under the button, closes on outside press/Escape. */
.popover {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  width: 380px;
  max-width: 80vw;
  z-index: 45;
  padding: 16px;
  background: var(--paper-2);
  border: 1px solid var(--rule-2);
  border-radius: var(--radius-panel);
  animation: pop-rise var(--dur-ui) var(--ease-out);
}
@keyframes pop-rise {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .popover { animation: none; }
}

/* Jobs rows (mockup .jobrow grid on hub data). */
.jobrows {
  display: flex;
  flex-direction: column;
}
.jobrow {
  display: grid;
  grid-template-columns: 14px minmax(0, 1.1fr) minmax(180px, 1fr) auto auto auto;
  gap: 12px;
  align-items: center;
  padding: 12px 18px;
  border-top: 1px solid var(--rule);
}
.jobrow:first-child {
  border-top: 0;
}
.jobrow__main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.jobrow__name {
  min-width: 0;
  font-size: var(--fs-ui);
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.jobrow__target {
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-data-sm);
  color: var(--ink-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.jobrow__bar {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.jobrow__rate {
  font-family: var(--font-mono);
  font-size: var(--fs-data-sm);
  color: var(--ink-2);
  white-space: nowrap;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.jobrow__chip {
  justify-self: start;
}

/* Catalog toolbar (bordered hybrid search + chips + sort) and pagerow. */
.catalog-toolbar {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  flex-wrap: wrap;
  padding-bottom: 12px;
}
.catalog-toolbar .search {
  flex: 1 1 240px;
  max-width: 320px;
}
.sortsel {
  width: auto;
  min-width: 170px;
  min-height: 44px;
}
.pagerow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 18px 14px;
}
/* aria-current page button reads as the pressed chip: ink ring via a real
   border (inset rings live in the shared stylesheet only, never here). */
.pagerow .bs-filter[aria-current="page"] {
  border: 1.5px solid var(--ink);
  padding: 0 10.5px;
  color: var(--ink);
}
.pagerow-gap {
  padding: 0 2px;
}
.catalog-empty {
  margin: 0;
  padding: 0 18px 14px;
}
.capacityline {
  display: block;
}
.arm-input {
  max-width: 280px;
}
/* Destructive links stay tappable when blocked (dispatch/agent guards). */
.bs-link:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

/* ≤900 tier: the jobrow drops its bar/rate columns and the toolbar wraps. */
html[data-tier="small"] .jobrow {
  grid-template-columns: 14px minmax(0, 1fr) auto;
  padding: 10px 12px;
}
html[data-tier="small"] .jobrow__bar,
html[data-tier="small"] .jobrow__rate {
  display: none;
}
html[data-tier="small"] .storebarrow {
  grid-template-columns: 46px minmax(0, 110px) auto;
}
html[data-tier="small"] .catalog-toolbar {
  gap: 8px;
}
html[data-tier="small"] .catalog-toolbar .search {
  min-width: 0;
  flex-basis: 100%;
  max-width: none;
}
html[data-tier="small"] .sortsel {
  min-width: 0;
  flex: 1;
}
html[data-tier="small"] .pagerow {
  padding: 8px 12px 12px;
}
html[data-tier="small"] .bulkbar {
  padding: 8px 12px;
}
html[data-tier="small"] .catalog-empty {
  padding: 0 12px 12px;
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
  height: 6px;
  border-radius: var(--radius-control);
  background: var(--border);
  overflow: hidden;
}
.dlbar__fill {
  height: 100%;
  border-radius: var(--radius-control);
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
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-panel);
}
.rowpop .menu-item {
  display: block;
  width: 100%;
  padding: 8px 10px;
  border: 0;
  background: none;
  text-align: left;
  font: 400 var(--fs-ui)/1.3 var(--font-sans);
  color: var(--ink-2);
  cursor: pointer;
}
.rowpop .menu-item:hover {
  background: var(--surface-2);
  color: var(--ink);
}
.rowpop .menu-item--thread {
  color: var(--thread-ink);
}
.rowpop .menu-item--thread:hover {
  background: none;
  color: var(--thread-ink);
  text-decoration: underline;
}
.confirm-card {
  width: min(520px, 92vw);
  max-height: 86vh;
  overflow: auto;
  padding: 14px;
  display: grid;
  gap: 12px;
}

/* IR-210: bulk store-delete selection bar, per-row checkboxes, and the
   confirm modal's scrollable name list. The bar sits between the toolbar and
   the table inside the catalog card — a thread band, no radius. */
.bulkbar {
  margin: 0;
  padding: 8px 18px;
  border-top: 1px solid var(--thread);
  border-bottom: 1px solid var(--thread);
  background: var(--thread-wash);
}
.bulkwarn {
  margin: 0;
  padding: 8px 18px 0;
}
.bulk-col {
  width: 28px;
}
.bulk-check {
  accent-color: var(--accent);
}
.confirm-list {
  margin: 0;
  max-height: 180px;
  overflow: auto;
  padding-left: 20px;
  font-size: 12px;
  line-height: 1.5;
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
  background: var(--paper-2);
  color: var(--ink-2);
  border: 1px solid var(--rule-2);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  font-family: var(--font-mono);
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

/* IRI-043 (option C): one scrim hosts the primary drawer and the job sheet —
   the sheet docks right (flex order last) instead of stacking a second modal. */
.overlay-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  width: 100%;
  padding: 0 16px;
  pointer-events: none;
}
.overlay-row > * {
  pointer-events: auto;
}
.overlay-row > .drawer {
  flex: 0 1 760px;
}
.overlay-row .sheet {
  order: 2;
  flex: 0 1 430px;
  min-width: 300px;
  max-height: 86vh;
  overflow: auto;
  padding: 14px;
  display: flex;
  flex-direction: column;
}
.sheet .joblog {
  flex: 1 1 auto;
}
.sheet__foot {
  padding-top: 8px;
}
.inline-confirm {
  border: 1px solid var(--thread);
  background: var(--thread-wash);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  margin-top: 12px;
}
@media (max-width: 1100px) {
  .overlay-row > .drawer {
    flex-basis: 540px;
  }
  .overlay-row .sheet {
    flex-basis: 380px;
    min-width: 260px;
  }
}
@media (max-width: 720px) {
  .overlay-row {
    flex-direction: column;
    gap: 10px;
    padding: 0 10px;
  }
  .overlay-row > .drawer,
  .overlay-row .sheet {
    flex: none;
    width: 100%;
    max-height: 44vh;
  }
}
</style>
