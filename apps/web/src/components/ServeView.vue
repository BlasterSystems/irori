<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { fetchCleanup, fetchNodes, fetchNodeLlm, type LlmSnapshot } from "../api";
import { vScrimClose } from "../scrim";
import { vDialog } from "../dialog";
import { live } from "../live";
import { fetchAllModelsNamed, fetchPlacement, placementChip } from "../models";
import { MAX_SETUP_NODES, type NodeInfo, type PlacementRow, type SetupTransfer, type TransferStage } from "@irori/core";
import {
  applySetupStates,
  cancelTransfer,
  createSetup,
  createTransfer,
  deleteSetup,
  engineLogEmptyText,
  fetchSetups,
  fetchSetup,
  openSetupLog,
  patchSetup,
  runningEnginesFromProbes,
  sanitizeWorkerIds,
  probeSeesEngine,
  scriptPathError,
  setupChipView,
  setupNodeLines,
  setupSubline,
  setupSummaryLine,
  sortSetupsForBoard,
  stagePercent,
  stageVal,
  startSetup,
  stopSetup,
  validateScripts,
  workerCapHint,
  composeScriptPath,
  splitRecipePaths,
  type RunningEngineRow,
  type SetupCreateInput,
  type SetupInfo,
  type SetupLogLine,
} from "../serve";

/* ── Fleet + setups state ─────────────────────────────────────────────────── */

