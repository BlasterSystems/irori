<template>
  <span class="tip" :data-tip="text" aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" /></svg>
  </span>
</template>

<script setup lang="ts">
/** Tooltip metadata affordance (IRI-025): visible = primary value, hover = detail. */
defineProps<{ text: string }>();
</script>
