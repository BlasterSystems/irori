<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { arrowFor, flowIntensity, flowParams, fmtBits, laneGeometry, TILE, type DiagramLayout, type LinkFlowState } from "../network";

/**
 * IR-286 (IRI-171): the Network card's fabric ring. Each cable is two lanes,
 * one per ring direction (ADR-0022 `--flow-cw` / `--flow-ccw`); particles move
 * at a log-scaled speed of the real per-direction rate. Nothing is ever
 * painted on a lane: rates sit in pills inside the ring, deviations in
 * badges on the outer side. Stale, offline and down links never move.
 */

export interface DiagramNode {
  id: string;
  name: string;
  role: string;
  online: boolean;
  inCluster: boolean;
}

export interface DiagramEdge {
  id: string;
  /** Clockwise endpoints: cw lane travels from → to. */
  from: string;
  to: string;
  cwBps: number | null;
  ccwBps: number | null;
  state: LinkFlowState;
  badge: { text: string; kind: "warn" | "bad" } | null;
  /** Tooltip lines (plain text). */
  details: string[];
}

export type HoverTarget = { kind: "link" | "node"; id: string } | null;

const props = defineProps<{
  layout: DiagramLayout;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  /** Highlighted link and node ids (cross-highlight from the table), or null. */
  highlight: { links: Set<string>; nodes: Set<string> } | null;
  /** Snapshot mode dims motion to 75 %: live frames are the full-strength view. */
  live: boolean;
}>();
const emit = defineEmits<{ hover: [target: HoverTarget] }>();

/** Lanes sit ±this many units from the edge's centre line (laneGeometry default). */
const LANE_OFFSET = 5;

const centre = computed(() => ({ x: props.layout.width / 2, y: props.layout.height / 2 }));

interface Geo {
  edge: DiagramEdge;
  cw: [{ x: number; y: number }, { x: number; y: number }];
  ccw: [{ x: number; y: number }, { x: number; y: number }];
  pill: { x: number; y: number; anchor: "start" | "middle" | "end"; cwArrow: string; ccwArrow: string };
  badge: { x: number; y: number; w: number } | null;
}

const geos = computed<Geo[]>(() =>
  props.edges.flatMap((edge) => {
    const a = props.layout.pos.get(edge.from);
    const b = props.layout.pos.get(edge.to);
    if (a === undefined || b === undefined) return [];
    const g = laneGeometry(a, b, centre.value, TILE);
    // Clearances are the box's half-extent PROJECTED on the edge normal, so
    // pills and badges clear both lanes (±LANE_OFFSET) on diagonal edges too.
    const nx = Math.abs(g.outer.x);
    const ny = Math.abs(g.outer.y);
    // Pills sit on the INNER side (toward the ring centre). Mostly-horizontal
    // edges centre the two-line pill (≈90×30); mostly-vertical ones anchor it
    // at its near end so it grows away from the edge.
    const across = ny >= nx;
    const pillD = across ? LANE_OFFSET + 45 * nx + 15 * ny + 14 : LANE_OFFSET + 15 * ny + 13;
    const pill = across
      ? { x: g.mid.x - g.outer.x * pillD, y: g.mid.y - g.outer.y * pillD, anchor: "middle" as const }
      : { x: g.mid.x - g.outer.x * pillD, y: g.mid.y - g.outer.y * pillD, anchor: g.outer.x > 0 ? ("end" as const) : ("start" as const) };
    // Badges sit on the OUTER side.
    const bw = edge.badge === null ? 0 : edge.badge.text.length * 6.6 + 14;
    const badgeD = LANE_OFFSET + (bw / 2) * nx + 9 * ny + 4;
    const badge = edge.badge === null ? null : { x: g.mid.x + g.outer.x * badgeD, y: g.mid.y + g.outer.y * badgeD, w: bw };
    return [{ edge, cw: g.cw, ccw: g.ccw, pill: { ...pill, cwArrow: arrowFor(a, b), ccwArrow: arrowFor(b, a) }, badge }];
  }),
);

const still = (s: LinkFlowState): boolean => s === "stale" || s === "offline" || s === "down";

// ─── motion ────────────────────────────────────────────────────────────────
const reducedMotion = ref(false);
const pageVisible = ref(true);
const inView = ref(true);
const flowEls = new Map<string, SVGLineElement>();
const laneState = new Map<string, { bps: number; offset: number }>();
let raf: number | null = null;
let last = 0;

