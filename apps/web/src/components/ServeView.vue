<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { fetchCleanup, fetchNodes, fetchNodeLlm, type LlmSnapshot } from "../api";
import { fetchModelsPage, fetchPlacement } from "../models";
import { setupChip, type NodeInfo, type SetupTransfer, type TransferStage } from "@irori/core";
import {
  cancelTransfer,
  createSetup,
  createTransfer,
  deleteSetup,
  fetchSetups,
  fetchSetup,
  fmtEta,
  openSetupLog,
  patchSetup,
  setupChipCls,
  setupNodeLines,
  setupSubline,
  stagePercent,
  stageVal,
  startSetup,
  stopSetup,
  validateScripts,
  type SetupCreateInput,
  type SetupInfo,
  type SetupLogLine,
} from "../serve";

/* ── Fleet + setups state ─────────────────────────────────────────────────── */

const nodes = ref<NodeInfo[]>([]);
const setups = ref<SetupInfo[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const headLlm = ref<Map<string, LlmSnapshot | null>>(new Map());
let pollTimer: ReturnType<typeof setInterval> | undefined;
let loadSeq = 0;

async function load(): Promise<void> {
  const seq = ++loadSeq;
  try {
    const rows = await fetchSetups();
    if (seq !== loadSeq) return;
    setups.value = rows;
    error.value = null;
  } catch (err) {
    if (seq !== loadSeq) return;
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    if (seq === loadSeq) loading.value = false;
  }
}

function chipOf(setup: SetupInfo): string {
  return setupChip(setup);
}

async function refreshLlm(rows: SetupInfo[]): Promise<void> {
  const seen = new Set<string>();
  for (const setup of rows) {
    if (seen.has(setup.headNodeId)) continue;
    seen.add(setup.headNodeId);
    try {
      headLlm.value.set(setup.headNodeId, await fetchNodeLlm(setup.headNodeId));
    } catch {
      // Keep the last good snapshot; retried on the next poll. Seeding once
      // froze tok/s at page-load values and cached "no probe" forever after
      // a single failed fetch.
    }
  }
}

function decodeTps(setup: SetupInfo): number | null {
  const snap = headLlm.value.get(setup.headNodeId) ?? null;
  if (snap === null) return null;
  const port = snap.ports.find((p) => p.port === setup.port);
  return port?.decodeTps ?? null;
}

onMounted(async () => {
  try {
    nodes.value = await fetchNodes();
  } catch {
    /* registry unavailable — cards still render */
  }
  await load();
  await refreshLlm(setups.value);
  pollTimer = setInterval(() => {
    void load();
    void fetchNodes()
      .then((rows) => {
        nodes.value = rows;
      })
      .catch(() => {});
    void refreshLlm(setups.value);
    if (selected.value !== null) void refreshDetail();
    if (wizardOpen.value && activeTransfer.value !== null && created.value !== null) void refreshWizardTransfer();
  }, 2500);
});

onBeforeUnmount(() => {
  clearInterval(pollTimer);
  closeLog();
});

/* ── Card actions ─────────────────────────────────────────────────────────── */

const actionError = ref<string | null>(null);

async function onStart(setup: SetupInfo): Promise<void> {
  actionError.value = null;
  try {
    await startSetup(setup.id);
    await load();
  } catch (err) {
    actionError.value = err instanceof Error ? err.message : String(err);
  }
}

/** Armed stop: first click arms, second within 4 s confirms. */
const armedStop = ref<string | null>(null);
let armedTimer: ReturnType<typeof setTimeout> | undefined;

function onArmStop(setup: SetupInfo): void {
  if (armedStop.value !== setup.id) {
    armedStop.value = setup.id;
    clearTimeout(armedTimer);
    armedTimer = setTimeout(() => {
      armedStop.value = null;
    }, 4000);
    return;
  }
  clearTimeout(armedTimer);
  armedStop.value = null;
  void onStop(setup);
}

async function onStop(setup: SetupInfo): Promise<void> {
  actionError.value = null;
  try {
    await stopSetup(setup.id);
    await load();
  } catch (err) {
    actionError.value = err instanceof Error ? err.message : String(err);
  }
}

/* ── Detail drawer ────────────────────────────────────────────────────────── */

const selected = ref<SetupInfo | null>(null);
const detail = ref<{ setup: SetupInfo; transfers: SetupTransfer[] } | null>(null);
const detailError = ref<string | null>(null);
const logLines = ref<SetupLogLine[]>([]);
let closeLogFn: (() => void) | null = null;
let detailId: string | null = null;

function closeLog(): void {
  closeLogFn?.();
  closeLogFn = null;
}

async function openDetail(setup: SetupInfo): Promise<void> {
  selected.value = setup;
  detailError.value = null;
  logLines.value = [];
  detailId = setup.id;
  closeLog();
  closeLogFn = openSetupLog(
    setup.id,
    (line) => {
      logLines.value.push(line);
      if (logLines.value.length > 500) logLines.value.splice(0, logLines.value.length - 500);
    },
    () => {},
  );
  await refreshDetail();
}

async function refreshDetail(): Promise<void> {
  if (selected.value === null) return;
  const id = selected.value.id;
  try {
    const d = await fetchSetup(id);
    if (detailId !== d.setup.id) return;
    detail.value = d;
    selected.value = d.setup;
    detailError.value = null; // success clears a stale banner
  } catch (err) {
    if (detailId !== id) return; // the failing request no longer owns the drawer
    detailError.value = err instanceof Error ? err.message : String(err);
  }
}

function closeDetail(): void {
  selected.value = null;
  detail.value = null;
  detailId = null;
  closeLog();
}

const latestStages = computed<TransferStage[]>(() => {
  const transfers = detail.value?.transfers ?? [];
  if (transfers.length === 0) return [];
  return transfers[0]!.stages;
});

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

/** Duplicate: opens the wizard prefilled with a fresh name. */
function onDuplicate(setup: SetupInfo): void {
  openWizard(setup);
  wizard.value.name = `${setup.name} (copy)`;
  wizard.value.editId = null;
}

async function onRemove(setup: SetupInfo): Promise<void> {
  if (armedStop.value !== `rm-${setup.id}`) {
    armedStop.value = `rm-${setup.id}`;
    clearTimeout(armedTimer);
    armedTimer = setTimeout(() => {
      armedStop.value = null;
    }, 4000);
    return;
  }
  clearTimeout(armedTimer);
  armedStop.value = null;
  try {
    await deleteSetup(setup.id);
    closeDetail();
    await load();
  } catch (err) {
    actionError.value = err instanceof Error ? err.message : String(err);
  }
}

/* ── Wizard ───────────────────────────────────────────────────────────────── */

const wizardOpen = ref(false);
const step = ref(1);
const busy = ref(false);
const wizardError = ref<string | null>(null);

interface WizardState {
  editId: string | null;
  name: string;
  kind: "single" | "cluster";
  headNodeId: string;
  workerIds: string[];
  model: string;
  scriptStart: string;
  scriptStop: string;
  envModelName: boolean;
  envPort: boolean;
  envExtraArgs: boolean;
  extraArgs: string;
  envModelPath: boolean;
  /** M8: route traffic through the agent capture proxy (ADR-0008). */
  capture: boolean;
}

const wizard = ref<WizardState>({
  editId: null,
  name: "",
  kind: "single",
  headNodeId: "",
  workerIds: [],
  model: "",
  scriptStart: "",
  scriptStop: "",
  envModelName: false,
  envPort: true,
  envExtraArgs: false,
  extraArgs: "",
  envModelPath: true,
  capture: false,
});

function openWizard(from?: SetupInfo): void {
  wizardOpen.value = true;
  step.value = 1;
  wizardError.value = null;
  validation.value = null;
  placementRows.value = null;
  created.value = null;
  activeTransfer.value = null;
  const w = wizard.value;
  w.editId = from?.id ?? null;
  w.name = from?.name ?? "";
  w.kind = from?.kind ?? "single";
  w.headNodeId = from?.headNodeId ?? firstHeadId();
  w.workerIds = from ? from.nodes.map((n) => n.nodeId) : [];
  w.model = from?.model ?? "";
  w.scriptStart = from?.scriptStart ?? "";
  w.scriptStop = from?.scriptStop ?? "";
  if (from) {
    w.envModelName = from.env.modelName;
    w.envPort = from.env.port;
    w.envExtraArgs = from.env.extraArgs.length > 0;
    w.extraArgs = from.env.extraArgs;
    w.envModelPath = from.env.modelPath;
    w.capture = from.captureProxy === true;
  } else {
    w.envModelName = false;
    w.envPort = true;
    w.envExtraArgs = false;
    w.extraArgs = "";
    w.envModelPath = true;
    w.capture = false;
  }
  w.model = from?.model ?? "";
  loadModelChoices("");
}

function firstHeadId(): string {
  const preferred = nodes.value.find((n) => n.online && n.role === "head") ?? nodes.value.find((n) => n.online);
  return preferred?.id ?? nodes.value[0]?.id ?? "";
}

/** ADR-0008 §7: capture setups pre-fill EXTRA_ARGS with a loopback-bind hint. */
function onCaptureToggle(): void {
  if (wizard.value.capture && !wizard.value.envExtraArgs && wizard.value.extraArgs.trim().length === 0) {
    wizard.value.envExtraArgs = true;
    wizard.value.extraArgs = "--host 127.0.0.1";
  }
}

function closeWizard(): void {
  wizardOpen.value = false;
}

const STEPS = ["Type", "Model", "Scripts", "Placement", "Review"];

function nextStep(): void {
  wizardError.value = null;
  if (step.value === 1 && wizard.value.headNodeId === "") {
    wizardError.value = "pick a head node";
    return;
  }
  if (step.value === 2 && wizard.value.model === "") {
    wizardError.value = "pick a model";
    return;
  }
  if (step.value === 3 && (wizard.value.scriptStart === "" || wizard.value.scriptStop === "")) {
    wizardError.value = "a stop script is required — both paths are needed";
    return;
  }
  if (step.value < 5) {
    step.value += 1;
    if (step.value === 2) void loadModelChoices("");
    if (step.value === 4) void loadPlacement();
  }
}

function prevStep(): void {
  wizardError.value = null;
  if (step.value > 1) step.value -= 1;
}

/* Step 2 — model search over the NAS catalog (chained HF handled in step 4). */

const modelChoices = ref<Array<{ name: string; runtime: string; bytes: number }>>([]);
const modelSearch = ref("");

async function loadModelChoices(q: string): Promise<void> {
  try {
    const page = await fetchModelsPage(1, q, "name");
    modelChoices.value = page.models.slice(0, 8).map((m) => ({ name: m.name, runtime: m.runtime, bytes: m.bytes }));
  } catch {
    modelChoices.value = [];
  }
}

let searchTimer: ReturnType<typeof setTimeout> | undefined;
function onModelSearch(): void {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void loadModelChoices(modelSearch.value), 300);
}

