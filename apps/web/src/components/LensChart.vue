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
</script>

<template>
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
  <div v-if="hover !== null" class="charttip" :style="{ left: `${hover.x}px`, top: `${hover.y}px` }" aria-hidden="true">
    <div v-if="timeLabel !== null" class="charttip__time">{{ timeLabel }}</div>
    <div v-for="r in rows" :key="r.label" class="charttip__row">
      <span class="charttip__swatch" :style="{ background: r.color }"></span>
      <span class="charttip__label">{{ r.label }}</span>
      <span class="charttip__value">{{ fmt(r.value) }}</span>
    </div>
  </div>
</template>
