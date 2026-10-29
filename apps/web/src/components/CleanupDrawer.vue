<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { createJob, fetchJob, type JobDetail } from "../models";
import { fetchCleanup, setWeeklySafePass, type CleanupState } from "../api";
import { DISK_WARN_PCT, fmtBytes } from "../analytics";
import { HYGIENE_CATEGORY_LABELS, HYGIENE_SAFE_CATEGORIES, type HygieneCategory } from "@irori/core";
import { vScrimClose } from "../scrim";

const props = defineProps<{ nodeId: string; nodeName: string }>();
const emit = defineEmits<{ close: [] }>();

type Tab = "audit" | "history";
const tab = ref<Tab>("audit");
const cleanup = ref<CleanupState | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);

/** audit rows: checked set (safe pre-checked), persisted per open. */
const checked = ref<Set<string>>(new Set(HYGIENE_SAFE_CATEGORIES));

type Phase = "idle" | "busy" | "running" | "done";
const phase = ref<Phase>("idle");
const outcomes = ref<Array<{ category: string; status: string; bytesReclaimed: number; itemsRemoved: number; error: string | null }>>([]);
const runOutput = ref<string[]>([]);
const confirmName = ref("");
const lastRunOk = ref<boolean | null>(null);
let pollTimer: ReturnType<typeof setInterval> | undefined;
let seq = 0;

async function refresh(): Promise<void> {
  try {
    cleanup.value = await fetchCleanup(props.nodeId);
    error.value = null;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

void refresh();

/** Runs a hygiene job to completion, streaming its output lines. */
async function runJob(kind: "hygiene-audit" | "hygiene-clean" | "hygiene-prevent", params: Record<string, unknown>): Promise<JobDetail> {
  const job = await createJob(props.nodeId, kind, params);
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    const detail: JobDetail = await fetchJob(job.id);
    if (kind !== "hygiene-audit") {
      runOutput.value = detail.output.map((o) => o.line);
    }
    if (detail.job.status !== "queued" && detail.job.status !== "running") return detail;
  }
}

async function runAudit(): Promise<void> {
  const mySeq = ++seq;
  phase.value = "busy";
  error.value = null;
  try {
    const detail = await runJob("hygiene-audit", {});
    if (mySeq !== seq) return;
    await refresh();
    void detail;
  } catch (err) {
    if (mySeq !== seq) return;
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    if (mySeq === seq) phase.value = "idle";
  }
}

const selectedCategories = computed(() => [...checked.value] as HygieneCategory[]);

async function runClean(): Promise<void> {
  if (confirmName.value !== props.nodeName) return;
  const mySeq = ++seq;
  phase.value = "running";
  runOutput.value = [];
  error.value = null;
  try {
    const detail = await runJob("hygiene-clean", { categories: selectedCategories.value, dryRun: false });
    if (mySeq !== seq) return;
    const last = detail.output.at(-1)?.line ?? "";
    try {
      const parsed = JSON.parse(last) as { outcomes?: typeof outcomes.value };
      outcomes.value = parsed.outcomes ?? [];
    } catch {
      outcomes.value = [];
    }
    lastRunOk.value = detail.job.status === "succeeded";
    phase.value = "done";
    await refresh();
  } catch (err) {
    if (mySeq !== seq) return;
    error.value = err instanceof Error ? err.message : String(err);
    phase.value = "idle";
  }
}

const preventionBusy = ref(false);
async function toggleWeekly(): Promise<void> {
  preventionBusy.value = true;
  try {
    const next = cleanup.value === null ? true : !cleanup.value.prevention.weeklySafePass;
    const prevention = await setWeeklySafePass(props.nodeId, next);
    if (cleanup.value !== null) cleanup.value.prevention = prevention;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    preventionBusy.value = false;
  }
}

async function applyLogRotation(): Promise<void> {
  preventionBusy.value = true;
  try {
    await runJob("hygiene-prevent", {});
    if (cleanup.value !== null) cleanup.value.prevention.logRotationApplied = true;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    preventionBusy.value = false;
  }
}

onBeforeUnmount(() => {
  seq += 1; // in-flight polls stop writing state
});

const auditReport = computed(() => {
  const row = cleanup.value?.latestAudit ?? null;
  if (row === null || typeof row.report !== "object" || row.report === null) return null;
  const report = row.report as {
    generatedAtMs: number;
    totalBytes: number | null;
    freeBytes: number | null;
    categories: Array<{
      category: string;
      safe: boolean;
      rationale: string;
      itemCount: number;
      reclaimableBytes: number;
      details?: Array<{ label: string; path: string | null; bytes: number; items: number }>;
    }>;
  };
  if (!Array.isArray(report.categories)) return null;
  return {
    ...report,
    categories: report.categories.map((row) => ({ ...row, details: Array.isArray(row.details) ? row.details : [] })),
  };
});

/** Reclaimable bytes across the checked categories (the clean button summary). */
const selectedReclaimable = computed(() =>
  auditRows.value
    .filter((row) => checked.value.has(row.category))
    .reduce((sum, row) => sum + row.reclaimableBytes, 0),
);

const auditRows = computed(() => {
  const audit = auditReport.value;
  if (audit === null) return [];
  const order = Object.keys(HYGIENE_CATEGORY_LABELS);
  return [...audit.categories].sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));
});

