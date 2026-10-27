<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { live } from "../live";
import {
  deleteNode,
  fetchHistory,
  fetchLlmHistory,
  fetchNodeLlm,
  HISTORY_RANGES,
  type HistoryRange,
  type HistoryResponse,
  type LlmHistoryResponse,
  type LlmSnapshot,
} from "../api";
import { computeCardData, formatPct, formatTemp, isHotTemp } from "../card-data";
import { computeDetailData, formatRate } from "../detail-data";
import { fmtBytes } from "../analytics";
import { nodeLlmPorts, shapeLlmPort, type LlmPortView } from "../llm-data";
import { cancelJob, createJob, fetchJob, jobStatusChip, startAgentUpdate, type JobDetail } from "../models";
import {
  deleteConfirmCopy,
  deleteRequestFor,
  fetchNodeInventory,
  filterModels,
  inventorySummary,
  leftoverLabel,
  refreshNodeInventory,
  registerCopy,
  registerRequestFor,
  storeMountLabel,
  type DeleteTarget,
} from "../inventory";
import type { NodeInventory } from "@irori/core";
import { agentDrifts, serverVersion } from "../version";
import LlmPanel from "./LlmPanel.vue";
import Sparkline from "./Sparkline.vue";
import CleanupDrawer from "./CleanupDrawer.vue";
import NodeModal from "./NodeModal.vue";

const props = defineProps<{ nodeId: string }>();

const node = computed(() => live.nodes.get(props.nodeId) ?? null);
const snapshot = computed(() => live.snapshots.get(props.nodeId) ?? null);
const card = computed(() =>
  node.value ? computeCardData(node.value, snapshot.value) : null,
);
/** Registry loaded but the id is unknown → real "not found", not "loading". */
const notFound = computed(() => node.value === null && live.nodes.size > 0);

/** Hover tooltip formatters (units included); wrappers absorb the null side
 *  of the shared formatters' domains — series values are already non-null. */
const tipPct = (v: number): string => formatPct(v) ?? "";
const tipRate = (v: number): string => formatRate(v) ?? "";

const range = ref<HistoryRange>("24h");
const history = ref<HistoryResponse | null>(null);
const loadState = ref<"loading" | "ready" | "error">("loading");
const errorMessage = ref<string | null>(null);
let controller: AbortController | null = null;

async function load(): Promise<void> {
  controller?.abort();
  controller = new AbortController();
  const { signal } = controller;
  loadState.value = "loading";
  errorMessage.value = null;
  try {
    const res = await fetchHistory(props.nodeId, range.value, signal);
    if (signal.aborted) return;
    history.value = res;
    loadState.value = "ready";
  } catch (err) {
    if (signal.aborted) return;
    history.value = null;
    loadState.value = "error";
    errorMessage.value = err instanceof Error ? err.message : String(err);
  }
}

watch(
  () => props.nodeId,
  () => {
    void load();
    void loadLlm();
    // IRI-010 lesson: one component instance across :nodeId changes — the
    // next node must not inherit "updating…" state from the previous one.
    updateBusy.value = false;
    updateMsg.value = null;
  },
);
watch(range, () => {
  void load();
  void loadLlm();
});
onMounted(() => {
  void load();
  void loadLlm();
  void loadInventory();
});
onUnmounted(() => {
  controller?.abort();
  llmController?.abort();
});

/* ── Inference (M3) ─────────────────────────────────────────────────────── */

const llmRest = ref<LlmSnapshot | null>(null);
const llmHistory = ref<LlmHistoryResponse | null>(null);
const llmState = ref<"loading" | "ready" | "error">("loading");
let llmController: AbortController | null = null;

/** REST seed for the port panels + per-range history; SSE keeps them live. */
async function loadLlm(): Promise<void> {
  llmController?.abort();
  llmController = new AbortController();
  const { signal } = llmController;
  llmState.value = "loading";
  // Never show the previous node's engines during/after navigation — the
  // template falls back to llmRest when SSE has no entry for this node yet.
  llmRest.value = null;
  llmHistory.value = null;
  // Older servers may not ship either endpoint yet; degrade independently.
  const [snapRes, histRes] = await Promise.allSettled([
    fetchNodeLlm(props.nodeId, signal),
    fetchLlmHistory(props.nodeId, range.value, signal),
  ]);
  if (signal.aborted) return;
  if (snapRes.status === "fulfilled") llmRest.value = snapRes.value;
  if (histRes.status === "fulfilled") llmHistory.value = histRes.value;
  llmState.value =
    snapRes.status === "rejected" && histRes.status === "rejected"
      ? "error"
      : "ready";
}

interface LlmPanelVm {
  view: LlmPortView;
  decode: Array<number | null> | null;
  prefill: Array<number | null> | null;
}

