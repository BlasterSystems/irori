<script setup lang="ts">
import { computed, ref } from "vue";
import { clampTipX, hoverIndex, sparklinePath, sparklineScale, type SparklineDomain, type SparklineScale } from "../sparkline";

const props = withDefaults(
  defineProps<{
    /** Series values; nulls render as gaps. */
    points: Array<number | null>;
    /** IRI-124: optional second series (e.g. temperature), drawn dashed on its
     *  own scale — a quiet °C line must not sit flat against a 0–100 % axis.
     *  null means "no second series" (panels without temperature). */
    points2?: Array<number | null> | null;
    /** viewBox width; the svg stretches horizontally to its container. */
    width?: number;
    /** viewBox height = rendered height in px. */
    height?: number;
    /** Stroke color; DS tokens only, never hard-coded hex. */
    color?: string;
    /** Stroke color of the second series; DS tokens only. */
    color2?: string;
    /** Fixed value domain (e.g. 0–100 for usage series); never clips. */
    domain?: SparklineDomain;
    /** Tooltip label for the first series (used when a second series exists). */
    label?: string;
    /** Tooltip label for the second series. */
    label2?: string;
    /** Accessible description; omit for decorative sparklines. */
    ariaLabel?: string;
    /** Tooltip value formatter (units included); default: 2-decimal rounding. */
    format?: (v: number) => string;
    /** Tooltip formatter for the second series. */
    format2?: (v: number) => string;
  }>(),
  { width: 600, height: 44, color: "var(--ink-2)", color2: "var(--thread)" },
);

const path = computed(() =>
  sparklinePath(props.points, props.width, props.height, props.domain),
);
const scale = computed(() => sparklineScale(props.points, props.domain));
/** Second series owns its scale: bucket temperatures span ~35–80 °C, not 0–100. */
const second = computed<Array<number | null> | null>(() => props.points2 ?? null);
const path2 = computed(() =>
  second.value === null ? "" : sparklinePath(second.value, props.width, props.height),
);
const scale2 = computed(() =>
  second.value === null ? null : sparklineScale(second.value),
);
const dual = computed(() => second.value !== null);

/** Hover state: nearest bucket index + fixed-position tooltip anchor. */
const hover = ref<{ index: number; x: number; y: number } | null>(null);

function bucketX(index: number): number {
  const n = props.points.length;
  return n <= 1 ? props.width / 2 : (index / (n - 1)) * props.width;
}

function valueY(v: number | null | undefined, s: SparklineScale | null): number | null {
  if (s === null || v === null || v === undefined) return null;
  return props.height - ((v - s.min) / (s.max - s.min)) * props.height;
}

function readAt(points: Array<number | null>, index: number): number | null {
  const v = points[index];
  return v === null || v === undefined ? null : v;
}

interface TipRow {
  key: string;
  label: string;
  color: string;
  dashed: boolean;
  value: number;
  y: number;
}

const rows = computed<TipRow[]>(() => {
  const h = hover.value;
  if (h === null) return [];
  const out: TipRow[] = [];
  const v1 = readAt(props.points, h.index);
  const y1 = valueY(v1, scale.value);
  if (v1 !== null && y1 !== null) {
    out.push({ key: "a", label: props.label ?? "", color: props.color, dashed: false, value: v1, y: y1 });
  }
  if (second.value !== null) {
    const v2 = readAt(second.value, h.index);
    const y2 = valueY(v2, scale2.value);
    if (v2 !== null && y2 !== null) {
      out.push({ key: "b", label: props.label2 ?? "", color: props.color2, dashed: true, value: v2, y: y2 });
    }
  }
  return out;
});

function onMove(e: PointerEvent): void {
  const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
  if (rect.width === 0) return;
  const index = hoverIndex(props.points.length, (e.clientX - rect.left) / rect.width);
  const readable =
    readAt(props.points, index) !== null ||
    (second.value !== null && readAt(second.value, index) !== null);
  const s1 = scale.value;
  hover.value = !readable || (s1 === null && scale2.value === null)
    ? null
    : { index, x: clampTipX(e.clientX), y: e.clientY };
}

const tip = computed(() => {
  const h = hover.value;
  if (h === null || dual.value) return "";
  const v = readAt(props.points, h.index);
  if (v === null) return "";
  return props.format !== undefined ? props.format(v) : String(Math.round(v * 100) / 100);
});

function fmt(v: number, which: "a" | "b"): string {
  const f = which === "a" ? props.format : props.format2;
  return f !== undefined ? f(v) : String(Math.round(v * 100) / 100);
}
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
      v-if="path2"
      fill="none"
      :stroke="color2"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-dasharray="4 3"
      :d="path2"
    />
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
      <circle v-for="r in rows" :key="r.key" :cx="bucketX(hover.index)" :cy="r.y" r="3" :fill="r.color" />
    </g>
  </svg>
  <div v-if="hover !== null && dual" class="charttip" :style="{ left: `${hover.x}px`, top: `${hover.y}px` }" aria-hidden="true">
    <div v-for="r in rows" :key="r.key" class="charttip__row">
      <span class="charttip__swatch" :style="{ background: r.color }"></span>
      <span class="charttip__label">{{ r.label }}</span>
      <span class="charttip__value">{{ fmt(r.value, r.key === 'a' ? 'a' : 'b') }}</span>
    </div>
  </div>
  <div v-else-if="hover !== null" class="charttip" :style="{ left: `${hover.x}px`, top: `${hover.y}px` }" aria-hidden="true">
    {{ tip }}
  </div>
</template>