const nodes = ref<NodeInfo[]>([]);
const setups = ref<SetupInfo[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
/** Latest LLM probe per node id — ALL nodes, not just setup heads (IR-152:
 *  the Running-now section must see engines no setup manages). */
const probes = ref<Map<string, LlmSnapshot | null>>(new Map());
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

/** IR-152: setup-state SSE frames (via the app-wide live store) overlay the
 *  REST rows so chips flip instantly; the 2.5 s poll stays the convergent
 *  source of truth (applySetupStates refuses stale frames). */
const board = computed<SetupInfo[]>(() => {
  const states = live.events.value.filter((e) => e.type === "setup-state");
  const merged = applySetupStates(setups.value, states);
  return sortSetupsForBoard(merged);
});

const summaryLine = computed(() => (setups.value.length === 0 ? "" : setupSummaryLine(setups.value)));

function probeSees(setup: SetupInfo): boolean {
  return probeSeesEngine(setup, probes.value);
}

function chipView(setup: SetupInfo) {
  return setupChipView(setup, { probeSees: probeSees(setup) });
}

async function refreshLlm(nodeIds: string[]): Promise<void> {
  for (const nodeId of nodeIds) {
    try {
      probes.value.set(nodeId, await fetchNodeLlm(nodeId));
    } catch {
      // Keep the last good snapshot; retried on the next poll. Seeding once
      // froze tok/s at page-load values and cached "no probe" forever after
      // a single failed fetch.
    }
  }
}

/** IR-152: every detected engine, managed or not — probe truth only. */
const runningNow = computed<RunningEngineRow[]>(() =>
  runningEnginesFromProbes(
    [...probes.value].flatMap(([nodeId, snap]) => (snap === null ? [] : [{ nodeId, ports: snap.ports }])),
    nodes.value,
    setups.value,
  ),
);

function decodeTps(setup: SetupInfo): number | null {
  const snap = probes.value.get(setup.headNodeId) ?? null;
  if (snap === null) return null;
  const port = snap.ports.find((p) => p.port === setup.port);
  return port?.decodeTps ?? null;
}

function probeNodeIds(): string[] {
  const ids = new Set<string>(nodes.value.map((n) => n.id));
  for (const s of setups.value) ids.add(s.headNodeId);
  return [...ids];
}

onMounted(async () => {
  try {
    nodes.value = await fetchNodes();
  } catch {
    /* registry unavailable — cards still render */
  }
  await load();
  await refreshLlm(probeNodeIds());
  pollTimer = setInterval(() => {
    void load();
    void fetchNodes()
      .then((rows) => {
        nodes.value = rows;
      })
      .catch(() => {});
    void refreshLlm(probeNodeIds());
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
/** IR-152: per-action in-flight refs — the button disables and reads
 *  "Starting…" until the call returns (double-submit guard + feedback that
 *  used to wait for the next 2.5 s poll). */
const startingId = ref<string | null>(null);
const stoppingId = ref<string | null>(null);
const removingId = ref<string | null>(null);

async function onStart(setup: SetupInfo): Promise<void> {
  if (startingId.value !== null) return;
  startingId.value = setup.id;
  actionError.value = null;
  try {
    await startSetup(setup.id);
    await load();
  } catch (err) {
    actionError.value = err instanceof Error ? err.message : String(err);
  } finally {
    startingId.value = null;
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
  if (stoppingId.value !== null) return;
  stoppingId.value = setup.id;
  actionError.value = null;
  try {
    await stopSetup(setup.id);
    await load();
  } catch (err) {
    actionError.value = err instanceof Error ? err.message : String(err);
  } finally {
    stoppingId.value = null;
  }
}

/**
 * IR-152: Adopt — an unmanaged engine the probe sees becomes manageable:
 * the wizard opens prefilled with the detected model/port/head so the owner
 * supplies the real script pair. No row is created here: a setup with
 * placeholder scripts would fail `test -x` at every start (the exact
 * dead-on-arrival trap this ticket removes), and the wizard's Create is the
 * honest path.
 */
function onAdopt(row: RunningEngineRow): void {
  openWizard();
  wizard.value.name = row.model ?? `${row.backend}:${row.port}`;
  wizard.value.model = row.model ?? "";
  wizard.value.kind = "single";
  wizard.value.headNodeId = row.nodeId;
  wizard.value.workerIds = [];
  wizardPort.value = row.port;
  // Type is answered; Model is only answered when the probe REPORTED one —
  // an engine that answers without a model id would otherwise reach Review
  // with an empty model and fail the server contract on Create.
  step.value = row.model === null ? 2 : 3;
  maxVisited.value = step.value;
  actionError.value = null;
}

/** Running-now managed row: jump straight to that setup's drawer. */
function openManaged(row: RunningEngineRow): void {
  const s = setups.value.find((x) => x.id === row.managedSetupId);
  if (s !== undefined) void openDetail(s);
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
  if (removingId.value !== null) return;
  clearTimeout(armedTimer);
  armedStop.value = null;
  removingId.value = setup.id;
  try {
    await deleteSetup(setup.id);
    closeDetail();
    await load();
  } catch (err) {
    actionError.value = err instanceof Error ? err.message : String(err);
  } finally {
    removingId.value = null;
  }
}

/* ── Wizard ───────────────────────────────────────────────────────────────── */

const wizardOpen = ref(false);
const step = ref(1);
const busy = ref(false);
const wizardError = ref<string | null>(null);
/** IR-152: furthest step reached — step dots navigate back to visited steps
 *  instead of only Next moving forward. */
const maxVisited = ref(1);

interface WizardState {
  editId: string | null;
  name: string;
  kind: "single" | "cluster";
  headNodeId: string;
  workerIds: string[];
  model: string;
  /** IRI-051: scripts are entered as a recipe folder plus start/stop names;
   *  the stored full paths are composed on submit (composeScriptPath). */
  recipeFolder: string;
  startName: string;
  stopName: string;
  envModelName: boolean;
  envPort: boolean;
  envExtraArgs: boolean;
  extraArgs: string;
  envModelPath: boolean;
  /** M8: route traffic through the agent capture proxy (ADR-0008). */
  capture: boolean;
  /** IR-52: store deduped request/response bodies (needs capture). */
  retain: boolean;
}

const wizard = ref<WizardState>({
  editId: null,
  name: "",
  kind: "single",
  headNodeId: "",
  workerIds: [],
  model: "",
  recipeFolder: "",
  startName: "",
  stopName: "",
  envModelName: false,
  envPort: true,
  envExtraArgs: false,
  extraArgs: "",
  envModelPath: true,
  capture: false,
  retain: false,
});

/** IRI-051: the stored full paths, composed from the recipe folder + names. */
const composedStart = computed(() => composeScriptPath(wizard.value.recipeFolder, wizard.value.startName));
const composedStop = computed(() => composeScriptPath(wizard.value.recipeFolder, wizard.value.stopName));

/** IRI-051: id → name for the review step; a short-id fallback keeps the row
 *  readable when the registry is unavailable or an id is stale. */
function nodeName(id: string): string {
  if (id === "") return "—";
  return nodes.value.find((n) => n.id === id)?.name ?? `${id.slice(0, 8)}…`;
}

/** IRI-051: the env story as value-bearing chips — the exported vars WITH
 *  their values, plus the capture/bodies toggles, instead of one flag-name wall. */
const envChips = computed(() => {
  const w = wizard.value;
  const chips: string[] = [];
  if (w.envModelName) chips.push("MODEL_NAME");
  if (w.envPort || w.capture) chips.push("PORT");
  if (w.envModelPath) chips.push("MODEL_PATH");
  if (w.envExtraArgs && w.extraArgs.trim() !== "") chips.push(`EXTRA_ARGS=${w.extraArgs.trim()}`);
  if (w.capture) chips.push("capture on");
  if (w.capture && w.retain) chips.push("bodies kept");
  return chips;
});

/**
 * Sanitize worker ids against the loaded node inventory (IRI-041). An empty
 * inventory (registry unavailable) must not wipe workers — pass through and
 * let the server validate with a precise error instead.
 */
function cleanWorkerIds(workerIds: string[], headNodeId: string): string[] {
  return nodes.value.length > 0 ? sanitizeWorkerIds(workerIds, headNodeId, nodes.value) : workerIds;
}

function openWizard(from?: SetupInfo): void {
  wizardOpen.value = true;
  step.value = 1;
  maxVisited.value = 1;
  wizardError.value = null;
  validation.value = null;
  validatedKey = null;
  placementRows.value = null;
  created.value = null;
  createdInput.value = null;
  activeTransfer.value = null;
  const w = wizard.value;
  w.editId = from?.id ?? null;
  w.name = from?.name ?? "";
  w.kind = from?.kind ?? "single";
  w.headNodeId = from?.headNodeId ?? firstHeadId();
  w.workerIds = from ? cleanWorkerIds(from.nodes.map((n) => n.nodeId), w.headNodeId) : [];
  w.model = from?.model ?? "";
  // IRI-051: the port must follow the source setup on edit/duplicate — this
  // ref was never assigned in openWizard, so edits submitted 8080 (or a value
  // stale from a previous wizard session).
  wizardPort.value = from?.port ?? 8080;
  // IRI-051: split stored paths into folder + names; differing dirnames fall
  // back to full paths in the name fields (compose passes them verbatim).
  const split = splitRecipePaths(from?.scriptStart ?? "", from?.scriptStop ?? "");
  w.recipeFolder = split.folder;
  w.startName = split.startName;
  w.stopName = split.stopName;
  if (from) {
    w.envModelName = from.env.modelName;
    w.envPort = from.env.port;
    w.envExtraArgs = from.env.extraArgs.length > 0;
    w.extraArgs = from.env.extraArgs;
    w.envModelPath = from.env.modelPath;
    w.capture = from.captureProxy === true;
    w.retain = from.bodyRetention === true;
  } else {
    w.envModelName = false;
    w.envPort = true;
    w.envExtraArgs = false;
    w.extraArgs = "";
    w.envModelPath = true;
    w.capture = false;
    w.retain = false;
  }
  loadModelChoices("");
}

function firstHeadId(): string {
  const preferred = nodes.value.find((n) => n.online && n.role === "head") ?? nodes.value.find((n) => n.online);
  return preferred?.id ?? nodes.value[0]?.id ?? "";
}

/** ADR-0008 §7: capture setups pre-fill EXTRA_ARGS with a loopback-bind hint. */
function onCaptureToggle(): void {
  if (!wizard.value.capture) wizard.value.retain = false;
  if (wizard.value.capture && !wizard.value.envExtraArgs && wizard.value.extraArgs.trim().length === 0) {
    wizard.value.envExtraArgs = true;
    wizard.value.extraArgs = "--host 127.0.0.1";
  }
}

function closeWizard(): void {
  wizardOpen.value = false;
}

const STEPS = ["Type", "Model", "Scripts", "Placement", "Review"];

/** IR-152: field-level messages for typed-but-invalid paths (the error
 *  banner alone left the owner guessing which box was wrong). Empty paths are
 *  "required" errors surfaced by Next, not inline noise on untouched fields. */
const startPathError = computed(() => (composedStart.value === "" ? null : scriptPathError(composedStart.value)));
const stopPathError = computed(() => (composedStop.value === "" ? null : scriptPathError(composedStop.value)));
/** A non-empty folder must itself be absolute; when the folder is empty the
 *  name fields carry full paths and compose passes them verbatim. */
const folderPathError = computed(() => (wizard.value.recipeFolder.trim() === "" ? null : scriptPathError(wizard.value.recipeFolder.trim())));
const workerHint = computed(() => workerCapHint(wizard.value.workerIds.length, wizard.value.kind));
const workerCap = MAX_SETUP_NODES - 1;

function gotoStep(n: number): void {
  if (n < 1 || n > maxVisited.value || n === step.value) return;
  wizardError.value = null;
  step.value = n;
  if (n === 2) void loadModelChoices(modelSearch.value);
  if (n === 4) void loadPlacement();
}

/** Step 3 gate: rules first, then an automatic head-side `test -x` (IR-152:
 *  validation was opt-in and owners burned starts on DOA paths — the check
 *  now happens before the row is ever saved). A failed head fetch never
 *  blocks: the server re-checks at save/start with a precise error. */
async function nextStep(): Promise<void> {
  wizardError.value = null;
  if (step.value === 1 && wizard.value.headNodeId === "") {
    wizardError.value = "pick a head node";
    return;
  }
  if (step.value === 2 && wizard.value.model === "") {
    wizardError.value = "pick a model";
    return;
  }
  if (step.value === 3) {
    if (composedStart.value === "" || composedStop.value === "") {
      wizardError.value = "both a start and a stop script are required";
      return;
    }
    if (startPathError.value !== null || stopPathError.value !== null) {
      wizardError.value = startPathError.value ?? stopPathError.value;
      return;
    }
    // Re-validate whenever the head or either path changed since the last
    // check — a cached ok for a different script set is exactly the
    // dead-on-arrival trap this gate exists for.
    if ((validation.value === null || validatedKey !== scriptsKey()) && !validating.value) {
      validating.value = true;
      try {
        const key = scriptsKey();
        validation.value = await validateScripts(wizard.value.headNodeId, [composedStart.value, composedStop.value]);
        validatedKey = key;
      } catch {
        validation.value = null; // head unreachable — don't block, save/start re-check
        validatedKey = null;
      } finally {
        validating.value = false;
      }
      const bad = (validation.value ?? []).filter((v) => !v.ok);
      if (bad.length > 0) {
        wizardError.value = bad.map((v) => `${v.error} — ${v.script}`).join(" · ");
        return;
      }
    }
  }
  if (step.value < 5) {
    step.value += 1;
    maxVisited.value = Math.max(maxVisited.value, step.value);
    if (step.value === 2) void loadModelChoices("");
    if (step.value === 4) void loadPlacement();
  }
}

function prevStep(): void {
  wizardError.value = null;
  if (step.value > 1) step.value -= 1;
}

/* Step 2 — model search over the NAS catalog (chained HF handled in step 4). */

const modelChoices = ref<Array<{ name: string; runtime: string; repository: string; bytes: number }>>([]);
const modelSearch = ref("");

async function loadModelChoices(q: string): Promise<void> {
  try {
    // IRI-051: the whole catalog, name-ordered client-side — a single server
    // page (25) is collation-selected and truncates families.
    const all = await fetchAllModelsNamed(q);
    modelChoices.value = all.map((m) => ({ name: m.name, runtime: m.runtime, repository: m.repository, bytes: m.bytes }));
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
/** IR-152 fix (review): the cache is keyed by the exact (head, start, stop)
 *  triple it validated. Without the key, validate → Back → edit to a
 *  nonexistent absolute path → Next skipped the re-check and saved the DOA
 *  row the ticket exists to prevent. */
let validatedKey: string | null = null;

function scriptsKey(): string {
  return JSON.stringify([wizard.value.headNodeId, composedStart.value, composedStop.value]);
}

async function onValidate(): Promise<void> {
  validating.value = true;
  validation.value = null;
  validatedKey = null;
  wizardError.value = null;
  try {
    const key = scriptsKey();
    validation.value = await validateScripts(wizard.value.headNodeId, [composedStart.value, composedStop.value]);
    validatedKey = key;
  } catch (err) {
    wizardError.value = err instanceof Error ? err.message : String(err);
  } finally {
    validating.value = false;
  }
}

/* Step 4 — placement: per-node plan + staged transfers on the created setup. */

const placementRows = ref<null | PlacementRow[]>(null);

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
/** Payload snapshot captured when `created` was persisted — detects form edits
 *  after a saved-but-unstarted row so retries replace instead of fork (IR-76). */
const createdInput = ref<string | null>(null);
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
    nodes: w.kind === "cluster" ? cleanWorkerIds(w.workerIds, w.headNodeId).map((nodeId) => ({ nodeId, role: "worker" as const })) : [],
    scriptStart: composedStart.value,
    scriptStop: composedStop.value,
    env: {
      modelName: w.envModelName,
      port: w.envPort,
      extraArgs: w.envExtraArgs ? w.extraArgs : "",
      modelPath: w.envModelPath,
    },
    captureProxy: w.capture,
    bodyRetention: w.retain,
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
  createdInput.value = JSON.stringify(wizardInput());
  created.value = setup;
  return setup;
}

/** Create-or-reuse for launch/save (IR-76): a row persisted by an earlier
 *  attempt (failed start, staged transfer) is replaced when the wizard inputs
 *  changed since — retries never fork the config. The replaced row is stopped
 *  (a refused start persists nothing) and has no runs to lose. */
async function ensureFreshCreated(): Promise<SetupInfo> {
  if (created.value !== null && createdInput.value !== JSON.stringify(wizardInput())) {
    // A staged transfer still owns live node jobs; deleting the row would
    // cascade its record away and leave the downloads running (a later
    // Stage transfers then fails with "busy: a job is already running").
    if (activeTransfer.value !== null && activeTransfer.value.status === "running") {
      await cancelTransfer(activeTransfer.value.id).catch(() => {});
    }
    activeTransfer.value = null;
    await deleteSetup(created.value.id);
    created.value = null;
  }
  if (created.value === null) {
    created.value = await createSetup(wizardInput());
    createdInput.value = JSON.stringify(wizardInput());
  }
  return created.value;
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
      const setup = await ensureFreshCreated();
      try {
        await startSetup(setup.id);
      } catch (err) {
        // The row was already persisted — a start refusal (e.g. MODEL_PATH
        // resolution) must not read as total loss (IR-76). The wizard stays
        // open: retry Create & start, or Save without starting to keep it.
        wizardError.value = `Setup saved — start failed: ${err instanceof Error ? err.message : String(err)}`;
        return;
      }
    }
    wizardOpen.value = false;
    await load();
  } catch (err) {
    wizardError.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

/** Step 5 — persist a new config without launching it (IR-76). */
async function onSaveOnly(): Promise<void> {
  busy.value = true;
  wizardError.value = null;
  try {
    await ensureFreshCreated();
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
        <p v-if="summaryLine !== ''">{{ summaryLine }}</p>
        <p v-else>Setups: model + nodes + your scripts. Irori validates, transfers, supervises — never edits your scripts.</p>
      </div>
      <div class="row">
        <button class="btn btn--primary" @click="openWizard()">New setup…</button>
      </div>
    </header>

    <p v-if="error" class="banner banner--warn">{{ error }}</p>
    <p v-else-if="actionError" class="banner banner--warn">{{ actionError }}</p>

    <!-- IR-152: probe truth, can never lie — every detected engine, managed
         or not. Serve used to say "stopped" while Overview called the same
         engine unmanaged; this section is the single source of both. -->
    <section v-if="runningNow.length > 0" class="stack" style="margin-bottom: 18px">
      <span class="label">Running now</span>
      <article v-for="row in runningNow" :key="row.key" class="card runnow">
        <div class="runnow__row">
          <span class="dot dot--ok" aria-hidden="true"></span>
          <span class="mono runnow__port">:{{ row.port }}</span>
          <strong>{{ row.model ?? "engine" }}</strong>
          <span class="chip">{{ row.backend }}</span>
          <span class="chip">{{ row.nodeName }}</span>
          <span v-if="row.decodeTps !== null" class="chip chip--ok">{{ row.decodeTps.toFixed(1) }} tok/s</span>
          <span class="grow"></span>
          <div class="row">
            <template v-if="row.managedSetupId !== null">
              <button class="btn btn--ghost btn--sm" @click="openManaged(row)">managed · {{ row.managedName }}</button>
            </template>
            <template v-else>
              <span class="chip chip--muted">unmanaged</span>
              <button class="btn btn--secondary btn--sm" @click="onAdopt(row)">Adopt</button>
            </template>
          </div>
        </div>
      </article>
    </section>

    <p v-if="loading && setups.length === 0" class="faint">loading…</p>
    <p v-else-if="setups.length === 0" class="faint">no setups yet — the usual case is one head + one worker</p>

    <!-- IR-152: running first, then failed, then idle; stable by name. -->
    <section class="stack">
      <article v-for="setup in board" :key="setup.id" class="card setup" @click="openDetail(setup)">
        <div class="setup__head">
          <span class="stat__value" style="font-size: 16px">{{ setup.name }}</span>
          <span class="chip" :class="chipView(setup).cls">
            <span class="dot" :class="chipView(setup).dot" aria-hidden="true"></span>
            {{ chipView(setup).label }}
          </span>
          <!-- IR-152: the head node line already carries :port — the chip is
               kind only (port was shown twice per card). -->
          <span class="chip">{{ setup.kind }}</span>
          <span class="grow"></span>
          <div class="row" @click.stop>
            <button
              v-if="setup.status === 'stopped' || setup.status === 'failed'"
              class="btn btn--secondary btn--sm"
              :disabled="startingId !== null || stoppingId !== null"
              @click="onStart(setup)"
            >
              {{ startingId === setup.id ? "Starting…" : "Start" }}
            </button>
            <button
              v-if="setup.status === 'starting' || setup.status === 'running' || probeSees(setup)"
              class="btn btn--ghost btn--sm"
              :class="{ 'btn--danger': armedStop === setup.id }"
              :disabled="stoppingId !== null"
              @click="onArmStop(setup)"
            >
              {{ stoppingId === setup.id ? "Stopping…" : armedStop === setup.id ? "Confirm stop" : "Stop…" }}
            </button>
            <button class="btn btn--ghost btn--sm" @click="openDetail(setup)">Logs</button>
          </div>
        </div>
        <div class="card__body" style="padding-top: 10px">
          <div class="row row--wrap" style="gap: 8px">
            <span v-for="line in setupNodeLines(setup, nodes, { decodeTps: decodeTps(setup), probeSees: probeSees(setup) })" :key="line.nodeId" class="chip" :class="line.cls">
              {{ line.label }} · <span class="dot" :class="line.cls.includes('ok') ? 'dot--ok' : line.cls.includes('warn') ? 'dot--warn' : line.cls.includes('halt') || line.cls.includes('muted') ? 'dot--halt' : 'dot--run'" aria-hidden="true"></span> {{ line.detail }}
            </span>
          </div>
          <div v-if="selected !== null && selected.id === setup.id && latestStages.length > 0 && (setup.status === 'starting' || setup.status === 'running')" class="stages">
            <div v-for="(stage, i) in latestStages" :key="i" class="stage">
              <span>{{ stage.label }}</span>
              <div class="bar"><div class="bar__fill" :style="{ width: `${stagePercent(stage)}%` }"></div></div>
              <span class="val">{{ stageVal(stage) }}</span>
            </div>
          </div>
          <!-- IR-152 (P2): failed reads warn with the reason visible on the
               card, not only in a faint subline. -->
          <p v-if="setup.status === 'failed' && setup.lastError !== null" class="fail-line">{{ setup.lastError }}</p>
          <p v-if="setupSubline(setup) !== '' && setup.status !== 'failed'" class="stat__sub" style="margin-top: 8px">{{ setupSubline(setup) }}</p>
        </div>
      </article>
    </section>

    <!-- Setup detail drawer: engine log, placement history, edit/duplicate/remove.
         IR-152: focus-trapped + Escape-closable (v-dialog), aria-modal, the
         Start/Stop the card has are reachable from the header, and failed
         shows its reason next to the state chip. -->
    <div v-if="selected !== null" class="drawer-scrim" v-scrim-close="closeDetail">
      <aside class="drawer" role="dialog" aria-modal="true" aria-label="Setup details" v-dialog="closeDetail">
        <div class="row row--between" style="margin-bottom: 10px">
          <div class="row row--wrap">
            <h3 style="font-size: 17px">{{ selected.name }}</h3>
            <span class="chip" :class="chipView(selected).cls">
              <span class="dot" :class="chipView(selected).dot" aria-hidden="true"></span>
              {{ chipView(selected).label }}
            </span>
            <span class="chip">{{ selected.kind }}</span>
          </div>
          <div class="row" style="align-items: center">
            <button
              v-if="selected.status === 'stopped' || selected.status === 'failed'"
              class="btn btn--secondary btn--sm"
              :disabled="startingId !== null || stoppingId !== null"
              @click="onStart(selected)"
            >
              {{ startingId === selected.id ? "Starting…" : "Start" }}
            </button>
            <button
              v-if="selected.status === 'starting' || selected.status === 'running' || probeSees(selected)"
              class="btn btn--ghost btn--sm"
              :class="{ 'btn--danger': armedStop === selected.id }"
              :disabled="stoppingId !== null"
              @click="onArmStop(selected)"
            >
              {{ stoppingId === selected.id ? "Stopping…" : armedStop === selected.id ? "Confirm stop" : "Stop…" }}
            </button>
            <button class="iconbtn" aria-label="Close details" @click="closeDetail">✕</button>
          </div>
        </div>
        <p v-if="selected.status === 'failed' && selected.lastError !== null" class="fail-line">{{ selected.lastError }}</p>
        <p v-if="detailError" class="banner banner--warn">{{ detailError }}</p>
        <div class="stack" style="overflow: auto">
          <dl class="kv">
            <dt>model</dt><dd class="mono">{{ selected.model }}</dd>
            <dt>nodes</dt><dd>{{ setupNodeLines(selected, nodes, { probeSees: probeSees(selected) }).map((l) => l.label).join(" · ") }}</dd>
            <dt>scripts</dt><dd class="mono" style="overflow-wrap: anywhere;">{{ selected.scriptStart }} <span class="faint">start</span> · {{ selected.scriptStop }} <span class="faint">stop</span></dd>
            <dt>env</dt><dd>{{ [selected.env.modelName ? "MODEL_NAME" : null, selected.env.port && !selected.captureProxy ? "PORT" : null, selected.env.extraArgs !== "" ? "EXTRA_ARGS" : null, selected.env.modelPath ? "MODEL_PATH" : null].filter(Boolean).join(" · ") || "none" }}{{ selected.captureProxy ? " · capture on" : "" }}{{ selected.bodyRetention ? " · bodies kept" : "" }}</dd>
          </dl>

          <!-- IR-152: the label says what it is (frames stream into telemetry
               since IR-147); the empty state explains what to expect. -->
          <div>
            <span class="label">Engine log</span>
            <div class="log" style="margin-top: 8px; max-height: 220px">
              <div v-if="logLines.length === 0" class="faint">{{ engineLogEmptyText(selected) }}</div>
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
            <button class="btn btn--danger btn--sm" :disabled="removingId !== null" @click="onRemove(selected)">{{ removingId === selected.id ? "Removing…" : armedStop === `rm-${selected.id}` ? "Confirm remove" : "Remove…" }}</button>
          </div>
        </div>
      </aside>
    </div>

    <!-- Setup wizard: type → model → scripts → placement → review -->
    <div v-if="wizardOpen" class="drawer-scrim" v-scrim-close="closeWizard">
      <div class="wizard" role="dialog" aria-modal="true" aria-label="New setup wizard" v-dialog="closeWizard">
        <div class="card__head row--between wizard__head" style="display: flex">
          <div class="row"><h3>{{ wizard.editId !== null ? "Edit setup" : "New setup" }}</h3><span class="mono faint">nothing runs until you launch</span></div>
          <button class="iconbtn" aria-label="Close wizard" @click="closeWizard">✕</button>
        </div>
        <!-- IR-152: dots navigate back to visited steps. -->
        <div class="steps" aria-label="Wizard progress">
          <button
            v-for="(label, i) in STEPS"
            :key="label"
            type="button"
            class="step-dot step-dot--btn"
            :class="{ 'is-done': i + 1 < step, 'is-cur': i + 1 === step, 'is-locked': i + 1 > maxVisited }"
            :disabled="i + 1 > maxVisited"
            @click="gotoStep(i + 1)"
          ><i></i>{{ label }}</button>
        </div>

        <section v-show="step === 1" class="step card__body">
          <div class="stack">
            <div class="field"><label>Config name (optional — defaults to the model name)</label><input v-model="wizard.name" class="input" placeholder="(model name)" /></div>
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
                <label v-for="n in nodes.filter((x) => x.id !== wizard.headNodeId && x.kind !== 'nas')" :key="n.id" class="pick" :class="{ 'is-on': wizard.workerIds.includes(n.id), 'is-capped': !wizard.workerIds.includes(n.id) && wizard.workerIds.length >= workerCap }">
                  <input type="checkbox" :checked="wizard.workerIds.includes(n.id)" :disabled="!wizard.workerIds.includes(n.id) && wizard.workerIds.length >= workerCap" @change="wizard.workerIds.includes(n.id) ? (wizard.workerIds = wizard.workerIds.filter((x) => x !== n.id)) : wizard.workerIds.length < workerCap && wizard.workerIds.push(n.id)" />
                  {{ n.name }} · {{ n.kind }}{{ n.online ? "" : " (offline)" }}
                </label>
              </div>
              <!-- IR-152: the 8th click used to be silently ignored. -->
              <p v-if="workerHint !== null" class="stat__sub">{{ workerHint }}</p>
            </div>
          </div>
        </section>

        <section v-show="step === 2" class="step card__body">
          <div class="stack">
            <input v-model="modelSearch" class="input mono" type="search" placeholder="Search the NAS catalog…" @input="onModelSearch" />
            <div class="pick-grid" style="max-height: 340px; overflow-y: auto">
              <label v-for="m in modelChoices" :key="m.name" class="pick" :class="{ 'is-on': wizard.model === m.name }">
                <input type="radio" name="wmodel" :checked="wizard.model === m.name" @change="onPickModel(m.name)" />
                <span style="flex: 1; min-width: 0;">
                  <strong>{{ m.name }}</strong> <span class="chip">{{ m.runtime }}</span> <span class="chip">{{ fmtGiB(m.bytes) }}</span>
                  <span class="stat__sub mono" style="display: block; overflow-wrap: anywhere;">{{ m.repository }}</span>
                </span>
              </label>
              <p v-if="modelChoices.length === 0" class="faint">no catalog matches — the exact HF repo id can be typed below for a chained download</p>
            </div>
            <div class="field"><label>Model (catalog name or HF repo id)</label><input v-model="wizard.model" class="input mono" /></div>
            <div class="field"><label>Serving port (script-defined; probed for health)</label><input v-model.number="wizardPort" class="input" type="number" min="1" max="65535" /></div>
          </div>
        </section>

        <section v-show="step === 3" class="step card__body">
          <div class="stack">
            <!-- IR-152: the old placeholder suggested ~ paths the head resolves
                 literally; tilde is rejected with an actionable message. -->
            <div class="field"><label>Scripts folder — absolute path on the head</label><input v-model="wizard.recipeFolder" class="input mono" :class="{ 'input--invalid': folderPathError !== null }" placeholder="/home/you/developer/recipes/GLM-5.3-Flash-EXL3" />
              <p v-if="folderPathError !== null" class="field-error">{{ folderPathError }}</p>
            </div>
            <div class="cols cols-2" style="gap: 10px">
              <div class="field"><label>Start script</label><input v-model="wizard.startName" class="input mono" :class="{ 'input--invalid': startPathError !== null }" placeholder="start-tp3.sh" />
                <p v-if="startPathError !== null" class="field-error">{{ startPathError }}</p>
              </div>
              <div class="field"><label>Stop script — required</label><input v-model="wizard.stopName" class="input mono" :class="{ 'input--invalid': stopPathError !== null }" placeholder="stop.sh" />
                <p v-if="stopPathError !== null" class="field-error">{{ stopPathError }}</p>
              </div>
            </div>
            <div class="row">
              <!-- IR-152: Next already validates on the head (test -x) before
                   saving; this re-checks without moving. -->
              <button class="btn btn--secondary btn--sm" :disabled="validating" @click="onValidate">{{ validating ? "validating…" : "Re-check scripts on head" }}</button>
              <template v-if="validation !== null">
                <span v-for="v in validation" :key="v.script" class="chip" :class="v.ok ? 'chip--ok' : 'chip--warn'">
                  <span class="dot" :class="v.ok ? 'dot--ok' : 'dot--warn'" aria-hidden="true"></span>
                  {{ v.ok ? "exists & executable" : v.error }}
                </span>
              </template>
            </div>
            <div class="field"><label>Optional env exports for the scripts</label>
              <div class="env-grid">
                <label class="pick" :class="{ 'is-on': wizard.envModelName }"><input v-model="wizard.envModelName" type="checkbox" /> MODEL_NAME</label>
                <label class="pick" :class="{ 'is-on': wizard.envPort }"><input v-model="wizard.envPort" type="checkbox" /> PORT</label>
                <label class="pick" :class="{ 'is-on': wizard.envModelPath }"><input v-model="wizard.envModelPath" type="checkbox" /> MODEL_PATH <span class="stat__sub">via modelctl path --local</span></label>
                <label class="pick" :class="{ 'is-on': wizard.envExtraArgs }"><input v-model="wizard.envExtraArgs" type="checkbox" /> EXTRA_ARGS</label>
              </div>
              <input v-if="wizard.envExtraArgs" v-model="wizard.extraArgs" class="input mono" style="margin-top: 6px" placeholder="--thinking --vision …" />
              <label class="pick" :class="{ 'is-on': wizard.capture }" style="margin-top: 6px"><input v-model="wizard.capture" type="checkbox" @change="onCaptureToggle" /> Capture usage <span class="stat__sub">agent proxies the LAN port, records per-request usage; the start script must honor $PORT.</span></label>
              <label v-if="wizard.capture" class="pick" :class="{ 'is-on': wizard.retain }" style="margin-top: 6px"><input v-model="wizard.retain" type="checkbox" /> Keep bodies <span class="stat__sub">stores deduped request/response bodies for chat reconstruction (capped).</span></label>
            </div>
          </div>
        </section>

        <section v-show="step === 4" class="step card__body">
          <div class="stack">
            <!-- IR-152: state-shaped vocabulary shared with the Models page
                 (placementChip) — raw verbs read as two meanings of one concept. -->
            <dl v-if="placementRows !== null" class="kv">
              <template v-for="row in placementRows" :key="row.node.id">
                <dt>{{ row.node.name }} · {{ row.node.role }}</dt>
                <dd>
                  <span class="chip" :class="placementChip(row.action).cls">{{ placementChip(row.action).label }}</span>
                  <template v-if="row.reason !== null"> {{ row.reason }}</template>
                  <template v-if="row.bytes !== null"> · {{ fmtGiB(row.bytes) }}</template>
                </dd>
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
              <span class="stat__sub">missing models are copied to the nodes in staged progress — Start runs whenever you launch it.</span>
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
          </div>
        </section>

        <section v-show="step === 5" class="step card__body">
          <div class="stack" style="gap: 14px">
            <div>
              <!-- IR-152: this is a configuration summary, not what runs now. -->
              <p class="stat__sub" style="margin: 0 0 4px"><strong>Configuration</strong></p>
              <dl class="kv">
                <dt>name</dt><dd>{{ wizard.name.trim() || wizard.model }}</dd>
                <dt>model</dt><dd class="mono">{{ wizard.model }}</dd>
                <dt>type</dt><dd>{{ wizard.kind === "cluster" ? "cluster" : "single node" }}</dd>
                <template v-if="wizard.kind === 'cluster'">
                  <dt>head</dt><dd><span class="chip">{{ nodeName(wizard.headNodeId) }}</span></dd>
                  <dt>workers</dt><dd><span v-for="id in wizard.workerIds" :key="id" class="chip" style="margin-right: 4px">{{ nodeName(id) }}</span><span v-if="wizard.workerIds.length === 0" class="faint">none</span></dd>
                </template>
                <template v-else>
                  <dt>node</dt><dd><span class="chip">{{ nodeName(wizard.headNodeId) }}</span></dd>
                </template>
              </dl>
            </div>
            <div>
              <p class="stat__sub" style="margin: 0 0 4px"><strong>Port and health</strong></p>
              <dl class="kv">
                <dt>port</dt><dd>{{ wizardPort }} <span class="faint">· probed for health</span></dd>
              </dl>
            </div>
            <div>
              <p class="stat__sub" style="margin: 0 0 4px"><strong>Scripts</strong></p>
              <dl class="kv">
                <dt>start</dt><dd class="mono" style="overflow-wrap: anywhere;">{{ composedStart }}</dd>
                <dt>stop</dt><dd class="mono" style="overflow-wrap: anywhere;">{{ composedStop }} <span class="faint">(re-checked at every start)</span></dd>
              </dl>
            </div>
            <div>
              <p class="stat__sub" style="margin: 0 0 4px"><strong>Environment</strong></p>
              <p style="margin: 0">
                <template v-if="envChips.length === 0"><span class="faint">no env exports, no capture</span></template>
                <span v-for="c in envChips" :key="c" class="chip mono" style="margin: 0 4px 4px 0">{{ c }}</span>
              </p>
            </div>
          </div>
        </section>

        <!-- IR-152: the error sits above the footer, next to the fields it
             refers to (it used to render below the sticky footer, far away). -->
        <p v-if="wizardError" class="banner banner--warn" style="margin: 0 16px 10px">{{ wizardError }}</p>

        <div class="card__head row--between wizard__foot" style="display: flex; border-top: 1px solid var(--border); border-bottom: 0">
          <span class="stat__sub">step {{ step }} of 5</span>
          <div class="row">
            <button v-if="step > 1" class="btn btn--secondary btn--sm" @click="prevStep">Back</button>
            <button v-if="step === 5 && wizard.editId === null" class="btn btn--secondary btn--sm" :disabled="busy" @click="onSaveOnly">{{ busy ? "working…" : "Save without starting" }}</button>
            <button v-if="step < 5" class="btn btn--primary btn--sm" :disabled="validating" @click="nextStep">{{ validating && step === 3 ? "checking…" : `Next · ${STEPS[step]}` }}</button>
            <button v-else class="btn btn--primary btn--sm" :disabled="busy" @click="onFinish">{{ busy ? "working…" : wizard.editId !== null ? "Save" : "Create & start" }}</button>
          </div>
        </div>
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
/* IR-152: Running-now rows — probe truth, dense one-liner per engine. */
.runnow {
  cursor: default;
}
.runnow__row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 11px 16px;
}
.runnow__port {
  color: var(--muted);
}
/* IR-152: the failure reason reads as a statement, not a faint hint. */
.fail-line {
  margin: 8px 0 0;
  color: var(--thread-ink);
  border: 1px solid var(--thread);
  background: var(--thread-wash);
  border-radius: var(--radius-sm, 6px);
  padding: 6px 10px;
  font-size: 12.5px;
  overflow-wrap: anywhere;
}
.field-error {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--thread-ink);
}
.input--invalid {
  border-color: var(--thread);
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
/* IRI-042: the wizard chrome stays pinned while the step body scrolls. */
.wizard__head {
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--surface);
}
.wizard__foot {
  position: sticky;
  bottom: 0;
  z-index: 2;
  background: var(--surface);
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
/* IR-152: dots became navigation buttons — keep the span's look, drop the
 * chrome, and grey the not-yet-visited ones. */
.step-dot--btn {
  background: none;
  border: 0;
  padding: 0;
  font: inherit;
  cursor: pointer;
}
.step-dot--btn:disabled,
.step-dot--btn.is-locked {
  cursor: default;
  opacity: 0.55;
}
.pick.is-capped {
  opacity: 0.55;
  cursor: not-allowed;
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
/* IRI-051: the model picker scans two columns at a glance instead of one
 * tall radio card per model; rows keep the .pick chrome. */
.pick-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  align-content: start;
}
.pick-grid .pick {
  align-items: flex-start;
}
/* IRI-051: env exports as a compact two-column checkbox grid. */
.env-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  align-content: start;
}
@media (max-width: 720px) {
  .pick-grid,
  .env-grid {
    grid-template-columns: 1fr;
  }
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
