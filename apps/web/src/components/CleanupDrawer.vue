<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { createJob, fetchJob, parsePruneCleanupQuarantineSummary, parseQuarantinePruneSummary, parseStagingTreeReport, type JobDetail, type PruneCleanupQuarantineSummary, type QuarantinePruneSummary, type StagingTreeReport } from "../models";
import { fetchCleanup, setWeeklySafePass, type CleanupState } from "../api";
import { fmtBytes } from "../analytics";
import { thresholds } from "../thresholds";
import { HYGIENE_CATEGORY_LABELS, HYGIENE_SAFE_CATEGORIES, type HygieneCategory } from "@irori/core";
import { vScrimClose } from "../scrim";
import { vDialog } from "../dialog";

const props = defineProps<{ nodeId: string; nodeName: string }>();
const emit = defineEmits<{ close: [] }>();

type Tab = "audit" | "history";
const tab = ref<Tab>("audit");
/** IR-224 S5: secondary sections collapse into accordions so the default
 *  view fits the body without scrolling; arming states live inside them. */
const acc = ref<{ staging: boolean }>({ staging: false });
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
async function runJob(kind: "hygiene-audit" | "hygiene-clean" | "hygiene-prevent" | "staging-tree-audit" | "quarantine-prune" | "prune-cleanup-quarantine", params: Record<string, unknown>): Promise<JobDetail> {
  const job = await createJob(props.nodeId, kind, params);
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    const detail: JobDetail = await fetchJob(job.id);
    if (kind !== "hygiene-audit" && kind !== "staging-tree-audit") {
      runOutput.value = detail.output.map((o) => o.line);
    }
    if (detail.job.status !== "queued" && detail.job.status !== "running") return detail;
  }
}

/** IR-211: staging-tree audit + armed quarantine prune (SPEC §11.6 typed gate per name). */
const stagingBusy = ref(false);
const stagingReport = ref<StagingTreeReport | null>(null);
const stagingError = ref<string | null>(null);
const pruneArm = ref<string | null>(null);
const pruneConfirm = ref("");
const pruneSummary = ref<QuarantinePruneSummary | null>(null);
let stagingSeq = 0;

async function auditStaging(): Promise<void> {
  const mySeq = ++stagingSeq;
  stagingBusy.value = true;
  stagingError.value = null;
  try {
    const detail = await runJob("staging-tree-audit", {});
    if (mySeq !== stagingSeq) return; // drawer closed mid-poll
    const report = parseStagingTreeReport(detail.output.at(-1)?.line);
    if (report === null) {
      stagingError.value = "the audit job produced no readable report" + (detail.job.status !== "succeeded" ? ` (${detail.job.status})` : "");
    } else {
      stagingReport.value = report;
    }
  } catch (err) {
    stagingError.value = err instanceof Error ? err.message : String(err);
  } finally {
    stagingBusy.value = false;
  }
}

async function pruneQuarantine(name: string | null): Promise<void> {
  if (name === null || pruneArm.value !== name || pruneConfirm.value !== name) return;
  const mySeq = ++stagingSeq;
  stagingBusy.value = true;
  stagingError.value = null;
  try {
    const detail = await runJob("quarantine-prune", { names: [name], confirm: "prune" });
    if (mySeq !== stagingSeq) return; // drawer closed mid-poll
    const summary = parseQuarantinePruneSummary(detail.output.at(-1)?.line);
    pruneSummary.value = summary;
    pruneArm.value = null;
    pruneConfirm.value = "";
    if (summary === null) stagingError.value = "the prune job produced no readable summary";
    else void auditStaging(); // freed bytes are the statfs delta; refresh the tree list
  } catch (err) {
    stagingError.value = err instanceof Error ? err.message : String(err);
  } finally {
    stagingBusy.value = false;
  }
}

const pruneRows = computed(() => (stagingReport.value === null ? [] : stagingReport.value.trees.filter((t) => t.kind === "active-quarantine")));

