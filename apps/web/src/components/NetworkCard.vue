<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { linkRates, type NetworkTestView, type TopologyLink } from "@irori/core";
import { live } from "../live";
import Tip from "./Tip.vue";
import {
  fetchLinkTests,
  latestTestByLink,
  LinkTestError,
  startAllLinkTests,
  startLinkTest,
  testSummary,
  acquireLiveLease,
  LIVE_RENEW_MS,
  LiveLeaseError,
  releaseLiveLease,
  withLiveRates,
  diagramLayout,
  fetchTopology,
  fmtBits,
  fmtRtt,
  linkFormat,
  linkLatency,
  ringOrder,
  roleLabel,
  utilPct,
  type TopologyView,
} from "../network";

/**
 * IRI-163 (ADR-0021): Overview Network card — the RoCE fabric between
 * Sparks. Structure and warnings come from GET /api/v1/network/topology
 * (re-read every 30 s); throughput is live from the SSE snapshot stream.
 * The NAS and the management LAN are never drawn (owner scope decision).
 */

const TOPOLOGY_REFRESH_MS = 30_000;

const topology = ref<TopologyView | null>(null);
const loadError = ref<string | null>(null);
let timer: ReturnType<typeof setInterval> | undefined;

async function refresh(): Promise<void> {
  try {
    topology.value = await fetchTopology();
    loadError.value = null;
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err);
  }
}

onMounted(() => {
  void refresh();
  void refreshTests();
  timer = setInterval(() => void refresh(), TOPOLOGY_REFRESH_MS);
});
onUnmounted(() => {
  clearInterval(timer);
  void stopLive();
});

// ─── IRI-166: on-demand link tests ──────────────────────────────────────────
const tests = ref<NetworkTestView[]>([]);
const testsRunning = ref(false);
const testMsg = ref<string | null>(null);
/** A refused request waiting for "Run anyway": the target and the reasons. */
const pendingGuard = ref<{ link: TopologyLink | null; reasons: string[]; error: string } | null>(null);

async function refreshTests(): Promise<void> {
  try {
    const out = await fetchLinkTests();
    tests.value = out.tests;
    testsRunning.value = out.running;
  } catch {
    /* tests unavailable (degraded hub) — the column shows "never tested" */
  }
}

// Every lifecycle frame (start, stage, result) re-reads the rows.
watch(
  () => live.netTestPulse?.value,
  (pulse) => {
    void refreshTests();
    // The terminal frame is sent while the hub still counts the run as busy:
    // read once more so the buttons re-enable.
    if (pulse != null && (pulse as { status?: string }).status !== "running") setTimeout(() => void refreshTests(), 1500);
  },
);

const latestTests = computed(() => latestTestByLink(tests.value));

async function runTest(link: TopologyLink | null, override = false): Promise<void> {
  testMsg.value = null;
  pendingGuard.value = null;
  try {
    if (link === null) {
      await startAllLinkTests(override);
      testMsg.value = "Testing every fabric link in turn, about 30 s each.";
    } else {
      await startLinkTest(link.a, link.b, override);
    }
    testsRunning.value = true;
    await refreshTests();
  } catch (err) {
    if (err instanceof LinkTestError && err.status === 409 && err.reasons.length > 0) {
      pendingGuard.value = { link, reasons: err.reasons, error: err.message };
      return;
    }
    testMsg.value = err instanceof Error ? err.message : String(err);
  }
}

// ─── IRI-164: opt-in live rates (shared 60 s lease, renewed while visible) ──
const LIVE_RATES = [
  { ms: 1000, label: "1 s" },
  { ms: 500, label: "500 ms" },
  { ms: 250, label: "250 ms" },
] as const;
const liveOn = ref(false);
const liveIntervalMs = ref<number>(1000);
const liveMsg = ref<string | null>(null);
let leaseId: string | null = null;
let renewTimer: ReturnType<typeof setInterval> | undefined;
/** Ticks so a frame that stops arriving goes stale on screen too. */
const clock = ref(Date.now());
let clockTimer: ReturnType<typeof setInterval> | undefined;

