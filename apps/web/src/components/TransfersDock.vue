<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { live } from "../live";
import { cancelJob } from "../models";
import { jobElapsed, jobLabel, jobStreams, type JobLive } from "../jobs";
import { formatEta } from "../models";
import { fmtBytes } from "../analytics";

/** IR-131 shape B: the cross-page transfers dock (IRI-048 scene B) — the
 *  Telemetry-drawer idiom. Re-seeds from GET /api/v1/jobs on open (survives
 *  reload), then follows the SSE-updated live.jobs map. Rows show parsed
 *  progress when the hub could parse it and an explicit "no progress"
 *  state otherwise — never a misleading fraction of one rsync stream. */
const emit = defineEmits<{ close: [] }>();

onMounted(() => {
  void live.refreshJobs(); // reload/reopen re-seed
});

const active = computed(() =>
  [...live.jobs.values()]
    .filter((j) => j.status === "queued" || j.status === "running")
    .sort((a, b) => Date.parse(b.startedAt ?? b.createdAt) - Date.parse(a.startedAt ?? a.createdAt)),
);
const recent = computed(() =>
  [...live.jobs.values()]
    .filter((j) => j.status !== "queued" && j.status !== "running")
    .sort((a, b) => Date.parse(b.finishedAt ?? b.createdAt) - Date.parse(a.finishedAt ?? a.createdAt))
    .slice(0, 12),
);

const now = ref(Date.now());
const tick = setInterval(() => {
  now.value = Date.now();
}, 1000);
onUnmounted(() => clearInterval(tick));

const KIND_CHIP: Record<string, string> = { "sync-local": "sync", push: "push", "download-queue": "queue" };

function chipLabel(job: JobLive): string {
  if (job.status === "queued") return "queued";
  if (job.cancelRequestedAt !== null) return "canceling";
  return KIND_CHIP[job.kind] ?? job.kind;
}
function chipClass(job: JobLive): string {
  if (job.cancelRequestedAt !== null) return "chip--warn";
  return "chip--ok";
}
function modelName(job: JobLive): string {
  const label = jobLabel(job.params);
  return label.length > 0 ? label.slice(1) : job.kind;
}
function routeText(job: JobLive): string {
  const node = live.nodes.get(job.nodeId)?.name ?? "node";
  const streams = jobStreams(job.kind, job.params);
  const streamsText = job.kind === "sync-local" || job.kind === "push" ? ` · ${streams} stream${streams === 1 ? "" : "s"}` : "";
  return `${node}${streamsText} · #${job.id.slice(0, 4)}`;
}
function progressText(job: JobLive): string | null {
  const p = job.progress;
  if (p === null || p === undefined || p.percent === null) return null;
  const segs: string[] = [];
  if (p.bytes !== null) segs.push(fmtBytes(p.bytes));
  if (p.rateBytesPerSec !== null && p.rateBytesPerSec > 0) segs.push(`${fmtBytes(p.rateBytesPerSec)}/s`);
  return segs.join(" · ") || null;
}
function etaText(job: JobLive): string | null {
  const eta = job.progress?.etaSeconds;
  return typeof eta === "number" ? `~${formatEta(eta)}` : null;
}
const cancelArmId = ref<string | null>(null);
const cancelBusy = ref(false);
const cancelError = ref<string | null>(null);

function armCancel(job: JobLive): void {
  cancelError.value = null;
  cancelArmId.value = job.id;
}
function disarmCancel(): void {
  if (!cancelBusy.value) cancelArmId.value = null;
}
async function runCancel(job: JobLive): Promise<void> {
  cancelBusy.value = true;
  cancelError.value = null;
  try {
    await cancelJob(job.id);
    cancelArmId.value = null;
    await live.refreshJobs();
  } catch (err) {
    // Honest failure: a 409 (offline / already canceling) surfaces verbatim —
    // the process may still be running, so the row stays.
    cancelError.value = err instanceof Error ? err.message : String(err);
  } finally {
    cancelBusy.value = false;
  }
}
</script>

