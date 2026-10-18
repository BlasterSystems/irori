<script setup lang="ts">
import Sparkline from "./Sparkline.vue";
import type { LlmPortView } from "../llm-data";

const props = defineProps<{
  /** Shaped view model from shapeLlmPort(). */
  port: LlmPortView;
  /** Decode tok/s series from the selected history range; null when absent. */
  decode: Array<number | null> | null;
  /** Prefill tok/s series from the selected history range; null when absent. */
  prefill: Array<number | null> | null;
  /** History range label for sparkline aria text (e.g. "24h"). */
  range: string;
}>();
</script>

<template>
  <article class="card">
    <div class="card__head">
      <div class="row">
        <h3>{{ port.header }}</h3>
        <span class="chip" :class="port.backendChipClass">{{ port.backendLabel }}</span>
        <span class="chip">{{ port.stateLabel }}</span>
      </div>
      <span v-if="port.model" class="mono faint">{{ port.model }}</span>
    </div>
    <div class="card__body" style="padding-top: 12px;">
      <div class="barrow">
        <span>Decode</span>
        <Sparkline
          v-if="props.decode"
          :points="props.decode"
          :height="26"
          :aria-label="`Decode tok/s, ${props.range}`"
        />
        <span v-else></span>
        <span class="val">{{ port.decodeLine }}</span>
      </div>
      <div class="barrow">
        <span>Prefill</span>
        <Sparkline
          v-if="props.prefill"
          :points="props.prefill"
          :height="26"
          :aria-label="`Prefill tok/s, ${props.range}`"
        />
        <span v-else></span>
        <span class="val">{{ port.prefillLine }}</span>
      </div>
      <div class="barrow"><span>Queue</span><span></span><span class="val">{{ port.queueLine }}</span></div>
      <div class="barrow">
        <span>KV cache</span>
        <div v-if="port.kvBarPct !== null" class="bar"><div class="bar__fill" :style="{ width: port.kvBarPct + '%' }"></div></div>
        <span v-else></span>
        <span class="val">{{ port.kvLine }}</span>
      </div>
      <div class="barrow"><span>TTFT p95</span><span></span><span class="val">{{ port.ttftLine }}</span></div>

      <dl v-if="port.engineMetaRows.length > 0" class="kv" style="margin-top: 14px;">
        <template v-for="row in port.engineMetaRows" :key="row.key">
          <dt>{{ row.key }}</dt><dd>{{ row.value }}</dd>
        </template>
      </dl>

      <p v-if="!port.detected" class="muted" style="margin-top: 12px;">no engine answered</p>
      <p v-if="port.detectOnly" class="stat__sub" style="margin-top: 12px;">detection-only (worker)</p>
      <p v-if="!port.detected" class="stat__sub" style="margin-top: 8px;">Probes continue on idle ports</p>
    </div>
  </article>
</template>

<style scoped>
/* Long model names must not force horizontal overflow on 390px phones. */
.card__head > .mono {
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>
