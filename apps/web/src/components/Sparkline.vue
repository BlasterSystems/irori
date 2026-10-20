<script setup lang="ts">
import { computed, ref } from "vue";
import { clampTipX, hoverIndex, sparklinePath, sparklineScale, type SparklineDomain } from "../sparkline";

const props = withDefaults(
  defineProps<{
    /** Series values; nulls render as gaps. */
    points: Array<number | null>;
    /** viewBox width; the svg stretches horizontally to its container. */
    width?: number;
    /** viewBox height = rendered height in px. */
    height?: number;
    /** Stroke color; DS tokens only, never hard-coded hex. */
    color?: string;
    /** Fixed value domain (e.g. 0–100 for usage series); never clips. */
    domain?: SparklineDomain;
    /** Accessible description; omit for decorative sparklines. */
    ariaLabel?: string;
    /** Tooltip value formatter (units included); default: 2-decimal rounding. */
    format?: (v: number) => string;
  }>(),
  { width: 600, height: 44, color: "var(--ink-2)" },
);

const path = computed(() =>
  sparklinePath(props.points, props.width, props.height, props.domain),
);
const scale = computed(() => sparklineScale(props.points, props.domain));

/** Hover state: nearest bucket index + fixed-position tooltip anchor. */
const hover = ref<{ index: number; x: number; y: number } | null>(null);

function bucketX(index: number): number {
  const n = props.points.length;
  return n <= 1 ? props.width / 2 : (index / (n - 1)) * props.width;
}

function dotY(index: number): number {
  const s = scale.value;
  const v = props.points[index];
  if (s === null || v === null || v === undefined) return props.height / 2;
  return props.height - ((v - s.min) / (s.max - s.min)) * props.height;
}

function onMove(e: PointerEvent): void {
  const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
  if (rect.width === 0) return;
  const index = hoverIndex(props.points.length, (e.clientX - rect.left) / rect.width);
  const v = props.points[index];
  hover.value =
    v === null || v === undefined || scale.value === null
      ? null
      : { index, x: clampTipX(e.clientX), y: e.clientY };
}

const tip = computed(() => {
  const h = hover.value;
  if (h === null) return "";
  const v = props.points[h.index];
  if (v === null || v === undefined) return "";
  return props.format !== undefined ? props.format(v) : String(Math.round(v * 100) / 100);
});
</script>

<template>
  <svg
    v-if="path"
    class="spark"
    :viewBox="`0 0 ${width} ${height}`"
    :height="height"
    preserveAspectRatio="none"
    :role="ariaLabel !== undefined ? 'img' : 'presentation'"
    :aria-label="ariaLabel"
    @pointermove="onMove"
    @pointerdown="onMove"
    @pointerleave="hover = null"
    @pointercancel="hover = null"
  >
    <path
      fill="none"
      :stroke="color"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      :d="path"
    />
    <g v-if="hover !== null">
      <line
        :x1="bucketX(hover.index)"
        :x2="bucketX(hover.index)"
        y1="0"
        :y2="height"
        stroke="var(--border-strong)"
        stroke-width="1"
      />
      <circle :cx="bucketX(hover.index)" :cy="dotY(hover.index)" r="3" :fill="color" />
    </g>
  </svg>
  <div v-if="hover !== null" class="charttip" :style="{ left: `${hover.x}px`, top: `${hover.y}px` }" aria-hidden="true">
    {{ tip }}
  </div>
</template>
