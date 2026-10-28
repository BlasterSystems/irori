/**
 * Process logger (IRI-039 / IR-117): pino JSON lines to stdout, plus an
 * env-gated OTLP logs bridge (`OTEL_EXPORTER_OTLP_ENDPOINT` set → records
 * also export; see otel.ts). No worker-thread transports — the agent is a
 * single esbuild bundle and in-process bridging keeps both runtimes simple.
 * `IRORI_LOG_LEVEL` overrides the level (default info) for both sinks.
 */
import pino from "pino";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { otelLogBridge } from "./otel.js";

const here = dirname(fileURLToPath(import.meta.url));

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(here, "../package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** The hub's process logger — one instance, every console.* call site migrated. */
export function buildLog(): pino.Logger {
  const level = (process.env.IRORI_LOG_LEVEL?.trim() || "info") as pino.Level;
  const streams: { level: pino.Level; stream: pino.DestinationStream }[] = [{ level, stream: process.stdout }];
  const bridge = otelLogBridge({ serviceName: "irori-server", version: packageVersion() });
  if (bridge !== null) streams.push({ level, stream: bridge });
  return pino({ level, base: { service: "irori-server" } }, pino.multistream(streams));
}

export const log = buildLog();