const llmPanels = computed<LlmPanelVm[]>(() => {
  const entry = live.getLlm(props.nodeId) ?? llmRest.value;
  const configured = node.value ? nodeLlmPorts(node.value) : [];
  const detectOnly = node.value?.role === "worker";

  // Displayed ports: configured list first, then hot-added ports that
  // answered. Undetected hot-added entries are idle ghosts of removed
  // ports — hidden (IRI-034), mirroring the Overview's detected-only rule.
  const ports: number[] = [];
  for (const p of configured) {
    if (!ports.includes(p)) ports.push(p);
  }
  for (const s of entry?.ports ?? []) {
    if (s.detected && !ports.includes(s.port)) ports.push(s.port);
  }
  ports.sort((a, b) => a - b);

  return ports.map((port) => {
    const snap = entry?.ports.find((s) => s.port === port) ?? null;
    const points = llmHistory.value?.series.find((s) => s.port === port)?.points ?? null;
    return {
      view: shapeLlmPort(snap, port, { detectOnly }),
      decode: points ? points.map((p) => p.decodeTps) : null,
      prefill: points ? points.map((p) => p.prefillTps) : null,
    };
  });
});

const detail = computed(() =>
  computeDetailData(snapshot.value, history.value, range.value),
);

const historyMeta = computed(() => {
  if (loadState.value === "loading") return "loading…";
  if (loadState.value === "error") return "unavailable";
  return `${detail.value.granularity} buckets · ${detail.value.pointCount} pts`;
});

const statusChipClass = computed(() =>
  node.value?.online ? "chip--ok" : "chip--muted",
);

/* ── Models on this node (IRI-028) ──────────────────────────────────────── */

const inventory = ref<NodeInventory | null>(null);
const inventoryUpdatedAt = ref<string | null>(null);
const inventoryState = ref<"loading" | "ready" | "error">("loading");
const inventoryError = ref<string | null>(null);
const inventoryBusy = ref(false);
const modelFilter = ref("");
/** One auto-refresh per node visit — a failed report must not loop jobs. */
let inventoryAutoTried = false;
/** Node navigation epoch: in-flight polls from the previous node stop writing. */
let nodeEpoch = 0;
let inventorySeq = 0;

const storeRows = computed(() => filterModels(inventory.value?.store?.models ?? [], modelFilter.value));
const storeMount = computed(() => {
  const root = inventory.value?.store?.root ?? node.value?.nasRoot ?? "";
  return root.length === 0 ? "" : storeMountLabel(root, snapshot.value?.storage ?? null);
});
const inventoryReadLabel = computed(() =>
  inventoryUpdatedAt.value === null ? null : new Date(inventoryUpdatedAt.value).toLocaleTimeString(),
);

async function loadInventory(): Promise<void> {
  const seq = ++inventorySeq;
  inventoryState.value = "loading";
  try {
    const res = await fetchNodeInventory(props.nodeId);
    if (seq !== inventorySeq) return;
    inventory.value = res.report;
    inventoryUpdatedAt.value = res.updatedAt;
    inventoryState.value = "ready";
    inventoryError.value = null;
    if (res.report === null && node.value?.online === true && !inventoryAutoTried) {
      inventoryAutoTried = true;
      void refreshInventory();
    }
  } catch (err) {
    if (seq !== inventorySeq) return;
    inventoryState.value = "error";
    inventoryError.value = err instanceof Error ? err.message : String(err);
  }
}

async function refreshInventory(): Promise<void> {
  if (inventoryBusy.value) return;
  const epoch = nodeEpoch;
  inventoryBusy.value = true;
  inventoryError.value = null;
  try {
    const job = await refreshNodeInventory(props.nodeId);
    const detail = await pollJob(job.id, undefined, 30 * 60_000, () => epoch === nodeEpoch);
    if (epoch !== nodeEpoch) return;
    if (detail.job.status !== "succeeded") {
      const line = detail.output.at(-1)?.line ?? `inventory job ${detail.job.status}`;
      inventoryError.value = /unknown job kind/i.test(line)
        ? "this node's agent predates the inventory job — update the agent from the header, then refresh"
        : line;
      return;
    }
    await loadInventory();
  } catch (err) {
    if (epoch !== nodeEpoch) return;
    inventoryError.value = err instanceof Error ? err.message : String(err);
  } finally {
    if (epoch === nodeEpoch) inventoryBusy.value = false;
  }
}

/** Polls a job to a terminal state; `alive` stops the loop after a node
 *  navigation (NodeDetail is one instance across :nodeId changes). */
