<script setup lang="ts">
import { computed } from "vue";
import type { HardwareSnapshot, NodeInfo } from "@irori/core";
import { computeCardData } from "../card-data";

const props = defineProps<{
  node: NodeInfo;
  snapshot: HardwareSnapshot | null;
}>();

const card = computed(() => computeCardData(props.node, props.snapshot));
</script>

<template>
  <article class="card">
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
    </div>
    <div class="card__body" style="padding-top: 12px;">
      <template v-if="card.hasSnapshot">
        <div class="barrow"><span>CPU</span><div class="bar"><div class="bar__fill" :style="{ width: (card.cpuBarPct ?? 0) + '%' }"></div></div><span class="val">{{ card.cpuLine }}</span></div>
        <div class="barrow"><span>MEM</span><div class="bar"><div class="bar__fill" :style="{ width: (card.memBarPct ?? 0) + '%' }"></div></div><span class="val">{{ card.memLine }}</span></div>
        <div v-for="gpu in card.gpus" :key="gpu.index" class="barrow">
          <span>GPU{{ gpu.index }}</span>
          <div class="bar"><div class="bar__fill" :style="{ width: (gpu.barPct ?? 0) + '%' }"></div></div>
          <span class="val">{{ gpu.name }} · {{ gpu.line }}</span>
        </div>
      </template>
      <p v-else class="muted">waiting for first snapshot</p>
    </div>
  </article>
</template>
