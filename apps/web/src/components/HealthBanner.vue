<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { HealthFinding, NodeInfo } from "@irori/core";
import { fetchCleanup } from "../api";
import { fmtBytes } from "../analytics";
import { nodeHash } from "../router";
import { copyToClipboard } from "../clipboard";
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

/** IR-239: the hub-disk row's remedy is copyable, not prose — the runbook
 *  commands land on the clipboard (works over the insecure http:// LAN
 *  origin via the legacy fallback) next to a deep link into
 *  docs/DEPLOYMENT.md. The phrase "hub VM filesystem" refutes the NAS
 *  assumption in place. */
const HUB_RUNBOOK_URL =
  "https://github.com/BlasterSystems/irori/blob/main/docs/DEPLOYMENT.md#hub-disk-pressure-hub_disk_pct-fleet";
const HUB_RUNBOOK_CMDS = [
  "docker system df",
  "docker builder prune -f",
  "docker image prune -a -f  # only after confirming nothing running uses those images",
].join("\n");
const hubCmdsCopied = ref(false);
async function copyHubRunbook(): Promise<void> {
  if (await copyToClipboard(HUB_RUNBOOK_CMDS)) {
    hubCmdsCopied.value = true;
    setTimeout(() => (hubCmdsCopied.value = false), 2000);
  }
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
      class="health-banner__row"
      :class="{ 'banner--critical': f.severity === 'critical' }"
      role="alert"
    >
      <span class="health-banner__marker" aria-hidden="true">{{ f.severity === "critical" ? "▪" : "◇" }}</span>
      <span class="health-banner__body">
        <span class="health-banner__title">{{ titleFor(f) }}</span>
        <span class="stat__sub">{{ f.summary }}</span>
        <span v-if="hintFor(f.metric)" class="stat__sub faint">{{ hintFor(f.metric) }}</span>
        <span v-if="f.metric === 'hub_disk_pct'" class="health-banner__remedy">
          <button class="btn btn--secondary btn--sm" type="button" @click="copyHubRunbook">
            {{ hubCmdsCopied ? "Copied ✓" : "Copy runbook commands" }}
          </button>
          <a class="health-banner__link stat__sub" :href="HUB_RUNBOOK_URL" target="_blank" rel="noreferrer">Runbook · docs/DEPLOYMENT.md</a>
        </span>
      </span>
    </p>
    <p
      v-for="f in nodeDiskFindings"
      :key="f.ruleId"
      class="health-banner__row"
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
/* IR-220: the v1.1 alert idiom — a glyph column + text stack on hairline
   rules, no bordered box (the old .banner chrome is gone). Severity keeps
   the banner--critical class name for the tests; it now reads as ink on the
   title, the marker carries the thread. */
.health-banner {
  margin-bottom: var(--space-2);
}
.health-banner__row {
  display: grid;
  grid-template-columns: 12px minmax(0, 1fr) auto;
  gap: 12px;
  align-items: start;
  padding: 10px 0;
  border-top: 1px solid var(--rule);
  font-size: var(--fs-ui);
  color: var(--ink);
}
.health-banner__row:first-child {
  border-top: 0;
  padding-top: 2px;
}
.health-banner__marker {
  margin-top: 5px;
  font-size: 12px;
  line-height: 1;
  color: var(--thread);
}
.health-banner__body {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.health-banner__title {
  font-size: var(--fs-ui);
  font-weight: 500;
  line-height: 1.35;
}
.health-banner__row.banner--critical .health-banner__title {
  color: var(--thread-ink);
}
.health-banner__link {
  color: inherit;
}
.health-banner__remedy {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 4px;
}
.health-banner__cta {
  grid-column: 3;
  align-self: center;
}
</style>
