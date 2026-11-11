<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { HealthFinding, NodeInfo } from "@irori/core";
import { fetchCleanup } from "../api";
import { fmtBytes } from "../analytics";
import { nodeHash } from "../router";
import CleanupDrawer from "./CleanupDrawer.vue";

/**
 * IR-203: global infra banner — the open FLEET-scoped health findings
 * (nodeId ""), rendered above the Overview content. Per-node findings stay on
 * the node cards / NodeDetail chips — except IR-204's disk-pressure rows,
 * which deep-link to the node and carry the reuseable clean-up-disk CTA
 * (ServeView's hygieneOffers idiom). The banner is read-only for dispatch: it
 * opens the CleanupDrawer and never fires a job itself. The findings GET
 * stays the only source (live.ts refreshes it on health SSE transitions and
 * once at boot); severity drives the hue and marker.
 */
const props = defineProps<{ findings: HealthFinding[]; nodes: NodeInfo[] }>();

const infraFindings = computed(() => props.findings.filter((f) => f.nodeId === ""));
const nodeDiskFindings = computed(() => props.findings.filter((f) => f.metric === "disk_pct" && f.nodeId !== ""));

/** Runbook hint per known infra metric; unknown metrics render summary-only. */
function hintFor(metric: string): string {
  switch (metric) {
    case "db_unavailable":
      return "hub data on the page may be stale until the database returns — degraded routes keep answering";
    case "hub_disk_pct":
      return "check the hub VM filesystem — docker build cache is the usual culprit (docker system df on the deploy host)";
    default:
      return "";
  }
}

function titleFor(f: HealthFinding): string {
  if (f.metric === "db_unavailable") return "Database unavailable";
  if (f.metric === "hub_disk_pct") return "Hub disk pressure";
  return f.summary.split(":")[0]?.trim() || f.summary;
}

function nodeName(id: string): string {
  return props.nodes.find((n) => n.id === id)?.name ?? id.slice(0, 8);
}

/** IR-204: est. reclaim per disk-finding node — lazy, once per node, silent
 *  on failure (0 hides the est. text). Same shape as ServeView's
 *  hygieneOffers so the two CTAs stay consistent. */
const reclaim = ref<Map<string, number>>(new Map());
watch(
  nodeDiskFindings,
  (rows) => {
    for (const row of rows) {
      if (reclaim.value.has(row.nodeId)) continue;
      reclaim.value.set(row.nodeId, 0);
      void fetchCleanup(row.nodeId)
        .then((state) => {
          const report = state.latestAudit?.report;
          const categories =
            report !== null && report !== undefined && Array.isArray((report as { categories?: unknown }).categories)
              ? (report as { categories: Array<{ reclaimableBytes: number }> }).categories
              : [];
          reclaim.value.set(row.nodeId, categories.reduce((sum, c) => sum + c.reclaimableBytes, 0));
        })
        .catch(() => reclaim.value.set(row.nodeId, 0));
    }
  },
  { immediate: true },
);

/** The reuseable per-node drawer; dispatch happens INSIDE it (typed
 *  confirms), never from the banner. */
const cleanupNode = ref<{ id: string; name: string } | null>(null);
function openCleanup(nodeId: string): void {
  cleanupNode.value = { id: nodeId, name: nodeName(nodeId) };
}
</script>

<template>
  <section v-if="infraFindings.length > 0 || nodeDiskFindings.length > 0" class="health-banner" aria-label="Infrastructure findings">
    <p
      v-for="f in infraFindings"
      :key="f.ruleId"
      class="banner health-banner__row"
      :class="{ 'banner--critical': f.severity === 'critical' }"
      role="alert"
    >
      <span class="health-banner__marker" aria-hidden="true">{{ f.severity === "critical" ? "▪" : "◇" }}</span>
      <span class="health-banner__body">
        <span class="health-banner__title">{{ titleFor(f) }}</span>
        <span class="stat__sub">{{ f.summary }}</span>
        <span v-if="hintFor(f.metric)" class="stat__sub faint">{{ hintFor(f.metric) }}</span>
      </span>
    </p>
    <p
      v-for="f in nodeDiskFindings"
      :key="f.ruleId"
      class="banner health-banner__row"
      :class="{ 'banner--critical': f.severity === 'critical' }"
      role="alert"
    >
      <span class="health-banner__marker" aria-hidden="true">{{ f.severity === "critical" ? "▪" : "◇" }}</span>
      <span class="health-banner__body">
        <span class="health-banner__title">Node disk pressure · <a class="health-banner__link" :href="nodeHash(f.nodeId)">{{ nodeName(f.nodeId) }}</a></span>
        <span class="stat__sub">{{ f.summary }}</span>
      </span>
      <button
        class="btn btn--secondary btn--sm health-banner__cta"
        :title="'Audit and reclaim disk space — nothing deleted without a typed confirm'"
        @click="openCleanup(f.nodeId)"
      >
        Clean up disk<template v-if="(reclaim.get(f.nodeId) ?? 0) > 0"> — est. +{{ fmtBytes(reclaim.get(f.nodeId) ?? 0) }}</template>
      </button>
    </p>
  </section>
  <CleanupDrawer v-if="cleanupNode !== null" :node-id="cleanupNode.id" :node-name="cleanupNode.name" @close="cleanupNode = null" />
</template>

<style scoped>
.health-banner {
  display: grid;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}
.health-banner__row {
  align-items: baseline;
  flex-wrap: wrap;
  row-gap: 6px;
}
.health-banner__marker {
  flex: none;
  font-size: 12px;
}
.health-banner__body {
  display: grid;
  gap: 2px;
  min-width: 0;
  flex: 1;
}
.health-banner__title {
  font-weight: 600;
}
.health-banner__link {
  color: inherit;
}
.health-banner__cta {
  flex: none;
  align-self: center;
}
</style>
