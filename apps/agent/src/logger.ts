/**
 * Process logger (IRI-039 / IR-117): pino JSON lines to stdout, plus an
 * env-gated OTLP logs bridge (`OTEL_EXPORTER_OTLP_ENDPOINT` set → records
 * also export; see otel.ts). No worker-thread transports — the agent is a
 * single esbuild bundle and in-process bridging keeps both runtimes simple.
 * `IRORI_LOG_LEVEL` overrides the level (default info) for both sinks.
 */
import pino from "pino";
import { otelLogBridge } from "./otel.js";
import { AGENT_VERSION } from "./version.js";

/** The agent's process logger — one instance; `log`/`fail` in main.ts route here. */
export function buildLog(): pino.Logger {
  const level = (process.env.IRORI_LOG_LEVEL?.trim() || "info") as pino.Level;
  const streams: { level: pino.Level; stream: pino.DestinationStream }[] = [{ level, stream: process.stdout }];
  const bridge = otelLogBridge({ serviceName: "irori-agent", version: AGENT_VERSION });
  if (bridge !== null) streams.push({ level, stream: bridge });
  return pino({ level, base: { service: "irori-agent" } }, pino.multistream(streams));
}

export const logger = buildLog();

/** String-only wrapper preserving the agent's `log(message)` call convention
 *  (pino instances are not callable in v10's typings). */
export function log(message: string): void {
  logger.info(message);
}
