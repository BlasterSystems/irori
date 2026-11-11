<script setup lang="ts">
import { computed } from "vue";
import type { HealthFinding } from "@irori/core";

/**
 * IR-203: global infra banner — the open FLEET-scoped health findings
 * (nodeId ""), rendered above the Overview content. Per-node findings stay on
 * the node cards / NodeDetail chips. Hidden entirely when nothing matches.
 * The findings GET stays the only source (live.ts refreshes it on health SSE
 * transitions and once at boot); severity drives the hue and marker.
 */
const props = defineProps<{ findings: HealthFinding[] }>();

const infraFindings = computed(() => props.findings.filter((f) => f.nodeId === ""));

/** Runbook hint per known infra metric; unknown metrics render summary-only. */
function hintFor(metric: string): string {
  switch (metric) {
    case "db_unavailable":
      return "hub data on this page may be stale until the database returns — degraded routes keep answering";
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
</script>

<template>
  <section v-if="infraFindings.length > 0" class="health-banner" aria-label="Infrastructure findings">
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
  </section>
</template>

<style scoped>
.health-banner {
  display: grid;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}
.health-banner__row {
  align-items: baseline;
}
.health-banner__marker {
  flex: none;
  font-size: 12px;
}
.health-banner__body {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.health-banner__title {
  font-weight: 600;
}
</style>