function bindFlow(key: string) {
  return (el: unknown) => {
    if (el instanceof SVGLineElement) flowEls.set(key, el);
    else {
      flowEls.delete(key);
      laneState.delete(key);
    }
  };
}

/** Target rate per lane key ("<id>:cw" / "<id>:ccw"); still links target 0. */
const targets = computed(() => {
  const m = new Map<string, number>();
  for (const e of props.edges) {
    m.set(`${e.id}:cw`, still(e.state) ? 0 : (e.cwBps ?? 0));
    m.set(`${e.id}:ccw`, still(e.state) ? 0 : (e.ccwBps ?? 0));
  }
  return m;
});

/** Reduced motion: a static encoding — stroke width and opacity by intensity, no dashes. */
function staticStyle(key: string): Record<string, string> | undefined {
  if (!reducedMotion.value) return undefined;
  const t = flowIntensity(targets.value.get(key) ?? 0);
  if (t === 0) return { opacity: "0" };
  return { strokeDasharray: "none", strokeWidth: (1.5 + 2.5 * t).toFixed(2), opacity: (0.35 + 0.65 * t).toFixed(2) };
}

/** Below this eased rate a lane has nothing left to draw (the 1 Mb/s floor, in bytes/s). */
const IDLE_BPS = 125_000;
const hasWork = (): boolean =>
  [...targets.value.values()].some((v) => v >= IDLE_BPS) || [...laneState.values()].some((st) => st.bps >= IDLE_BPS);

function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  for (const [key, el] of flowEls) {
    const st = laneState.get(key) ?? { bps: 0, offset: 0 };
    const target = targets.value.get(key) ?? 0;
    st.bps += (target - st.bps) * Math.min(1, dt * 3); // ≈600 ms ease toward each sample
    const p = flowParams(flowIntensity(st.bps));
    if (p === null) {
      el.style.opacity = "0";
    } else {
      st.offset -= p.speed * dt;
      el.style.strokeDasharray = `3 ${p.gap.toFixed(1)}`;
      el.style.strokeDashoffset = st.offset.toFixed(1);
      el.style.opacity = (p.opacity * (props.live ? 1 : 0.75)).toFixed(2);
    }
    laneState.set(key, st);
  }
  // Idle fabric: stop scheduling frames; a target change restarts the loop.
  raf = hasWork() ? requestAnimationFrame(frame) : null;
}

const running = computed(() => !reducedMotion.value && pageVisible.value && inView.value);
function sync(): void {
  if (typeof requestAnimationFrame !== "function") return;
  if (running.value && raf === null && hasWork()) {
    last = performance.now();
    raf = requestAnimationFrame(frame);
  } else if (!running.value && raf !== null) {
    cancelAnimationFrame(raf);
    raf = null;
  }
}
watch(running, sync);
watch(targets, sync);

const root = ref<HTMLElement | null>(null);
let mq: MediaQueryList | null = null;
let io: IntersectionObserver | null = null;
const onMq = (): void => void (reducedMotion.value = mq?.matches ?? false);
const onVis = (): void => void (pageVisible.value = document.visibilityState !== "hidden");

onMounted(() => {
  if (typeof matchMedia === "function") {
    mq = matchMedia("(prefers-reduced-motion: reduce)");
    onMq();
    mq.addEventListener?.("change", onMq);
  }
  if (typeof document !== "undefined") {
    onVis();
    document.addEventListener("visibilitychange", onVis);
  }
  if (typeof IntersectionObserver === "function" && root.value !== null) {
    io = new IntersectionObserver((entries) => (inView.value = entries.some((e) => e.isIntersecting)));
    io.observe(root.value);
  }
  sync();
});
onUnmounted(() => {
  if (raf !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
  raf = null;
  mq?.removeEventListener?.("change", onMq);
  if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVis);
  io?.disconnect();
});

// ─── hover + tooltip ───────────────────────────────────────────────────────
const tip = ref<{ id: string; x: number; y: number } | null>(null);
const tipEdge = computed(() => (tip.value === null ? null : (props.edges.find((e) => e.id === tip.value!.id) ?? null)));

function onEdgeMove(id: string, ev: MouseEvent): void {
  emit("hover", { kind: "link", id });
  const box = root.value?.getBoundingClientRect();
  if (box === undefined) return;
  tip.value = { id, x: Math.min(Math.max(0, box.width - 290), ev.clientX - box.left + 14), y: ev.clientY - box.top + 14 };
}
function onTileEnter(id: string): void {
  tip.value = null;
  emit("hover", { kind: "node", id });
}
function leave(): void {
  tip.value = null;
  emit("hover", null);
}

