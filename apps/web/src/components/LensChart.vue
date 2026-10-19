<script setup lang="ts">
import type { LensChart } from "../analytics";

defineProps<{
  chart: LensChart;
  /** Unit label shown top-right (tok/s, W, °C…). */
  unit?: string;
  /** Accessible description. */
  ariaLabel?: string;
}>();
</script>

<template>
  <svg
    class="spark"
    :viewBox="`0 0 ${chart.width} ${chart.height}`"
    :height="chart.height"
    preserveAspectRatio="none"
    :role="ariaLabel !== undefined ? 'img' : 'presentation'"
    :aria-label="ariaLabel"
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
  </svg>
</template>