// IR-207: the interrupted cleanup-staging debris (.staging/.cleanup-quarantine) —
// modelctl 0.24.0's prune-cleanup-quarantine; same two-step arm as the
// per-name prune, dry-run first (no confirm) so the operator sees the list.
const debrisArm = ref(false);
const debrisConfirm = ref("");
const debrisSummary = ref<PruneCleanupQuarantineSummary | null>(null);

async function pruneDebris(): Promise<void> {
  if (!debrisArm.value || debrisConfirm.value !== "prune") return;
  const mySeq = ++stagingSeq;
  stagingBusy.value = true;
  stagingError.value = null;
  try {
    const detail = await runJob("prune-cleanup-quarantine", { confirm: "prune" });
    if (mySeq !== stagingSeq) return; // drawer closed mid-poll
    const summary = parsePruneCleanupQuarantineSummary(detail.output.at(-1)?.line);
    debrisSummary.value = summary;
    debrisArm.value = false;
    debrisConfirm.value = "";
    if (summary === null) stagingError.value = "the prune job produced no readable summary";
    else void auditStaging(); // freed bytes are the statfs delta; refresh the tree list
  } catch (err) {
    stagingError.value = err instanceof Error ? err.message : String(err);
  } finally {
    stagingBusy.value = false;
  }
}

/** Dry-run first: lists what an armed prune would remove, never deletes. */
async function previewDebris(): Promise<void> {
  const mySeq = ++stagingSeq;
  stagingBusy.value = true;
  stagingError.value = null;
  try {
    const detail = await runJob("prune-cleanup-quarantine", {});
    if (mySeq !== stagingSeq) return;
    const summary = parsePruneCleanupQuarantineSummary(detail.output.at(-1)?.line);
    if (summary === null) stagingError.value = "the prune job produced no readable summary";
    else debrisSummary.value = summary;
  } catch (err) {
    stagingError.value = err instanceof Error ? err.message : String(err);
  } finally {
    stagingBusy.value = false;
  }
}

/** IR-237 review: covers the auto-audit that follows a clean — the audit
 *  actions must not bump seq during it (their 409 would also stale the
 *  post-audit refresh). */
const auditBusy = ref(false);

async function runAudit(): Promise<void> {
  if (auditBusy.value || phase.value === "running") return;
  const mySeq = ++seq;
  auditBusy.value = true;
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
    auditBusy.value = false;
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
    if (detail.job.status === "succeeded" && mySeq === seq) {
      // IR-240: a hygiene-clean never writes an audit row — follow the clean
      // with a fresh audit (the agent's audit cache is already invalidated)
      // so rows/chips show post-clean values without a manual Re-audit.
      // auditBusy keeps the audit actions from bumping seq mid-audit.
      auditBusy.value = true;
      try {
        await runJob("hygiene-audit", {}).catch(() => null);
      } finally {
        auditBusy.value = false;
      }
    }
    if (mySeq === seq) await refresh();
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
  stagingSeq += 1;
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
  diskPct.value !== null && diskPct.value >= thresholds.diskWarnPct ? "chip--warn" : "chip",
);

function catLabel(category: string): string {
  return HYGIENE_CATEGORY_LABELS[category as HygieneCategory] ?? category;
}
</script>

