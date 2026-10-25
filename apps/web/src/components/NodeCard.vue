<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { HardwareSnapshot, LlmPortSnapshot, NodeInfo } from "@irori/core";
import { computeCardData, formatTemp, isHotTemp } from "../card-data";
import { nodeHash } from "../router";
import { fetchCleanup } from "../api";
import { diskChipCls, diskPct, fmtBytes, sumReclaimable } from "../analytics";
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

// Disk hygiene chip (SPEC §11.6): plain ≤89%, warn ≥90%, none under 80%.
// Reclaimable bytes come from the node's latest audit — only fetched when
// the card actually crosses the threshold (rarely more than a node or two).
const diskPctValue = computed(() => {
  const storage = props.snapshot?.storage ?? [];
  let best: number | null = null;
  for (const s of storage) {
    if (typeof s?.totalBytes !== "number" || typeof s?.usedBytes !== "number") continue;
    const pct = diskPct(s.usedBytes, s.totalBytes);
    if (pct !== null && (best === null || pct > best)) best = pct;
  }
  return best;
});
const reclaimable = ref<number | null>(null);
let auditFetched = false;
watch(
  diskPctValue,
  async (pct) => {
    if (pct === null || pct < 80 || auditFetched) return;
    auditFetched = true;
    try {
      const state = await fetchCleanup(props.node.id);
      const report = state.latestAudit?.report;
      if (report !== null && report !== undefined && Array.isArray((report as { categories?: unknown }).categories)) {
        reclaimable.value = sumReclaimable(report as { categories: Array<{ reclaimableBytes: number }> });
      }
    } catch {
      // No audit yet / server busy — the chip still shows the usage tier.
    }
  },
  { immediate: true },
);
const diskChip = computed(() => diskChipCls(diskPctValue.value));
</script>

<template>
  <a class="card card--link" :href="nodeHash(node.id)" :aria-label="`Open ${card.name} detail`">
    <div class="card__head">
      <div class="row">
        <h3>{{ card.name }}</h3>
        <span v-if="card.role !== 'standalone'" class="chip chip--accent">{{ card.role }}</span>
        <span class="chip">{{ card.kind }}</span>
        <span class="chip" :class="card.online ? 'chip--ok' : 'chip--muted'">
          <span class="dot" :class="card.dotClass" aria-hidden="true"></span>{{ card.statusText }}
        </span>
      </div>
      <span v-if="card.agentVersion" class="mono faint">Agent {{ card.agentVersion }}</span>
      <span v-if="agentDrifts(card.agentVersion)" class="chip chip--warn">update</span>
    </div>
    <div class="card__body" style="padding-top: 12px;">
      <p v-if="card.inferenceLine" class="stat__sub" style="margin-bottom: 10px;">{{ card.inferenceLine }}</p>
      <template v-if="card.hasSnapshot">
        <div v-for="row in card.rows" :key="row.key" class="barrow">
          <span>{{ row.label }}</span>
          <div class="bar"><div class="bar__fill" :style="{ width: (row.barPct ?? 0) + '%' }"></div></div>
          <span class="val" :class="{ 'metric--hot': row.warn === true }">{{ row.line }}<template v-if="row.tempC !== null"><template v-if="row.line"> · </template><span :class="{ 'metric--hot': isHotTemp(row.tempC) }">{{ formatTemp(row.tempC) }}</span></template></span>
        </div>
      </template>
      <p v-else class="muted">waiting for first snapshot</p>
      <p v-if="diskPctValue !== null && diskChip !== null" style="margin-top: 10px;">
        <span class="chip" :class="diskChip">Disk {{ diskPctValue }}%<template v-if="reclaimable !== null"> · {{ fmtBytes(reclaimable) }} reclaimable</template></span>
      </p>
    </div>
  </a>
</template>

<style scoped>
.card--link {
  display: block;
}
</style>