function onPickModel(name: string): void {
  wizard.value.model = name;
  placementRows.value = null;
}

/* Step 3 — create-time script validation via the head agent (test -x). */

const validation = ref<Array<{ script: string; ok: boolean; error: string | null }> | null>(null);
const validating = ref(false);

async function onValidate(): Promise<void> {
  validating.value = true;
  validation.value = null;
  wizardError.value = null;
  try {
    validation.value = await validateScripts(wizard.value.headNodeId, [wizard.value.scriptStart, wizard.value.scriptStop]);
  } catch (err) {
    wizardError.value = err instanceof Error ? err.message : String(err);
  } finally {
    validating.value = false;
  }
}

/* Step 4 — placement: per-node plan + staged transfers on the created setup. */

const placementRows = ref<null | Array<{ node: { id: string; name: string; role: string; online: boolean }; action: string; reason: string | null; bytes: number | null }>>(null);

// Placement tie-in (SPEC §11.6): a failed capacity check offers
// "Clean up disk — est. +N GB" from the node's latest audit.
const CAPACITY_RE = /needs \d+ bytes, only \d+ free/;
const capacityRows = computed(() => (placementRows.value ?? []).filter((p) => p.action === "unavailable" && p.reason !== null && CAPACITY_RE.test(p.reason)));
const hygieneOffers = ref<Map<string, number>>(new Map());
const hygieneNode = ref<{ id: string; name: string } | null>(null);
watch(capacityRows, (rows) => {
  for (const row of rows) {
    if (hygieneOffers.value.has(row.node.id)) continue;
    void fetchCleanup(row.node.id)
      .then((state) => {
        const report = state.latestAudit?.report;
        const categories = report !== null && report !== undefined && Array.isArray((report as { categories?: unknown }).categories)
          ? (report as { categories: Array<{ reclaimableBytes: number }> }).categories
          : [];
        hygieneOffers.value.set(row.node.id, categories.reduce((sum, c) => sum + c.reclaimableBytes, 0));
      })
      .catch(() => hygieneOffers.value.set(row.node.id, 0));
  }
});
function openHygiene(nodeId: string, name: string): void {
  hygieneNode.value = { id: nodeId, name };
}
const created = ref<SetupInfo | null>(null);
const activeTransfer = ref<SetupTransfer | null>(null);