<template>
  <aside class="dock" role="dialog" aria-label="Transfers">
    <div class="dock-head">
      <h3>Transfers</h3>
      <span class="chip" :class="live.connected.value ? 'chip--ok' : 'chip--warn'">
        <span :class="live.connected.value ? 'pulse' : 'dot dot--warn'" aria-hidden="true"></span>
        {{ live.connected.value ? "live" : "offline" }}
      </span>
      <button class="btn btn--ghost btn--sm" aria-label="Close transfers" @click="emit('close')">✕</button>
    </div>
    <div class="dock-body">
      <div v-if="active.length > 0" class="xsub"><span class="label">Active · {{ active.length }}</span></div>
      <div v-for="job in active" :key="job.id" class="dockrow">
        <div class="dockrow-top">
          <span class="chip" :class="chipClass(job)" style="flex: none;">
            <span :class="job.status === 'running' && job.cancelRequestedAt === null ? 'dot dot--run' : 'dot dot--warn'" aria-hidden="true"></span> {{ chipLabel(job) }}
          </span>
          <span class="xmodel">{{ modelName(job) }}</span>
          <button v-if="job.cancelRequestedAt === null" class="btn btn--danger btn--sm" @click="armCancel(job)">Cancel…</button>
        </div>
        <div class="dockrow-route">{{ routeText(job) }}</div>
        <div v-if="job.progress?.percent !== null && job.progress?.percent !== undefined" class="bar dockrow-bar">
          <div class="bar__fill" :style="{ width: `${job.progress.percent}%` }"></div>
        </div>
        <p v-if="job.progress?.percent === null || job.progress?.percent === undefined" class="stat__sub dockrow-noprogress">no progress available{{ jobStreams(job.kind, job.params) > 1 ? ` (${jobStreams(job.kind, job.params)} streams)` : job.kind === "download-queue" ? " (batch)" : "" }}</p>
        <div class="dockrow-meta">
          <span>{{ progressText(job) ?? "—" }}</span>
          <span>{{ [etaText(job), jobElapsed(job, now)].filter((s) => s !== null).join(" · ") }}</span>
        </div>
        <div v-if="cancelArmId === job.id" class="dconfirm" role="alertdialog" aria-label="Cancel transfer">
          <p class="stat__sub" style="margin: 0 0 6px">
            Cancel this {{ job.kind }}? Whatever it already wrote stays as resumable staging{{ job.kind === "push" ? " on the destinations" : "" }}.
          </p>
          <p v-if="cancelError !== null" class="stat__sub" style="margin: 0 0 6px; color: var(--thread-ink);">{{ cancelError }}</p>
          <div class="row" style="justify-content: flex-end; gap: 8px;">
            <button class="btn btn--ghost btn--sm" @click="disarmCancel">Keep running</button>
            <button class="btn btn--danger btn--sm" :disabled="cancelBusy" @click="runCancel(job)">{{ cancelBusy ? "Stopping…" : "Cancel transfer" }}</button>
          </div>
        </div>
      </div>
      <p v-if="active.length === 0" class="dockrow dockrow-empty">no active transfers</p>
      <template v-if="recent.length > 0">
        <div class="xsub"><span class="label">Earlier</span></div>
        <div v-for="job in recent" :key="job.id" class="dockrow">
          <div class="dockrow-top">
            <span class="chip" :class="job.status === 'succeeded' ? 'chip--ok' : job.status === 'canceled' ? '' : 'chip--warn'" style="flex: none;">
              <span :class="job.status === 'succeeded' ? 'dot dot--ok' : 'dot dot--halt'" aria-hidden="true"></span> {{ job.status }}
            </span>
            <span class="xmodel">{{ modelName(job) }}</span>
          </div>
          <div class="dockrow-route">{{ routeText(job) }} · {{ jobElapsed(job, now) }}</div>
        </div>
      </template>
    </div>
    <div class="dock-foot">
      <span class="stat__sub faint">updates live · survives navigation & reload</span>
    </div>
  </aside>
</template>

<style scoped>
/* IRI-048 scene B: the dock chrome mirrors TelemetryDrawer (fixed right, z 8
   per the chrome layering contract); rows carry the shared transfer anatomy. */
.dock {
  position: fixed;
  top: var(--topbar-h, 64px);
  right: 0;
  bottom: 0;
  z-index: 8;
  width: 400px;
  max-width: 100%;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border-left: 1px solid var(--border);
}
.dock-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}
.dock-head h3 {
  flex: 1;
  font-size: 16px;
}
.dock-body {
  flex: 1;
  overflow: auto;
}
.dockrow {
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}
.dockrow-empty {
  color: var(--faint);
  font-family: var(--font-mono);
  font-size: 12px;
}
.dockrow-top {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.dockrow-top .xmodel {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dockrow-route {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--faint);
  margin-top: 2px;
}
.dockrow-bar {
  margin-top: 8px;
}
.dockrow-noprogress {
  margin-top: 6px;
}
.dockrow-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 5px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--faint);
}
.xsub {
  padding: 10px 14px 2px;
}
.xsub .label {
  display: block;
  margin-bottom: 6px;
}
.dconfirm {
  margin-top: 8px;
  border: 1px solid var(--thread);
  background: var(--thread-wash);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
}
.dock-foot {
  border-top: 1px solid var(--border);
  padding: 8px 14px;
}
@media (max-width: 720px) {
  .dock {
    width: 100%;
    border-left: 0;
  }
}
</style>