<template>
  <div class="drawer-scrim" v-scrim-close="() => emit('close')">
    <aside class="drawer drawer--hy is-open" role="dialog" aria-modal="true" aria-label="Disk hygiene" v-dialog="() => emit('close')">
      <div class="drawer__head row row--between">
        <div style="min-width: 0">
          <div class="row">
            <h3 style="font-size: 17px">Disk hygiene — {{ nodeName }}</h3>
            <span v-if="diskPct !== null" class="chip" :class="diskChipCls">Disk {{ diskPct }}%</span>
            <span v-if="totalReclaimable !== null" class="chip chip--accent">{{ fmtBytes(totalReclaimable) }} reclaimable</span>
          </div>
          <p class="stat__sub">
            <template v-if="cleanup?.latestAudit">audited {{ auditReport === null ? 'recently' : new Date(auditReport.generatedAtMs).toLocaleTimeString() }} · cached ~5 min</template>
            <template v-else>never audited — run an audit to estimate reclaimable space</template>
          </p>
        </div>
        <button class="iconbtn" aria-label="Close disk hygiene" @click="emit('close')">✕</button>
      </div>

      <div class="drawer__body">
      <div class="tabs" style="margin-bottom: 8px" role="tablist" aria-label="Cleanup tabs">
        <button role="tab" :aria-selected="tab === 'audit'" :class="{ 'is-active': tab === 'audit' }" @click="tab = 'audit'">Audit</button>
        <button role="tab" :aria-selected="tab === 'history'" :class="{ 'is-active': tab === 'history' }" @click="tab = 'history'">History</button>
      </div>

      <p v-if="error" class="banner banner--warn">{{ error }}</p>
      <p v-else-if="loading" class="muted">loading…</p>

      <p class="stat__sub" style="margin-bottom: 8px;">
        Read-only audit — protected models and in-use images are never touched.
      </p>

      <template v-if="tab === 'audit'">
        <!-- IR-224 S5 (mockup): weekly prevention leads the body; the audit
             timestamp moved to the fixed head. -->
        <div class="stack" style="gap: 6px; margin-bottom: 8px">
          <label class="pick" :class="{ 'is-on': cleanup?.prevention.weeklySafePass === true }">
            <input type="checkbox" :disabled="preventionBusy" :checked="cleanup?.prevention.weeklySafePass === true" @change="toggleWeekly" />
            <span>
              <strong>Weekly always-safe pass</strong>
              <div class="stat__sub">build cache, compiler/pkg caches, tmp, journal — nothing else</div>
            </span>
          </label>
        </div>

        <div class="row row--between" style="margin-bottom: 8px">
          <span class="stat__sub" style="flex: 1; min-width: 0">safe categories pre-checked · care rows are opt-in</span>
          <span class="row" style="gap: 8px">
            <button
              v-if="cleanup?.prevention.logRotationApplied !== true"
              class="btn btn--secondary btn--sm"
              :disabled="preventionBusy"
              title="docker daemon.json: max-size 10m, max-file 3"
              @click="applyLogRotation"
            >Apply log rotation</button>
            <span v-else class="stat__sub faint">docker log rotation applied ✓</span>
            <button class="btn btn--secondary btn--sm" :disabled="auditBusy || phase === 'busy' || phase === 'running'" @click="runAudit">
              {{ phase === "busy" || auditBusy ? "auditing…" : cleanup?.latestAudit ? "Re-audit" : "Run audit" }}
            </button>
          </span>
        </div>

        <div class="stack" style="gap: 4px">
          <label
            v-for="row in auditRows"
            :key="row.category"
            class="pick"
            :class="{ 'is-on': checked.has(row.category), 'is-disabled': row.reclaimableBytes === 0, 'is-empty': row.reclaimableBytes === 0 && row.itemCount === 0 }"
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
              <!-- IR-229 follow-up: categories with nothing auditable collapse to
                   their one name line — rationale, breakdown and weight bar only
                   earn space when there is something to reclaim. The checkbox
                   contract is untouched (empty rows stay disabled-and-checked
                   no-ops exactly as before). -->
              <template v-if="row.reclaimableBytes > 0 || row.itemCount > 0">
                <span class="stat__sub">{{ row.rationale }}</span>
                <span v-if="row.category === 'modelctl-staging'" class="stat__sub faint">frees space on the store volume</span>
                <ul v-if="row.details.some((d) => d.bytes > 0)" class="hy-details">
                  <li v-for="detail in row.details.filter((d) => d.bytes > 0)" :key="`${detail.label}:${detail.path ?? ''}`" class="stat__sub">
                    <span class="mono">{{ detail.label }}</span>
                    <span v-if="detail.items > 1" class="faint"> · {{ detail.items }} items</span>
                    <span class="mono"> · {{ fmtBytes(detail.bytes) }}</span>
                    <span v-if="detail.path !== null" class="faint mono hy-path" :title="detail.path"> · {{ detail.path }}</span>
                  </li>
                </ul>
                <span class="bar"><span class="bar__fill" :style="{ width: `${Math.round((row.reclaimableBytes / maxReclaimable) * 100)}%` }"></span></span>
              </template>
            </span>
          </label>
        </div>

        <!-- IR-211: hidden staging debris (quarantine trees staging-audit cannot see) —
             IR-224 S5: collapsed into an accordion so the default view fits the
             body without scrolling; arming stays typed and per tree. -->
        <div class="hy-acc" style="margin-top: 8px">
          <button class="hy-acc__btn" type="button" :aria-expanded="acc.staging ? 'true' : 'false'" @click="acc.staging = !acc.staging">
            <span>Staging &amp; quarantine trees <span class="faint mono">· arm per tree</span></span>
            <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
          </button>
          <div v-show="acc.staging" class="hy-acc__panel">
          <div class="row row--between">
            <button class="btn btn--secondary btn--sm" :disabled="stagingBusy || phase === 'busy' || phase === 'running'" @click="auditStaging">
              {{ stagingBusy ? "working…" : "Audit staging trees" }}
            </button>
          </div>
          <p class="stat__sub faint">
            staging-audit skips hidden dirs — this walk includes .active-quarantine and .cleanup-quarantine. Quarantine
            pruning routes through modelctl cleanup-quarantine (validated before deleting); cleanup-quarantine debris
            (an interrupted cleanup prune) goes through modelctl prune-cleanup-quarantine — dry run first, armed only
            after the typed confirm.
          </p>
          <p v-if="stagingError" class="banner banner--warn">{{ stagingError }}</p>
          <template v-if="stagingReport !== null">
            <p class="stat__sub">
              active-quarantine {{ fmtBytes(stagingReport.totals.activeQuarantineBytes) }} · cleanup-quarantine
              {{ fmtBytes(stagingReport.totals.cleanupQuarantineBytes) }} · other staging
              {{ fmtBytes(stagingReport.totals.stagingBytes) }} · store free
              {{ stagingReport.freeBytes === null ? "unknown" : fmtBytes(stagingReport.freeBytes) }}
              <span v-if="stagingReport.timedOut">· partial (walk deadline hit)</span>
            </p>
            <div v-if="stagingReport.totals.cleanupQuarantineBytes > 0" class="stack" style="gap: 6px; margin-top: 6px">
              <div class="row" style="gap: 6px; flex-wrap: wrap;">
                <button class="btn btn--ghost btn--sm" :disabled="stagingBusy || phase === 'busy' || phase === 'running'" @click="previewDebris">
                  List cleanup debris (dry run)
                </button>
                <template v-if="debrisArm">
                  <input
                    v-model="debrisConfirm"
                    class="select"
                    placeholder="type prune to arm"
                    aria-label="Type prune to confirm removing the cleanup-quarantine debris"
                    style="flex: 1; min-width: 0; max-width: 220px;"
                  />
                  <button class="bs-link bs-link--thread" :disabled="debrisConfirm !== 'prune' || stagingBusy" @click="pruneDebris">Prune debris</button>
                  <button class="btn btn--ghost btn--sm" @click="debrisArm = false; debrisConfirm = ''">Cancel</button>
                </template>
                <button v-else class="bs-link bs-link--thread" :disabled="stagingBusy || phase === 'busy' || phase === 'running'" @click="debrisArm = true; debrisConfirm = ''">
                  Prune debris…
                </button>
              </div>
              <p v-if="debrisSummary !== null" class="stat__sub">
                last cleanup prune: {{ debrisSummary.applied ? "applied" : "dry run" }} ·
                {{ debrisSummary.results.length }} tree(s)
                <span v-if="debrisSummary.freedBytes !== null">· freed {{ fmtBytes(debrisSummary.freedBytes) }}</span>
              </p>
            </div>
            <ul class="hy-details">
              <li v-for="row in pruneRows" :key="row.path" class="stat__sub">
                <span class="mono">{{ row.name }}</span>
                <span class="mono faint"> · {{ fmtBytes(row.bytes ?? 0) }}</span>
                <span class="faint mono hy-path" :title="row.path"> · {{ row.path }}</span>
                <span class="row" style="gap: 6px; margin-top: 4px" v-if="pruneArm === row.name">
                  <input
                    v-model="pruneConfirm"
                    class="select"
                    :placeholder="`type ${row.name} to arm`"
                    :aria-label="`Type ${row.name} to confirm pruning its quarantine trees`"
                    style="flex: 1; min-width: 0;"
                  />
                  <button class="bs-link bs-link--thread" :disabled="pruneConfirm !== row.name || stagingBusy" @click="pruneQuarantine(row.name)">Prune</button>
                  <button class="btn btn--ghost btn--sm" @click="pruneArm = null; pruneConfirm = ''">Cancel</button>
                </span>
                <button v-else class="btn btn--ghost btn--sm" style="margin-left: 8px" :disabled="stagingBusy || (row.bytes ?? 0) === 0" @click="pruneArm = row.name; pruneConfirm = ''">Prune…</button>
              </li>
            </ul>
            <p v-if="pruneSummary !== null" class="stat__sub">
              last prune: {{ pruneSummary.armed ? "armed" : "dry run" }} ·
              {{ pruneSummary.results.map((r) => `${r.name}: ${r.status}`).join(", ") }}
              <span v-if="pruneSummary.freedBytes !== null">· freed {{ fmtBytes(pruneSummary.freedBytes) }}</span>
            </p>
          </template>
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
      </div>

      <!-- Typed node-name confirm (SPEC §11.6) — the only destructive gate.
           IR-224 S5: the foot is flex-fixed, so the gate is always visible —
           the body scrolls, the panel never does. -->
      <div class="drawer__foot">
        <div class="hy-confirm stack" style="gap: 6px">
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
              :disabled="auditBusy || phase === 'busy' || phase === 'running' || selectedCategories.length === 0 || confirmName !== nodeName"
              @click="runClean"
            >{{ phase === "running" ? "cleaning…" : `Clean ${selectedCategories.length} categories` }}</button>
          </div>
        </div>
      </div>
    </aside>
  </div>