const maxReclaimable = computed(() => Math.max(1, ...auditRows.value.map((r) => r.reclaimableBytes)));

/** Total the audit estimates across all categories; null before the first audit. */
const totalReclaimable = computed(() => {
  const audit = auditReport.value;
  if (audit === null) return null;
  return audit.categories.reduce((sum, c) => sum + c.reclaimableBytes, 0);
});

const diskPct = computed(() => {
  const audit = auditReport.value;
  if (audit === null || audit.totalBytes === null || audit.totalBytes <= 0 || audit.freeBytes === null) return null;
  return Math.round(((audit.totalBytes - audit.freeBytes) / audit.totalBytes) * 100);
});

const diskChipCls = computed(() =>
  diskPct.value !== null && diskPct.value >= DISK_WARN_PCT ? "chip--warn" : "chip",
);

function catLabel(category: string): string {
  return HYGIENE_CATEGORY_LABELS[category as HygieneCategory] ?? category;
}
</script>

<template>
  <div class="drawer-scrim" v-scrim-close="() => emit('close')">
    <aside class="drawer is-open" role="dialog" aria-label="Disk hygiene">
      <div class="row row--between" style="margin-bottom: 10px">
        <div class="row">
          <h3 style="font-size: 17px">Disk hygiene — {{ nodeName }}</h3>
          <span v-if="diskPct !== null" class="chip" :class="diskChipCls">Disk {{ diskPct }}%</span>
          <span v-if="totalReclaimable !== null" class="chip chip--accent">{{ fmtBytes(totalReclaimable) }} reclaimable</span>
        </div>
        <button class="iconbtn" aria-label="Close disk hygiene" @click="emit('close')">✕</button>
      </div>

      <div class="tabs" style="margin-bottom: 12px" role="tablist" aria-label="Cleanup tabs">
        <button role="tab" :aria-selected="tab === 'audit'" :class="{ 'is-active': tab === 'audit' }" @click="tab = 'audit'">Audit</button>
        <button role="tab" :aria-selected="tab === 'history'" :class="{ 'is-active': tab === 'history' }" @click="tab = 'history'">History</button>
      </div>

      <p v-if="error" class="banner banner--warn">{{ error }}</p>
      <p v-else-if="loading" class="muted">loading…</p>

      <p class="stat__sub" style="margin-bottom: 10px;">
        Reclaims caches, journal, /tmp and stale artifacts — protected models and in-use
        images are never touched; care rows are opt-in. The audit is read-only: nothing
        is deleted until you type the node name and run the clean.
      </p>

      <template v-if="tab === 'audit'">
        <div class="row row--between" style="margin-bottom: 10px">
          <span class="stat__sub">
            <template v-if="cleanup?.latestAudit">audited {{ auditReport === null ? 'recently' : new Date(auditReport.generatedAtMs).toLocaleTimeString() }} · cached ~5 min</template>
            <template v-else>never audited — run an audit to estimate reclaimable space</template>
          </span>
          <button class="btn btn--secondary btn--sm" :disabled="phase === 'busy' || phase === 'running'" @click="runAudit">
            {{ phase === "busy" ? "auditing…" : cleanup?.latestAudit ? "Re-audit" : "Run audit" }}
          </button>
        </div>

        <div class="stack" style="gap: 6px">
          <label
            v-for="row in auditRows"
            :key="row.category"
            class="pick"
            :class="{ 'is-on': checked.has(row.category), 'is-disabled': row.reclaimableBytes === 0 }"
          >
            <input
              type="checkbox"
              :checked="checked.has(row.category)"
              :disabled="row.reclaimableBytes === 0 || phase === 'busy' || phase === 'running'"
              @change="checked.has(row.category) ? checked.delete(row.category) : checked.add(row.category)"
            />
            <span class="stack" style="gap: 2px; flex: 1">
              <span class="row row--between">
                <span>
                  <strong>{{ catLabel(row.category) }}</strong>
                  <span v-if="!row.safe" class="chip" title="needs care — opt-in">◇ care</span>
                  <span v-if="row.category === 'modelctl-staging'" class="chip chip--accent" title="store-volume scope — only the store node reports staging (IRI-047)">NAS store</span>
                </span>
                <span class="row" style="gap: 8px">
                  <span class="stat__sub">{{ row.itemCount }} {{ row.itemCount === 1 ? "item" : "items" }}</span>
                  <span class="mono">{{ fmtBytes(row.reclaimableBytes) }}</span>
                </span>
              </span>
              <span class="stat__sub">{{ row.rationale }}</span>
              <span v-if="row.category === 'modelctl-staging'" class="stat__sub faint">frees space on the store volume</span>
              <ul v-if="row.details.length > 0" class="hy-details">
                <li v-for="detail in row.details" :key="`${detail.label}:${detail.path ?? ''}`" class="stat__sub">
                  <span class="mono">{{ detail.label }}</span>
                  <span v-if="detail.items > 1" class="faint"> · {{ detail.items }} items</span>
                  <span class="mono"> · {{ fmtBytes(detail.bytes) }}</span>
                  <span v-if="detail.path !== null" class="faint mono hy-path" :title="detail.path"> · {{ detail.path }}</span>
                </li>
              </ul>
              <span class="bar"><span class="bar__fill" :style="{ width: `${Math.round((row.reclaimableBytes / maxReclaimable) * 100)}%` }"></span></span>
            </span>
          </label>
        </div>

        <div class="row row--between" style="margin-top: 12px">
          <span class="stat__sub">safe categories pre-checked · care rows are opt-in</span>
        </div>

        <!-- Typed node-name confirm (SPEC §11.6) — the only destructive gate.
             Sticky (IRI-042): stays pinned above the scrollable category rows. -->
        <div class="hy-confirm stack" style="gap: 6px; margin-top: 8px">
          <div class="row row--between">
            <label class="stat__sub">type the node name to confirm: <strong>{{ nodeName }}</strong></label>
            <span class="stat__sub">{{ selectedCategories.length }} selected · {{ fmtBytes(selectedReclaimable) }}</span>
          </div>
          <div class="row" style="gap: 8px">
            <input
              v-model="confirmName"
              class="select"
              :placeholder="nodeName"
              aria-label="Type the node name to confirm the clean"
              style="flex: 1; min-width: 0;"
            />
            <button
              class="btn btn--sm"
              :disabled="phase === 'busy' || phase === 'running' || selectedCategories.length === 0 || confirmName !== nodeName"
              @click="runClean"
            >{{ phase === "running" ? "cleaning…" : `Clean ${selectedCategories.length} categories` }}</button>
          </div>
        </div>

        <!-- Staged streamed run -->
        <div v-if="phase === 'running' || phase === 'done'" style="margin-top: 12px">
          <h4 style="margin-bottom: 6px">
            {{ phase === "running" ? "Running…" : lastRunOk === false ? "Finished with failures" : "Finished" }}
          </h4>
          <pre v-if="runOutput.length > 0" class="mono faint" style="max-height: 220px; overflow: auto; white-space: pre-wrap">{{ runOutput.join("\n") }}</pre>
          <div v-if="phase === 'done'" style="margin-top: 8px">
            <table class="table">
              <thead><tr><th>category</th><th>result</th><th>reclaimed</th></tr></thead>
              <tbody>
                <tr v-for="o in outcomes" :key="o.category">
                  <td class="mono">{{ catLabel(o.category) }}</td>
                  <td><span class="chip" :class="{ 'chip--warn': o.status === 'failed' }">{{ o.status }}</span><span v-if="o.error" class="stat__sub"> {{ o.error }}</span></td>
                  <td class="mono">{{ fmtBytes(o.bytesReclaimed) }}</td>
                </tr>
              </tbody>
            </table>
            <button class="btn btn--secondary btn--sm" style="margin-top: 8px" @click="phase = 'idle'">Close result</button>
          </div>
        </div>

        <!-- Prevention (opt-in, drawer bottom) -->
        <div style="margin-top: 16px; border-top: 1px solid var(--border); padding-top: 10px">
          <h4 style="margin-bottom: 6px">Prevention</h4>
          <label class="pick" :class="{ 'is-on': cleanup?.prevention.weeklySafePass === true }">
            <input type="checkbox" :disabled="preventionBusy" :checked="cleanup?.prevention.weeklySafePass === true" @change="toggleWeekly" />
            <span>
              <strong>Weekly always-safe pass</strong>
              <div class="stat__sub">build cache, compiler/pkg caches, tmp, journal — nothing else</div>
            </span>
          </label>
          <div class="row row--between" style="margin-top: 8px">
            <span class="stat__sub">docker log rotation (max-size 10m, max-file 3)</span>
            <button class="btn btn--secondary btn--sm" :disabled="preventionBusy || cleanup?.prevention.logRotationApplied === true" @click="applyLogRotation">
              {{ cleanup?.prevention.logRotationApplied === true ? "applied ✓" : "Apply log rotation" }}
            </button>
          </div>
        </div>
      </template>

      <template v-else>
        <table v-if="(cleanup?.history.length ?? 0) > 0" class="table">
          <thead><tr><th>when</th><th>kind</th><th>status</th><th>detail</th></tr></thead>
          <tbody>
            <tr v-for="h in cleanup?.history" :key="h.id">
              <td class="mono">{{ new Date(h.createdAt).toLocaleString() }}</td>
              <td>{{ h.kind }}</td>
              <td><span class="chip" :class="{ 'chip--warn': h.status === 'failed' }">{{ h.status }}</span></td>
              <td class="stat__sub">
                <template v-if="h.error">{{ h.error }}</template>
                <template v-else-if="h.kind === 'clean' && typeof h.report === 'object' && h.report !== null">
                  {{ ((h.report as { outcomes?: Array<{ bytesReclaimed: number }> }).outcomes ?? []).reduce((s, o) => s + o.bytesReclaimed, 0) }} bytes reclaimed
                </template>
                <template v-else>—</template>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="muted">no cleanup history — last 20 runs show here (kept 90 d)</p>
      </template>
    </aside>
  </div>
</template>

<style scoped>
.hy-details {
  list-style: none;
  margin: 2px 0 0;
  padding: 0 0 0 2px;
  display: grid;
  gap: 2px;
}
.hy-details li {
  font-size: 11.5px;
}
.hy-path {
  overflow-wrap: anywhere;
}
/* IRI-042: the destructive gate rides the drawer's scroll container, so it
 * pins to the visible bottom until its natural position scrolls into view. */
.hy-confirm {
  position: sticky;
  bottom: 0;
  z-index: 2;
  background: var(--surface);
  border-top: 1px solid var(--border);
  padding-top: 10px;
}
</style>
