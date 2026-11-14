<script setup lang="ts">
import { computed } from "vue";

/** IR-224 S4: nav/chrome icons as inlined outline paths (lucide-style
 *  geometry, 24px grid). Vendored locally on purpose — the DS kit's Icon.jsx
 *  masks a jsDelivr CDN at runtime, which the air-gapped LAN hub cannot
 *  reach; the path data below is compiled into the bundle instead. */
const ICON_PATHS: Record<string, string[]> = {
  overview: ["M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"],
  models: ["M12 3l8 4.5-8 4.5-8-4.5L12 3z", "M4 12l8 4.5 8-4.5", "M4 16.5L12 21l8-4.5"],
  serve: ["M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 1 0 0-17z", "M10 8.5l6 3.5-6 3.5v-7z"],
  analytics: ["M4 19V5", "M4 19h16", "M7 15l4-5 3 3 5-7"],
  usage: ["M5 20V10", "M10 20V4", "M15 20v-7", "M20 20V7"],
  chats: ["M20 12a8 8 0 1 0-3 6.2L21 19l-.9-3.4A7.9 7.9 0 0 0 20 12z"],
  benchmarks: ["M5 14a7 7 0 0 1 14 0", "M12 14l3.5-3.5", "M3.5 14h3", "M17.5 14h3"],
  audit: ["M12 3l7 3v6c0 4.4-3 7.4-7 9-4-1.6-7-4.6-7-9V6l7-3z", "M9.5 12l2 2 3.5-4"],
  logs: ["M6 3h9l4 4v14H6V3z", "M9 9h6", "M9 13h6", "M9 17h4"],
  community: [
    "M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 1 0 0-17z",
    "M3.5 12h17",
    "M12 3.5c2.5 2.3 3.8 5.2 3.8 8.5s-1.3 6.2-3.8 8.5c-2.5-2.3-3.8-5.2-3.8-8.5s1.3-6.2 3.8-8.5z",
  ],
  plus: ["M12 5v14", "M5 12h14"],
  clock: ["M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 1 0 0-17z", "M12 7v5l3.5 2"],
  "chevron-left": ["M15 6l-6 6 6 6"],
};

const props = defineProps<{ name: string }>();
const segments = computed(() => ICON_PATHS[props.name] ?? []);
</script>

<template>
  <svg class="bs-icon" viewBox="0 0 24 24" aria-hidden="true">
    <path v-for="(d, i) in segments" :key="i" :d="d" />
  </svg>
</template>
