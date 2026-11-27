<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { linkRates, type NetworkTestView, type TopologyLink } from "@irori/core";
import { live } from "../live";
import { serverCadenceMs } from "../version";
import Tip from "./Tip.vue";
import Sparkline from "./Sparkline.vue";
import NetworkDiagram, { type DiagramEdge, type DiagramNode, type HoverTarget } from "./NetworkDiagram.vue";
import {
  fetchLinkHistory,
  historySeries,
  LINK_TEST_TOOLS,
  type LinkTestTool,
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
  fabricSummary,
  fmtBits,
  fmtLoadPct,
  fmtRtt,
  isClockwise,
  linkFlowState,
  sampleSource,
  linkFormat,
  linkLatency,
  loadBarPct,
  ringOrder,
  roleLabel,
  sharedFormat,
  SNAPSHOT_INTERVAL_MS,
  STALE_INTERVALS,
  utilPct,
  type FlowRow,
  type LinkFlowState,
  type TopologyView,
} from "../network";

/**
 * IRI-163 (ADR-0021): Overview Network card — the RoCE fabric between
 * Sparks. Structure and warnings come from GET /api/v1/network/topology
 * (re-read every 30 s); throughput is live from the SSE snapshot stream.
 * The NAS and the management LAN are never drawn (owner scope decision).
 *
 * IR-286 (IRI-171): animated per-direction lanes (NetworkDiagram), no text on
 * edges, a summary, and a layout driven by the card's OWN width (container
 * queries) so it never overflows wherever the Overview places it.
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
    /* tests unavailable (degraded hub) — the column shows "untested" */
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
      await startAllLinkTests(override, testTool.value);
      testMsg.value = "Testing every fabric link in turn, about 30 s each.";
    } else {
      await startLinkTest(link.a, link.b, override, testTool.value);
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

// IRI-168: the test tool (TCP by default; RDMA is what NCCL sees).
const testTool = ref<LinkTestTool>("iperf3");

// ─── IRI-168: per-link 24 h history (minute rows), re-read every 5 min ───────
const HISTORY_REFRESH_MS = 300_000;
const history = ref(new Map<string, Array<number | null>>());
let historyTimer: ReturnType<typeof setInterval> | undefined;
async function refreshHistory(): Promise<void> {
  const links = topology.value?.links ?? [];
  const next = new Map<string, Array<number | null>>();
  await Promise.all(
    links.map(async (l) => {
      try {
        next.set(l.id, historySeries(await fetchLinkHistory(l.id, "24h")));
      } catch {
        /* history unavailable (degraded hub) — no sparkline */
      }
    }),
  );
  history.value = next;
}
watch(
  () => (topology.value?.links ?? []).map((l) => l.id).join(","),
  (ids, prev) => {
    if (ids !== prev) void refreshHistory();
  },
);
onMounted(() => {
  historyTimer = setInterval(() => void refreshHistory(), HISTORY_REFRESH_MS);
});
onUnmounted(() => clearInterval(historyTimer));

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
}