async function takeLease(): Promise<void> {
  try {
    const lease = await acquireLiveLease(liveIntervalMs.value, leaseId ?? undefined);
    leaseId = lease.leaseId;
    liveMsg.value = lease.effectiveIntervalMs < liveIntervalMs.value ? `another viewer streams at ${lease.effectiveIntervalMs} ms` : null;
  } catch (err) {
    if (err instanceof LiveLeaseError && err.status === 410 && err.reason === "unknown-lease" && leaseId !== null) {
      // The lease lapsed (hidden tab): take a fresh one; the cap restarts.
      leaseId = null;
      await takeLease();
      return;
    }
    if (err instanceof LiveLeaseError && err.status === 410) {
      // The 10-minute limit: stop visibly rather than silently re-leasing forever.
      leaseId = null;
      await stopLive();
      liveMsg.value = "Live mode stopped after 10 minutes.";
      return;
    }
    await stopLive();
    liveMsg.value = err instanceof Error ? err.message : String(err);
  }
}

async function startLive(): Promise<void> {
  liveOn.value = true;
  liveMsg.value = null;
  await takeLease();
  if (!liveOn.value) return;
  clearInterval(renewTimer);
  renewTimer = setInterval(() => {
    // Renew only while the page is visible; a hidden tab lets the lease lapse.
    if (typeof document === "undefined" || document.visibilityState !== "hidden") void takeLease();
  }, LIVE_RENEW_MS);
  clearInterval(clockTimer);
  clockTimer = setInterval(() => (clock.value = Date.now()), 500);
}

async function stopLive(): Promise<void> {
  liveOn.value = false;
  clearInterval(renewTimer);
  clearInterval(clockTimer);
  renewTimer = undefined;
  if (leaseId !== null) {
    const id = leaseId;
    leaseId = null;
    await releaseLiveLease(id);
  }
}

async function toggleLive(): Promise<void> {
  if (liveOn.value) await stopLive();
  else await startLive();
}

async function changeRate(): Promise<void> {
  if (liveOn.value) await takeLease();
}

const nameOf = (id: string): string => topology.value?.nodes.find((n) => n.id === id)?.name ?? id.slice(0, 8);

const layout = computed(() => {
  const t = topology.value;
  if (t === null) return null;
  return diagramLayout(ringOrder(t.nodes, t.links));
});

interface LinkRow {
  link: TopologyLink;
  title: string;
  format: string;
  txBps: number | null;
  rxBps: number | null;
  util: number | null;
  rttMs: number | null;
  lossPct: number | null;
  mtuMismatch: boolean;
  down: boolean;
}

const rows = computed<LinkRow[]>(() =>
  (topology.value?.links ?? []).map((link) => {
    // Live: the latest SSE snapshot of node a (tx = a → b).
    // IRI-164: a fresh live frame overrides the 2 s snapshot rates.
    const entries = liveOn.value ? withLiveRates(live.snapshots.get(link.a)?.network, live.netRates?.get(link.a), clock.value) : live.snapshots.get(link.a)?.network;
    const rates = linkRates(link, entries);
    const lat = linkLatency(link, { a: live.snapshots.get(link.a)?.linkProbes, b: live.snapshots.get(link.b)?.linkProbes });
    return {
      link,
      title: `${nameOf(link.a)} ↔ ${nameOf(link.b)}`,
      format: linkFormat(link),
      txBps: rates.txBps,
      rxBps: rates.rxBps,
      util: utilPct(rates, link.speedMbps),
      rttMs: lat.rttMs,
      lossPct: lat.lossPct,
      mtuMismatch: link.lanes.some((l) => l.a.mtu !== null && l.b.mtu !== null && l.a.mtu !== l.b.mtu),
      down: link.lanesUp < link.lanes.length,
    };
  }),
);

const warnLinks = computed(() => new Set((topology.value?.warnings ?? []).filter((w) => w.severity === "warn" && w.linkId !== undefined).map((w) => w.linkId!)));

const runningClusters = computed(() => (topology.value?.clusters ?? []).filter((c) => c.running));
const isEmpty = computed(() => topology.value !== null && topology.value.links.length === 0 && topology.value.switches.length === 0);
</script>