async function pollJob(id: string, onUpdate?: (detail: JobDetail) => void, deadlineMs = 30 * 60_000, alive: () => boolean = () => true): Promise<JobDetail> {
  const deadline = Date.now() + deadlineMs;
  let last: JobDetail | null = null;
  for (;;) {
    await new Promise((r) => setTimeout(r, 1500));
    if (!alive() || last !== null && (last.job.status !== "queued" && last.job.status !== "running")) return last!;
    last = await fetchJob(id);
    onUpdate?.(last);
    if (last.job.status !== "queued" && last.job.status !== "running") return last;
    if (Date.now() > deadline) return last;
  }
}

const deleteTarget = ref<DeleteTarget | null>(null);
const deleteJob = ref<JobDetail | null>(null);
const deleteBusy = ref(false);
const modelDeleteError = ref<string | null>(null);
const deleteCopy = computed(() => (deleteTarget.value === null ? null : deleteConfirmCopy(deleteTarget.value)));
const deleteRunning = computed(
  () => deleteJob.value !== null && (deleteJob.value.job.status === "queued" || deleteJob.value.job.status === "running"),
);

function askDelete(target: DeleteTarget): void {
  deleteTarget.value = target;
  modelDeleteError.value = null;
}

async function runDelete(): Promise<void> {
  const target = deleteTarget.value;
  if (target === null || deleteBusy.value) return;
  const request = deleteRequestFor(target);
  if (request === null) {
    modelDeleteError.value = "this leftover has no derivable gc-objects target";
    return;
  }
  const epoch = nodeEpoch;
  deleteBusy.value = true;
  modelDeleteError.value = null;
  deleteJob.value = null;
  deleteTarget.value = null;
  try {
    const job = await createJob(props.nodeId, request.kind, request.params);
    const detail = await pollJob(
      job.id,
      (d) => {
        if (epoch === nodeEpoch) deleteJob.value = d;
      },
      30 * 60_000,
      () => epoch === nodeEpoch,
    );
    if (epoch !== nodeEpoch) return;
    deleteJob.value = detail;
    if (detail.job.status !== "succeeded") {
      modelDeleteError.value = detail.output.at(-1)?.line ?? `job ${detail.job.status}`;
    }
    // A settle invalidates the cached inventory server-side; rebuild it.
    inventory.value = null;
    await loadInventory();
  } catch (err) {
    if (epoch !== nodeEpoch) return;
    modelDeleteError.value = err instanceof Error ? err.message : String(err);
  } finally {
    if (epoch === nodeEpoch) deleteBusy.value = false;
  }
}

async function cancelDelete(): Promise<void> {
  const job = deleteJob.value;
  if (job === null) return;
  try {
    await cancelJob(job.job.id);
  } catch (err) {
    modelDeleteError.value = err instanceof Error ? err.message : String(err);
  }
}

// IR-104: register an unregistered cache dir in place (modelctl register-local,
// verify-then-register, no transfer). Shares the Model operation card and
// busy/error state with the delete flow — only one model job runs at a time.
const registerTarget = ref<{ repo: string; user: string } | null>(null);
const registerCopyText = computed(() => (registerTarget.value === null ? null : registerCopy(registerTarget.value.repo)));

function askRegister(repo: string, user: string): void {
  registerTarget.value = { repo, user };
  modelDeleteError.value = null;
}

async function runRegister(): Promise<void> {
  const target = registerTarget.value;
  if (target === null || deleteBusy.value) return;
  const request = registerRequestFor(target.repo, target.user);
  const epoch = nodeEpoch;
  deleteBusy.value = true;
  modelDeleteError.value = null;
  deleteJob.value = null;
  registerTarget.value = null;
  try {
    const job = await createJob(props.nodeId, request.kind, request.params);
    const detail = await pollJob(
      job.id,
      (d) => {
        if (epoch === nodeEpoch) deleteJob.value = d;
      },
      30 * 60_000,
      () => epoch === nodeEpoch,
    );
    if (epoch !== nodeEpoch) return;
    deleteJob.value = detail;
    if (detail.job.status !== "succeeded") {
      modelDeleteError.value = detail.output.at(-1)?.line ?? `job ${detail.job.status}`;
    }
    // The settle invalidates the cached inventory server-side; rebuild it.
    inventory.value = null;
    await loadInventory();
  } catch (err) {
    if (epoch !== nodeEpoch) return;
    modelDeleteError.value = err instanceof Error ? err.message : String(err);
  } finally {
    if (epoch === nodeEpoch) deleteBusy.value = false;
  }
}

watch(
  () => props.nodeId,
  () => {
    nodeEpoch += 1;
    inventorySeq += 1;
    inventoryAutoTried = false;
    inventory.value = null;
    inventoryUpdatedAt.value = null;
    inventoryState.value = "loading";
    inventoryError.value = null;
    inventoryBusy.value = false;
    modelFilter.value = "";
    deleteTarget.value = null;
    deleteJob.value = null;
    deleteBusy.value = false;
    modelDeleteError.value = null;
    void loadInventory();
  },
);