function targetIds(): string[] {
  return wizard.value.kind === "cluster" ? [wizard.value.headNodeId, ...wizard.value.workerIds] : [wizard.value.headNodeId];
}

/** The setup payload from the wizard's current state. */
function wizardInput(): SetupCreateInput {
  const w = wizard.value;
  return {
    name: w.name.trim() || w.model,
    kind: w.kind,
    model: w.model,
    port: wizardPort.value,
    headNodeId: w.headNodeId,
    nodes: w.kind === "cluster" ? w.workerIds.map((nodeId) => ({ nodeId, role: "worker" as const })) : [],
    scriptStart: w.scriptStart,
    scriptStop: w.scriptStop,
    env: {
      modelName: w.envModelName,
      port: w.envPort,
      extraArgs: w.envExtraArgs ? w.extraArgs : "",
      modelPath: w.envModelPath,
    },
    captureProxy: w.capture,
  };
}

async function ensureCreated(): Promise<SetupInfo> {
  if (created.value !== null) return created.value;
  if (wizard.value.editId !== null) {
    // Edit: transfers run against the EXISTING setup — patch it with the
    // wizard's values first so the plan matches what will be saved.
    const patched = await patchSetup(wizard.value.editId, wizardInput());
    created.value = patched;
    return patched;
  }
  const setup = await createSetup(wizardInput());
  created.value = setup;
  return setup;
}

