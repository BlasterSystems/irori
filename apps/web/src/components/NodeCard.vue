<script setup lang="ts">
import { computed } from "vue";
import type { HardwareSnapshot, LlmPortSnapshot, NodeInfo } from "@irori/core";
import { computeCardData, formatTemp, isHotTemp } from "../card-data";
import { nodeHash } from "../router";
import { agentDrifts } from "../version";

const props = defineProps<{
  node: NodeInfo;
  snapshot: HardwareSnapshot | null;
  /** Latest LLM probe entry; heads render the inference summary line. */
  llm?: { ports: LlmPortSnapshot[] } | null;
}>();

const card = computed(() =>
  computeCardData(props.node, props.snapshot, props.llm ?? null),
);
</script>

<template>
  <a class="card card--link" :class="{ 'card--offline': !card.online }" :href="nodeHash(node.id)" :aria-label="`Open ${card.name} detail`">
    <div v-if="!card.online" class="offline-strip">OFFLINE</div>
    <div class="card__head">
      <div class="row">
        <h3 class="card__name">{{ card.name }}</h3>
        <span v-if="card.role !== 'standalone'" class="chip chip--accent">{{ card.role }}</span>
        <span class="chip">{{ card.kind }}</span>
      </div>
      <span v-if="card.agentVersion" class="mono faint">Agent {{ card.agentVersion }}</span>
      <span v-if="agentDrifts(card.agentVersion)" class="chip chip--warn">update</span>
    </div>
    <div class="card__body" style="padding-top: 12px;">
      <p v-if="card.inferenceLine" class="stat__sub" style="margin-bottom: 10px;">{{ card.inferenceLine }}</p>
      <template v-if="card.hasSnapshot">
        <div v-for="row in card.rows" :key="row.key" class="barrow">
          <span>{{ row.label }}</span>
          <div class="bar"><div class="bar__fill" :style="{ width: (row.barPct ?? 0) + '%' }"></div><div v-if="row.freePct !== undefined" class="bar__fill bar__fill--free" :style="{ width: row.freePct + '%' }"></div></div>
          <span class="val" :class="{ 'metric--hot': row.warn === true }">{{ row.line }}<template v-if="row.tempC !== null"><template v-if="row.line"> · </template><span :class="{ 'metric--hot': isHotTemp(row.tempC) }">{{ formatTemp(row.tempC) }}</span></template></span>
        </div>
      </template>
      <p v-else class="muted">waiting for first snapshot</p>
    </div>
  </a>
</template>

<style scoped>
.card--link {
  display: block;
}
/* IR-103: online cards carry no status chip — liveness is the live rows.
   Offline must be unmistakable: error border, strip, dimmed stale metrics. */
.card--offline {
  border-color: var(--error);
}
.offline-strip {
  background: var(--error);
  color: var(--paper);
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-align: center;
  padding: 3px 8px;
  border-radius: var(--radius) var(--radius) 0 0;
}
.card--offline .card__body {
  opacity: 0.55;
}
.card__name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
</style>