/* ── Agent update (IRI-012) ─────────────────────────────────────────────── */

const updateBusy = ref(false);
const updateMsg = ref<string | null>(null);
let updateDisposed = false;
onUnmounted(() => {
  updateDisposed = true;
});

/** Drift chip/button state: hidden entirely on unknown or matching versions. */
const drift = computed(() => agentDrifts(node.value?.agentVersion));
const updateLabel = computed(() =>
  updateBusy.value ? "updating…" : serverVersion.value !== null ? `Update agent → ${serverVersion.value}` : "Update agent",
);

/**
 * Dispatches the self-update and polls the job to a terminal state. Success
 * is settled server-side on the node's next hello (the restart severs the
 * socket mid-job), which this poll picks up; live agentVersion arrives via
 * the SSE node-online event regardless.
 */
async function updateAgent(): Promise<void> {
  if (node.value === null || updateBusy.value) return;
  const forNode = props.nodeId;
  updateBusy.value = true;
  updateMsg.value = "dispatching update — the agent restarts and reconnects…";
  try {
    const job = await startAgentUpdate(node.value.id);
    const deadline = Date.now() + 15 * 60_000;
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      // NodeDetail is one instance across navigations (IRI-010): stop the
      // poll and leave the refs alone when the user moved on.
      if (updateDisposed || props.nodeId !== forNode) return;
      const detail = await fetchJob(job.id);
      if (detail.job.status === "succeeded") {
        updateMsg.value = `agent updated to ${serverVersion.value ?? "the hub version"} — running setups were restarted`;
        void live.refreshNodes();
        break;
      }
      if (detail.job.status === "failed" || detail.job.status === "canceled") {
        updateMsg.value = `update failed: ${detail.output.at(-1)?.line ?? detail.job.status}`;
        break;
      }
      if (Date.now() > deadline) {
        updateMsg.value = "update timed out — check the job output and the node journal";
        break;
      }
    }
  } catch (err) {
    updateMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    if (props.nodeId === forNode) updateBusy.value = false;
  }
}

const cleanupOpen = ref(false);

/* ── Node management (IRI-010) ──────────────────────────────────────────── */

const editOpen = ref(false);
const rotateOpen = ref(false);
const deleteError = ref<string | null>(null);
/** Armed two-click delete (ServeView onRemove pattern): 4 s window. */
const armedDelete = ref(false);
let deleteTimer: ReturnType<typeof setTimeout> | undefined;

async function onRemove(): Promise<void> {
  if (!armedDelete.value) {
    armedDelete.value = true;
    clearTimeout(deleteTimer);
    deleteTimer = setTimeout(() => (armedDelete.value = false), 4000);
    return;
  }
  clearTimeout(deleteTimer);
  armedDelete.value = false;
  deleteError.value = null;
  try {
    await deleteNode(props.nodeId);
    await live.refreshNodes();
    // The node no longer exists — back to the fleet grid.
    if (typeof location !== "undefined") location.hash = "#/";
  } catch (err) {
    deleteError.value = err instanceof Error ? err.message : String(err);
  }
}

/** NodeDetail is ONE component instance across navigations (the router only
 *  patches :node-id) — an armed delete must never carry over to the next
 *  node, or the second click would remove the wrong one. */
watch(
  () => props.nodeId,
  () => {
    armedDelete.value = false;
    deleteError.value = null;
    clearTimeout(deleteTimer);
  },
);
onUnmounted(() => clearTimeout(deleteTimer));
</script>