/** Serving port — the script owns it; Irori needs it for probes and env. */
const wizardPort = ref(8080);

async function loadPlacement(): Promise<void> {
  placementRows.value = null;
  if (wizard.value.model === "") return;
  try {
    const res = await fetchPlacement(wizard.value.model);
    const wanted = new Set(targetIds());
    placementRows.value = res.placements.filter((p) => wanted.has(p.node.id));
  } catch {
    placementRows.value = null; // model absent from the catalog — staged HF chain
  }
}

const staging = ref(false);

async function onStageTransfers(): Promise<void> {
  staging.value = true;
  wizardError.value = null;
  try {
    const setup = await ensureCreated();
    const missing = (placementRows.value ?? []).filter((p) => p.action !== "present").map((p) => p.node.id);
    if (missing.length === 0) {
      wizardError.value = "nothing to transfer — every node has the model";
      return;
    }
    activeTransfer.value = await createTransfer(setup.id, missing);
  } catch (err) {
    wizardError.value = err instanceof Error ? err.message : String(err);
  } finally {
    staging.value = false;
  }
}

async function onCancelTransfer(): Promise<void> {
  if (activeTransfer.value === null) return;
  try {
    await cancelTransfer(activeTransfer.value.id);
  } catch (err) {
    wizardError.value = err instanceof Error ? err.message : String(err);
  }
}

/** Live staged progress: pulls the transfer's stages from the server. */
async function refreshWizardTransfer(): Promise<void> {
  if (created.value === null || activeTransfer.value === null) return;
  try {
    const d = await fetchSetup(created.value.id);
    const t = d.transfers.find((x) => x.id === activeTransfer.value!.id);
    if (t) activeTransfer.value = t;
  } catch {
    /* transient — the next poll retries */
  }
}

/* Step 5 — create (if the placement step was skipped) and start. */

