<script setup lang="ts">
import { computed, ref } from "vue";
import { clampTipX, hoverIndex } from "../sparkline";
import type { LensChart } from "../analytics";

const props = defineProps<{
  chart: LensChart;
  /** Unit label shown top-right (tok/s, W, °C…). */
  unit?: string;
  /** Accessible description. */
  ariaLabel?: string;
  /** Tooltip value formatter (units included); default: 2-decimal rounding. */
  format?: (v: number) => string;
  /** Bucket-start formatter for the tooltip header. */
  timeFormat?: (t: number) => string;
  /** IR-219: labeled variant — 44px y-label column, scale grid, mono
   *  uppercase x labels, legend swatches (v1.1 chart idiom). Bare otherwise. */
  labeled?: boolean;
}>();

/** Hover state: nearest bucket index + fixed-position tooltip anchor. */
const hover = ref<{ index: number; x: number; y: number } | null>(null);

const bucketCount = computed(() =>
  Math.max(1, ...props.chart.series.map((s) => s.points.length)),
);

function bucketX(index: number): number {
  const n = bucketCount.value;
  return n <= 1 ? props.chart.width / 2 : (index / (n - 1)) * props.chart.width;
}

function valueY(v: number, scale?: { min: number; max: number }): number {
  const { height, yMin, yMax } = props.chart;
  const min = scale?.min ?? yMin;
  const max = scale?.max ?? yMax;
  return height - ((v - min) / (max - min)) * height;
}

function onMove(e: PointerEvent): void {
  const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
  if (rect.width === 0) return;
  const index = hoverIndex(bucketCount.value, (e.clientX - rect.left) / rect.width);
  const readable = props.chart.series.some((s) => {
    const v = s.points[index];
    return v !== null && v !== undefined;
  });
  hover.value = readable ? { index, x: clampTipX(e.clientX), y: e.clientY } : null;
}

const rows = computed(() => {
  const h = hover.value;
  if (h === null) return [];
  return props.chart.series.flatMap((s) => {
    const v = s.points[h.index];
    return v === null || v === undefined
      ? []
      : [{ label: s.label, color: s.color, dashed: s.dashed === true, scale: s.scale, value: v }];
  });
});

const timeLabel = computed(() => {
  const h = hover.value;
  if (h === null || props.timeFormat === undefined) return null;
  const t = props.chart.times[h.index];
  return t === undefined ? null : props.timeFormat(t);
});

function fmt(v: number): string {
  return props.format !== undefined ? props.format(v) : String(Math.round(v * 100) / 100);
}

// ── Labeled variant (IR-219) ──────────────────────────────────────────
// Per-series-scaled charts have no chart-level scale, so their y column
// would lie — they get the x labels + legend only.
const perSeries = computed(() => props.chart.series.some((s) => s.scale !== undefined));