<template>
  <div>
    <div class="pagehead">
      <div>
        <p class="label" style="margin: 0 0 4px;">Nodes / {{ node?.name ?? "…" }}</p>
        <div class="row">
          <h1>{{ node?.name ?? nodeId }}</h1>
          <template v-if="card">
            <span v-if="card.role !== 'standalone'" class="chip chip--accent">{{ card.role }}</span>
            <span class="chip">{{ card.kind }}</span>
            <span class="chip" :class="statusChipClass">
              <span class="dot" :class="card.dotClass" aria-hidden="true"></span>{{ card.statusText }}
            </span>
            <span class="chip">{{ node?.host }}</span>
            <span v-if="card.agentVersion" class="chip">Agent {{ card.agentVersion }}</span>
            <span v-if="drift" class="chip chip--warn">update available</span>
          </template>
          <template v-if="node">
            <button class="btn btn--ghost btn--sm" @click="editOpen = true">Edit</button>
            <button class="btn btn--ghost btn--sm" @click="rotateOpen = true">Rotate token</button>
            <button
              v-if="drift"
              class="btn btn--secondary btn--sm"
              :disabled="updateBusy || node.online !== true"
              title="Restarts the agent — running setups and benches on this node stop"
              @click="updateAgent"
            >{{ updateLabel }}</button>
            <button class="btn btn--ghost btn--sm" @click="onRemove">{{ armedDelete ? "Confirm delete" : "Delete" }}</button>
          </template>
          <button
            class="btn btn--secondary btn--sm"
            title="Audit and reclaim disk space — caches, journal, /tmp; dry-run plan first, nothing deleted without a typed confirm"
            @click="cleanupOpen = true"
          >Disk hygiene</button>
          <a class="chip detail-back" href="#/">← Overview</a>
        </div>
        <p v-if="updateMsg" class="stat__sub" style="margin-top: 8px;">{{ updateMsg }}</p>
        <p v-if="notFound" class="muted" style="margin-top: 8px;">
          Node not found in the registry — it may have been removed.
        </p>
        <p v-if="deleteError" class="banner banner--warn" style="margin-top: 8px;">{{ deleteError }}</p>
      </div>
    </div>

    <h2 style="margin-bottom: 10px;">Live</h2>
    <section class="cols cols-2" style="margin-bottom: 12px;">
      <article class="card">
        <div class="card__head">
          <h3>Sensors</h3>
          <span v-if="card" class="mono faint">{{ card.online ? "streaming" : "offline" }}</span>
        </div>
        <div class="card__body" style="padding-top: 12px;">
          <template v-if="card?.hasSnapshot">
            <div v-for="row in card.rows" :key="row.key" class="barrow">
              <span>{{ row.label }}</span>
              <div class="bar"><div class="bar__fill" :style="{ width: (row.barPct ?? 0) + '%' }"></div><div v-if="row.freePct !== undefined" class="bar__fill bar__fill--free" :style="{ width: row.freePct + '%' }"></div></div>
              <span class="val" :class="{ 'metric--hot': row.warn === true }">{{ row.line }}<template v-if="row.tempC !== null"><template v-if="row.line"> · </template><span :class="{ 'metric--hot': isHotTemp(row.tempC) }">{{ formatTemp(row.tempC) }}</span></template></span>
            </div>
          </template>
          <p v-else class="muted">waiting for first snapshot</p>
        </div>
      </article>
    </section>

    <h2 style="margin-bottom: 10px;">Inference</h2>
    <p v-if="llmPanels.length === 0" class="muted" style="margin: 0 0 12px;">no LLM ports configured</p>
    <section v-else class="cols cols-2" style="margin-bottom: 12px;">
      <LlmPanel
        v-for="panel in llmPanels"
        :key="panel.view.port"
        :port="panel.view"
        :decode="panel.decode"
        :prefill="panel.prefill"
        :range="range"
      />
    </section>
    <p
      v-if="llmState === 'error' && llmPanels.length > 0"
      class="stat__sub"
      style="margin: -2px 0 12px;"
    >inference history unavailable — showing live probes only</p>

    <h2 style="margin-bottom: 10px;">Models</h2>

    <p v-if="inventoryState === 'error'" class="banner banner--warn" style="margin-bottom: 12px;">
      inventory unavailable — {{ inventoryError }}
      <button class="btn btn--sm btn--secondary" type="button" @click="loadInventory">Retry</button>
    </p>
    <div v-else-if="inventory === null" class="row row--between" style="margin-bottom: 12px;">
      <span class="muted">
        {{ inventoryBusy ? "reading the node's caches…" : node?.online === true ? "no inventory yet" : "node offline — no inventory" }}
      </span>
      <button class="btn btn--secondary btn--sm" :disabled="inventoryBusy || node?.online !== true" @click="refreshInventory">
        {{ inventoryBusy ? "reading…" : "Read models" }}
      </button>
    </div>
    <template v-else>
      <p v-if="inventoryError" class="banner banner--warn" style="margin-bottom: 12px;">{{ inventoryError }}</p>

      <!-- IRI-034: the store card carries the Refresh affordance on the store
           node; every other case still needs one in reach. -->
      <div v-if="!(inventory.store && node?.kind === 'nas')" class="row row--between" style="margin-bottom: 12px;">
        <span class="muted">
          {{ inventoryBusy ? "reading the node's caches…" : inventory.store ? "store catalog renders on the store node" : "local caches" }}
          <span v-if="inventoryReadLabel && !inventoryBusy" class="stat__sub faint">— read {{ inventoryReadLabel }}</span>
        </span>
        <button class="btn btn--secondary btn--sm" :disabled="inventoryBusy || node?.online !== true" @click="refreshInventory">
          {{ inventoryBusy ? "reading…" : "Refresh" }}
        </button>
      </div>

      <article v-if="inventory.store && node?.kind === 'nas'" class="card" style="margin-bottom: 12px;">
        <div class="card__head">
          <h3>Store</h3>
          <span class="chip">{{ inventory.store.source }}</span>
          <span class="mono faint model-root">{{ storeMount }}</span>
          <span class="stat__sub">{{ inventorySummary(inventory.store.models) }}</span>
          <span v-if="inventoryReadLabel" class="stat__sub faint">read {{ inventoryReadLabel }}</span>
          <button class="btn btn--secondary btn--sm" :disabled="inventoryBusy" @click="refreshInventory">
            {{ inventoryBusy ? "reading…" : "Refresh" }}
          </button>
        </div>
        <div class="card__body" style="padding-top: 12px;">
          <p v-if="inventory.store.warning" class="stat__sub faint">{{ inventory.store.warning }}</p>

          <div
            v-for="leftover in inventory.store.leftovers"
            :key="leftover.object"
            class="banner banner--warn"
            style="display: block; margin-bottom: 8px;"
          >
            <div class="row row--between">
              <span><strong>{{ leftoverLabel(leftover) }}</strong> — failed delete leftover</span>
              <span class="mono">{{ leftover.bytes !== null ? fmtBytes(leftover.bytes) : "size unknown" }}</span>
            </div>
            <p class="stat__sub mono model-object">{{ leftover.object }}</p>
            <p v-if="leftover.error" class="stat__sub">{{ leftover.error }}</p>
            <div class="row" style="gap: 8px; margin-top: 6px;">
              <button
                class="btn btn--danger btn--sm"
                :disabled="deleteBusy || leftover.target === null"
                @click="askDelete({ scope: 'leftover', name: leftover.name, object: leftover.object, target: leftover.target ?? '', bytes: leftover.bytes, error: leftover.error })"
              >Remove leftover</button>
              <span v-if="leftover.target === null" class="stat__sub faint">no gc-objects target derivable</span>
            </div>
          </div>

          <div class="model-toolbar">
            <input v-model="modelFilter" class="input" placeholder="Filter by name or repository…" aria-label="Filter store models" />
            <span class="stat__sub faint">{{ storeRows.length }} of {{ inventory.store.models.length }}</span>
          </div>
          <p v-if="inventory.store.models.length === 0" class="muted">no active models in the store</p>
          <div v-else class="model-scroll">
            <table class="table">
              <thead><tr><th>Model</th><th>Repository</th><th>Runtime</th><th>Size</th><th></th></tr></thead>
              <tbody>
                <tr v-for="m in storeRows" :key="m.name">
                  <td class="model-name">{{ m.name }}</td>
                  <td class="model-repo" :title="m.repository">{{ m.repository }}</td>
                  <td><span class="chip">{{ m.runtime }}</span></td>
                  <td class="mono">{{ m.bytes !== null ? fmtBytes(m.bytes) : "—" }}</td>
                  <td style="text-align: right;">
                    <button
                      class="btn btn--ghost btn--sm"
                      :disabled="deleteBusy"
                      @click="askDelete({ scope: 'store', name: m.name, repository: m.repository, bytes: m.bytes })"
                    >Delete</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </article>

      <article
        v-for="cache in inventory.local"
        :key="`${cache.user}:${cache.cacheDir}`"
        class="card"
        style="margin-bottom: 12px;"
      >
        <div class="card__head">
          <h3>Local cache</h3>
          <span class="chip">{{ cache.user }}</span>
          <span class="mono faint model-root">{{ cache.cacheDir }}</span>
          <span v-if="cache.modelctlVersion" class="stat__sub faint">modelctl {{ cache.modelctlVersion }}</span>
          <span class="stat__sub">{{ inventorySummary(cache.models) }}</span>
        </div>
        <div class="card__body" style="padding-top: 12px;">
          <p v-if="cache.error" class="banner banner--warn">{{ cache.error }}</p>
          <p v-else-if="cache.models.length === 0" class="muted">no local registrations</p>
          <table v-else class="table">
            <thead><tr><th>Model</th><th>Repository</th><th>Runtime</th><th>Size</th><th></th></tr></thead>
            <tbody>
              <tr v-for="m in cache.models" :key="m.name">
                <td class="model-name">{{ m.name }}</td>
                <td class="model-repo" :title="m.repository">{{ m.repository }}</td>
                <td><span class="chip">{{ m.runtime }}</span></td>
                <td class="mono">{{ m.bytes !== null ? fmtBytes(m.bytes) : "—" }}</td>
                <td style="text-align: right;">
                  <button
                    class="btn btn--ghost btn--sm"
                    :disabled="deleteBusy"
                    @click="askDelete({ scope: 'local', name: m.name, repository: m.repository, bytes: m.bytes, user: cache.user, cacheDir: cache.cacheDir })"
                  >Delete</button>
                </td>
              </tr>
            </tbody>
          </table>
          <template v-if="cache.error === null && cache.orphans.length > 0">
            <p class="stat__sub" style="margin: 12px 0 6px;">unregistered cache entries — verified against the NAS by hash, nothing transferred</p>
            <table class="table">
              <thead><tr><th>Unregistered</th><th style="text-align: right;">Register</th></tr></thead>
              <tbody>
                <tr v-for="repo in cache.orphans" :key="repo">
                  <td class="model-repo" :title="repo">{{ repo }}</td>
                  <td style="text-align: right;">
                    <button class="btn btn--ghost btn--sm" :disabled="deleteBusy" @click="askRegister(repo, cache.user)">Register</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </template>
        </div>
      </article>
      <p v-if="inventory.local.length === 0" class="muted" style="margin-bottom: 12px;">no HF cache found for any user on this node</p>
    </template>

    <div v-if="deleteBusy || deleteJob !== null || modelDeleteError !== null" class="card" style="margin-bottom: 12px;">
      <div class="card__head">
        <h3>Model operation</h3>
        <span v-if="deleteJob" class="chip" :class="jobStatusChip(deleteJob.job.status).cls">{{ jobStatusChip(deleteJob.job.status).label }}</span>
        <button v-if="deleteRunning" class="btn btn--danger btn--sm" @click="cancelDelete">Cancel</button>
      </div>
      <div class="card__body" style="padding-top: 12px;">
        <p v-if="modelDeleteError" class="banner banner--warn">{{ modelDeleteError }}</p>
        <pre v-if="deleteJob" class="model-log mono faint">{{ deleteJob.output.map((o) => o.line).slice(-10).join("\n") || "waiting for output…" }}</pre>
        <p v-else-if="deleteBusy" class="stat__sub">dispatching…</p>
      </div>
    </div>

    <h2 style="margin-bottom: 10px;">History</h2>
    <div class="row row--between detail-range" style="margin-bottom: 12px;">
      <div class="seg" role="group" aria-label="History range">
        <button
          v-for="r in HISTORY_RANGES"
          :key="r"
          type="button"
          :class="{ 'is-active': r === range }"
          @click="range = r"
        >{{ r }}</button>
      </div>
      <span class="mono faint">{{ historyMeta }}</span>
    </div>

    <div
      v-if="loadState === 'error'"
      class="banner banner--warn"
      role="alert"
      style="margin-bottom: 12px; flex-wrap: wrap; row-gap: 8px;"
    >
      <span class="grow">history unavailable — {{ errorMessage }}</span>
      <button class="btn btn--sm btn--secondary" type="button" @click="load">Retry</button>
    </div>

    <section v-if="loadState === 'ready'" class="cols cols-2">
      <article class="card">
        <div class="card__head"><h3>CPU</h3><span class="mono faint">{{ detail.cpu.current }}</span></div>
        <div class="card__body" style="padding-top: 12px;">
          <template v-if="detail.cpu.current">
            <Sparkline :points="detail.cpu.series" :domain="{ min: 0, max: 100 }" :format="tipPct" :aria-label="`CPU usage, ${range}`" />
            <p v-if="detail.cpu.sub" class="stat__sub" style="margin-top: 8px;">{{ detail.cpu.sub }}</p>
            <p v-for="note in detail.cpu.notes" :key="note" class="stat__sub">{{ note }}</p>
          </template>
          <p v-else class="muted">no data yet</p>
        </div>
      </article>

      <article class="card">
        <div class="card__head"><h3>Memory</h3><span class="mono faint">{{ detail.memory.current }}</span></div>
        <div class="card__body" style="padding-top: 12px;">
          <template v-if="detail.memory.current">
            <Sparkline :points="detail.memory.series" :format="fmtBytes" :aria-label="`Memory used, ${range}`" />
            <p v-if="detail.memory.sub" class="stat__sub" style="margin-top: 8px;">{{ detail.memory.sub }}</p>
            <p v-for="note in detail.memory.notes" :key="note" class="stat__sub">{{ note }}</p>
          </template>
          <p v-else class="muted">no data yet</p>
        </div>
      </article>

      <article class="card">
        <div class="card__head"><h3>GPU</h3><span class="mono faint">{{ detail.gpu.current }}</span></div>
        <div class="card__body" style="padding-top: 12px;">
          <template v-if="detail.gpu.current">
            <Sparkline :points="detail.gpu.series" :domain="{ min: 0, max: 100 }" :format="tipPct" :aria-label="`GPU usage, ${range}`" />
            <p v-if="detail.gpu.sub" class="stat__sub" style="margin-top: 8px;">{{ detail.gpu.sub }}</p>
            <p v-for="note in detail.gpu.notes" :key="note" class="stat__sub">{{ note }}</p>
          </template>
          <p v-else class="muted">no data yet</p>
        </div>
      </article>

      <article class="card">
        <div class="card__head"><h3>Network</h3><span class="mono faint">{{ detail.network.current }}</span></div>
        <div class="card__body" style="padding-top: 12px;">
          <template v-if="detail.network.current">
            <div class="barrow">
              <span>RX</span>
              <Sparkline :points="detail.network.series" :height="36" :format="tipRate" :aria-label="`Network receive, ${range}`" />
              <span class="val">{{ detail.network.current }}</span>
            </div>
            <div v-if="detail.network.series2" class="barrow">
              <span>TX</span>
              <Sparkline :points="detail.network.series2" :height="36" :format="tipRate" :aria-label="`Network transmit, ${range}`" />
              <span class="val">{{ detail.network.sub }}</span>
            </div>
          </template>
          <p v-else class="muted">no data yet</p>
        </div>
      </article>
    </section>

    <NodeModal v-if="editOpen && node !== null" mode="edit" :node="node" @close="editOpen = false" />
    <NodeModal v-if="rotateOpen && node !== null" mode="rotate" :node="node" @close="rotateOpen = false" />
    <CleanupDrawer v-if="cleanupOpen && node !== null" :node-id="nodeId" :node-name="node.name" @close="cleanupOpen = false" />

    <!-- IRI-028: model delete confirmation (store / local cache / leftover) -->
    <div v-if="deleteTarget !== null && deleteCopy !== null" class="drawer-scrim" @click.self="deleteTarget = null">
      <section class="card confirm-card" role="alertdialog" aria-modal="true" :aria-label="deleteCopy.title">
        <div class="card__head">
          <h3>{{ deleteCopy.title }}</h3>
          <button class="btn btn--secondary btn--sm" @click="deleteTarget = null">Close</button>
        </div>
        <p class="stat__sub" style="margin: 0;">{{ deleteCopy.body }}</p>
        <div class="row row--between">
          <span class="stat__sub faint">nothing is deleted until you confirm</span>
          <div class="row">
            <button class="btn btn--secondary btn--sm" @click="deleteTarget = null">Cancel</button>
            <button class="btn btn--danger btn--sm" :disabled="deleteBusy" @click="runDelete">{{ deleteCopy.danger }}</button>
          </div>
        </div>
      </section>
    </div>

    <!-- IR-104: register-from-cache confirmation (verify-then-register, no transfer) -->
    <div v-if="registerTarget !== null && registerCopyText !== null" class="drawer-scrim" @click.self="registerTarget = null">
      <section class="card confirm-card" role="alertdialog" aria-modal="true" :aria-label="registerCopyText.title">
        <div class="card__head">
          <h3>{{ registerCopyText.title }}</h3>
          <button class="btn btn--secondary btn--sm" @click="registerTarget = null">Close</button>
        </div>
        <p class="stat__sub" style="margin: 0;">{{ registerCopyText.body }}</p>
        <div class="row row--between">
          <span class="stat__sub faint">verification is read-only — nothing is transferred</span>
          <div class="row">
            <button class="btn btn--secondary btn--sm" @click="registerTarget = null">Cancel</button>
            <button class="btn btn--secondary btn--sm" :disabled="deleteBusy" @click="runRegister">{{ registerCopyText.danger }}</button>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.detail-back {
  display: inline-flex;
  align-items: center;
  min-height: 34px;
}

/* The h1 falls back to the raw node id until the registry loads; keep the
   36-char UUID from forcing horizontal overflow on 390px phones. */
h1 {
  overflow-wrap: anywhere;
}

/* IRI-028: node model tables */
.model-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.model-toolbar .input {
  flex: 1;
  min-width: 0;
}
.model-scroll {
  max-height: 360px;
  overflow: auto;
}
.model-name {
  font-family: var(--font-mono);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.model-repo {
  color: var(--muted);
  font-size: 12px;
  max-width: 340px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-root,
.model-object {
  overflow-wrap: anywhere;
}
.model-object {
  margin: 4px 0;
}
.model-log {
  max-height: 180px;
  overflow: auto;
  white-space: pre-wrap;
}
.confirm-card {
  width: min(520px, 92vw);
  max-height: 86vh;
  overflow: auto;
  padding: 14px;
  display: grid;
  gap: 12px;
}

@media (max-width: 720px) {
  .detail-back {
    min-height: 44px;
  }
  .detail-range {
    width: 100%;
  }
  .detail-range .seg button {
    min-height: 44px;
  }
}
</style>
