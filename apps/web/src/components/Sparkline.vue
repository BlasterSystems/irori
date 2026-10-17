<script setup lang="ts">
import { computed } from "vue";
import { sparklinePath, type SparklineDomain } from "../sparkline";

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
  }>(),
  { width: 600, height: 44, color: "var(--ink-2)" },
);

const path = computed(() =>
  sparklinePath(props.points, props.width, props.height, props.domain),
);
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
  >
    <path
      fill="none"
      :stroke="color"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      :d="path"
    />
  </svg>
</template>