/** Compact axis label (44px column); full formatters carry units. */
function compact(v: number): string {
  const round1 = (x: number): string => String(Math.round(x * 10) / 10);
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${round1(v / 1_000_000)}M`;
  if (a >= 1000) return `${round1(v / 1000)}k`;
  return String(Math.round(v * 10) / 10);
}

const yTicks = computed(() => {
  if (props.labeled !== true || perSeries.value) return [];
  const { height, yMin, yMax } = props.chart;
  if (!Number.isFinite(yMin) || !Number.isFinite(yMax) || yMax <= yMin) return [];
  const out: Array<{ pct: number; label: string }> = [];
  for (let i = 0; i < 4; i++) {
    const v = yMin + ((yMax - yMin) * i) / 3;
    const y = height - ((v - yMin) / (yMax - yMin)) * height;
    out.push({ pct: (y / height) * 100, label: compact(v) });
  }
  return out;
});

const xTicks = computed(() => {
  if (props.labeled !== true) return [];
  const n = bucketCount.value;
  if (n < 2) return [];
  const mid = Math.floor((n - 1) / 2);
  const idx = [...new Set([0, mid, n - 1])];
  return idx.map((i) => {
    const t = props.chart.times[i];
    const label = t === undefined ? "" : (props.timeFormat !== undefined ? props.timeFormat(t) : shortTime(t));
    return { label, mid: i === mid };
  });
});

/** Axis-label fallback when no timeFormat is passed: "HH:MM" local. */
function shortTime(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
</script>

<template>
  <div class="lens-chart" :class="{ 'lens-chart--labeled': labeled === true }">
    <div v-if="labeled === true && yTicks.length > 0" class="lens-chart__ycol" aria-hidden="true">
      <template v-for="t in yTicks" :key="t.label">
        <span class="lens-chart__ylabel" :style="{ top: `${t.pct}%` }">{{ t.label }}</span>
      </template>
    </div>
    <div class="lens-chart__plot">
      <template v-if="labeled === true && yTicks.length > 0">
        <span v-for="t in yTicks" :key="t.label" class="lens-chart__grid" :style="{ top: `${t.pct}%` }"></span>
      </template>
      <svg
        class="spark"
        :viewBox="`0 0 ${chart.width} ${chart.height}`"
        :height="chart.height"
        preserveAspectRatio="none"
        :role="ariaLabel !== undefined ? 'img' : 'presentation'"
        :aria-label="ariaLabel"
        @pointermove="onMove"
        @pointerdown="onMove"
        @pointerleave="hover = null"
        @pointercancel="hover = null"
      >
        <line
          v-for="g in chart.guides"
          :key="`g${g.value}`"
          x1="0"
          :x2="chart.width"
          :y1="g.y"
          :y2="g.y"
          stroke="var(--border)"
          stroke-width="1"
          stroke-dasharray="4 3"
        />
        <path
          v-for="(p, i) in chart.paths"
          :key="`p${i}`"
          fill="none"
          :stroke="p.color"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          :stroke-dasharray="p.dashed ? '4 3' : undefined"
          :d="p.d"
        />
        <template v-for="m in chart.markers" :key="`m${Math.round(m.x)}-${m.tier}`">
          <rect v-if="m.tier === 'critical'" :x="m.x - 3" y="2" width="6" height="6" fill="var(--error)" />
          <path v-else d="M0,-4 L3.2,0 L0,4 L-3.2,0 Z" :transform="`translate(${m.x},6)`" fill="var(--warning)" />
        </template>
        <g v-if="hover !== null">
          <line
            :x1="bucketX(hover.index)"
            :x2="bucketX(hover.index)"
            y1="0"
            :y2="chart.height"
            stroke="var(--border-strong)"
            stroke-width="1"
          />
          <circle v-for="r in rows" :key="r.label" :cx="bucketX(hover.index)" :cy="valueY(r.value, r.scale)" r="3" :fill="r.color" />
        </g>
      </svg>
    </div>
  </div>
  <div v-if="labeled === true && xTicks.length > 0" class="lens-chart__xrow" aria-hidden="true">
    <span v-for="(x, i) in xTicks" :key="i" :class="{ 'lens-chart__xmid': x.mid }">{{ x.label }}</span>
  </div>
  <div v-if="labeled === true && chart.series.length > 0" class="bs-legend" aria-hidden="true">
    <span v-for="s in chart.series" :key="s.label">
      <svg width="14" height="8" viewBox="0 0 14 8" aria-hidden="true"><path d="M0 6 L14 2" fill="none" :stroke="s.color" stroke-width="1.5" :stroke-dasharray="s.dashed === true ? '4 3' : undefined"/></svg>
      {{ s.label }}
    </span>
  </div>
  <div v-if="hover !== null" class="charttip" :style="{ left: `${hover.x}px`, top: `${hover.y}px` }" aria-hidden="true">
    <div v-if="timeLabel !== null" class="charttip__time">{{ timeLabel }}</div>
    <div v-for="r in rows" :key="r.label" class="charttip__row">
      <span class="charttip__swatch" :style="{ background: r.color }"></span>
      <span class="charttip__label">{{ r.label }}</span>
      <span class="charttip__value">{{ fmt(r.value) }}</span>
    </div>
  </div>
</template>

<style scoped>
/* Bare mode renders exactly the v1.0 plot (spark + tooltip); labeled mode
   adds the v1.1 y column, x labels and legend. */
.lens-chart { display: block; min-width: 0; }
.lens-chart--labeled { display: flex; }
.lens-chart__plot { position: relative; flex: 1; min-width: 0; }
.lens-chart__ycol { position: relative; flex: none; width: 44px; }
.lens-chart__grid { position: absolute; left: 0; right: 0; border-top: 1px solid var(--rule); }
.lens-chart__ylabel { position: absolute; right: 8px; transform: translateY(-50%);
  font-family: var(--font-mono); font-size: 11px; line-height: 1; color: var(--ink-3); }
.lens-chart__xrow { position: relative; height: 14px; margin-top: 4px;
  font-family: var(--font-mono); font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-3); }
.lens-chart--labeled + .lens-chart__xrow { margin-left: 44px; }
.lens-chart__xrow > span { position: absolute; top: 0; }
.lens-chart__xrow > span:first-child { left: 0; }
.lens-chart__xrow > span:last-child { right: 0; }
.lens-chart__xrow > .lens-chart__xmid { left: 50%; transform: translateX(-50%); }
</style>