async function onFinish(): Promise<void> {
  busy.value = true;
  wizardError.value = null;
  try {
    if (wizard.value.editId !== null) {
      await patchSetup(wizard.value.editId, wizardInput());
    } else {
      const setup = created.value ?? (await createSetup(wizardInput()));
      created.value = setup;
      await startSetup(setup.id);
    }
    wizardOpen.value = false;
    await load();
  } catch (err) {
    wizardError.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

function fmtGiB(bytes: number | null): string {
  if (bytes === null) return "—";
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
</script>

<template>
  <div class="page">
    <header class="pagehead">
      <div>
        <h1>Serve</h1>
        <p>Setups: model + nodes + your scripts. Irori validates, transfers, supervises — never edits your scripts.</p>
      </div>
      <div class="row">
        <button class="btn btn--primary" @click="openWizard()">New setup…</button>
      </div>
    </header>

    <p v-if="error" class="banner banner--warn">{{ error }}</p>
    <p v-else-if="actionError" class="banner banner--warn">{{ actionError }}</p>
    <p v-else-if="loading && setups.length === 0" class="faint">loading…</p>
    <p v-else-if="setups.length === 0" class="faint">no setups yet — the usual case is one head + one worker</p>

    <section class="stack">
      <article v-for="setup in setups" :key="setup.id" class="card setup" @click="openDetail(setup)">
        <div class="setup__head">
          <span class="stat__value" style="font-size: 16px">{{ setup.name }}</span>
          <span class="chip" :class="setupChipCls(chipOf(setup))">
            <span class="dot" :class="`dot--${chipOf(setup) === 'healthy' ? 'ok' : chipOf(setup) === 'foreign' ? 'warn' : chipOf(setup) === 'starting' || chipOf(setup) === 'stopping' ? 'run' : 'halt'}`" aria-hidden="true"></span>
            {{ chipOf(setup) }}
          </span>
          <span class="chip">{{ setup.kind }} · {{ setup.port }}</span>
          <span class="grow"></span>
          <div class="row" @click.stop>
            <button v-if="setup.status === 'stopped' || setup.status === 'failed'" class="btn btn--secondary btn--sm" @click="onStart(setup)">Start</button>
            <button v-if="setup.status === 'starting' || setup.status === 'running'" class="btn btn--ghost btn--sm" :class="{ 'btn--danger': armedStop === setup.id }" @click="onArmStop(setup)">
              {{ armedStop === setup.id ? "Confirm stop" : "Stop…" }}
            </button>
            <button class="btn btn--ghost btn--sm" @click="openDetail(setup)">Logs</button>
          </div>
        </div>
        <div class="card__body" style="padding-top: 10px">
          <div class="row row--wrap" style="gap: 8px">
            <span v-for="line in setupNodeLines(setup, nodes, { decodeTps: decodeTps(setup) })" :key="line.nodeId" class="chip" :class="line.cls">
              {{ line.label }} · <span class="dot" :class="line.cls.includes('ok') ? 'dot--ok' : line.cls.includes('warn') ? 'dot--warn' : line.cls.includes('halt') ? 'dot--halt' : 'dot--run'" aria-hidden="true"></span> {{ line.detail }}
            </span>
          </div>
          <div v-if="selected !== null && selected.id === setup.id && latestStages.length > 0 && (setup.status === 'starting' || setup.status === 'running')" class="stages">
            <div v-for="(stage, i) in latestStages" :key="i" class="stage">
              <span>{{ stage.label }}</span>
              <div class="bar"><div class="bar__fill" :style="{ width: `${stagePercent(stage)}%` }"></div></div>
              <span class="val">{{ stageVal(stage) }}</span>
            </div>
          </div>
          <p v-if="setupSubline(setup) !== ''" class="stat__sub" style="margin-top: 8px">{{ setupSubline(setup) }}</p>
        </div>
      </article>
    </section>

    <!-- Setup detail drawer: engine log, placement history, edit/duplicate/remove -->
    <div v-if="selected !== null" class="drawer-scrim" @click.self="closeDetail">
      <aside class="drawer" role="dialog" aria-label="Setup details">
        <div class="row row--between" style="margin-bottom: 10px">
          <div class="row">
            <h3 style="font-size: 17px">{{ selected.name }}</h3>
            <span class="chip" :class="setupChipCls(chipOf(selected))">{{ chipOf(selected) }}</span>
            <span class="chip">{{ selected.kind }}</span>
          </div>
          <button class="iconbtn" aria-label="Close details" @click="closeDetail">✕</button>
        </div>
        <p v-if="detailError" class="banner banner--warn">{{ detailError }}</p>
        <div class="stack" style="overflow: auto">
          <dl class="kv">
            <dt>model</dt><dd class="mono">{{ selected.model }}</dd>
            <dt>nodes</dt><dd>{{ setupNodeLines(selected, nodes).map((l) => l.label).join(" · ") }}</dd>
            <dt>port</dt><dd>{{ selected.port }}</dd>
            <dt>start</dt><dd class="mono">{{ selected.scriptStart }}</dd>
            <dt>stop</dt><dd class="mono">{{ selected.scriptStop }}</dd>
            <dt>env</dt><dd>{{ [selected.env.modelName ? "MODEL_NAME" : null, selected.env.port && !selected.captureProxy ? "PORT" : null, selected.env.extraArgs !== "" ? "EXTRA_ARGS" : null, selected.env.modelPath ? "MODEL_PATH" : null].filter(Boolean).join(" · ") || "none" }}{{ selected.captureProxy ? " · capture on" : "" }}</dd>
          </dl>

          <div>
            <span class="label">Engine log · streaming into telemetry</span>
            <div class="log" style="margin-top: 8px; max-height: 220px">
              <div v-if="logLines.length === 0" class="faint">no output yet</div>
              <div v-for="line in logLines.slice(-120)" :key="line.seq"><span class="dim">{{ fmtTime(line.ts) }}</span> {{ line.line }}</div>
            </div>
          </div>

          <div>
            <span class="label">Placement</span>
            <div class="stack" style="margin-top: 8px">
              <div v-if="latestStages.length === 0" class="faint">no transfers recorded</div>
              <div v-for="(stage, i) in latestStages" :key="i" class="row row--between">
                <span class="mono">{{ stage.label }}</span>
                <span class="chip" :class="stage.status === 'succeeded' ? 'chip--ok' : stage.status === 'failed' || stage.status === 'canceled' ? 'chip--warn' : 'chip--muted'">{{ stage.status }}{{ stage.progress?.percent != null ? ` · ${Math.round(stage.progress.percent)}%` : "" }}</span>
              </div>
            </div>
          </div>

          <div class="row">
            <button class="btn btn--secondary btn--sm" @click="openWizard(selected); closeDetail()">Edit…</button>
            <button class="btn btn--secondary btn--sm" @click="onDuplicate(selected); closeDetail()">Duplicate…</button>
            <button class="btn btn--danger btn--sm" @click="onRemove(selected)">{{ armedStop === `rm-${selected.id}` ? "Confirm remove" : "Remove…" }}</button>
          </div>
        </div>
      </aside>
    </div>

    <!-- Setup wizard: type → model → scripts → placement → review -->
    <div v-if="wizardOpen" class="drawer-scrim" @click.self="closeWizard">
      <div class="wizard" role="dialog" aria-modal="true" aria-label="New setup wizard">
        <div class="card__head row--between" style="display: flex">
          <div class="row"><h3>{{ wizard.editId !== null ? "Edit setup" : "New setup" }}</h3><span class="mono faint">nothing runs until you launch</span></div>
          <button class="iconbtn" aria-label="Close wizard" @click="closeWizard">✕</button>
        </div>
        <div class="steps" aria-label="Wizard progress">
          <span v-for="(label, i) in STEPS" :key="label" class="step-dot" :class="{ 'is-done': i + 1 < step, 'is-cur': i + 1 === step }"><i></i>{{ label }}</span>
        </div>

        <section v-show="step === 1" class="step card__body">
          <div class="stack">
            <div class="stack" style="gap: 8px">
              <label class="pick" :class="{ 'is-on': wizard.kind === 'single' }"><input v-model="wizard.kind" type="radio" value="single" name="wtype" /> <strong>Single node</strong><div class="stat__sub">one node serves; the usual case</div></label>
              <label class="pick" :class="{ 'is-on': wizard.kind === 'cluster' }"><input v-model="wizard.kind" type="radio" value="cluster" name="wtype" /> <strong>Cluster (head + workers)</strong><div class="stat__sub">sharded / multi-node serving · up to 8 nodes</div></label>
            </div>
            <div class="field"><label>Head node</label>
              <select v-model="wizard.headNodeId" class="select">
                <option v-for="n in nodes" :key="n.id" :value="n.id">{{ n.name }} · {{ n.kind }}{{ n.online ? "" : " (offline)" }}</option>
              </select>
            </div>
            <div v-if="wizard.kind === 'cluster'" class="field"><label>Workers</label>
              <div class="stack" style="gap: 6px">
                <label v-for="n in nodes.filter((x) => x.id !== wizard.headNodeId)" :key="n.id" class="pick" :class="{ 'is-on': wizard.workerIds.includes(n.id) }">
                  <input type="checkbox" :checked="wizard.workerIds.includes(n.id)" @change="n.id in wizard.workerIds ? (wizard.workerIds = wizard.workerIds.filter((x) => x !== n.id)) : wizard.workerIds.length < 7 && wizard.workerIds.push(n.id)" />
                  {{ n.name }} · {{ n.kind }}{{ n.online ? "" : " (offline)" }}
                </label>
              </div>
            </div>
          </div>
        </section>

        <section v-show="step === 2" class="step card__body">
          <div class="stack">
            <input v-model="modelSearch" class="input mono" type="search" placeholder="Search the NAS catalog…" @input="onModelSearch" />
            <div class="stack" style="gap: 8px">
              <label v-for="m in modelChoices" :key="m.name" class="pick" :class="{ 'is-on': wizard.model === m.name }">
                <input type="radio" name="wmodel" :checked="wizard.model === m.name" @change="onPickModel(m.name)" />
                <strong>{{ m.name }}</strong> <span class="chip">{{ m.runtime }}</span> <span class="chip">{{ fmtGiB(m.bytes) }}</span>
              </label>
              <p v-if="modelChoices.length === 0" class="faint">no catalog matches — the exact HF repo id can be typed in Review for a chained download</p>
            </div>
            <div class="field"><label>Model (catalog name or HF repo id)</label><input v-model="wizard.model" class="input mono" /></div>
            <div class="field"><label>Serving port (script-defined; probed for health)</label><input v-model.number="wizardPort" class="input" type="number" min="1" max="65535" /></div>
          </div>
        </section>

        <section v-show="step === 3" class="step card__body">
          <div class="stack">
            <div class="field"><label>Start script — path on the head</label><input v-model="wizard.scriptStart" class="input mono" placeholder="/home/me/glm/start.sh" /></div>
            <div class="field"><label>Stop script — required (armed stop is a core promise)</label><input v-model="wizard.scriptStop" class="input mono" placeholder="/home/me/glm/stop.sh" /></div>
            <div class="row">
              <button class="btn btn--secondary btn--sm" :disabled="validating" @click="onValidate">{{ validating ? "validating…" : "Validate on head (test -x)" }}</button>
              <template v-if="validation !== null">
                <span v-for="v in validation" :key="v.script" class="chip" :class="v.ok ? 'chip--ok' : 'chip--warn'">
                  <span class="dot" :class="v.ok ? 'dot--ok' : 'dot--warn'" aria-hidden="true"></span>
                  {{ v.ok ? "exists & executable" : v.error }}
                </span>
              </template>
            </div>
            <div class="field"><label>Optional env exports for the scripts</label>
              <div class="stack" style="gap: 6px">
                <label class="pick" :class="{ 'is-on': wizard.envModelName }"><input v-model="wizard.envModelName" type="checkbox" /> MODEL_NAME</label>
                <label class="pick" :class="{ 'is-on': wizard.envPort }"><input v-model="wizard.envPort" type="checkbox" /> PORT</label>
                <label class="pick" :class="{ 'is-on': wizard.envModelPath }"><input v-model="wizard.envModelPath" type="checkbox" /> MODEL_PATH <span class="stat__sub">resolved on the head via modelctl path --local</span></label>
                <label class="pick" :class="{ 'is-on': wizard.envExtraArgs }"><input v-model="wizard.envExtraArgs" type="checkbox" /> EXTRA_ARGS</label>
                <input v-if="wizard.envExtraArgs" v-model="wizard.extraArgs" class="input mono" placeholder="--thinking --vision …" />
                <label class="pick" :class="{ 'is-on': wizard.capture }"><input v-model="wizard.capture" type="checkbox" @change="onCaptureToggle" /> Capture usage (M8) <span class="stat__sub">serves the engine on loopback; the agent proxies the LAN port and records per-request usage. The start script must honor $PORT.</span></label>
              </div>
            </div>
          </div>
        </section>

        <section v-show="step === 4" class="step card__body">
          <div class="stack">
            <dl v-if="placementRows !== null" class="kv">
              <template v-for="row in placementRows" :key="row.node.id">
                <dt>{{ row.node.name }} · {{ row.node.role }}</dt>
                <dd>{{ row.action }}{{ row.reason !== null ? ` — ${row.reason}` : "" }}{{ row.bytes !== null ? ` · ${fmtGiB(row.bytes)}` : "" }}</dd>
              </template>
            </dl>
            <p v-else class="stat__sub">{{ wizard.model }} is absent from the NAS catalog — staging will chain the HF download (NAS first, then the cluster).</p>
            <div v-for="row in capacityRows" :key="row.node.id" class="row row--between" style="margin-top: 6px">
              <span class="stat__sub">{{ row.node.name }}: {{ row.reason }}</span>
              <button class="btn btn--secondary btn--sm" @click="openHygiene(row.node.id, row.node.name)">
                Clean up disk<template v-if="(hygieneOffers.get(row.node.id) ?? 0) > 0"> — est. +{{ fmtGiB(hygieneOffers.get(row.node.id) ?? 0) }}</template>
              </button>
            </div>
            <div class="row row--between">
              <span class="stat__sub">missing models transfer in staged progress — start runs after activation.</span>
              <button class="btn btn--secondary btn--sm" :disabled="staging" @click="onStageTransfers">{{ staging ? "staging…" : "Stage transfers" }}</button>
            </div>
            <div v-if="activeTransfer !== null" class="stack">
              <div v-for="(stage, i) in activeTransfer.stages" :key="i" class="stage">
                <span>{{ stage.label }}</span>
                <div class="bar"><div class="bar__fill" :style="{ width: `${stagePercent(stage)}%` }"></div></div>
                <span class="val">{{ stageVal(stage) }}</span>
              </div>
              <div class="row row--between">
                <span class="stat__sub">transfer {{ activeTransfer.status }}</span>
                <button v-if="activeTransfer.status === 'running'" class="btn btn--ghost btn--sm" @click="onCancelTransfer">Cancel transfer</button>
              </div>
            </div>
            <p class="stat__sub">"Pull from HF instead" = stage with HF → node download; skip staging and Start runs as-is.</p>
          </div>
        </section>

        <section v-show="step === 5" class="step card__body">
          <dl class="kv">
            <dt>type</dt><dd>{{ wizard.kind === "cluster" ? `cluster — head + ${wizard.workerIds.length} worker(s)` : "single node" }}</dd>
            <dt>model</dt><dd class="mono">{{ wizard.model }}</dd>
            <dt>port</dt><dd>{{ wizardPort }} · probed for health (/v1/models with the model id) · timeout 15 m</dd>
            <dt>scripts</dt><dd class="mono">{{ wizard.scriptStart }} · {{ wizard.scriptStop }} <span class="faint">(re-validated at every start)</span></dd>
            <dt>env</dt><dd>{{ [wizard.envModelName ? "MODEL_NAME" : null, wizard.envPort || wizard.capture ? "PORT" : null, wizard.envExtraArgs && wizard.extraArgs !== "" ? "EXTRA_ARGS" : null, wizard.envModelPath ? "MODEL_PATH" : null].filter(Boolean).join(" · ") || "none" }}<template v-if="wizard.capture"> · capture on ($PORT is the loopback engine port)</template></dd>
            <dt>log</dt><dd>streamed into telemetry (ring + persisted run log)</dd>
          </dl>
        </section>

        <div class="card__head row--between" style="display: flex; border-top: 1px solid var(--border); border-bottom: 0">
          <span class="stat__sub">step {{ step }} of 5</span>
          <div class="row">
            <button v-if="step > 1" class="btn btn--secondary btn--sm" @click="prevStep">Back</button>
            <button v-if="step < 5" class="btn btn--primary btn--sm" @click="nextStep">Next · {{ STEPS[step] }}</button>
            <button v-else class="btn btn--primary btn--sm" :disabled="busy" @click="onFinish">{{ busy ? "working…" : wizard.editId !== null ? "Save" : "Create & start" }}</button>
          </div>
        </div>
        <p v-if="wizardError" class="banner banner--warn" style="margin: 0 16px 12px">{{ wizardError }}</p>
      </div>
    </div>
  </div>

  <CleanupDrawer v-if="hygieneNode !== null" :node-id="hygieneNode.id" :node-name="hygieneNode.name" @close="hygieneNode = null" />
</template>


<style scoped>
.setup {
  display: flex;
  flex-direction: column;
  cursor: pointer;
}
.setup__head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px 0;
}
.stages {
  margin-top: 8px;
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
  width: min(560px, 100%);
  max-height: 88vh;
  overflow: auto;
  padding: 14px;
}
.wizard {
  width: min(720px, 100%);
  max-height: 92vh;
  overflow: auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius, 8px);
  padding-bottom: 4px;
}
.steps {
  display: flex;
  gap: var(--space-2, 8px);
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  align-items: center;
}
.step-dot {
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--faint, var(--muted));
}
.step-dot i {
  width: 8px;
  height: 8px;
  border: 1.5px solid var(--rule-2, var(--border));
  border-radius: 50%;
  display: inline-block;
}
.step-dot.is-done i {
  background: var(--ink, currentColor);
  border-color: var(--ink, currentColor);
}
.step-dot.is-cur {
  color: var(--fg);
}
.step-dot.is-cur i {
  border-color: var(--ink, currentColor);
}
.step-dot + .step-dot::before {
  content: "—";
  color: var(--rule-2, var(--border));
  margin: 0 6px;
}
.pick {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius, 8px);
  cursor: pointer;
  flex-wrap: wrap;
}
.pick.is-on {
  border-color: var(--ink, currentColor);
}
.pick input {
  width: 16px;
  height: 16px;
}
.val {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--muted);
  min-width: 150px;
  text-align: right;
}
@media (min-width: 721px) {
  .drawer-scrim {
    align-items: center;
  }
}
</style>
