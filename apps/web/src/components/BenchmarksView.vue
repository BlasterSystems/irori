<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { fetchNodes } from "../api";
import type { NodeInfo } from "@irori/core";
import { formatP } from "@irori/core";
import { live } from "../live";
import {
  cancelBenchRun,
  benchConfigSummary,
  benchHeadline,
  benchTargetLabel,
  canCompare,
  compareQualityRuns,
  decodeBestLevel,
  fetchBenchActive,
  fetchBenchRuns,
  formatContextSize,
  startBench,
  type BenchRun,
  type DecodeResult,
  type PrefillResult,
  type QualityResult,
  type ToolevalResult,
} from "../bench";

/* ── Bench tabs + forms ───────────────────────────────────────────────── */

const TABS = [
  { id: "decode", label: "Decode" },
  { id: "prefill", label: "Prefill" },
  { id: "quality", label: "Quality" },
  { id: "tooleval", label: "Tool eval" },
] as const;
type Tab = (typeof TABS)[number]["id"];

const tab = ref<Tab>("decode");
const nodes = ref<NodeInfo[]>([]);
const runs = ref<BenchRun[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const formError = ref<string | null>(null);
const starting = ref(false);

const decodeConcOptions = [1, 2, 4, 8, 16, 32];
const decodeConc = ref<number[]>([1, 4, 8]);
const decodeMaxTokens = ref(400);
const decodePromptType = ref("structured");
const prefillSizeOptions = [1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144, 300000];
const prefillSizes = ref<number[]>([4096, 8192, 16384, 32768]);
const qualityCategories = ["qa", "reason", "arith", "track", "gsm8k", "mmlu"] as const;
const qualityCatLabels: Record<string, string> = {
  qa: "QA",
  reason: "Reasoning",
  arith: "Arithmetic chain",
  track: "State tracking",
  gsm8k: "GSM8K",
  mmlu: "MMLU",
};
const qualityCats = ref<string[]>([...qualityCategories]);
const qualityConcurrency = ref(4);
const targetNodeId = ref<string>("");
const targetPort = ref<number | null>(null);
const targetModel = ref<string>("");

function sizeLabel(n: number): string {
  return formatContextSize(n);
}

function toggle<T>(list: T[], value: T): void {
  const i = list.indexOf(value);
  if (i === -1) list.push(value);
  else list.splice(i, 1);
}

/** Nodes with a real engine to hit: LLM-assigned sparks/hosts first. */
const benchableNodes = computed(() => nodes.value.filter((n) => n.kind !== "nas"));

function nodePorts(node: NodeInfo | undefined): number[] {
  return node?.llmPorts ?? [];
}

function onTargetChange(): void {
  const node = nodes.value.find((n) => n.id === targetNodeId.value);
  const ports = nodePorts(node);
  targetPort.value = ports.length > 0 ? ports[0]! : 8080;
}

/* ── History + compare selection ──────────────────────────────────────── */

const selected = ref<string[]>([]);

const runsForTab = computed(() => runs.value.filter((r) => r.type === tab.value));

const compareRuns = computed(() => {
  const [a, b] = selected.value;
  const aRun = runsForTab.value.find((r) => r.id === a);
  const bRun = runsForTab.value.find((r) => r.id === b);
  if (!canCompare(aRun, bRun) || aRun!.type !== bRun!.type) return null;
  return { a: aRun!, b: bRun! };
});

function toggleSelect(id: string): void {
  const i = selected.value.indexOf(id);
  if (i !== -1) {
    selected.value.splice(i, 1);
    return;
  }
  if (selected.value.length >= 2) selected.value.shift();
  selected.value.push(id);
}

interface DecodeCompareRow {
  concurrency: number;
  a: number | null;
  b: number | null;
  aStream: number | null;
  bStream: number | null;
}

const decodeCompareRows = computed<DecodeCompareRow[]>(() => {
  if (compareRuns.value === null || compareRuns.value.a.type !== "decode") return [];
  const levelsOf = (run: BenchRun): DecodeCompareRow[] =>
    (run.result as DecodeResult).levels.map((l) => ({
      concurrency: l.concurrency,
      a: l.aggregateDecodeTps,
      b: null,
      aStream: l.meanDecodeTps,
      bStream: null,
    }));
  const rows = new Map<number, DecodeCompareRow>();
  for (const row of levelsOf(compareRuns.value.a)) rows.set(row.concurrency, { ...row });
  for (const level of (compareRuns.value.b.result as DecodeResult).levels) {
    const existing = rows.get(level.concurrency);
    if (existing) {
      existing.b = level.aggregateDecodeTps;
      existing.bStream = level.meanDecodeTps;
    } else {
      rows.set(level.concurrency, { concurrency: level.concurrency, a: null, b: level.aggregateDecodeTps, aStream: null, bStream: level.meanDecodeTps });
    }
  }
  return [...rows.values()].sort((x, y) => x.concurrency - y.concurrency);
});

interface PrefillCompareRow {
  tokens: number;
  a: number | null;
  b: number | null;
}

const prefillCompareRows = computed<PrefillCompareRow[]>(() => {
  if (compareRuns.value === null || compareRuns.value.a.type !== "prefill") return [];
  const rows = new Map<number, PrefillCompareRow>();
  for (const s of (compareRuns.value.a.result as PrefillResult).sizes) rows.set(s.tokens, { tokens: s.tokens, a: s.medianTps, b: null });
  for (const s of (compareRuns.value.b.result as PrefillResult).sizes) {
    const existing = rows.get(s.tokens);
    if (existing) existing.b = s.medianTps;
    else rows.set(s.tokens, { tokens: s.tokens, a: null, b: s.medianTps });
  }
  return [...rows.values()].sort((x, y) => x.tokens - y.tokens);
});

const qualityCompare = computed(() => {
  if (compareRuns.value === null || compareRuns.value.a.type !== "quality") return null;
  return compareQualityRuns(compareRuns.value.a.result as QualityResult, compareRuns.value.b.result as QualityResult);
});

const qualityCompareRows = computed(() => {
  if (qualityCompare.value === null) return [];
  return qualityCompare.value.rows.map((row) => ({
    ...row,
    label: qualityCatLabels[row.category] ?? row.category,
  }));
});

const toolevalCompareRows = computed(() => {
  if (compareRuns.value === null || compareRuns.value.a.type !== "tooleval") return [];
  const rows = new Map<string, { id: string; title: string; a: boolean | null; b: boolean | null }>();
  for (const s of (compareRuns.value.a.result as ToolevalResult).scenarios) rows.set(s.id, { id: s.id, title: s.title, a: s.pass, b: null });
  for (const s of (compareRuns.value.b.result as ToolevalResult).scenarios) {
    const existing = rows.get(s.id);
    if (existing) existing.b = s.pass;
    else rows.set(s.id, { id: s.id, title: s.title, a: null, b: s.pass });
  }
  return [...rows.values()].sort((x, y) => x.id.localeCompare(y.id));
});

/* ── Run lifecycle ────────────────────────────────────────────────────── */

const progressOf = (run: BenchRun): string | null => {
  const entry = live.benches.get(run.id);
  if (!entry || entry.status !== "running" || !entry.progress) return null;
  const p = entry.progress;
  const parts = [`${p.index}/${p.total}`];
  if (p.label) parts.push(p.label);
  if (p.liveTps !== null) parts.push(`${p.liveTps} tok/s`);
  return parts.join(" · ");
};

async function start(): Promise<void> {
  if (targetNodeId.value === "") {
    formError.value = "Pick a target node first.";
    return;
  }
  starting.value = true;
  formError.value = null;
  try {
    const base: Record<string, unknown> = { port: targetPort.value ?? 8080 };
    if (targetModel.value.trim() !== "") base.model = targetModel.value.trim();
    if (tab.value === "decode") {
      await startBench("decode", targetNodeId.value, { ...base, concurrencies: [...decodeConc.value].sort((a, b) => a - b), maxTokens: decodeMaxTokens.value, promptType: decodePromptType.value });
    } else if (tab.value === "prefill") {
      await startBench("prefill", targetNodeId.value, { ...base, sizes: [...prefillSizes.value].sort((a, b) => a - b) });
    } else if (tab.value === "quality") {
      await startBench("quality", targetNodeId.value, { ...base, categories: [...qualityCats.value], concurrency: qualityConcurrency.value });
    } else {
      await startBench("tooleval", targetNodeId.value, { ...base });
    }
    await load();
  } catch (err) {
    formError.value = err instanceof Error ? err.message : String(err);
  } finally {
    starting.value = false;
  }
}

async function cancel(run: BenchRun): Promise<void> {
  try {
    await cancelBenchRun(run.id);
    await load();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

/* ── Load + poll ──────────────────────────────────────────────────────── */

let pollTimer: ReturnType<typeof setInterval> | undefined;
let loadSeq = 0;

async function load(): Promise<void> {
  const seq = ++loadSeq;
  try {
    const [active, all] = await Promise.all([fetchBenchActive(), fetchBenchRuns(tab.value, { limit: 30 })]);
    if (seq !== loadSeq) return;
    const byId = new Map(all.map((r) => [r.id, r]));
    const merged = [...all, ...active.filter((r) => !byId.has(r.id) && r.type === tab.value)];
    runs.value = merged.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    error.value = null;
  } catch (err) {
    if (seq !== loadSeq) return;
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    if (seq === loadSeq) loading.value = false;
  }
}

onMounted(async () => {
  try {
    nodes.value = await fetchNodes();
    const first = benchableNodes.value[0];
    if (first) {
      targetNodeId.value = first.id;
      onTargetChange();
    }
  } catch {
    /* registry unavailable — the form still renders */
  }
  await load();
  pollTimer = setInterval(() => void load(), 2500);
});

onBeforeUnmount(() => {
  clearInterval(pollTimer);
});
</script>

<template>
  <div class="pagehead">
    <div>
      <h1>Benchmarks</h1>
      <p>Decode · prefill · quality · tool eval — runs execute via the agent against live engines.</p>
    </div>
  </div>

  <div class="tabs" role="tablist" aria-label="Benchmark type" style="margin-bottom: 12px">
    <button
      v-for="t in TABS"
      :key="t.id"
      role="tab"
      :class="{ 'is-active': tab === t.id }"
      :aria-selected="tab === t.id"
      @click="tab = t.id; selected = []; void load()"
    >
      {{ t.label }}
    </button>
  </div>

  <section class="card" style="margin-bottom: 12px">
    <div class="card__head">
      <h3>New {{ tab }} run</h3>
      <span class="mono faint">lab protocol · temp 0 · thinking off</span>
    </div>
    <div class="card__body">
      <div class="cols cols-4">
        <div class="field">
          <label for="bench-target">Target</label>
          <select id="bench-target" v-model="targetNodeId" class="select mono" @change="onTargetChange">
            <option value="" disabled>— select node —</option>
            <option v-for="node in benchableNodes" :key="node.id" :value="node.id">{{ node.name }}</option>
          </select>
        </div>
        <div class="field">
          <label for="bench-port">Port</label>
          <select id="bench-port" v-model="targetPort" class="select mono">
            <option :value="null" disabled>—</option>
            <option v-for="port in nodePorts(nodes.find((n) => n.id === targetNodeId))" :key="port" :value="port">{{ port }}</option>
            <option v-if="nodePorts(nodes.find((n) => n.id === targetNodeId)).length === 0" :value="8080">8080</option>
          </select>
        </div>
        <div class="field">
          <label for="bench-model">Model</label>
          <input id="bench-model" v-model="targetModel" class="input mono" placeholder="auto-detect" />
        </div>
        <div v-if="tab === 'decode'" class="field">
          <label for="bench-maxtok">Max tokens</label>
          <input id="bench-maxtok" v-model.number="decodeMaxTokens" class="input mono" type="number" min="64" max="2048" step="32" />
        </div>
        <div v-else-if="tab === 'quality'" class="field">
          <label for="bench-conc">Concurrency</label>
          <input id="bench-conc" v-model.number="qualityConcurrency" class="input mono" type="number" min="1" max="16" />
        </div>
        <div v-else class="field">
          <label>&nbsp;</label>
          <span class="stat__sub">{{ tab === "tooleval" ? "20 deterministic scenarios" : "unique prefix per request" }}</span>
        </div>
      </div>

      <div v-if="tab === 'decode'" class="row row--wrap" style="margin-top: 10px">
        <span class="label">Concurrency</span>
        <button
          v-for="c in decodeConcOptions"
          :key="c"
          class="bs-filter"
          :aria-pressed="decodeConc.includes(c)"
          @click="toggle(decodeConc, c)"
        >
          ×{{ c }}
        </button>
        <span class="label" style="margin-left: 12px">Task</span>
        <select v-model="decodePromptType" class="select" style="width: auto">
          <option value="structured">Structured</option>
          <option value="prose">Prose</option>
          <option value="code">Code</option>
          <option value="json">JSON</option>
        </select>
      </div>
      <div v-if="tab === 'prefill'" class="row row--wrap" style="margin-top: 10px">
        <span class="label">Context sizes</span>
        <button
          v-for="s in prefillSizeOptions"
          :key="s"
          class="bs-filter"
          :aria-pressed="prefillSizes.includes(s)"
          @click="toggle(prefillSizes, s)"
        >
          {{ sizeLabel(s) }}
        </button>
      </div>
      <div v-if="tab === 'quality'" class="row row--wrap" style="margin-top: 10px">
        <span class="label">Categories</span>
        <button
          v-for="c in qualityCategories"
          :key="c"
          class="bs-filter"
          :aria-pressed="qualityCats.includes(c)"
          @click="toggle(qualityCats, c)"
        >
          {{ qualityCatLabels[c] }}
        </button>
      </div>

      <div class="row row--between" style="margin-top: 12px">
        <span v-if="formError" class="mono" style="color: var(--thread-ink)">{{ formError }}</span>
        <span v-else class="stat__sub">streams share one server · results persist in Postgres (last 30 per type)</span>
        <button class="btn btn--primary btn--sm" :disabled="starting" @click="start">{{ starting ? "Starting…" : `Start ${tab} run` }}</button>
      </div>
    </div>
  </section>

  <div class="row row--between" style="margin-bottom: 8px">
    <h2>History</h2>
    <div class="row">
      <span class="stat__sub">{{ runsForTab.length }} runs</span>
      <button v-if="compareRuns" class="btn btn--secondary btn--sm" @click="selected = []">Clear compare</button>
    </div>
  </div>

  <section class="card">
    <div class="card__body card__body--flush" style="overflow-x: auto">
      <div v-if="error" class="banner" style="margin: 12px">{{ error }}</div>
      <table class="table">
        <thead>
          <tr>
            <th>Run</th>
            <th>When</th>
            <th>Target</th>
            <th>Config</th>
            <th>{{ tab === "quality" ? "Score" : tab === "tooleval" ? "Pass" : "tok/s" }}</th>
            <th>State</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="run in runsForTab" :key="run.id">
            <td class="mono">{{ run.id.slice(0, 8) }}</td>
            <td class="mono faint">{{ run.status === "running" ? "running" : new Date(run.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) }}</td>
            <td class="mono">{{ benchTargetLabel(run) }}</td>
            <td class="mono faint">{{ benchConfigSummary(run) }}</td>
            <td class="mono">
              <strong v-if="run.status === 'completed'">{{ benchHeadline(run) }}</strong>
              <span v-else-if="run.status === 'running'">{{ progressOf(run) ?? "…" }}</span>
              <span v-else class="faint">{{ benchHeadline(run) }}</span>
            </td>
            <td>
              <span v-if="run.status === 'running'" class="chip"><span class="dot dot--run" aria-hidden="true"></span>running</span>
              <span v-else-if="run.status === 'completed'" class="chip chip--ok"><span class="dot dot--ok" aria-hidden="true"></span>completed</span>
              <span v-else-if="run.status === 'canceled'" class="chip chip--muted"><span class="dot dot--halt" aria-hidden="true"></span>cancelled</span>
              <span v-else class="chip chip--warn"><span class="dot dot--warn" aria-hidden="true"></span>failed</span>
            </td>
            <td style="text-align: right">
              <label v-if="run.status === 'completed'" class="visually-hidden" :for="`sel-${run.id}`">select for compare</label>
              <input
                v-if="run.status === 'completed'"
                :id="`sel-${run.id}`"
                type="checkbox"
                :checked="selected.includes(run.id)"
                style="accent-color: var(--ink); margin-right: 6px"
                @change="toggleSelect(run.id)"
              />
              <button v-if="run.status === 'running'" class="btn btn--danger btn--sm" @click="cancel(run)">Cancel</button>
            </td>
          </tr>
          <tr v-if="runsForTab.length === 0 && !loading">
            <td colspan="7" class="faint" style="text-align: center">No {{ tab }} runs yet.</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>

  <section v-if="compareRuns" class="card" style="margin-top: 12px">
    <div class="card__head">
      <h3>Compare</h3>
      <span class="mono faint">{{ compareRuns.a.id.slice(0, 8) }} vs {{ compareRuns.b.id.slice(0, 8) }}</span>
    </div>
    <div class="card__body card__body--flush" style="overflow-x: auto">
      <!-- Decode: aggregate + per-stream tok/s per concurrency level -->
      <table v-if="tab === 'decode'" class="table">
        <thead>
          <tr><th>Load</th><th>A aggregate</th><th>B aggregate</th><th>A stream</th><th>B stream</th></tr>
        </thead>
        <tbody>
          <tr v-for="row in decodeCompareRows" :key="row.concurrency">
            <td class="mono">×{{ row.concurrency }}</td>
            <td class="mono">{{ row.a !== null ? row.a.toFixed(1) : "—" }}</td>
            <td class="mono">{{ row.b !== null ? row.b.toFixed(1) : "—" }}</td>
            <td class="mono faint">{{ row.aStream !== null ? row.aStream.toFixed(1) : "—" }}</td>
            <td class="mono faint">{{ row.bStream !== null ? row.bStream.toFixed(1) : "—" }}</td>
          </tr>
        </tbody>
      </table>

      <!-- Prefill: median tok/s per context size -->
      <table v-else-if="tab === 'prefill'" class="table">
        <thead>
          <tr><th>Context</th><th>A tok/s</th><th>B tok/s</th></tr>
        </thead>
        <tbody>
          <tr v-for="row in prefillCompareRows" :key="row.tokens">
            <td class="mono">{{ sizeLabel(row.tokens) }}</td>
            <td class="mono">{{ row.a !== null ? row.a.toFixed(0) : "—" }}</td>
            <td class="mono">{{ row.b !== null ? row.b.toFixed(0) : "—" }}</td>
          </tr>
        </tbody>
      </table>

      <!-- Quality: per-category + McNemar -->
      <template v-else-if="tab === 'quality'">
        <table class="table">
          <thead>
            <tr><th>Category</th><th>A</th><th>B</th><th>only A</th><th>only B</th><th>p</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in qualityCompareRows" :key="row.category">
              <td>{{ row.label }}</td>
              <td class="mono">{{ row.pctA !== null ? `${row.pctA.toFixed(1)}%` : "—" }}</td>
              <td class="mono">{{ row.pctB !== null ? `${row.pctB.toFixed(1)}%` : "—" }}</td>
              <td class="mono">{{ row.onlyA }}</td>
              <td class="mono">{{ row.onlyB }}</td>
              <td class="mono">{{ row.onlyA + row.onlyB === 0 ? "—" : formatP(row.p) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="qualityCompare" class="stat__sub" style="padding: 10px 12px">{{ qualityCompare.note }}</p>
      </template>

      <!-- Tool eval: side-by-side per scenario -->
      <table v-else class="table">
        <thead>
          <tr><th>Scenario</th><th>Title</th><th>A</th><th>B</th></tr>
        </thead>
        <tbody>
          <tr v-for="row in toolevalCompareRows" :key="row.id">
            <td class="mono">{{ row.id }}</td>
            <td>{{ row.title }}</td>
            <td class="mono">{{ row.a === null ? "—" : row.a ? "pass" : "fail" }}</td>
            <td class="mono">{{ row.b === null ? "—" : row.b ? "pass" : "fail" }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>

  <p class="stat__sub" style="margin-top: 10px">
    Paired quality compares report exact McNemar p on items only one run got right · p ≥ 0.05 means within noise.
  </p>
</template>