async function stopLive(): Promise<void> {
  liveOn.value = false;
  clearInterval(renewTimer);
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

// ─── IR-286: freshness ───────────────────────────────────────────────────────
/** Ticks so a frame that stops arriving goes stale on screen too. */
const clock = ref(Date.now());
const clockTimer = setInterval(() => (clock.value = Date.now()), 1000);
onUnmounted(() => clearInterval(clockTimer));

/** The hub's snapshot cadence (IR-87, 1–60 s); the 2 s default only for hubs that predate it. */
const snapshotMs = computed(() => serverCadenceMs.value ?? SNAPSHOT_INTERVAL_MS);

// ─── rows ────────────────────────────────────────────────────────────────────
const nameOf = (id: string): string => topology.value?.nodes.find((n) => n.id === id)?.name ?? id.slice(0, 8);

const order = computed(() => (topology.value === null ? [] : ringOrder(topology.value.nodes, topology.value.links)));
const layout = computed(() => (topology.value === null ? null : diagramLayout(order.value)));

const warnLinks = computed(() => new Set((topology.value?.warnings ?? []).filter((w) => w.severity === "warn" && w.linkId !== undefined).map((w) => w.linkId!)));

interface LinkRow extends FlowRow {
  link: TopologyLink;
  /** Clockwise endpoint ids. */
  fromId: string;
  toId: string;
  format: string;
  util: number | null;
  loadBar: number;
  lossPct: number | null;
  mtuMismatch: boolean;
  badge: DiagramEdge["badge"];
}

const rows = computed<LinkRow[]>(() => {
  const t = topology.value;
  if (t === null) return [];
  const online = new Map(t.nodes.map((n) => [n.id, n.online]));
  return t.links.map((link) => {
    // Live: the latest SSE snapshot of node a (tx = a → b).
    // IRI-164: a fresh live frame overrides the 2 s snapshot rates.
    const entries = liveOn.value ? withLiveRates(live.snapshots.get(link.a)?.network, live.netRates?.get(link.a), clock.value) : live.snapshots.get(link.a)?.network;
    const rates = linkRates(link, entries);
    const lat = linkLatency(link, { a: live.snapshots.get(link.a)?.linkProbes, b: live.snapshots.get(link.b)?.linkProbes });
    const lay = layout.value;
    const centre = { x: (lay?.width ?? 0) / 2, y: (lay?.height ?? 0) / 2 };
    const cw = isClockwise(lay?.pos.get(link.a), lay?.pos.get(link.b), centre);
    const [fromId, toId] = cw ? [link.a, link.b] : [link.b, link.a];
    const cwBps = cw ? rates.txBps : rates.rxBps;
    const ccwBps = cw ? rates.rxBps : rates.txBps;
    const state: LinkFlowState = linkFlowState({
      lanesUp: link.lanesUp,
      online: (online.get(link.a) ?? false) && (online.get(link.b) ?? false),
      // Judged against the source the rates actually came from (fresh live frame or snapshot),
      // using the store's client receive times — never agent clocks.
      ...sampleSource({
        liveOn: liveOn.value,
        frame: live.netRates?.get(link.a),
        snapshotAtMs: live.snapshotAt?.get(link.a),
        snapshotIntervalMs: snapshotMs.value,
        nowMs: clock.value,
      }),
      nowMs: clock.value,
      cwBps,
      ccwBps,
    });
    const mtuMismatch = link.lanes.some((l) => l.a.mtu !== null && l.b.mtu !== null && l.a.mtu !== l.b.mtu);
    const degraded = link.lanesUp > 0 && link.lanesUp < link.lanes.length;
    const warn = degraded || mtuMismatch || warnLinks.value.has(link.id);
    const badge: DiagramEdge["badge"] =
      state === "down"
        ? { text: "down", kind: "bad" }
        : degraded
          ? { text: `${link.lanesUp}/${link.lanes.length} lanes`, kind: "warn" }
          : mtuMismatch
            ? { text: "MTU ≠", kind: "warn" }
            : warn
              ? { text: "warn", kind: "warn" }
              : null;
    return {
      id: link.id,
      link,
      title: `${nameOf(link.a)} ↔ ${nameOf(link.b)}`,
      fromId,
      toId,
      from: nameOf(fromId),
      to: nameOf(toId),
      cwBps,
      ccwBps,
      rttMs: lat.rttMs,
      lossPct: lat.lossPct,
      state,
      warn,
      format: linkFormat(link),
      util: utilPct(rates, link.speedMbps),
      loadBar: loadBarPct(cwBps, ccwBps),
      mtuMismatch,
      badge,
    };
  });
});

const runningClusters = computed(() => (topology.value?.clusters ?? []).filter((c) => c.running));
const clusterMembers = computed(() => new Set(runningClusters.value.flatMap((c) => c.memberIds)));
const isEmpty = computed(() => topology.value !== null && topology.value.links.length === 0 && topology.value.switches.length === 0);

const diagramNodes = computed<DiagramNode[]>(() =>
  (topology.value?.nodes ?? []).map((n) => ({ id: n.id, name: n.name, role: roleLabel(n.role), online: n.online, inCluster: clusterMembers.value.has(n.id) })),
);

const diagramEdges = computed<DiagramEdge[]>(() =>
  rows.value.map((r) => ({
    id: r.id,
    from: r.fromId,
    to: r.toId,
    cwBps: r.cwBps,
    ccwBps: r.ccwBps,
    state: r.state,
    badge: r.badge,
    details: [
      r.format,
      `${r.from} → ${r.to}  ${fmtBits(r.cwBps)}`,
      `${r.to} → ${r.from}  ${fmtBits(r.ccwBps)}`,
      `RTT ${fmtRtt(r.rttMs)} · loss ${r.lossPct === null ? "—" : `${r.lossPct} %`}`,
      `lanes ${r.link.lanesUp}/${r.link.lanes.length} · ${testSummary(latestTests.value.get(r.id), clock.value)}`,
    ],
  })),
);

// ─── header + summary ────────────────────────────────────────────────────────
const commonFormat = computed(() => sharedFormat(topology.value?.links ?? []));
const summary = computed(() => fabricSummary(rows.value));
const allStale = computed(() => rows.value.length > 0 && rows.value.every((r) => r.state === "stale" || r.state === "offline"));
const staleSeconds = computed(() => {
  const seen = (topology.value?.nodes ?? []).map((n) => live.snapshotAt?.get(n.id)).filter((t): t is number => t !== undefined);
  return seen.length === 0 ? null : Math.round((clock.value - Math.max(...seen)) / 1000);
});
const modeBadge = computed(() => {
  if (allStale.value) return { cls: "netmode--stale", text: staleSeconds.value === null ? "no data" : `stale · ${staleSeconds.value} s` };
  if (liveOn.value) return { cls: "netmode--live", text: `live · ${LIVE_RATES.find((r) => r.ms === liveIntervalMs.value)?.label ?? `${liveIntervalMs.value} ms`}` };
  return { cls: "", text: `snapshot · ${fmtCadence(snapshotMs.value)}` };
});
function fmtCadence(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 100) / 10} s` : `${ms} ms`;
}
/** Screen-reader announcement: changes only when the mode does, never per second. */
const modeKind = computed(() => (allStale.value ? "Network data is stale" : liveOn.value ? "Network live mode" : "Network snapshot mode"));
const healthText = computed(() => {
  const s = summary.value;
  if (s.health === "no-data") return "no data";
  if (s.health === "warn") return `${s.warnings} warning${s.warnings === 1 ? "" : "s"}`;
  return "healthy";
});

// ─── cross-highlight (diagram ⇄ table) ───────────────────────────────────────
const hover = ref<HoverTarget>(null);
const highlight = computed(() => {
  const h = hover.value;
  if (h === null) return null;
  if (h.kind === "link") {
    const r = rows.value.find((x) => x.id === h.id);
    return r === undefined ? null : { links: new Set([r.id]), nodes: new Set([r.link.a, r.link.b]) };
  }
  const links = rows.value.filter((r) => r.link.a === h.id || r.link.b === h.id).map((r) => r.id);
  return { links: new Set(links), nodes: new Set([h.id]) };
});
</script>

<template>
  <section class="card section-gap netcard" aria-label="Network">
    <div class="card__head">
      <div class="nettitle">
        <div class="row">
          <h3>Network</h3>
          <span class="netmode" :class="modeBadge.cls"><i aria-hidden="true"></i>{{ modeBadge.text }}</span>
          <span class="visually-hidden" role="status">{{ modeKind }}</span>
          <Tip
            :text="`RoCE fabric between Sparks only — the NAS and the management LAN are never shown · links from neighbour MACs or shared point-to-point subnets · throughput from the ${fmtCadence(snapshotMs)} snapshots (or the Live stream), the larger of RDMA and kernel counters · lanes: clockwise outer, counter-clockwise inner; motion speed and density follow a log scale of each direction's rate (1 Mb/s → 400 Gb/s); no motion when idle (< 1 Mb/s), stale (> ${STALE_INTERVALS}× the sample interval), offline or down`"
          />
        </div>
        <div v-if="topology !== null && topology.links.length > 0" class="netsub mono">
          RoCE fabric · <b>{{ topology.links.length }} link{{ topology.links.length === 1 ? "" : "s" }}</b> ·
          <template v-if="commonFormat !== null">every link <b>{{ commonFormat }}</b></template>
          <template v-else>mixed formats — see the links</template>
        </div>
      </div>
      <div class="row netcontrols">
        <label class="visually-hidden" for="net-test-tool">Test tool</label>
        <select id="net-test-tool" v-model="testTool" class="input netrate">
          <option v-for="t in LINK_TEST_TOOLS" :key="t.value" :value="t.value">{{ t.label }}</option>
        </select>
        <button type="button" class="btn btn--primary btn--sm" :disabled="testsRunning || (topology?.links.length ?? 0) === 0" @click="runTest(null)">Test all links</button>
        <button type="button" class="btn btn--secondary btn--sm" :aria-pressed="liveOn" @click="toggleLive">{{ liveOn ? "Stop live" : "Go live" }}</button>
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
      <div v-else class="netbody">
        <div class="netbody__diag">
          <NetworkDiagram
            v-if="layout !== null && diagramNodes.length > 0"
            :layout="layout"
            :nodes="diagramNodes"
            :edges="diagramEdges"
            :highlight="highlight"
            :live="liveOn"
            @hover="hover = $event"
          />
        </div>

        <div class="netbody__aside">
          <div v-if="rows.length > 0" class="netsummary">
            <div class="netstat" :class="`netstat--${summary.health}`">
              <div class="netstat__k">Health</div>
              <div class="netstat__v">{{ healthText }}</div>
              <div class="netstat__s">{{ summary.linksUp }}/{{ summary.links }} links up</div>
            </div>
            <div class="netstat">
              <div class="netstat__k">Fabric total</div>
              <div class="netstat__v">{{ fmtBits(summary.totalBps) }}</div>
              <div class="netstat__s">all links, both directions</div>
            </div>
            <div class="netstat">
              <div class="netstat__k">Busiest</div>
              <div class="netstat__v">{{ fmtBits(summary.busiest?.bps ?? null) }}</div>
              <div class="netstat__s">{{ summary.busiest === null ? "—" : `${summary.busiest.from} → ${summary.busiest.to}` }}</div>
            </div>
            <div class="netstat" :class="{ 'netstat--warn': (summary.worstRtt?.ms ?? 0) > 1 }">
              <div class="netstat__k">Worst RTT</div>
              <div class="netstat__v">{{ summary.worstRtt === null ? "—" : fmtRtt(summary.worstRtt.ms) }}</div>
              <div class="netstat__s">{{ summary.worstRtt?.title ?? "—" }}</div>
            </div>
          </div>
          <div v-if="rows.length > 0" class="netlegend mono">
            <span><i class="netlegend__cw"></i>clockwise</span>
            <span><i class="netlegend__ccw"></i>counter-clockwise</span>
            <span><i class="netlegend__na"></i>no data</span>
            <span><i class="netlegend__down"></i>down</span>
            <span class="netlegend__note">motion ∝ log rate</span>
          </div>
          <ul v-if="runningClusters.length > 0" class="netlist">
            <li v-for="c in runningClusters" :key="c.id">
              <span class="chip chip--muted">cluster</span>
              {{ c.name }}: {{ nameOf(c.headNodeId) }} (head) with {{ c.memberIds.filter((m) => m !== c.headNodeId).map(nameOf).join(", ") }}
              <span class="muted">· {{ c.fabricPath === null ? "head offline" : c.fabricPath ? "RoCE path to the head" : "no RoCE path to the head" }}</span>
            </li>
          </ul>
        </div>

        <div class="netbody__list">
          <table v-if="rows.length > 0" class="table nettable">
            <thead>
              <tr>
                <th>Link</th>
                <th class="netc-dir">Traffic</th>
                <th class="netc-load" title="Busier direction on the log motion scale; % of the link speed">Load</th>
                <th>RTT · loss</th>
                <th class="netc-24h">24 h</th>
                <th><span class="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="r in rows"
                :key="r.id"
                class="netrow"
                :class="{ 'netrow--on': highlight?.links.has(r.id) }"
                :data-link="r.id"
                tabindex="0"
                @mouseenter="hover = { kind: 'link', id: r.id }"
                @mouseleave="hover = null"
                @focusin="hover = { kind: 'link', id: r.id }"
                @focusout="hover = null"
              >
                <td>
                  <strong class="netrow__title">{{ r.title }}</strong>
                  <div class="muted mono netrow__sub">
                    {{ r.link.lanesUp }}/{{ r.link.lanes.length }} lanes up<span v-if="r.state === 'down'" class="netwarn-text"> · down</span
                    ><span v-else-if="r.link.lanesUp < r.link.lanes.length" class="netwarn-text"> · degraded</span>
                  </div>
                  <div v-if="r.mtuMismatch" class="mono netwarn-text netrow__sub">{{ r.format }}</div>
                  <div v-else-if="commonFormat === null" class="mono muted netrow__sub">{{ r.format }}</div>
                </td>
                <td class="netc-dir mono">
                  <div class="netdir"><i class="netdir__cw" aria-hidden="true"></i>{{ r.from }} → {{ r.to }} <span class="netdir__v">{{ fmtBits(r.cwBps) }}</span></div>
                  <div class="netdir"><i class="netdir__ccw" aria-hidden="true"></i>{{ r.to }} → {{ r.from }} <span class="netdir__v">{{ fmtBits(r.ccwBps) }}</span></div>
                </td>
                <td class="netc-load">
                  <div class="netload" :title="r.util === null ? 'no rate yet' : `${r.util}% of link speed`">
                    <div class="netload__fill" :style="{ width: r.loadBar + '%' }"></div>
                  </div>
                  <div class="mono muted netrow__sub">{{ fmtLoadPct(r.util) }}</div>
                </td>
                <td class="mono netc-rtt">{{ fmtRtt(r.rttMs) }}<span v-if="r.lossPct !== null"> · {{ r.lossPct }} %</span></td>
                <td class="netc-24h">
                  <Sparkline
                    v-if="(history.get(r.id)?.filter((v) => v !== null).length ?? 0) > 1"
                    class="nethist"
                    :points="history.get(r.id)!"
                    :height="24"
                    :width="110"
                    :aria-label="`${r.title} throughput, last 24 hours`"
                    :format="(v: number) => `${v} Gb/s`"
                  />
                </td>
                <td class="netc-test">
                  <button type="button" class="btn btn--secondary btn--sm" :disabled="testsRunning || r.link.lanesUp === 0" @click="runTest(r.link)">Test</button>
                  <div class="mono muted netrow__test" :title="latestTests.get(r.id)?.error ?? undefined">
                    {{ latestTests.get(r.id) === undefined ? "untested" : testSummary(latestTests.get(r.id), clock) }}
                  </div>
                </td>
              </tr>
            </tbody>
          </table>

          <ul v-if="topology.switches.length > 0" class="netlist">
            <li v-for="s in topology.switches" :key="s.id" class="mono">
              Switched subnet {{ s.subnet }}: {{ s.members.map((m) => `${nameOf(m.nodeId)} ${m.iface}`).join(", ") }}
            </li>
          </ul>
        </div>
      </div>

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
/* IR-286: the card sizes itself from its OWN width, never the viewport tier. */
.netcard { container-type: inline-size; container-name: netcard; }
.nettitle { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.netsub { font-size: var(--fs-small); color: var(--text-2); }
.netsub b { color: var(--text-1); font-weight: 500; }
.netmode { display: inline-flex; align-items: center; gap: 6px; padding: 1px 8px; border: 1px solid var(--border-2); border-radius: 999px; font-family: var(--font-mono); font-size: 11px; color: var(--text-2); white-space: nowrap; }
.netmode i { width: 7px; height: 7px; border-radius: 50%; background: var(--ink-3); }
.netmode--live { color: var(--text-1); }
.netmode--live i { background: var(--thread); }
.netmode--stale { color: var(--accent-text); border-color: var(--thread); }
.netmode--stale i { background: var(--thread); }
.netcontrols { gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.netguard { margin: 0 18px 12px; padding: 12px 14px; border: 1px solid var(--accent); background: var(--accent-wash); border-radius: var(--radius-panel); font-size: var(--fs-small); display: flex; flex-direction: column; gap: 8px; }
.netguard p, .netguard ul { margin: 0; }
.netguard ul { padding-left: 18px; }
.netrate { width: auto; min-height: var(--control-sm); }
.netlivemsg { margin: 0; padding: 0 18px; font-size: var(--fs-small); }

/* Grid areas; ≥ 1280 px card: ring left, summary + list right. */
.netbody {
  display: grid; gap: 12px 28px; align-items: start;
  grid-template-columns: minmax(380px, 460px) minmax(0, 1fr);
  grid-template-areas: "diag aside" "diag list";
}
.netbody > * { min-width: 0; }
.netbody__diag { grid-area: diag; }
.netbody__aside { grid-area: aside; display: flex; flex-direction: column; gap: 12px; }
/* Last-resort guard; the container layouts below keep it unused. */
.netbody__list { grid-area: list; overflow-x: auto; }

.netsummary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.netstat { min-width: 0; padding: 8px 10px; border: 1px solid var(--border-1); border-radius: var(--radius-panel); background: var(--surface-sunken); }
.netstat__k { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: var(--tracking-mono); text-transform: uppercase; color: var(--text-3); }
.netstat__v { font-family: var(--font-mono); font-size: 15px; font-weight: 500; color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.netstat__s { font-family: var(--font-mono); font-size: 11px; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.netstat--warn .netstat__v, .netstat--no-data .netstat__v { color: var(--accent-text); }

.netlegend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 11px; color: var(--text-2); }
.netlegend i { display: inline-block; width: 18px; border-top: 2px solid; vertical-align: middle; margin-right: 6px; }
.netlegend .netlegend__cw { border-top-color: var(--flow-cw); }
.netlegend .netlegend__ccw { border-top-color: var(--flow-ccw); }
.netlegend .netlegend__na { border-top-color: var(--ink-3); border-top-style: dashed; }
.netlegend .netlegend__down { border-top-color: var(--thread); border-top-style: dashed; }
.netlegend__note { color: var(--text-3); }

.nettable td { vertical-align: middle; }
.netrow { cursor: default; }
.netrow:hover td, .netrow--on td { background: var(--band); }
.netrow:focus-visible { outline: 2px solid var(--thread); outline-offset: -2px; }
.netrow__title { white-space: nowrap; }
.netrow__sub { font-size: 11.5px; margin-top: 2px; white-space: nowrap; }
.netdir { font-size: 12px; white-space: nowrap; color: var(--text-2); }
.netdir i { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 6px; }
.netdir__cw { background: var(--flow-cw); }
.netdir__ccw { background: var(--flow-ccw); }
.netdir__v { display: inline-block; min-width: 76px; text-align: right; color: var(--text-1); }
.netc-load { width: 110px; }
.netload { height: 6px; background: var(--band); border-radius: 3px; overflow: hidden; }
.netload__fill { height: 100%; background: var(--ink-2); transition: width 0.6s; }
@media (prefers-reduced-motion: reduce) { .netload__fill { transition: none; } }
.netc-rtt { white-space: nowrap; }
.nethist { display: block; max-width: 110px; }
.netc-test { text-align: right; }
.netrow__test { font-size: 11px; margin-top: 4px; white-space: normal; line-height: 1.35; max-width: 16ch; margin-left: auto; }
.netwarn-text { color: var(--accent-text); }
.netlist, .netwarnings { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; font-size: var(--fs-small); }
.netlist { margin-top: var(--space-3); }
.netbody__aside .netlist { margin-top: 0; }
.netwarnings { margin-top: var(--space-3); }
.netwarnings li { display: flex; gap: 8px; align-items: baseline; }

/* < 1280: the table moves BELOW the animation; the summary sits beside the ring. */
@container netcard (max-width: 1279px) {
  .netbody { grid-template-columns: minmax(340px, 500px) minmax(0, 1fr); grid-template-areas: "diag aside" "list list"; }
  .netbody__aside { align-self: center; }
  .netsummary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
/* < 820: drop the 24 h and Load columns (the ring already shows load). */
@container netcard (max-width: 819px) {
  .netc-24h, .netc-load { display: none; }
}
/* < 700: single column; summary as a 4-up strip under the ring. */
@container netcard (max-width: 699px) {
  .netbody { grid-template-columns: minmax(0, 1fr); grid-template-areas: "diag" "aside" "list"; }
  .netbody__diag { max-width: 460px; width: 100%; justify-self: center; }
  .netsummary { grid-template-columns: repeat(4, minmax(0, 1fr)); }
}
/* < 600 (phone): rows become cards, pills hidden, larger tile text, header stacks. */
@container netcard (max-width: 599px) {
  .card__head { flex-direction: column; align-items: flex-start; }
  .netcontrols { justify-content: flex-start; }
  .netsummary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .netbody :deep(.netpill) { display: none; }
  .netbody :deep(.nettile__name) { font-size: 20px; }
  .netbody :deep(.nettile__role) { font-size: 14px; }
  .nettable thead { display: none; }
  .nettable tr { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 12px; padding: 10px 0; border-bottom: 1px solid var(--border-1); }
  .nettable td { border-bottom: 0; padding: 0; }
  .netc-dir { grid-column: 1 / -1; }
  .netc-test { grid-column: 2; grid-row: 1; }
}
</style>
