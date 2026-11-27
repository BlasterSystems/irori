<script setup lang="ts">
import { computed } from "vue";
import type { HardwareSnapshot, NodeInfo } from "@irori/core";
import { computeCardData, formatTemp, isHotTemp } from "../card-data";
import { nodeHash } from "../router";
import { agentDrifts } from "../version";

const props = defineProps<{
  node: NodeInfo;
  snapshot: HardwareSnapshot | null;
}>();

const card = computed(() =>
  computeCardData(props.node, props.snapshot),
);
</script>

<template>
  <a class="card card--link" :class="{ 'card--offline': !card.online }" :href="nodeHash(node.id)" :aria-label="`Open ${card.name} detail`">
    <div v-if="!card.online" class="offline-strip">OFFLINE</div>
    <div class="card__head">
      <div class="row">
        <!-- IRI-159: the static identity (model · kind · agent · totals) lives
             in the name tooltip — the visible head carries state chips only. -->
        <h3 class="card__name">
          <span v-if="card.identityTip" class="tip nametip" :data-tip="card.identityTip" tabindex="0" :aria-label="card.identityTip">{{ card.name }}</span>
          <template v-else>{{ card.name }}</template>
        </h3>
        <span v-if="card.role !== 'standalone'" class="chip chip--accent">{{ card.role }}</span>
        <span v-if="agentDrifts(card.agentVersion)" class="chip chip--warn">update</span>
      </div>
    </div>
    <div class="card__body" style="padding-top: 12px;">
      <template v-if="card.hasSnapshot">
        <div v-for="row in card.rows" :key="row.key" class="barrow">
          <span v-if="row.tip !== undefined" class="tip rowtip" :data-tip="row.tip" tabindex="0" :aria-label="row.tip">{{ row.label }}</span>
          <span v-else>{{ row.label }}</span>
          <div class="bar"><div class="bar__fill" :style="{ width: (row.barPct ?? 0) + '%' }"></div><div v-if="row.freePct !== undefined" class="bar__fill bar__fill--free" :style="{ width: row.freePct + '%' }"></div></div>
          <span class="val" :class="{ 'metric--hot': row.warn === true }"><span class="v-compact">{{ row.line }}</span><span v-if="row.lineFull !== undefined" class="v-total">{{ row.lineFull }}</span><template v-if="(row.lineFull ?? row.line)"><template v-if="row.line"> · </template><span :class="{ 'metric--hot': isHotTemp(row.tempC) }">{{ formatTemp(row.tempC) }}</span></template></span>
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
/* IRI-159: tooltip carriers reuse the global .tip machinery (hover + keyboard
   focus per IRI-155, display:none at rest per IR-196) — labels get a dotted
   underline instead of an info icon, so no extra chrome is added. display:
   inline (not the global inline-flex): text-decoration does not propagate
   into flex items, and these carriers are plain text. */
.nametip,
.rowtip {
  display: inline;
  margin-left: 0;
  color: inherit;
  text-decoration: underline dotted var(--rule-2);
  text-underline-offset: 3px;
}
/* Touch fallback (IRI-159): no hover means no tooltips — the totals come back
   inline (the pre-IRI-159 values); the node detail page stays the full view. */
.v-total {
  display: none;
}
@media (hover: none) {
  .v-compact {
    display: none;
  }
  .v-total {
    display: inline;
  }
}
</style>
