<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  cancelJob,
  createJob,
  fetchJob,
  fetchModelsPage,
  fetchPlacement,
  formatGiB,
  jobStatusChip,
  placementChip,
  type JobDetail,
  type JobView,
  type ModelsPage,
  type PlacementResponse,
} from "../models";

const search = ref("");
const page = ref(1);
const modelsPage = ref<ModelsPage | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

/** Selected model name → placement view. */
const selected = ref<string | null>(null);
const placement = ref<PlacementResponse | null>(null);
const placementLoading = ref(false);
const placementError = ref<string | null>(null);

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
    const result = await fetchModelsPage(page.value, search.value);
    if (seq !== loadSeq) return;
    modelsPage.value = result;
  } catch (err) {
    if (seq !== loadSeq) return;
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    if (seq === loadSeq) loading.value = false;
  }
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

async function openModel(name: string): Promise<void> {
  selected.value = name;
  placement.value = null;
  placementError.value = null;
  placementLoading.value = true;
  try {
    placement.value = await fetchPlacement(name);
  } catch (err) {
    placementError.value = err instanceof Error ? err.message : String(err);
  } finally {
    placementLoading.value = false;
  }
}

function closeDetail(): void {
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

async function openJob(id: string): Promise<void> {
  clearInterval(jobPoll);
  try {
    job.value = await fetchJob(id);
  } catch (err) {
    jobError.value = err instanceof Error ? err.message : String(err);
    return;
  }
  jobPoll = setInterval(async () => {
    if (job.value === null) return;
    if (job.value.job.status === "succeeded" || job.value.job.status === "failed" || job.value.job.status === "canceled") {
      clearInterval(jobPoll);
      return;
    }
    try {
      job.value = await fetchJob(job.value.job.id);
    } catch {
      clearInterval(jobPoll);
    }
  }, 2000);
}

function closeJob(): void {
  clearInterval(jobPoll);
  job.value = null;
  jobError.value = null;
}

onMounted(() => void load());
onBeforeUnmount(() => {
  clearTimeout(debounce);
  clearInterval(jobPoll);
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
      <span v-if="modelsPage" class="mono faint">{{ modelsPage.total }} models</span>
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
                  <button
                    v-else-if="row.action === 'push'"
                    class="btn btn--secondary btn--sm"
                    @click="runJob(row.node.id, 'push', { name: selected, hosts: row.viaNodeIds, jobs: 4 })"
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