const dimLink = (id: string): boolean => props.highlight !== null && !props.highlight.links.has(id);
const dimNode = (id: string): boolean => props.highlight !== null && !props.highlight.nodes.has(id);

const nodeById = computed(() => new Map(props.nodes.map((n) => [n.id, n])));
const ariaLabel = computed(() => {
  const name = (id: string) => nodeById.value.get(id)?.name ?? id.slice(0, 8);
  const links = props.edges.map((e) =>
    e.state === "down" || e.state === "stale" || e.state === "offline"
      ? `${name(e.from)} ↔ ${name(e.to)} ${e.state === "stale" ? "no data" : e.state}`
      : `${name(e.from)} → ${name(e.to)} ${fmtBits(e.cwBps)}, ${name(e.to)} → ${name(e.from)} ${fmtBits(e.ccwBps)}`,
  );
  return `Fabric ring: ${props.nodes.map((n) => n.name).join(", ")}${links.length > 0 ? `. Links: ${links.join("; ")}` : ""}`;
});
</script>

<template>
  <div ref="root" class="netdiag" @mouseleave="leave">
    <svg class="netdiag__svg" :viewBox="`0 0 ${layout.width} ${layout.height}`" role="img" :aria-label="ariaLabel">
      <g
        v-for="g in geos"
        :key="g.edge.id"
        class="netedge"
        :class="[`netedge--${g.edge.state}`, { 'netedge--dim': dimLink(g.edge.id), 'netedge--on': highlight?.links.has(g.edge.id) }]"
        :data-link="g.edge.id"
      >
        <line class="netlane netlane--cw" :x1="g.cw[0].x" :y1="g.cw[0].y" :x2="g.cw[1].x" :y2="g.cw[1].y" />
        <line class="netlane netlane--ccw" :x1="g.ccw[0].x" :y1="g.ccw[0].y" :x2="g.ccw[1].x" :y2="g.ccw[1].y" />
        <line
          :ref="bindFlow(`${g.edge.id}:cw`)"
          class="netflow netflow--cw"
          :style="staticStyle(`${g.edge.id}:cw`)"
          :x1="g.cw[0].x"
          :y1="g.cw[0].y"
          :x2="g.cw[1].x"
          :y2="g.cw[1].y"
        />
        <line
          :ref="bindFlow(`${g.edge.id}:ccw`)"
          class="netflow netflow--ccw"
          :style="staticStyle(`${g.edge.id}:ccw`)"
          :x1="g.ccw[0].x"
          :y1="g.ccw[0].y"
          :x2="g.ccw[1].x"
          :y2="g.ccw[1].y"
        />
        <line
          class="nethit"
          :x1="(g.cw[0].x + g.ccw[1].x) / 2"
          :y1="(g.cw[0].y + g.ccw[1].y) / 2"
          :x2="(g.cw[1].x + g.ccw[0].x) / 2"
          :y2="(g.cw[1].y + g.ccw[0].y) / 2"
          @mousemove="onEdgeMove(g.edge.id, $event)"
          @mouseleave="leave"
        />
        <g v-if="g.badge !== null && g.edge.badge !== null" class="netbadge" :class="`netbadge--${g.edge.badge.kind}`">
          <rect :x="g.badge.x - g.badge.w / 2" :y="g.badge.y - 9" :width="g.badge.w" height="18" rx="9" />
          <text :x="g.badge.x" :y="g.badge.y + 4" text-anchor="middle">{{ g.edge.badge.text }}</text>
        </g>
      </g>

      <g
        v-for="g in geos"
        :key="`pill-${g.edge.id}`"
        class="netpill"
        :class="{ 'netpill--dim': dimLink(g.edge.id) }"
        :data-link="g.edge.id"
        aria-hidden="true"
      >
        <template v-if="g.edge.state === 'stale' || g.edge.state === 'offline'">
          <text :x="g.pill.x" :y="g.pill.y + 4" :text-anchor="g.pill.anchor" class="netpill__na">{{ g.edge.state === "offline" ? "offline" : "no data" }}</text>
        </template>
        <template v-else-if="g.edge.state !== 'down'">
          <text :x="g.pill.x" :y="g.pill.y - 3" :text-anchor="g.pill.anchor">
            <tspan class="netpill__cw">{{ g.pill.cwArrow }}</tspan> <tspan class="netpill__v">{{ fmtBits(g.edge.cwBps) }}</tspan>
          </text>
          <text :x="g.pill.x" :y="g.pill.y + 12" :text-anchor="g.pill.anchor">
            <tspan class="netpill__ccw">{{ g.pill.ccwArrow }}</tspan> <tspan class="netpill__v">{{ fmtBits(g.edge.ccwBps) }}</tspan>
          </text>
        </template>
      </g>

      <g
        v-for="n in nodes"
        :key="n.id"
        class="nettile"
        :class="{ 'nettile--off': !n.online, 'nettile--cluster': n.inCluster, 'nettile--dim': dimNode(n.id), 'nettile--on': highlight?.nodes.has(n.id) }"
        :data-node="n.id"
        :transform="`translate(${(layout.pos.get(n.id)?.x ?? 0) - TILE.w / 2}, ${(layout.pos.get(n.id)?.y ?? 0) - TILE.h / 2})`"
        @mouseenter="onTileEnter(n.id)"
        @mouseleave="leave"
      >
        <rect :width="TILE.w" :height="TILE.h" rx="4" />
        <text :x="TILE.w / 2" y="22" text-anchor="middle" class="nettile__name">{{ n.name }}</text>
        <text :x="TILE.w / 2" y="38" text-anchor="middle" class="nettile__role">{{ n.online ? n.role : "offline" }}</text>
      </g>
    </svg>
    <div v-if="tip !== null && tipEdge !== null" class="nettip" :style="{ left: `${tip.x}px`, top: `${tip.y}px` }" role="tooltip">
      <strong>{{ nodeById.get(tipEdge.from)?.name }} ↔ {{ nodeById.get(tipEdge.to)?.name }}</strong>
      <span v-for="(line, i) in tipEdge.details" :key="i">{{ line }}</span>
    </div>
  </div>
