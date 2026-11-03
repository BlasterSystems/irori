import type { HardwareSnapshot } from "@irori/core";

/**
 * IRI-069: Prometheus text exposition from the latest snapshot ring.
 * node_exporter/DCGM-style names in base units; one metric family per line
 * pair (# HELP/# TYPE optional but conventional — kept minimal for size).
 */

function esc(s: string): string {
  return s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

export interface MetricsNode {
  id: string;
  name: string;
  online: boolean;
  snapshot: HardwareSnapshot | null;
}

/** Renders the /metrics body; pure so promtool-style assertions are easy. */
export function renderPrometheus(nodes: MetricsNode[]): string {
  const lines: string[] = [];
  const emit = (name: string, help: string, type: string, samples: Array<{ labels: string; value: number | string }>): void => {
    if (samples.length === 0) return;
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const s of samples) lines.push(`${name}{${s.labels}} ${s.value}`);
  };
  lines.push("# HELP irori_up The Irori hub is serving.", "# TYPE irori_up gauge", "irori_up 1");

  emit("irori_node_online", "1 when the node agent is connected.", "gauge", nodes.map((n) => ({ labels: `node="${esc(n.name)}"`, value: n.online ? 1 : 0 })));

  const withSnap = nodes.filter((n) => n.snapshot !== null) as Array<MetricsNode & { snapshot: HardwareSnapshot }>;
  emit(
    "irori_collector_last_success_timestamp_seconds",
    "Agent clock of the node's most recent snapshot.",
    "gauge",
    withSnap.map((n) => ({ labels: `node="${esc(n.name)}"`, value: Math.floor(n.snapshot.timestampMs / 1000) })),
  );
  emit(
    "irori_node_gpu_temp_celsius",
    "Max GPU temperature across cards.",
    "gauge",
    withSnap.flatMap((n) =>
      n.snapshot.gpus.map((g) => ({ labels: `node="${esc(n.name)}",gpu="${g.index}"`, value: g.tempC ?? NaN })).filter((s) => !Number.isNaN(s.value)),
    ),
  );
  emit(
    "irori_node_gpu_power_watts",
    "GPU board power draw.",
    "gauge",
    withSnap.flatMap((n) =>
      n.snapshot.gpus.map((g) => ({ labels: `node="${esc(n.name)}",gpu="${g.index}"`, value: g.powerW ?? NaN })).filter((s) => !Number.isNaN(s.value)),
    ),
  );
  emit(
    "irori_node_gpu_utilization_ratio",
    "GPU utilization (0-1).",
    "gauge",
    withSnap.flatMap((n) =>
      n.snapshot.gpus.map((g) => ({ labels: `node="${esc(n.name)}",gpu="${g.index}"`, value: (g.usagePct ?? NaN) / 100 })).filter((s) => !Number.isNaN(s.value)),
    ),
  );
  emit(
    "irori_node_cpu_temp_celsius",
    "CPU package temperature.",
    "gauge",
    withSnap.map((n) => ({ labels: `node="${esc(n.name)}"`, value: n.snapshot.cpu.tempC ?? NaN })).filter((s) => !Number.isNaN(s.value)),
  );
  emit(
    "irori_node_memory_used_bytes",
    "Used main memory (unified pool on GB10).",
    "gauge",
    withSnap.map((n) => ({ labels: `node="${esc(n.name)}"`, value: n.snapshot.memory.usedBytes })),
  );
  emit(
    "irori_node_memory_total_bytes",
    "Total main memory.",
    "gauge",
    withSnap.map((n) => ({ labels: `node="${esc(n.name)}"`, value: n.snapshot.memory.totalBytes })),
  );
  emit(
    "irori_node_storage_used_bytes",
    "Used filesystem bytes (per mount).",
    "gauge",
    withSnap.flatMap((n) => n.snapshot.storage.map((s) => ({ labels: `node="${esc(n.name)}",mount="${esc(s.mount)}"`, value: s.usedBytes }))),
  );
  emit(
    "irori_node_storage_total_bytes",
    "Total filesystem bytes (per mount).",
    "gauge",
    withSnap.flatMap((n) => n.snapshot.storage.map((s) => ({ labels: `node="${esc(n.name)}",mount="${esc(s.mount)}"`, value: s.totalBytes }))),
  );
  emit(
    "irori_node_load1",
    "1-minute load average.",
    "gauge",
    withSnap.filter((n) => n.snapshot.load1 !== undefined).map((n) => ({ labels: `node="${esc(n.name)}"`, value: n.snapshot.load1! })),
  );
  emit(
    "irori_node_uptime_seconds",
    "Host uptime.",
    "gauge",
    withSnap.filter((n) => n.snapshot.uptimeS !== undefined).map((n) => ({ labels: `node="${esc(n.name)}"`, value: n.snapshot.uptimeS! })),
  );
  return lines.join("\n") + "\n";
}