</template>

<style scoped>
/* IR-224 S5: the cleanup drawer is the one panel that never scrolls —
   fixed head, scrolling body (shared .drawer__body chrome), fixed confirm
   foot. Every other .drawer keeps its panel-scroll contract. */
.drawer--hy { display: flex; flex-direction: column; padding: 0; overflow: hidden; max-height: 92vh; }
.drawer--hy .drawer__head { flex: none; padding: 14px 14px 0; }
.drawer--hy .drawer__body { flex: 1 1 auto; padding: 0 14px 14px; }
.drawer--hy .drawer__foot { flex: none; padding: 10px 14px 14px; border-top: 1px solid var(--border); background: var(--surface); }
/* IR-229 follow-up: category rows tighten to mockup density — full cards for
   rows with reclaimables, one-line micro rows for audited-but-empty ones. */
.drawer--hy .pick { padding: 6px 12px; }
.drawer--hy .pick.is-empty { padding: 2px 12px; }
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
/* Secondary sections (IR-224 S5): collapsed by default, chevron state keyed
   off aria-expanded (the same idiom as the ServeView drawers). */
.hy-acc { border: 1px solid var(--border); border-radius: var(--radius-control); }
.hy-acc + .hy-acc { margin-top: 8px; }
.hy-acc__btn { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; min-height: 36px;
  padding: 0 12px; border: 0; background: none; font: 500 var(--fs-ui)/1.3 var(--font-sans); color: var(--fg); cursor: pointer; text-align: left; }
.hy-acc__btn:hover { background: var(--surface-2); }
.hy-acc__btn .chev { flex: none; width: 16px; height: 16px; stroke: currentColor; fill: none; stroke-width: 1.5;
  transition: transform var(--dur-press) var(--ease-out); }
.hy-acc__btn[aria-expanded="true"] .chev { transform: rotate(90deg); }
.hy-acc__panel { padding: 10px 12px 12px; border-top: 1px solid var(--border); }
/* The destructive gate rides the fixed foot (was position:sticky inside the
 * whole-panel scroll, IRI-042) — always visible while the body scrolls. */
.hy-confirm {
  z-index: 2;
}
</style>