</template>

<style scoped>
.netdiag { position: relative; }
.netdiag__svg { width: 100%; height: auto; display: block; overflow: visible; }
.netlane { stroke-width: 2; stroke-linecap: round; opacity: 0.2; }
.netlane--cw, .netflow--cw { stroke: var(--flow-cw); }
.netlane--ccw, .netflow--ccw { stroke: var(--flow-ccw); }
.netflow { stroke-width: 2.2; stroke-linecap: round; opacity: 0; }
.netedge--stale .netlane, .netedge--offline .netlane { stroke: var(--ink-3); opacity: 0.8; stroke-dasharray: 3 5; }
.netedge--down .netlane { stroke: var(--thread); opacity: 0.8; stroke-dasharray: 5 5; }
.netedge--stale .netflow, .netedge--offline .netflow, .netedge--down .netflow { display: none; }
.netedge--on .netflow { stroke-width: 3; }
.nethit { stroke: transparent; stroke-width: 22; cursor: pointer; }
.netbadge rect { fill: var(--surface-card); stroke: var(--thread); }
.netbadge text { font-family: var(--font-mono); font-size: 10.5px; fill: var(--accent-text); }
.netpill text { font-family: var(--font-mono); font-size: 11px; }
.netpill__v { fill: var(--text-1); }
.netpill__cw { fill: var(--flow-cw); }
.netpill__ccw { fill: var(--flow-ccw); }
.netpill__na { fill: var(--text-3); }
.nettile rect { fill: var(--surface-sunken); stroke: var(--border-2); }
.nettile--cluster rect { stroke: var(--thread); stroke-opacity: 0.55; }
.nettile--on rect { stroke: var(--text-1); stroke-opacity: 1; }
.nettile--off rect { stroke-dasharray: 4 3; opacity: 0.6; }
.nettile__name { font-family: var(--font-sans); font-size: 13.5px; font-weight: 600; fill: var(--text-1); }
.nettile__role { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: var(--tracking-mono); text-transform: uppercase; fill: var(--text-3); }
.nettile--cluster .nettile__role { fill: var(--accent-text); }
.netedge, .netpill, .nettile { transition: opacity 0.15s; }
.netedge--dim, .netpill--dim { opacity: 0.25; }
.nettile--dim { opacity: 0.45; }
.nettip {
  position: absolute; z-index: 3; pointer-events: none; min-width: 220px; max-width: 280px;
  display: flex; flex-direction: column; gap: 1px; padding: 8px 10px;
  background: var(--surface-tooltip); border: 1px solid var(--border-2); border-radius: var(--radius-panel);
  font-family: var(--font-mono); font-size: 11.5px; line-height: 1.55; color: var(--text-2);
}
.nettip strong { font-family: var(--font-sans); font-size: 12.5px; color: var(--text-1); }
</style>