<template>
  <section class="card section-gap netcard" aria-label="Network">
    <div class="card__head">
      <div class="row">
        <h3>Network</h3>
        <Tip text="RoCE fabric between Sparks only — the NAS and the management LAN are never shown · links from neighbour MACs or shared point-to-point subnets · throughput is live from the 2 s snapshots (the larger of RDMA and kernel counters)" />
      </div>
      <div class="row netcontrols">
        <button type="button" class="btn btn--primary btn--sm" :disabled="testsRunning || (topology?.links.length ?? 0) === 0" @click="runTest(null)">Test all fabric links</button>
        <button type="button" class="btn btn--secondary btn--sm" :aria-pressed="liveOn" @click="toggleLive">
          <span class="dot" :class="liveOn ? 'dot--run' : ''" aria-hidden="true"></span>{{ liveOn ? "Live" : "Live off" }}
        </button>
        <label class="visually-hidden" for="net-live-rate">Live refresh rate</label>
        <select id="net-live-rate" v-model.number="liveIntervalMs" class="input netrate" @change="changeRate">
          <option v-for="r in LIVE_RATES" :key="r.ms" :value="r.ms">{{ r.label }}</option>
        </select>
      </div>
    </div>
    <p v-if="liveMsg !== null" class="muted netlivemsg" role="status">{{ liveMsg }}</p>
    <p v-if="testMsg !== null" class="muted netlivemsg" role="status">{{ testMsg }}</p>
    <div v-if="pendingGuard !== null" class="netguard" role="alertdialog" aria-label="Endpoint busy">
      <span class="chip chip--warn">endpoint busy</span>
      <p>{{ pendingGuard.error }}.</p>
      <ul>
        <li v-for="r in pendingGuard.reasons" :key="r">{{ r }}</li>
      </ul>
      <div class="row">
        <button type="button" class="btn btn--ghost btn--sm" @click="pendingGuard = null">Cancel</button>
        <button type="button" class="btn btn--secondary btn--sm" @click="runTest(pendingGuard.link, true)">Run anyway</button>
      </div>
    </div>
    <div class="card__body">
      <p v-if="loadError !== null && topology === null" class="muted">Topology unavailable: {{ loadError }}</p>
      <p v-else-if="topology === null" class="muted">Loading the fabric…</p>
      <p v-else-if="isEmpty" class="muted">No RoCE fabric links detected between Sparks.</p>
      <template v-else>
        <svg
          v-if="layout !== null"
          class="netdiagram"
          :viewBox="`0 0 ${layout.width} ${layout.height}`"
          role="img"
          :aria-label="`Fabric diagram: ${rows.map((r) => r.title).join(', ')}`"
        >
          <g v-for="r in rows" :key="r.link.id">
            <line
              :x1="layout.pos.get(r.link.a)?.x"
              :y1="layout.pos.get(r.link.a)?.y"
              :x2="layout.pos.get(r.link.b)?.x"
              :y2="layout.pos.get(r.link.b)?.y"
              class="netedge"
              :class="{ 'netedge--warn': warnLinks.has(r.link.id) || r.down }"
            />
            <text
              :x="((layout.pos.get(r.link.a)?.x ?? 0) + (layout.pos.get(r.link.b)?.x ?? 0)) / 2"
              :y="((layout.pos.get(r.link.a)?.y ?? 0) + (layout.pos.get(r.link.b)?.y ?? 0)) / 2 - 6"
              class="netlabel"
              text-anchor="middle"
            >{{ r.format }}</text>
            <text
              :x="((layout.pos.get(r.link.a)?.x ?? 0) + (layout.pos.get(r.link.b)?.x ?? 0)) / 2"
              :y="((layout.pos.get(r.link.a)?.y ?? 0) + (layout.pos.get(r.link.b)?.y ?? 0)) / 2 + 10"
              class="netlabel netlabel--live"
              text-anchor="middle"
            >↑ {{ fmtBits(r.txBps) }} ↓ {{ fmtBits(r.rxBps) }}<tspan v-if="r.rttMs !== null"> · {{ fmtRtt(r.rttMs) }}</tspan></text>
          </g>
          <g v-for="n in topology.nodes" :key="n.id" :transform="`translate(${(layout.pos.get(n.id)?.x ?? 0) - 64}, ${(layout.pos.get(n.id)?.y ?? 0) - 22})`">
            <rect width="128" height="44" rx="4" class="nettile" :class="{ 'nettile--off': !n.online }" />
            <text x="64" y="19" text-anchor="middle" class="nettile__name">{{ n.name }}</text>
            <text x="64" y="34" text-anchor="middle" class="nettile__role">{{ n.online ? roleLabel(n.role) : "offline" }}</text>
          </g>
        </svg>

        <table class="table nettable">
          <thead>
            <tr>
              <th>Link</th>
              <th>Format</th>
              <th>Live</th>
              <th>Latency</th>
              <th>Last test</th>
              <th><span class="visually-hidden">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.link.id">
              <td>
                <strong>{{ r.title }}</strong>
                <div class="muted mono">{{ r.link.lanesUp }}/{{ r.link.lanes.length }} lanes up</div>
              </td>
              <td class="mono" :class="{ 'netwarn-text': r.mtuMismatch }">{{ r.format }}</td>
              <td>
                <div class="mono">↑ {{ fmtBits(r.txBps) }} ↓ {{ fmtBits(r.rxBps) }}</div>
                <div class="bar netbar" :title="r.util === null ? 'no rate yet' : `${r.util}% of link speed`">
                  <div class="bar__fill" :style="{ width: (r.util ?? 0) + '%' }"></div>
                </div>
              </td>
              <td class="mono">{{ fmtRtt(r.rttMs) }}<span v-if="r.lossPct !== null"> · {{ r.lossPct }} %</span></td>
              <td class="mono" :title="latestTests.get(r.link.id)?.error ?? undefined">{{ testSummary(latestTests.get(r.link.id), Date.now()) }}</td>
              <td>
                <button type="button" class="btn btn--secondary btn--sm" :disabled="testsRunning || r.link.lanesUp === 0" @click="runTest(r.link)">Test</button>
              </td>
            </tr>
          </tbody>
        </table>

        <ul v-if="topology.switches.length > 0" class="netlist">
          <li v-for="s in topology.switches" :key="s.id" class="mono">
            Switched subnet {{ s.subnet }}: {{ s.members.map((m) => `${nameOf(m.nodeId)} ${m.iface}`).join(", ") }}
          </li>
        </ul>

        <ul v-if="runningClusters.length > 0" class="netlist">
          <li v-for="c in runningClusters" :key="c.id">
            <span class="chip chip--muted">cluster</span>
            {{ c.name }}: {{ nameOf(c.headNodeId) }} (head) with {{ c.memberIds.filter((m) => m !== c.headNodeId).map(nameOf).join(", ") }}
            <span class="muted">· {{ c.fabricPath === null ? "head offline" : c.fabricPath ? "RoCE path to the head" : "no RoCE path to the head" }}</span>
          </li>
        </ul>
      </template>

      <ul v-if="(topology?.warnings.length ?? 0) > 0" class="netwarnings" aria-label="Network warnings">
        <li v-for="(w, i) in topology?.warnings" :key="`${w.code}-${i}`">
          <span class="chip" :class="w.severity === 'warn' ? 'chip--warn' : 'chip--muted'">{{ w.code.replaceAll("-", " ") }}</span>
          <span>{{ w.message }}</span>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.netcontrols { gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.netguard { margin: 0 18px 12px; padding: 12px 14px; border: 1px solid var(--accent); background: var(--accent-wash); border-radius: var(--radius-panel); font-size: var(--fs-small); display: flex; flex-direction: column; gap: 8px; }
.netguard p, .netguard ul { margin: 0; }
.netguard ul { padding-left: 18px; }
.netrate { width: auto; min-height: var(--control-sm); }
.netlivemsg { margin: 0; padding: 0 18px; font-size: var(--fs-small); }
.netdiagram { width: 100%; height: auto; max-height: 360px; display: block; margin-bottom: var(--space-3); }
.netedge { stroke: var(--ink-2); stroke-width: 2; }
.netedge--warn { stroke: var(--thread); stroke-dasharray: 6 4; }
.netlabel { font-family: var(--font-mono); font-size: 11px; fill: var(--text-2); paint-order: stroke; stroke: var(--surface-card); stroke-width: 4px; }
.netlabel--live { fill: var(--text-1); }
.nettile { fill: var(--surface-card); stroke: var(--border-2); }
.nettile--off { stroke-dasharray: 4 3; opacity: 0.6; }
.nettile__name { font-family: var(--font-sans); font-size: 13px; font-weight: 600; fill: var(--text-1); }
.nettile__role { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: var(--tracking-mono); text-transform: uppercase; fill: var(--text-3); }
.nettable td { vertical-align: top; }
.netbar { margin-top: 6px; max-width: 220px; }
.netwarn-text { color: var(--accent-text); }
.netlist, .netwarnings { list-style: none; margin: var(--space-3) 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; font-size: var(--fs-small); }
.netwarnings li { display: flex; gap: 8px; align-items: baseline; }
/* Small tier (IRI-046 / IR-128): the link table is the view; the diagram is dropped. */
html[data-tier="small"] .netdiagram { display: none; }
html[data-tier="small"] .nettable thead { display: none; }
html[data-tier="small"] .nettable tr { display: grid; grid-template-columns: 1fr; padding: 10px 0; border-bottom: 1px solid var(--border); }
html[data-tier="small"] .nettable td { border-bottom: 0; padding: 2px 0; }
</style>
