<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { live } from "../live";
import { cancelJob, fetchJob, jobStatusChip, type JobDetail } from "../models";
import { isActiveJob, jobElapsed, sortJobs, type JobLive } from "../jobs";
import { vScrimClose } from "../scrim";

/**
 * Global job activity (IRI-028): every job across the fleet, live. Seeded
 * from GET /api/v1/jobs and kept current by the SSE `job` / `job-progress`
 * frames, so leaving the modal that started a download never loses its log.
 */

const emit = defineEmits<{ close: [] }>();

const rows = computed<JobLive[]>(() => sortJobs([...live.jobs.values()]));
const openId = ref<string | null>(null);
const detail = ref<JobDetail | null>(null);
const error = ref<string | null>(null);
const busy = ref(false);
const nowMs = ref(Date.now());
let poll: ReturnType<typeof setInterval> | undefined;
let tick: ReturnType<typeof setInterval> | undefined;
let disposed = false;

function nodeName(nodeId: string): string {
  return live.nodes.get(nodeId)?.name ?? nodeId.slice(0, 8);
}

function elapsed(job: JobLive): string {
  return jobElapsed(job, nowMs.value);
}

function closeDetail(): void {
  openId.value = null;
  detail.value = null;
  error.value = null;
  clearInterval(poll);
  poll = undefined;
}

async function loadDetail(id: string): Promise<void> {
  try {
    const next = await fetchJob(id);
    if (!disposed && openId.value === id) detail.value = next;
  } catch (err) {
    if (!disposed && openId.value === id) error.value = err instanceof Error ? err.message : String(err);
  }
}

function toggle(id: string): void {
  if (openId.value === id) {
    closeDetail();
    return;
  }
  openId.value = id;
  detail.value = null;
  error.value = null;
  clearInterval(poll);
  void loadDetail(id);
  poll = setInterval(() => {
    const job = live.jobs.get(id);
    if (job === undefined || !isActiveJob(job)) {
      clearInterval(poll);
      poll = undefined;
      return;
    }
    void loadDetail(id);
  }, 2000);
}

async function cancel(id: string): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await cancelJob(id);
    await live.refreshJobs();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

/** Live tail for the expanded job: fetched ring + the newest SSE line. */
const outputLines = computed<string[]>(() => {
  const job = openId.value === null ? null : live.jobs.get(openId.value);
  const lines = detail.value?.output.map((line) => line.line) ?? [];
  if (job?.lastLine != null && lines.at(-1) !== job.lastLine) lines.push(job.lastLine);
  return lines.slice(-200);
});

watch(
  () => rows.value.map((job) => `${job.id}:${job.status}`).join("|"),
  () => {
    if (openId.value !== null) {
      const job = live.jobs.get(openId.value);
      if (job !== undefined && !isActiveJob(job)) {
        void loadDetail(openId.value);
        clearInterval(poll);
        poll = undefined;
      }
    }
  },
);

void live.refreshJobs();
tick = setInterval(() => (nowMs.value = Date.now()), 1000);

onBeforeUnmount(() => {
  disposed = true;
  clearInterval(poll);
  clearInterval(tick);
});
</script>

<template>
  <div class="drawer-scrim" v-scrim-close="() => emit('close')">
    <aside class="drawer is-open" role="dialog" aria-label="Job activity">
      <div class="row row--between" style="margin-bottom: 10px">
        <div class="row">
          <h3 style="font-size: 17px">Activity</h3>
          <span class="chip">{{ rows.length }} jobs</span>
          <span v-if="live.runningJobs.value > 0" class="chip chip--accent">{{ live.runningJobs.value }} running</span>
        </div>
        <button class="iconbtn" aria-label="Close activity" @click="emit('close')">✕</button>
      </div>

      <p class="stat__sub" style="margin-bottom: 10px;">
        Every job across the fleet — one active per node. Output streams here while the job runs;
        the last 400 lines stay available after it settles.
      </p>

      <p v-if="error" class="banner banner--warn">{{ error }}</p>
      <p v-if="rows.length === 0" class="muted">no jobs yet</p>

      <div v-else class="stack" style="gap: 6px">
        <div v-for="job in rows" :key="job.id" class="activity-row" :class="{ 'is-open': openId === job.id }">
          <button class="activity-head" :aria-expanded="openId === job.id" @click="toggle(job.id)">
            <span class="row" style="gap: 8px; flex-wrap: wrap;">
              <span class="chip">{{ nodeName(job.nodeId) }}</span>
              <span class="mono">{{ job.kind }}</span>
              <span class="chip" :class="jobStatusChip(job.status).cls">{{ jobStatusChip(job.status).label }}</span>
              <span class="stat__sub faint">{{ elapsed(job) }}</span>
            </span>
            <span class="activity-tail mono faint">{{ job.lastLine ?? "no output yet…" }}</span>
          </button>
          <div v-if="openId === job.id" class="activity-body">
            <pre class="activity-log mono">{{ outputLines.join("\n") || "no output yet…" }}</pre>
            <div class="row row--between">
              <span class="stat__sub faint">job {{ job.id.slice(0, 8) }}</span>
              <button
                v-if="isActiveJob(job)"
                class="btn btn--danger btn--sm"
                :disabled="busy"
                @click="cancel(job.id)"
              >Cancel job</button>
            </div>
          </div>
        </div>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.activity-row {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}
.activity-row.is-open {
  border-color: var(--ink);
}
.activity-head {
  display: grid;
  gap: 4px;
  width: 100%;
  padding: 8px 10px;
  text-align: left;
  background: var(--surface-2);
  border: 0;
  cursor: pointer;
  color: inherit;
  font: inherit;
}
.activity-tail {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.activity-body {
  padding: 10px;
  display: grid;
  gap: 8px;
}
.activity-log {
  margin: 0;
  max-height: 260px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 11.5px;
}
</style>
