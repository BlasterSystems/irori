<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { fetchNodes } from "../api";
import { pickStoreNode, type NodeInfo } from "@irori/core";
import {
  cancelJob,
  createJob,
  downloadStatusChip,
  enqueueDownload,
  enqueueDownloadsBatch,
  fetchDownloadQueue,
  fetchJob,
  fetchModelsPage,
  fetchPlacement,
  formatGiB,
  jobStatusChip,
  placementChip,
  removeDownload,
  retryDownload,
  type DownloadQueueEntry,
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
 * parses into editable rows (source + optional store name). Submit sends ONE
 * batch (`POST /downloads {downloads, jobs}`; a single row uses the
 * single-entry shape) — the server always queues and drains them as one
 * `download-queue` batch on the store node when it is idle.
 */
const downloadPaste = ref("");
let rowIdCounter = 0;
const downloadRows = ref<Array<{ id: number; source: string; name: string }>>([]);

function parsePaste(): void {
  const seen = new Set(downloadRows.value.map((r) => r.source.trim().toLowerCase()));
  for (const raw of downloadPaste.value.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rowIdCounter += 1;
    downloadRows.value.push({ id: rowIdCounter, source: line, name: "" });
  }
  downloadPaste.value = "";
}

function removeRow(index: number): void {
  downloadRows.value.splice(index, 1);
}

async function submitDownload(): Promise<void> {
  const rows = downloadRows.value
    .map((r) => ({ source: r.source.trim(), name: r.name.trim() }))
    .filter((r) => r.source.length > 0);
  if (rows.length === 0) return;
  downloadBusy.value = true;
  downloadError.value = null;
  let entries: DownloadQueueEntry[];
  try {
    if (rows.length === 1) {
      entries = [await enqueueDownload({ source: rows[0]!.source, name: rows[0]!.name || undefined, jobs: downloadJobs.value })];
    } else {
      entries = await enqueueDownloadsBatch({
        downloads: rows.map((r) => ({ source: r.source, name: r.name || undefined })),
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

async function retryEntry(id: string): Promise<void> {
  try {
    const entry = await retryDownload(id);
    await refreshQueue();
    if (entry.status === "running" && entry.jobId !== null) await openJob(entry.jobId);
  } catch (err) {
    queueError.value = err instanceof Error ? err.message : String(err);
  }
}

function openBatch(jobId: string): void {
  void openJob(jobId);
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
  placementLoading.value = true;
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
      void refreshQueue(); // a settled download batch changes the queue rows
      return;
    }
    const pollSeq = jobSeq;
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
  clearTimeout(debounce);
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

    <table v-else-if="modelsPage !== null" class="hytable">
      <thead>
        <tr>
          <th>Name</th><th>Runtime</th><th>Repository</th><th class="num">Size</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="m in modelsPage.models" :key="m.name" class="is-clickable" @click="openModel(m.name)">
          <td class="mono">{{ m.name }}</td>
          <td><span class="chip">{{ m.runtime }}</span></td>
          <td class="mono faint">{{ m.repository }}</td>
          <td class="num mono">{{ formatGiB(m.bytes) }}</td>
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
      <table v-if="downloadQueueEntries.length > 0" class="hytable">
        <thead>
          <tr><th>Model</th><th>Status</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="e in downloadQueueEntries" :key="e.id">
            <td class="mono">{{ e.name }} <span class="mono faint">· {{ e.source }}</span></td>
            <td>
              <span class="chip" :class="downloadStatusChip(e.status).cls">{{ downloadStatusChip(e.status).label }}</span>
              <span v-if="e.error" class="mono faint"> {{ e.error }}</span>
            </td>
            <td class="num">
              <button v-if="e.jobId !== null" class="btn btn--secondary btn--sm" @click="openBatch(e.jobId)">Job</button>
              <button
                v-if="e.status === 'failed' || e.status === 'canceled'"
                class="btn btn--secondary btn--sm"
                @click="retryEntry(e.id)"
              >Retry</button>
              <button v-if="e.status !== 'running'" class="btn btn--ghost btn--sm" @click="removeEntry(e.id)">Remove</button>
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
          <table class="hytable">
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
                    @click="runJob(row.node.id, 'nas-delete', { name: selected })"
                  >Delete (dry run)</button>
                </td>
              </tr>
            </tbody>
          </table>
          <p class="stat__sub faint">
            Sync/push jobs stream output below · destructive deletes are armed via a second apply job
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
        <pre class="joblog mono">{{ job.output.map((o) => o.line).join("\n") || "no output yet…" }}</pre>
        <div v-if="job.job.status === 'running' || job.job.status === 'queued'" class="row row--between">
          <span class="faint">streaming…</span>
          <button class="btn btn--danger btn--sm" @click="cancelJob(job.job.id)">Cancel job</button>
        </div>
      </section>
    </div>

    <!-- Download from HF modal: ALWAYS queues via POST /downloads; server picks the NAS-preferred store node -->
    <div v-if="downloadOpen" class="drawer-scrim" @click.self="downloadOpen = false">
      <section class="card drawer" aria-label="Download from Hugging Face">
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
            placeholder="unsloth/GLM-5.3-Flash-EXL3&#10;zai-org/Second-Model"
          ></textarea>
          <button class="btn btn--secondary btn--sm" style="margin-top: 6px" :disabled="downloadPaste.trim().length === 0" @click="parsePaste">
            Parse rows
          </button>
        </div>
        <div class="field">
          <span class="stat__sub">Downloads to queue ({{ downloadRows.length }})</span>
          <p v-if="downloadRows.length === 0" class="stat__sub faint" style="margin: 4px 0 0">
            Nothing parsed yet — paste repos above and parse, then tweak names before queueing.
          </p>
          <table v-else class="hytable" style="margin-top: 4px">
            <thead>
              <tr><th>Hugging Face repo</th><th>Store name (optional)</th><th></th></tr>
            </thead>
            <tbody>
              <tr v-for="(row, index) in downloadRows" :key="row.id">
                <td><input v-model="row.source" class="input mono" type="text" :aria-label="`Repo ${index + 1}`" /></td>
                <td><input v-model="row.name" class="input mono" type="text" :placeholder="row.source.split('/').pop() || ''" :aria-label="`Store name ${index + 1}`" /></td>
                <td><button class="btn btn--ghost btn--sm" :aria-label="`Remove ${row.source}`" @click="removeRow(index)">✕</button></td>
              </tr>
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
            {{ downloadBusy ? "Queueing…" : `Add ${downloadRows.length} to queue` }}
          </button>
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
@media (min-width: 721px) {
  .drawer-scrim {
    align-items: center;
  }
}
</style>
